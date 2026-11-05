/**
 * dsh-memory — one shared memory pool for every local DSH conversation.
 *
 * Host half: a small JSON-backed store, zero-token conversation capture,
 * bounded automatic recall, a model-facing `memory` tool, and the
 * `/dsh-memory/api` routes used by the sidebar panel.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

export const name = 'dsh-memory';
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection'];

const STORE_VERSION = 2;
const STORE_FORMAT = 'dsh-memory';
const STORE_CIPHER = 'aes-256-gcm';
const STORE_AAD = Buffer.from('dsh-memory:v2');
const KEY_BYTES = 32;
const BACKUP_KEEP = 16;
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_NAME_RE = /^backup-\d{8}-\d{6}-\d{3}-([a-z0-9-]+)\.json$/;
const JOURNAL_COMPACT_EVENTS = 200;
const JOURNAL_COMPACT_BYTES = 512 * 1024;
const MAX_MEMORIES = 2500;
const CAPTURE_MAX_CHARS = 760;
const SUMMARY_MAX_CHARS = 420;
const SUMMARY_MIN_USER = 8;
const SUMMARY_MIN_ASSISTANT = 60;
const NOTE_MAX_CHARS = 4000;
const RECALL_MAX_ITEMS = 2;
const RECALL_SNIPPET_CHARS = 180;
const RECALL_MESSAGE_MAX_CHARS = 760;
const RECALL_MIN_COVERAGE = 0.25;
const RECALL_MIN_SCORE = 0.9;
// Local feature-hashed vectors. This is deliberately not a neural embedding
// model: it costs no tokens, runs offline, and adds fuzzy token overlap on top
// of the synonym/concept layer. Signed hashing keeps collisions unbiased.
const VECTOR_DIM = 384;
const VECTOR_MIN_SIMILARITY = 0.3;
const VECTOR_ONLY_WEIGHT = 2;
const VECTOR_BLEND = 0.55;
const API_PREFIX = '/dsh-memory/api';
const API_BODY_MAX = 64 * 1024;
const SOURCE_KIND = 'plugin:dsh-memory';
const RECALL_LOG_MAX = 120;
const EPISODE_WINDOW_MS = 15 * 60 * 1000;
const BACKUP_IMPORT_MAX = 8 * 1024 * 1024;
// The graph deliberately stays on this side of the API: relation strength is a
// local similarity calculation, and the renderer must not have to ship every
// token vector to the browser.
const GRAPH_LIMIT_MAX = 600;
const GRAPH_NEIGHBORS = 4;
const GRAPH_EDGE_MIN = 0.1;

async function durableWrite(file, data, mode = 0o600) {
  const handle = await open(file, 'w', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableAppend(file, data, mode = 0o600) {
  const handle = await open(file, 'a', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableCreate(file, data, mode = 0o600) {
  const handle = await open(file, 'wx', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
}

// Recalled text is untrusted external data. Keep the explanation payload small
// and never let it carry raw prompt text beyond what the user typed for a test.
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  recallMode: 'legacy',
  capture: true,
  maxItems: RECALL_MAX_ITEMS,
  minScore: RECALL_MIN_SCORE,
  minCoverage: RECALL_MIN_COVERAGE,
  margin: 0.02,
  diversity: 0.22,
  queryExpansion: true,
  semantic: false,
});

const ACRONYMS = new Map([
  ['k8s', 'kubernetes'], ['dsh', 'deepseek harness'], ['ui', '界面'],
  ['api', '接口'], ['db', '数据库'], ['llm', '大模型'], ['repo', '仓库'],
  ['pr', 'pull request'], ['ci', '持续集成'], ['os', '操作系统'],
]);

const QUERY_PREFIX_RE = /^(?:请|麻烦|帮我|帮忙|能不能|可以|我想|请问|how\s+do\s+i|can\s+you|please|help\s+me)\s*/i;

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const LATIN_RUN = /[a-z0-9][a-z0-9_\-.]{1,}/g;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'that', 'this', 'from', 'are',
  'was', 'were', 'have', 'has', 'had', 'not', 'but', 'can', 'could', 'would',
  'should', 'will', 'just', 'about', 'into', 'than', 'then', 'them', 'they',
  'there', 'their', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  'use', 'using', 'used', 'make', 'made', 'get', 'got', 'one', 'two', 'all',
  'any', 'our', 'out', 'now', 'new', 'also', 'more', 'some', 'such', 'only',
  'very', 'much', 'many', 'like', 'want', 'need', 'please', 'help', 'thanks',
  'hello', 'okay', 'yes', 'no', 'let', 'its', 'it\'s', 'we', 'he', 'she',
]);

const CJK_STOP = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这些', '那些',
  '什么', '怎么', '怎样', '为什么', '可以', '可能', '应该', '需要', '现在',
  '就是', '不是', '没有', '因为', '所以', '但是', '如果', '然后', '还是',
  '已经', '自己', '这样', '那样', '为了', '时候', '东西', '问题', '帮我',
  '一下', '进行', '使用', '通过', '以及', '或者', '而且', '不过', '其实',
  '知道', '觉得', '看到', '这里', '那里', '今天', '明天', '昨天', '工作',
  '一个', '一些', '有点', '比较', '非常', '真的', '好的', '好的', '谢谢',
  '你好', '请问', '麻烦', '希望', '开始', '继续', '直接', '具体', '相关',
]);

// Small, hand-curated concept groups. This is deliberately not an embedding
// model: it costs zero tokens at capture and recall time, works offline, and
// gives common rephrasings a second chance without opening the floodgates.
const SYNONYM_GROUPS = [
  ['深色', '暗色', '暗黑', '夜间', 'dark'],
  ['浅色', '亮色', '白色', 'light'],
  ['简洁', '简单', '干净', '清爽', '克制', 'minimal'],
  ['界面', '页面', '外观', 'ui', '布局', 'layout'],
  ['主题', '风格', '配色', 'theme', 'style'],
  ['插件', '扩展', 'extension', 'plugin'],
  ['记忆', '回忆', 'memory'],
  ['项目', '工程', '代码库', '仓库', 'repo', 'project'],
  ['会议', '开会', '讨论', 'meeting'],
  ['计划', '待办', '安排', '日程', 'schedule', 'todo', 'plan', 'roadmap'],
  ['下个版本', '下一版', '新版本', '版本', '发布', 'release', 'version'],
  ['环境', '系统', '配置', '版本', 'environment', 'env'],
  ['偏好', '喜欢', '习惯', 'preference'],
  ['人物', '同事', '朋友', '联系人', 'person'],
  ['主人', '用户', '用户名', '名字', '称呼', 'owner', 'user', 'name'],
  ['远程仓库', '仓库', '远程', 'origin', 'remote', 'repository'],
  ['同步', '推送', '上传', 'push', 'sync', 'upload'],
  ['加密', '安全', '隐私', 'security', 'encrypt', 'aes', 'gcm', 'aes-256-gcm'],
  ['图谱', '关系图', 'graph'],
  ['压缩', '摘要', '概括', 'summary'],
  ['总结', '汇总', '小结', '表格', '格式', '呈现', 'format', 'table'],
  ['设置', '调整', 'setting', 'config'],
  ['天气', '气温', 'weather'],
  ['错误', '报错', '失败', 'error', 'bug'],
  ['发布', '上线', '推送', 'release', 'deploy'],
  ['文件', '文档', 'file', 'doc'],
  ['手机', '移动端', 'mobile'],
  ['电脑', '本机', 'windows', 'pc'],
];
const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  const terms = group.map((term) => term.toLowerCase());
  for (const term of terms) {
    let related = SYNONYMS.get(term);
    if (related === undefined) {
      related = new Set();
      SYNONYMS.set(term, related);
    }
    for (const other of terms) if (other !== term) related.add(other);
  }
}

function trimText(text, max) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function projectName(value) {
  if (typeof value !== 'string') return undefined;
  const parts = value.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1);
  if (name === undefined || name.length === 0) return undefined;
  return name.slice(0, 64);
}

// Memory text is data, never instructions. Neutralize the few patterns that
// most often turn a poisoned note into a prompt-injection gadget. The stored
// copy is kept verbatim; only the model-facing reminder is sanitized.
function promptSafeText(value) {
  return String(value ?? '')
    .replace(/\{\{|\}\}/g, '｛｝')
    .replace(/<\/?(?:system|assistant|developer|tool)(?:-reminder)?[^>]*>/gi, '[标签已移除]')
    .replace(/(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions/gi, '[指令内容已过滤]')
    .replace(/(?:忽略|无视)(?:以上|之前|前面)(?:的)?(?:所有)?(?:指令|要求)/g, '[指令内容已过滤]')
    .replace(/(?:你现在是|从现在开始你(?:是|要)|进入开发者模式)/g, '[指令内容已过滤]');
}

function normalizeForHash(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashText(text) {
  return createHash('sha1').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const word of lower.match(LATIN_RUN) ?? []) {
    if (STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    tokens.push(word);
    // Hyphenated identifiers are common here (aes-256-gcm, dsh-memory,
    // deepseek-flash). Index the parts too so a short query such as
    // "AES-GCM" can still meet the exact-token gate.
    if (word.includes('-')) {
      for (const part of word.split('-')) {
        if (/^\d+$/.test(part)) continue;
        if (part.length >= 2 && !STOPWORDS.has(part)) tokens.push(part);
      }
    }
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      if (!CJK_STOP.has(run)) tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!CJK_STOP.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

// FNV-1a over UTF-16 code units. Fast, deterministic, and good enough for
// feature hashing; the sign bit is reused to reduce collision bias.
function hashVectorFeature(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function featureVector(text) {
  const vector = new Float32Array(VECTOR_DIM);
  for (const token of tokenize(text)) {
    const hash = hashVectorFeature(token);
    vector[hash % VECTOR_DIM] += (hash & 0x80000000) === 0 ? 1 : -1;
    // Latin typos and inflections are common; character trigrams give the
    // vector a second, looser view of those words without a model.
    if (token.length >= 4 && /^[a-z0-9]/.test(token)) {
      for (let index = 0; index + 3 <= token.length; index += 1) {
        const trigramHash = hashVectorFeature(token.slice(index, index + 3));
        vector[trigramHash % VECTOR_DIM] += (trigramHash & 0x80000000) === 0 ? 0.5 : -0.5;
      }
    }
  }
  let norm = 0;
  for (let index = 0; index < VECTOR_DIM; index += 1) norm += vector[index] * vector[index];
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < VECTOR_DIM; index += 1) vector[index] *= scale;
  return vector;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  for (let index = 0; index < VECTOR_DIM; index += 1) dot += left[index] * right[index];
  return Math.max(0, Math.min(1, dot));
}

/**
 * A second, concept-level vector. It hashes canonical synonym groups and the
 * memory category into a separate 384-d space. This is still fully local and
 * zero-token, but it can match "部署" with "上线" even when BM25 cannot. It is
 * opt-in because it changes ranking, never required for the legacy path.
 */
function semanticFeatureVector(text, category) {
  const vector = new Float32Array(VECTOR_DIM);
  const groups = new Map();
  for (const group of SYNONYM_GROUPS) {
    const canonical = group[0].toLowerCase();
    for (const term of group) groups.set(term.toLowerCase(), canonical);
  }
  for (const token of tokenize(text)) {
    const concept = groups.get(token) ?? token;
    const index = hashVectorFeature(`concept:${concept}`) % VECTOR_DIM;
    vector[index] += 1;
  }
  if (typeof category === 'string') {
    vector[hashVectorFeature(`category:${category}`) % VECTOR_DIM] += 1.4;
  }
  let norm = 0;
  for (let index = 0; index < VECTOR_DIM; index += 1) norm += vector[index] * vector[index];
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < VECTOR_DIM; index += 1) vector[index] *= scale;
  return vector;
}

function expandQueryConcepts(queryTokens) {
  return queryTokens.map((token) => {
    const terms = [token];
    for (const related of SYNONYMS.get(token) ?? []) {
      if (!terms.includes(related)) terms.push(related);
    }
    return terms;
  });
}

function autoTags(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (token.length < 2) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, 3)
    .map(([token]) => token);
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，;；\s]+/);
  const unique = [];
  for (const raw of list) {
    const tag = trimText(raw, 24).toLowerCase();
    if (tag.length === 0 || unique.includes(tag)) continue;
    unique.push(tag);
    if (unique.length >= 8) break;
  }
  return unique;
}

// Local redaction happens before summarisation and long before the record is
// encrypted. The pool must never become an accidental secrets archive.
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已隐藏]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[密钥已隐藏]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[令牌已隐藏]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[令牌已隐藏]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[令牌已隐藏]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[密钥已隐藏]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[令牌已隐藏]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [令牌已隐藏]'],
  [/(?:password|passwd|pwd|密码|口令)\s*[:=：]\s*[^\s，,；;]{2,}/gi, (match) => `${match.split(/[:=：]/)[0]}：[已隐藏]`],
];

function redactSensitive(text) {
  let output = String(text ?? '');
  for (const [pattern, replacement] of SECRET_RULES) output = output.replace(pattern, replacement);
  return output;
}

const BOILERPLATE_RE = /^(好的?|好呀|当然|没问题|明白了?|收到|以下是|下面是|总结一下|希望|注意|说明|根据你|让我|我来)[：:，,\s]/;
const ACK_RE = /^(好的?|嗯+|哦+|ok(ay)?|行|可以|继续|谢谢|多谢|收到|明白|知道了|没错|对的?|是的?|不用|算了|再见|拜拜|你好)[。！？!?,.，、\s~～]*$/i;

function cleanDialogueText(raw) {
  return redactSensitive(String(raw ?? ''))
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]{80,})`/g, '[代码]')
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;])|(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

function clipSummaryText(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const slice = value.slice(0, Math.max(1, limit - 1));
  const cut = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('；'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('，'),
    slice.lastIndexOf('. '),
  );
  return `${(cut > limit * 0.55 ? slice.slice(0, cut) : slice).trim()}…`;
}

/**
 * Local extractive summary: no model call, no token cost. Instead of deleting
 * everything except a few high-frequency sentences, keep the opening thesis,
 * a bounded set of heading/bullet points, and the closing conclusion. That
 * preserves decisions and instructions that a frequency-only summary loses.
 */
function summarizeDialogue(raw, role) {
  const cleaned = cleanDialogueText(raw);
  if (cleaned.length === 0) return { text: '', compressed: false, originalLength: 0 };
  if (cleaned.length <= SUMMARY_MAX_CHARS) {
    return { text: cleaned, compressed: cleaned.length < String(raw ?? '').length, originalLength: String(raw ?? '').length };
  }

  const counts = new Map();
  for (const token of tokenize(cleaned)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const scoreLine = (line) => {
    const unique = new Set(tokenize(line));
    let score = 0;
    for (const token of unique) score += counts.get(token) ?? 0;
    score /= Math.sqrt(Math.max(4, line.length));
    if (/(建议|结论|因此|所以|需要|可以|步骤|注意|关键|默认|结果|偏好|实现|保持|采用)/.test(line)) score += 0.5;
    return score;
  };

  const sections = cleaned.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^(#{1,4}\s+|[-*•]\s+|\d+[.)]\s+)/.test(line))
    .map((line) => line.replace(/^(#{1,4}\s+|[-*•]\s+|\d+[.)]\s+)/, '').trim())
    .filter((line) => line.length >= 6);
  const rankedBullets = bullets
    .map((line, index) => ({ line, index, score: scoreLine(line) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .sort((left, right) => left.index - right.index);

  const leadSource = sections[0] ?? lines[0] ?? cleaned;
  const lead = clipSummaryText(leadSource, role === 'assistant' ? 220 : 180);
  const tailSource = [...sections].reverse().find((section) => section !== leadSource);
  const tail = tailSource === undefined ? '' : clipSummaryText(tailSource, 150);

  const parts = [lead];
  if (rankedBullets.length > 0) {
    let points = rankedBullets.map((item) => clipSummaryText(item.line, 110));
    while (points.length > 0 && parts.join('\n').length + points.join('；').length > SUMMARY_MAX_CHARS - 24) {
      points = points.slice(0, -1);
    }
    if (points.length > 0) parts.push(`要点：${points.join('；')}`);
  } else {
    // No explicit list structure: keep first, last and the two strongest
    // sentences so the summary still spans the whole reply.
    const sentences = splitSentences(cleaned).filter((sentence) => !BOILERPLATE_RE.test(sentence));
    const picked = [];
    const add = (sentence) => {
      const key = sentence.replace(/\s+/g, '').toLowerCase();
      if (sentence.length >= 6 && !picked.some((row) => row.key === key)) picked.push({ sentence, key });
    };
    if (sentences[0] !== undefined) add(sentences[0]);
    if (sentences.length > 1) add(sentences[sentences.length - 1]);
    for (const item of sentences.map((sentence, index) => ({ sentence, index, score: scoreLine(sentence) })).sort((left, right) => right.score - left.score)) {
      if (picked.length >= 4) break;
      add(item.sentence);
    }
    const body = picked
      .filter((item) => !lead.includes(item.sentence.slice(0, Math.min(8, item.sentence.length))))
      .map((item) => item.sentence)
      .join(' ');
    if (body.length > 0) parts[0] = clipSummaryText(`${lead} ${body}`, SUMMARY_MAX_CHARS - 1);
  }
  if (tail.length > 0 && !parts.join(' ').includes(tail.slice(0, Math.min(12, tail.length)))) parts.push(`结论：${tail}`);

  let output = parts.join('\n');
  if (output.length > SUMMARY_MAX_CHARS) output = clipSummaryText(output, SUMMARY_MAX_CHARS);
  if (output.length < 24) output = clipSummaryText(lines.slice(0, 2).join(' '), SUMMARY_MAX_CHARS);
  return { text: output, compressed: output.length < cleaned.length, originalLength: cleaned.length };
}

function isLowValueDialogue(raw, role) {
  const clean = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || ACK_RE.test(clean) || /^```[\s\S]*```$/.test(clean)) return true;
  if (role === 'assistant' ? clean.length < SUMMARY_MIN_ASSISTANT : clean.length < SUMMARY_MIN_USER) return true;
  return tokenize(clean).length < 3;
}

function dialoguePayload(message) {
  if (message === null || typeof message !== 'object') return undefined;
  const kind = message.source?.kind;
  let role;
  if (message.role === 'user' && kind === 'user') role = 'user';
  else if (message.role === 'assistant' && kind === 'model') {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (blocks.some((block) => block?.type === 'tool-call')) return undefined;
    role = 'assistant';
  } else return undefined;

  const raw = textBlocks(message);
  if (raw.length === 0 || isLowValueDialogue(raw, role)) return undefined;
  const summary = summarizeDialogue(raw, role);
  if (summary.text.length === 0) return undefined;
  return {
    role,
    text: `${role === 'assistant' ? '助手' : '用户'}：${summary.text}`,
    summary: summary.text,
    compressed: summary.compressed,
    originalLength: summary.originalLength,
  };
}

// A small, deterministic taxonomy keeps the pool browsable without an extra
// model call. Categories are derived from tags first, then local keywords.
const CATEGORY_META = {
  preference: { label: '偏好', color: '#e6a6ff' },
  project: { label: '项目', color: '#7cb8ff' },
  environment: { label: '环境', color: '#6fe0c0' },
  fact: { label: '事实', color: '#ffd479' },
  plan: { label: '计划', color: '#ff9f7a' },
  person: { label: '人物', color: '#ff9ec4' },
  conversation: { label: '对话', color: '#9aa7ff' },
  uncategorized: { label: '未分类', color: '#8a8f98' },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);
const CATEGORY_ALIASES = new Map();
for (const key of CATEGORY_ORDER) CATEGORY_ALIASES.set(key, key);
for (const alias of ['未分类', '其他', '其它', 'unknown', 'other', 'misc']) CATEGORY_ALIASES.set(alias, 'uncategorized');
for (const alias of ['偏好', '喜欢', '习惯', '风格', '主题', '界面', '审美']) CATEGORY_ALIASES.set(alias, 'preference');
for (const alias of ['项目', '插件', '代码', '开发', '仓库', '构建', '部署', '功能']) CATEGORY_ALIASES.set(alias, 'project');
for (const alias of ['环境', '系统', '版本', '配置', '安装', '路径', 'windows', 'powershell', 'node', 'python']) CATEGORY_ALIASES.set(alias, 'environment');
for (const alias of ['事实', '数据', '文件', '接口', '字段', '结构', 'json']) CATEGORY_ALIASES.set(alias, 'fact');
for (const alias of ['计划', '待办', '目标', '安排', '明天', '下周', 'todo', 'plan']) CATEGORY_ALIASES.set(alias, 'plan');
for (const alias of ['人物', '用户', '同事', '朋友', '联系人', '名字', 'person']) CATEGORY_ALIASES.set(alias, 'person');
for (const alias of ['对话', '聊天', 'conversation']) CATEGORY_ALIASES.set(alias, 'conversation');

const CATEGORY_KEYWORDS = {
  preference: ['偏好', '喜欢', '习惯', '风格', '主题', '简洁', '讨厌', '更愿意', 'prefer', 'favorite', 'theme', 'style', 'dark', 'light'],
  project: ['项目', '插件', '代码', '仓库', '构建', '开发', '实现', '部署', '功能', '重构', 'bug', 'repo', 'project', 'plugin', 'code', 'build', 'deploy', 'feature'],
  environment: ['环境', '系统', '版本', '路径', '目录', '安装', '配置', 'windows', 'powershell', 'node', 'python', 'edge', 'chrome', 'gpu', 'cpu', '内存', '磁盘'],
  fact: ['位于', '数据', '保存', '支持', '使用', '文件', '接口', '字段', '结构', '事实', 'version', 'api', 'json'],
  plan: ['计划', '明天', '下周', '待办', '目标', '准备', '打算', '接下来', 'todo', 'plan', 'goal', 'next'],
  person: ['我叫', '名字', '称呼', '同事', '朋友', '联系人', 'person', 'name'],
  conversation: ['聊天', '闲聊', '对话', '寒暄', '聊了', '随便问', 'conversation', 'chat'],
};

function normalizeCategory(value) {
  const key = trimText(value, 24).toLowerCase();
  if (key.length === 0) return undefined;
  return CATEGORY_ALIASES.get(key);
}

/**
 * Score every category instead of returning the first keyword hit. The record
 * keeps a primary label plus alternatives/confidence, so low-signal memories
 * can honestly fall into "未分类" rather than being forced into a bucket.
 */
function classifyMemory(text, tags, kind) {
  const scores = new Map(CATEGORY_ORDER.map((key) => [key, 0]));
  const tagCategories = new Set();
  for (const tag of tags) {
    const category = normalizeCategory(tag);
    if (category === undefined || category === 'uncategorized') continue;
    tagCategories.add(category);
    scores.set(category, (scores.get(category) ?? 0) + 2.4);
  }
  const lower = String(text ?? '').toLowerCase();
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const word of words) {
      if (!lower.includes(word)) continue;
      score += word.length >= 3 ? 1.15 : 0.85;
    }
    if (score > 0) scores.set(category, (scores.get(category) ?? 0) + Math.min(4.6, score));
  }
  const ranked = [...scores.entries()]
    .filter(([key]) => key !== 'uncategorized')
    .sort((left, right) => right[1] - left[1]);
  const top = ranked[0];
  const second = ranked[1];
  if (top === undefined || top[1] < 1.0) {
    const fallbackConfidence = kind === 'note' ? 0.22 : 0.28;
    return {
      category: 'uncategorized',
      categoryScores: { uncategorized: 1 },
      categoryConfidence: fallbackConfidence,
      categoryAlternatives: [],
      categorySource: 'fallback',
    };
  }
  const topScore = top[1];
  const secondScore = second?.[1] ?? 0;
  const normalized = {};
  for (const [key, score] of scores) {
    if (score <= 0) continue;
    normalized[key] = Math.round((score / topScore) * 100) / 100;
  }
  const confidence = Math.min(0.95, 0.45 + 0.5 * (topScore / (topScore + 1.4)));
  const alternatives = ranked
    .slice(1)
    .filter(([, score]) => score >= Math.max(0.9, topScore * 0.55))
    .slice(0, 2)
    .map(([key]) => key);
  return {
    category: top[0],
    categoryScores: normalized,
    categoryConfidence: Math.round(confidence * 100) / 100,
    categoryAlternatives: alternatives,
    categorySource: tagCategories.has(top[0]) ? 'tag' : 'keyword',
  };
}

function classifyCategory(text, tags, kind) {
  return classifyMemory(text, tags, kind).category;
}

function categoryQueryScores(text) {
  const lower = String(text ?? '').toLowerCase();
  const scores = new Map();
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const word of words) {
      if (lower.includes(word)) score += word.length >= 3 ? 1 : 0.6;
    }
    if (score > 0) scores.set(category, Math.min(3, score));
  }
  return scores;
}

function languageOf(text) {
  const value = String(text ?? '');
  const cjk = (value.match(CJK_RUN) ?? []).join('').length;
  const latin = (value.match(/[a-z]/gi) ?? []).length;
  if (cjk === 0 && latin === 0) return 'unknown';
  if (cjk > 0 && latin > cjk * 1.5) return 'mixed';
  return cjk > 0 ? 'zh' : 'en';
}

function extractEntities(text, tags) {
  const seen = new Set();
  const entities = [];
  const add = (value) => {
    const normalized = trimText(value, 32).toLowerCase();
    if (normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    entities.push(normalized);
  };
  for (const tag of tags) add(tag);
  const value = String(text ?? '');
  for (const word of value.match(/[A-Za-z][A-Za-z0-9_\-.]{2,}/g) ?? []) add(word);
  // CJK terms are approximated by the highest-value bigrams/trigrams. This is
  // deliberately local and deterministic; it gives the ranker stable anchors
  // without a model call.
  for (const run of value.match(CJK_RUN) ?? []) {
    if (run.length <= 3) {
      add(run);
      continue;
    }
    for (const size of [4, 3]) {
      for (let index = 0; index + size <= run.length && entities.length < 18; index += size) {
        add(run.slice(index, index + size));
      }
    }
    if (entities.length < 18) add(run.slice(0, 4));
  }
  return entities.slice(0, 14);
}

function topicOf(text, tags, category) {
  if (tags.length > 0) return tags[0];
  const tokens = tokenize(strippedRoleText(text));
  if (tokens.length > 0) return tokens[0];
  return CATEGORY_META[category]?.label ?? category;
}

function queryTypeOf(text) {
  if (/(谁|名字|账号|所有者|作者|联系人|负责人|owner|who|whose)/i.test(String(text ?? ''))) return 'person';
  return classifyCategory(text, autoTags(text), 'dialogue');
}

function normalizeQuery(text) {
  return String(text ?? '')
    .replace(QUERY_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 2) return 99;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
    }
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column];
  }
  return previous[right.length];
}


function createMemory({ text, tags, kind = 'note', importance = 0.7, source = {}, hash, category, categoryConfidence, categoryScores, categoryAlternatives, categorySource, compressed = false, originalLength, role, episodeKey }) {
  const now = new Date().toISOString();
  const normalizedTags = normalizeTags(tags);
  const cleanText = trimText(text, kind === 'note' ? NOTE_MAX_CHARS : CAPTURE_MAX_CHARS);
  const explicitCategory = normalizeCategory(category);
  const classified = explicitCategory === undefined
    ? classifyMemory(cleanText, normalizedTags, kind)
    : {
      category: explicitCategory,
      categoryScores: { [explicitCategory]: 1 },
      categoryConfidence: 1,
      categoryAlternatives: [],
      categorySource: 'user',
    };
  const normalizedCategory = classified.category;
  return {
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    text: cleanText,
    tags: normalizedTags,
    kind,
    role: role === 'user' || role === 'assistant' || role === 'episode' ? role : undefined,
    episodeKey: typeof episodeKey === 'string' ? episodeKey : undefined,
    hasReply: false,
    category: normalizedCategory,
    categoryConfidence: Number.isFinite(categoryConfidence) ? Math.max(0, Math.min(1, categoryConfidence)) : classified.categoryConfidence,
    categoryScores: categoryScores && typeof categoryScores === 'object' ? categoryScores : classified.categoryScores,
    categoryAlternatives: Array.isArray(categoryAlternatives)
      ? categoryAlternatives.map(normalizeCategory).filter((key) => key !== undefined && key !== normalizedCategory).slice(0, 2)
      : classified.categoryAlternatives,
    categorySource: typeof categorySource === 'string' ? categorySource : classified.categorySource,
    topic: topicOf(cleanText, normalizedTags, normalizedCategory),
    project: projectName(source.cwd),
    entities: extractEntities(cleanText, normalizedTags),
    language: languageOf(cleanText),
    importance: Math.max(0, Math.min(1, Number(importance) || 0)),
    hash: hash ?? hashText(text),
    compressed: compressed === true,
    originalLength: Number.isFinite(originalLength) ? Math.max(cleanText.length, originalLength) : cleanText.length,
    createdAt: now,
    updatedAt: now,
    source: {
      sessionId: source.sessionId,
      cwd: source.cwd,
    },
    hits: 0,
    lastHitAt: null,
    lastRecalledQuery: null,
    feedbackUseful: 0,
    feedbackUseless: 0,
    lastFeedbackAt: null,
    mergedCount: 0,
    pinned: false,
    blocked: false,
  };
}

function strippedRoleText(text) {
  return String(text ?? '').replace(/^(用户|助手)[：:]\s*/, '');
}

function textSimilarity(left, right) {
  const leftTokens = new Set(tokenize(strippedRoleText(left)));
  const rightTokens = new Set(tokenize(strippedRoleText(right)));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / (leftTokens.size + rightTokens.size - shared);
}

function feedbackRatio(memory) {
  const useful = memory.feedbackUseful ?? 0;
  const useless = memory.feedbackUseless ?? 0;
  return (useful + 1) / (useful + useless + 2);
}

function isSuppressed(memory) {
  return (memory.feedbackUseless ?? 0) >= 3 && (memory.feedbackUseful ?? 0) === 0;
}

class MemoryLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryLockedError';
    this.status = 503;
    this.code = 'locked';
  }
}

class MemoryReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryReadOnlyError';
    this.status = 423;
    this.code = 'read-only';
  }
}

class MemoryPersistError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MemoryPersistError';
    this.status = 500;
    this.code = 'persist-failed';
  }
}

class MemoryStore {
  constructor(file, keyFile, configFile) {
    this.file = file;
    this.keyFile = keyFile;
    this.configFile = configFile;
    this.journalFile = `${file}.journal.jsonl`;
    this.backupDir = join(dirname(file), 'backups');
    this.lockFile = `${file}.lock`;
    this.lockInstance = null;
    this.lockOwner = null;
    this.lockError = null;
    this.readOnly = false;
    this.lastBackupAt = 0;
    this.key = null;
    this.locked = false;
    this.loadError = null;
    this.memories = [];
    this.byId = new Map();
    this.byHash = new Map();
    this.postings = new Map();
    this.vectors = new Map();
    this.semanticVectors = new Map();
    this.docLengths = new Map();
    this.totalLength = 0;
    this.writeChain = Promise.resolve();
    this.persistTimer = null;
    this.lastPersistAt = null;
    this.lastPersistError = null;
    this.persistFailures = 0;
    this.retryTimer = null;
    this.retryDelayMs = 5000;
    this.version = 0;
    this.ready = false;
    this.config = { ...DEFAULT_CONFIG };
    this.recallLog = [];
    this.calibration = {};
    this.revision = 0;
    this.generation = randomUUID();
    this.compactionId = null;
    this.journalEntries = 0;
    this.journalBytes = 0;
    this.pending = {
      clear: false,
      puts: new Set(),
      deletes: new Set(),
      recalls: [],
      calibration: false,
    };
  }

  queuePut(id) {
    if (typeof id !== 'string' || id.length === 0) return;
    this.pending.puts.add(id);
    this.pending.deletes.delete(id);
  }

  queueDelete(id) {
    if (typeof id !== 'string' || id.length === 0) return;
    this.pending.deletes.add(id);
    this.pending.puts.delete(id);
  }

  queueRecall(entry) {
    this.pending.recalls.push(entry);
  }

  async loadConfig() {
    try {
      const raw = await readFile(this.configFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        this.config = { ...DEFAULT_CONFIG, ...parsed, version: 1 };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A broken config must never lock memory data; fall back to defaults.
        this.config = { ...DEFAULT_CONFIG };
      }
    }
    this.config.recallMode = this.config.recallMode === 'hybrid' ? 'hybrid' : 'legacy';
  }

  async updateConfig(patch = {}) {
    this.assertWritable();
    const next = { ...this.config };
    if (patch.recallMode !== undefined) next.recallMode = patch.recallMode === 'hybrid' ? 'hybrid' : 'legacy';
    if (patch.capture !== undefined) next.capture = patch.capture !== false;
    if (patch.queryExpansion !== undefined) next.queryExpansion = patch.queryExpansion !== false;
    if (patch.semantic !== undefined) next.semantic = patch.semantic === true;
    for (const key of ['maxItems', 'minScore', 'minCoverage', 'margin', 'diversity']) {
      if (patch[key] === undefined) continue;
      const value = Number(patch[key]);
      if (!Number.isFinite(value)) continue;
      if (key === 'maxItems') next[key] = Math.max(1, Math.min(5, Math.round(value)));
      else next[key] = Math.max(0, Math.min(1, value));
    }
    this.config = next;
    await mkdir(dirname(this.configFile), { recursive: true });
    const temporary = `${this.configFile}.${process.pid}.${Date.now()}.tmp`;
    await durableWrite(temporary, JSON.stringify(this.config, null, 2));
    await rename(temporary, this.configFile);
    await syncDirectory(dirname(this.configFile));
    return this.config;
  }

  get writable() {
    return !this.locked && !this.readOnly;
  }

  assertWritable() {
    if (this.locked) throw new MemoryLockedError(this.loadError?.message ?? 'memory store is locked');
    if (this.readOnly) {
      const owner = this.lockOwner?.pid === undefined ? 'another process' : `pid ${this.lockOwner.pid}`;
      throw new MemoryReadOnlyError(`memory store is read-only: another writer (${owner}) owns the lock`);
    }
  }

  assertReadable() {
    if (this.locked) throw new MemoryLockedError(this.loadError?.message ?? 'memory store is locked');
  }

  lockIsStale(owner) {
    if (owner === null || typeof owner !== 'object') return true;
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    // A live process always owns its lock. Age alone is never evidence that
    // the writer is gone: DSH can run for days, and another instance must not
    // steal a lock just because it was created a long time ago.
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      // EPERM means the process exists but we cannot signal it; treat it as
      // alive. Only ESRCH (no such process) proves the owner is gone.
      return error?.code === 'ESRCH';
    }
  }

  async acquireLock() {
    await mkdir(dirname(this.file), { recursive: true });
    const instance = randomUUID();
    const record = { pid: process.pid, instance, createdAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeFile(this.lockFile, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        this.lockInstance = instance;
        this.lockOwner = record;
        this.readOnly = false;
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          this.lockError = error;
          this.readOnly = true;
          return false;
        }
        let owner = null;
        try {
          owner = JSON.parse(await readFile(this.lockFile, 'utf8'));
        } catch {
          owner = null;
        }
        if (this.lockIsStale(owner)) {
          try {
            await unlink(this.lockFile);
          } catch {
            // Another process may have removed or replaced it; retry.
          }
          continue;
        }
        this.lockOwner = owner;
        this.lockError = new MemoryReadOnlyError(`memory store is owned by pid ${owner?.pid ?? 'unknown'}`);
        this.readOnly = true;
        return false;
      }
    }
    this.lockError = new MemoryReadOnlyError('could not acquire the memory writer lock');
    this.readOnly = true;
    return false;
  }

  async ownsLock() {
    if (!this.writable) return false;
    try {
      const owner = JSON.parse(await readFile(this.lockFile, 'utf8'));
      return owner?.instance === this.lockInstance && Number(owner?.pid) === process.pid;
    } catch {
      return false;
    }
  }

  async releaseLock() {
    if (this.lockInstance === null) return;
    try {
      const owner = JSON.parse(await readFile(this.lockFile, 'utf8'));
      if (owner?.instance === this.lockInstance && Number(owner?.pid) === process.pid) await unlink(this.lockFile);
    } catch {
      // Missing/replaced lock: nothing to release.
    }
    this.lockInstance = null;
  }

  async readKey({ create = false } = {}) {
    if (this.key !== null) return this.key;
    try {
      const key = await readFile(this.keyFile);
      if (key.length !== KEY_BYTES) throw new MemoryLockedError(`invalid memory key at ${this.keyFile}`);
      this.key = key;
      return key;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new MemoryLockedError(`cannot read memory key at ${this.keyFile}: ${error?.message ?? error}`);
      }
      if (!create) throw new MemoryLockedError(`memory key is missing: ${this.keyFile}`);
      const key = randomBytes(KEY_BYTES);
      try {
        await mkdir(join(this.keyFile, '..'), { recursive: true });
        await durableCreate(this.keyFile, key);
        await syncDirectory(dirname(this.keyFile));
        this.key = key;
        return key;
      } catch (writeError) {
        if (writeError?.code === 'EEXIST') return this.readKey({ create: false });
        throw new MemoryLockedError(`cannot create memory key at ${this.keyFile}: ${writeError?.message ?? writeError}`);
      }
    }
  }

  async ensureKey() {
    return this.readKey({ create: true });
  }

  async decryptEnvelope(envelope) {
    const key = await this.readKey({ create: false });
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const data = Buffer.from(envelope.data, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || data.length === 0) throw new Error('encrypted memory envelope is malformed');
    const decipher = createDecipheriv(STORE_CIPHER, key, iv);
    decipher.setAAD(STORE_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  encryptPayload(payload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(STORE_CIPHER, this.key, iv);
    cipher.setAAD(STORE_AAD);
    const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return {
      format: STORE_FORMAT,
      version: STORE_VERSION,
      encrypted: true,
      alg: STORE_CIPHER,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
  }

  backupStamp() {
    const now = new Date();
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  }

  async backupPayload(payload, reason = 'manual') {
    const cleanReason = String(reason).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'manual';
    await this.ensureKey();
    await mkdir(this.backupDir, { recursive: true });
    const name = `backup-${this.backupStamp()}-${cleanReason}.json`;
    const target = join(this.backupDir, name);
    const temporary = `${target}.${process.pid}.tmp`;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await durableWrite(temporary, JSON.stringify(this.encryptPayload(body)));
    await rename(temporary, target);
    await syncDirectory(this.backupDir);
    this.lastBackupAt = Date.now();
    await this.pruneBackups();
    return name;
  }

  async readDiskPayload() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.format === STORE_FORMAT && parsed.encrypted === true) return await this.decryptEnvelope(parsed);
      return raw;
    } catch {
      return undefined;
    }
  }

  currentPayload() {
    return {
      version: STORE_VERSION,
      storage: 'jsonl',
      revision: this.revision,
      generation: this.generation,
      compactionId: this.compactionId ?? undefined,
      updatedAt: new Date().toISOString(),
      memories: this.memories.map((memory) => ({ ...memory })),
      recallLog: this.recallLog.slice(-RECALL_LOG_MAX),
      calibration: this.calibration,
    };
  }

  async writeSnapshot() {
    this.compactionId = randomUUID();
    const envelope = this.encryptPayload(JSON.stringify(this.currentPayload()));
    await mkdir(join(this.file, '..'), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await durableWrite(temporary, JSON.stringify(envelope));
    await rename(temporary, this.file);
    await syncDirectory(dirname(this.file));
  }

  takeEvents() {
    const events = [];
    if (this.pending.clear) events.push({ op: 'clear' });
    for (const id of this.pending.puts) {
      const memory = this.byId.get(id);
      if (memory !== undefined) events.push({ op: 'put', memory: { ...memory } });
    }
    for (const id of this.pending.deletes) {
      if (!this.pending.puts.has(id)) events.push({ op: 'delete', id });
    }
    if (this.pending.recalls.length > 0) {
      events.push({ op: 'recall', entries: this.pending.recalls.splice(0) });
    }
    if (this.pending.calibration) events.push({ op: 'calibration', value: { ...this.calibration } });
    this.pending.clear = false;
    this.pending.puts.clear();
    this.pending.deletes.clear();
    this.pending.calibration = false;
    for (const event of events) {
      this.revision += 1;
      event.revision = this.revision;
      event.generation = this.generation;
    }
    return events;
  }

  applyJournalEvent(event) {
    if (event === null || typeof event !== 'object') return;
    if (event.op === 'clear') {
      this.memories = [];
      this.byId.clear();
      this.byHash.clear();
      this.recallLog = [];
      this.calibration = {};
      return;
    }
    if (event.op === 'delete') {
      const existing = this.byId.get(event.id);
      if (existing !== undefined) this.dropMemory(existing);
      return;
    }
    if (event.op === 'put' && event.memory !== null && typeof event.memory === 'object') {
      const existing = this.byId.get(event.memory.id);
      if (existing !== undefined) this.dropMemory(existing);
      const hash = typeof event.memory.hash === 'string' ? event.memory.hash : hashText(event.memory.text ?? '');
      const sameHash = this.byHash.get(hash);
      if (sameHash !== undefined && sameHash.id !== event.memory.id) this.dropMemory(sameHash);
      this.adopt(event.memory);
      return;
    }
    if (event.op === 'recall' && Array.isArray(event.entries)) {
      this.recallLog.push(...event.entries);
      if (this.recallLog.length > RECALL_LOG_MAX) this.recallLog.splice(0, this.recallLog.length - RECALL_LOG_MAX);
      return;
    }
    if (event.op === 'calibration' && event.value !== null && typeof event.value === 'object') {
      this.calibration = event.value;
    }
  }

  async replayJournal(baseRevision, baseGeneration = null) {
    let raw;
    try {
      raw = await readFile(this.journalFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      this.loadError = error;
      this.locked = true;
      return;
    }
    const lines = raw.split('\n');
    let lastNonEmpty = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim().length > 0) lastNonEmpty = index;
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.length === 0) continue;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (error) {
        if (index === lastNonEmpty) {
          // A crash can leave a torn final append; it was never acknowledged.
          this.journalEntries += 1;
          continue;
        }
        this.loadError = new MemoryLockedError(`memory journal is corrupt at line ${index + 1}: ${error?.message ?? error}`);
        this.locked = true;
        return;
      }
      let event;
      try {
        event = JSON.parse(await this.decryptEnvelope(envelope));
      } catch (error) {
        this.loadError = new MemoryLockedError(`memory journal could not be decrypted at line ${index + 1}: ${error?.message ?? error}`);
        this.locked = true;
        return;
      }
      this.journalEntries += 1;
      this.journalBytes += Buffer.byteLength(line);
      if (baseGeneration !== null && typeof event.generation === 'string' && event.generation !== baseGeneration) continue;
      if (Number(event.revision) <= baseRevision) continue;
      this.applyJournalEvent(event);
      if (Number(event.revision) > this.revision) this.revision = Number(event.revision);
    }
  }

  async compact() {
    if (!this.writable) return;
    if (!(await this.ownsLock())) {
      this.readOnly = true;
      this.lockError = new MemoryReadOnlyError('memory writer lock was lost; refusing to compact the store');
      return;
    }
    await this.writeSnapshot();
    await durableWrite(this.journalFile, '');
    await syncDirectory(dirname(this.journalFile));
    this.journalEntries = 0;
    this.journalBytes = 0;
  }


  async backupNow(reason = 'manual') {
    this.assertWritable();
    return this.backupPayload(this.currentPayload(), reason);
  }

  async maybeAutoBackup() {
    if (!this.writable) return;
    if (this.lastBackupAt > 0 && Date.now() - this.lastBackupAt < BACKUP_INTERVAL_MS) return;
    const backups = await this.listBackups();
    if (backups.length > 0) this.lastBackupAt = backups[0].createdAt;
    if (backups.length > 0 && Date.now() - backups[0].createdAt < BACKUP_INTERVAL_MS) return;
    try {
      await this.backupNow('auto');
    } catch {
      // A failed snapshot must not block normal memory operations.
    }
  }

  async pruneBackups() {
    const names = (await readdir(this.backupDir).catch(() => []))
      .filter((name) => BACKUP_NAME_RE.test(name))
      .sort()
      .reverse();
    for (const name of names.slice(BACKUP_KEEP)) {
      await unlink(join(this.backupDir, name)).catch(() => {});
    }
  }

  async listBackups() {
    const names = (await readdir(this.backupDir).catch(() => []))
      .filter((name) => BACKUP_NAME_RE.test(name))
      .sort()
      .reverse();
    const items = [];
    for (const name of names) {
      try {
        const info = await stat(join(this.backupDir, name));
        items.push({
          name,
          reason: BACKUP_NAME_RE.exec(name)?.[1] ?? 'manual',
          size: info.size,
          createdAt: info.mtimeMs,
        });
      } catch {
        // A backup removed concurrently is simply omitted.
      }
    }
    return items;
  }

  backupPath(name) {
    const safe = basename(String(name ?? ''));
    if (safe !== name || !BACKUP_NAME_RE.test(safe)) {
      throw Object.assign(new Error('invalid backup name'), { status: 400, code: 'bad-request' });
    }
    return join(this.backupDir, safe);
  }

  async readBackup(name) {
    const safe = basename(String(name ?? ''));
    if (safe !== name || !BACKUP_NAME_RE.test(safe)) {
      throw Object.assign(new Error('invalid backup name'), { status: 400, code: 'bad-request' });
    }
    const file = join(this.backupDir, safe);
    const info = await stat(file);
    if (info.size > BACKUP_IMPORT_MAX) {
      throw Object.assign(new Error('backup is too large'), { status: 413, code: 'too-large' });
    }
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const encrypted = parsed?.format === STORE_FORMAT && parsed.encrypted === true;
    const payloadText = encrypted ? await this.decryptEnvelope(parsed) : raw;
    const payload = JSON.parse(payloadText);
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.memories) ? payload.memories : [];
    return {
      name: safe,
      raw,
      encrypted,
      payload,
      rows,
      count: rows.length,
      revision: Number(payload?.revision) || 0,
      generation: typeof payload?.generation === 'string' ? payload.generation : null,
      size: info.size,
      createdAt: info.mtimeMs,
    };
  }

  async verifyBackup(name) {
    this.assertReadable();
    const backup = await this.readBackup(name);
    return {
      ok: true,
      name: backup.name,
      encrypted: backup.encrypted,
      count: backup.count,
      revision: backup.revision,
      size: backup.size,
      createdAt: backup.createdAt,
    };
  }

  async exportBackup(name) {
    this.assertReadable();
    const backup = await this.readBackup(name);
    return {
      name: backup.name,
      size: backup.size,
      data: Buffer.from(backup.raw, 'utf8').toString('base64'),
    };
  }

  async importBackup(data) {
    this.assertWritable();
    if (typeof data !== 'string' || data.length === 0) {
      throw Object.assign(new Error('backup data is required'), { status: 400, code: 'bad-request' });
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0 || buffer.length > BACKUP_IMPORT_MAX) {
      throw Object.assign(new Error('backup is empty or too large'), { status: 413, code: 'too-large' });
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw Object.assign(new Error('backup is not valid JSON'), { status: 400, code: 'bad-request' });
    }
    const encrypted = parsed?.format === STORE_FORMAT && parsed.encrypted === true;
    const payloadText = encrypted ? await this.decryptEnvelope(parsed) : buffer.toString('utf8');
    const payload = JSON.parse(payloadText);
    if (!Array.isArray(payload) && !Array.isArray(payload?.memories)) {
      throw Object.assign(new Error('backup payload has no memories'), { status: 400, code: 'bad-request' });
    }
    return this.backupPayload(payloadText, 'imported');
  }

  async restoreBackup(name) {
    this.assertWritable();
    const backup = await this.readBackup(name);
    const payload = backup.payload;
    const rows = backup.rows;
    await this.backupNow('pre-restore');
    this.memories = [];
    this.byId.clear();
    this.byHash.clear();
    this.recallLog = Array.isArray(payload?.recallLog) ? payload.recallLog.slice(-RECALL_LOG_MAX) : [];
    this.calibration = payload?.calibration !== null && typeof payload?.calibration === 'object' ? payload.calibration : {};
    this.revision = Number(payload?.revision) || 0;
    this.generation = backup.generation ?? randomUUID();
    this.pending.clear = false;
    this.pending.puts.clear();
    this.pending.deletes.clear();
    this.pending.recalls = [];
    this.pending.calibration = false;
    for (const row of rows) this.adopt(row);
    this.rebuildIndex();
    await this.compact();
    return this.stats();
  }

  async open() {
    await this.loadConfig();
    await this.acquireLock();
    await this.load();
    await this.maybeAutoBackup();
    return this;
  }

  async load() {
    let raw;
    let encrypted = false;
    let baseRevision = 0;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.loadError = error;
        this.locked = true;
        return;
      }
      if (!this.writable) {
        this.ready = true;
        this.rebuildIndex();
        return;
      }
      try {
        await this.ensureKey();
      } catch (keyError) {
        this.loadError = keyError;
        this.locked = true;
        return;
      }
      // A crash may have happened before the first snapshot was written but
      // after journal events were appended. Replay the journal before deciding
      // the store is empty.
      await this.replayJournal(0);
      this.ready = true;
      this.rebuildIndex();
      if (!this.locked && this.writable && this.journalEntries > 0) await this.compact();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      encrypted = parsed?.format === STORE_FORMAT && parsed.encrypted === true;
      const payload = encrypted ? JSON.parse(await this.decryptEnvelope(parsed)) : parsed;
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.memories) ? payload.memories : [];
      baseRevision = Number(payload?.revision) || 0;
      this.revision = baseRevision;
      if (typeof payload?.generation === 'string' && payload.generation.length > 0) this.generation = payload.generation;
      if (typeof payload?.compactionId === 'string') this.compactionId = payload.compactionId;
      if (Array.isArray(payload?.recallLog)) this.recallLog = payload.recallLog.slice(-RECALL_LOG_MAX);
      if (payload?.calibration !== null && typeof payload?.calibration === 'object') this.calibration = payload.calibration;
      for (const row of rows) this.adopt(row);
      if (!encrypted) {
        // A legacy plaintext store is readable once, then immediately rewritten
        // as an encrypted envelope. Keep an encrypted snapshot first so the
        // migration never destroys the only copy.
        await this.ensureKey();
        if (this.writable) {
          const snapshot = Array.isArray(payload) ? { version: 1, memories: payload } : payload;
          await this.backupPayload(JSON.stringify(snapshot), 'pre-migration').catch(() => {});
        }
      }
    } catch (error) {
      if (error instanceof MemoryLockedError || encrypted || String(error?.message ?? '').includes('unable to authenticate')) {
        this.loadError = error instanceof MemoryLockedError
          ? error
          : new MemoryLockedError(`memory store could not be decrypted with the local key: ${error?.message ?? error}`);
        this.locked = true;
        this.ready = true;
        return;
      }
      // A corrupt plaintext store must not take the whole plugin down.
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // ignore
      }
      try {
        await this.ensureKey();
      } catch (keyError) {
        this.loadError = keyError;
        this.locked = true;
      }
    }
    if (!this.locked) await this.replayJournal(baseRevision, this.generation);
    this.ready = true;
    this.rebuildIndex();
    if (!encrypted && !this.locked && this.writable) await this.compact();
  }

  adopt(row) {
    if (row === null || typeof row !== 'object') return;
    const text = trimText(row.text, NOTE_MAX_CHARS);
    if (text.length === 0) return;
    const kind = row.kind === 'episode' ? 'episode' : row.kind === 'dialogue' ? 'dialogue' : 'note';
    const tags = normalizeTags(row.tags);
    const classified = classifyMemory(text, tags, kind);
    const explicitCategory = normalizeCategory(row.category);
    const category = explicitCategory ?? classified.category;
    const categoryConfidence = Number.isFinite(row.categoryConfidence)
      ? Math.max(0, Math.min(1, row.categoryConfidence))
      : explicitCategory === classified.category
        ? classified.categoryConfidence
        : 0.6;
    const categoryScores = row.categoryScores !== null && typeof row.categoryScores === 'object'
      ? Object.fromEntries(Object.entries(row.categoryScores)
        .map(([key, value]) => [normalizeCategory(key), Number(value)])
        .filter(([key, value]) => key !== undefined && Number.isFinite(value)))
      : classified.categoryScores;
    const categoryAlternatives = Array.isArray(row.categoryAlternatives)
      ? row.categoryAlternatives.map(normalizeCategory).filter((key) => key !== undefined && key !== category).slice(0, 2)
      : classified.categoryAlternatives.filter((key) => key !== category);
    const memory = {
      id: typeof row.id === 'string' && row.id.length > 0 ? row.id : randomUUID().replace(/-/g, '').slice(0, 8),
      text,
      tags,
      kind,
      role: row.role === 'user' || row.role === 'assistant' || row.role === 'episode' ? row.role : undefined,
      episodeKey: typeof row.episodeKey === 'string' ? row.episodeKey : undefined,
      hasReply: row.hasReply === true,
      category,
      categoryConfidence,
      categoryScores,
      categoryAlternatives,
      categorySource: typeof row.categorySource === 'string' ? row.categorySource : 'legacy',
      topic: typeof row.topic === 'string' && row.topic.length > 0 ? trimText(row.topic, 32) : topicOf(text, tags, category),
      project: projectName(row.project) ?? projectName(row.source?.cwd),
      entities: Array.isArray(row.entities) ? row.entities.map((value) => trimText(value, 32)).filter(Boolean).slice(0, 14) : extractEntities(text, tags),
      language: row.language === 'zh' || row.language === 'en' || row.language === 'mixed' || row.language === 'unknown' ? row.language : languageOf(text),
      importance: Math.max(0, Math.min(1, Number(row.importance) || 0.6)),
      compressed: row.compressed === true,
      originalLength: Number.isFinite(row.originalLength) ? Math.max(text.length, row.originalLength) : text.length,
      hash: typeof row.hash === 'string' && row.hash.length > 0 ? row.hash : hashText(text),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
      source: {
        sessionId: typeof row.source?.sessionId === 'string' ? row.source.sessionId : undefined,
        cwd: typeof row.source?.cwd === 'string' ? row.source.cwd : undefined,
      },
      hits: Number.isFinite(row.hits) ? Math.max(0, row.hits) : 0,
      lastHitAt: typeof row.lastHitAt === 'string' ? row.lastHitAt : null,
      lastRecalledQuery: typeof row.lastRecalledQuery === 'string' ? row.lastRecalledQuery : null,
      feedbackUseful: Number.isFinite(row.feedbackUseful) ? Math.max(0, row.feedbackUseful) : 0,
      feedbackUseless: Number.isFinite(row.feedbackUseless) ? Math.max(0, row.feedbackUseless) : 0,
      lastFeedbackAt: typeof row.lastFeedbackAt === 'string' ? row.lastFeedbackAt : null,
      mergedCount: Number.isFinite(row.mergedCount) ? Math.max(0, row.mergedCount) : 0,
      pinned: row.pinned === true,
      blocked: row.blocked === true,
    };
    if (this.byId.has(memory.id) || this.byHash.has(memory.hash)) return;
    this.memories.push(memory);
    this.byId.set(memory.id, memory);
    this.byHash.set(memory.hash, memory);
  }

  rebuildIndex() {
    this.postings.clear();
    this.vectors.clear();
    this.semanticVectors.clear();
    this.docLengths.clear();
    this.totalLength = 0;
    for (const memory of this.memories) this.indexMemory(memory);
    this.bump();
  }

  indexMemory(memory) {
    const searchable = `${memory.text} ${memory.tags.join(' ')} ${memory.topic ?? ''} ${(memory.entities ?? []).join(' ')}`;
    const tokens = tokenize(searchable);
    this.vectors.set(memory.id, featureVector(searchable));
    this.semanticVectors.set(memory.id, semanticFeatureVector(searchable, memory.category));
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) {
      let bucket = this.postings.get(token);
      if (bucket === undefined) {
        bucket = new Map();
        this.postings.set(token, bucket);
      }
      bucket.set(memory.id, count);
    }
    const length = Math.max(1, tokens.length);
    this.docLengths.set(memory.id, length);
    this.totalLength += length;
  }

  unindexMemory(memory) {
    const length = this.docLengths.get(memory.id) ?? 0;
    this.totalLength = Math.max(0, this.totalLength - length);
    this.docLengths.delete(memory.id);
    this.vectors.delete(memory.id);
    this.semanticVectors.delete(memory.id);
    for (const bucket of this.postings.values()) bucket.delete(memory.id);
  }

  dropMemory(memory) {
    this.byId.delete(memory.id);
    this.byHash.delete(memory.hash);
    this.memories = this.memories.filter((row) => row.id !== memory.id);
    this.unindexMemory(memory);
  }

  bump() {
    if (!this.writable) return;
    this.version += 1;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 300);
    this.persistTimer.unref?.();
  }

  schedulePersistRetry() {
    if (!this.writable || this.retryTimer !== null) return;
    const delay = Math.min(60000, this.retryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelayMs = Math.min(60000, this.retryDelayMs * 2);
      if (this.writable) void this.flush();
    }, delay);
    this.retryTimer.unref?.();
  }

  async flush({ throwOnError = false } = {}) {
    if (!this.writable) {
      if (throwOnError) this.assertWritable();
      return false;
    }
    try {
      await this.ensureKey();
    } catch (error) {
      this.lastPersistError = error;
      this.persistFailures += 1;
      if (throwOnError) throw new MemoryPersistError('failed to prepare the memory encryption key', error);
      return false;
    }
    this.writeChain = this.writeChain.then(async () => {
      if (!this.writable) return false;
      if (!(await this.ownsLock())) {
        this.readOnly = true;
        this.lockError = new MemoryReadOnlyError('memory writer lock was lost; refusing to overwrite the store');
        this.lastPersistError = this.lockError;
        this.persistFailures += 1;
        return false;
      }
      const events = this.takeEvents();
      if (events.length === 0) return true;
      try {
        await this.maybeAutoBackup();
        await mkdir(join(this.file, '..'), { recursive: true });
        const lines = events.map((event) => JSON.stringify(this.encryptPayload(JSON.stringify(event)))).join('\n') + '\n';
        await durableAppend(this.journalFile, lines);
        this.journalEntries += events.length;
        this.journalBytes += Buffer.byteLength(lines);
        if (this.journalEntries >= JOURNAL_COMPACT_EVENTS || this.journalBytes >= JOURNAL_COMPACT_BYTES) {
          await this.compact();
        }
        this.lastPersistAt = new Date().toISOString();
        this.lastPersistError = null;
        this.retryDelayMs = 5000;
        return true;
      } catch (error) {
        // Re-queue events so a transient disk failure retries on the next bump.
        for (const event of events) {
          if (event.op === 'clear') this.pending.clear = true;
          else if (event.op === 'put') this.pending.puts.add(event.memory.id);
          else if (event.op === 'delete') this.pending.deletes.add(event.id);
          else if (event.op === 'recall') this.pending.recalls.push(...event.entries);
          else if (event.op === 'calibration') this.pending.calibration = true;
        }
        this.lastPersistError = error;
        this.persistFailures += 1;
        this.lockError = error;
        this.schedulePersistRetry();
        return false;
      }
    }).catch((error) => {
      this.lastPersistError = error;
      this.persistFailures += 1;
      this.schedulePersistRetry();
      return false;
    });
    const ok = await this.writeChain;
    if (!ok && throwOnError) {
      throw new MemoryPersistError(
        `failed to persist memory: ${this.lastPersistError?.message ?? 'unknown write error'}`,
        this.lastPersistError ?? undefined,
      );
    }
    return ok;
  }

  add({ text, tags, kind = 'note', importance, source, hash, compressed = false, originalLength, role, episodeKey, pinned, blocked }) {
    this.assertWritable();
    const clean = trimText(text, kind === 'note' ? NOTE_MAX_CHARS : CAPTURE_MAX_CHARS);
    if (clean.length === 0) return undefined;
    const contentHash = hash ?? hashText(clean);
    const existing = this.byHash.get(contentHash);
    if (existing !== undefined) {
      existing.updatedAt = new Date().toISOString();
      this.queuePut(existing.id);
      this.bump();
      return existing;
    }
    if (role === 'assistant') {
      const target = this.findOpenEpisode(source?.sessionId);
      if (target !== undefined) return this.mergeEpisode(target, clean, tags, compressed, originalLength);
    }
    const incoming = createMemory({ text: clean, tags: tags?.length ? tags : autoTags(clean), kind, importance: importance ?? (kind === 'note' ? 0.8 : role === 'assistant' ? 0.35 : 0.4), source, hash: contentHash, compressed, originalLength, role, episodeKey });
    incoming.pinned = pinned === true;
    incoming.blocked = blocked === true;
    if (role === 'assistant') incoming.hasReply = true;
    const duplicate = this.findNearDuplicate(incoming);
    if (duplicate !== undefined) {
      this.mergeInto(duplicate, incoming);
      return duplicate;
    }
    const memory = incoming;
    this.memories.push(memory);
    this.byId.set(memory.id, memory);
    this.byHash.set(memory.hash, memory);
    this.indexMemory(memory);
    this.evict();
    this.queuePut(memory.id);
    this.bump();
    return memory;
  }

  findOpenEpisode(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const now = Date.now();
    for (let index = this.memories.length - 1; index >= 0; index -= 1) {
      const memory = this.memories[index];
      if (memory.source.sessionId !== sessionId) continue;
      if (memory.role !== 'user' || memory.hasReply === true) continue;
      if (now - Date.parse(memory.updatedAt) > EPISODE_WINDOW_MS) continue;
      return memory;
    }
    return undefined;
  }

  mergeEpisode(target, assistantText, tags, compressed, originalLength) {
    this.unindexMemory(target);
    this.byHash.delete(target.hash);
    target.text = trimText(`${target.text}\n${assistantText}`, CAPTURE_MAX_CHARS);
    target.kind = 'episode';
    target.role = 'episode';
    target.hasReply = true;
    target.tags = normalizeTags([...target.tags, ...(tags ?? [])]);
    const classified = classifyMemory(target.text, target.tags, 'episode');
    target.category = classified.category;
    target.categoryConfidence = classified.categoryConfidence;
    target.categoryScores = classified.categoryScores;
    target.categoryAlternatives = classified.categoryAlternatives;
    target.categorySource = classified.categorySource;
    target.entities = extractEntities(target.text, target.tags);
    target.topic = topicOf(target.text, target.tags, target.category);
    target.language = languageOf(target.text);
    target.compressed = target.compressed || compressed === true;
    target.originalLength = Math.max(target.originalLength ?? 0, target.text.length) + Math.max(0, Number(originalLength) || 0);
    target.importance = Math.min(1, target.importance + 0.01);
    target.updatedAt = new Date().toISOString();
    target.hash = hashText(target.text);
    this.byHash.set(target.hash, target);
    this.indexMemory(target);
    this.queuePut(target.id);
    this.bump();
    return target;
  }

  findNearDuplicate(incoming) {
    if (incoming.text.length < 16) return undefined;
    const incomingRole = incoming.text.slice(0, 2);
    let best;
    let bestSimilarity = 0;
    for (const memory of this.memories) {
      if (memory.kind !== incoming.kind) continue;
      if (memory.category !== incoming.category) continue;
      if (memory.text.slice(0, 2) !== incomingRole) continue;
      if (memory.text.length < 16) continue;
      const similarity = textSimilarity(memory.text, incoming.text);
      if (similarity > bestSimilarity) {
        best = memory;
        bestSimilarity = similarity;
      }
    }
    return bestSimilarity >= 0.78 ? best : undefined;
  }

  mergeInto(target, incoming) {
    this.unindexMemory(target);
    this.byHash.delete(target.hash);
    if (incoming.text.length > target.text.length + 10) {
      target.text = incoming.text;
      target.hash = incoming.hash;
    }
    target.tags = normalizeTags([...target.tags, ...incoming.tags]);
    target.entities = extractEntities(target.text, target.tags);
    target.topic = topicOf(target.text, target.tags, target.category);
    target.language = languageOf(target.text);
    target.importance = Math.min(1, Math.max(target.importance, incoming.importance) + 0.01);
    target.compressed = target.compressed || incoming.compressed;
    target.originalLength = Math.max(target.originalLength ?? target.text.length, incoming.originalLength ?? incoming.text.length);
    target.mergedCount = (target.mergedCount ?? 0) + 1;
    target.updatedAt = new Date().toISOString();
    this.byHash.set(target.hash, target);
    this.indexMemory(target);
    this.queuePut(target.id);
    this.bump();
  }

  rate(id, verdict) {
    this.assertWritable();
    const raw = String(id ?? '').trim().replace(/^#/, '');
    if (raw.length === 0) throw Object.assign(new Error('memory feedback needs an id'), { status: 400, code: 'bad-request' });
    const memory = this.byId.get(raw) ?? [...this.byId.values()].find((row) => row.id.startsWith(raw));
    if (memory === undefined) throw Object.assign(new Error('memory not found'), { status: 404, code: 'not-found' });
    if (verdict !== 'useful' && verdict !== 'useless') {
      throw Object.assign(new Error('feedback verdict must be useful or useless'), { status: 400, code: 'bad-request' });
    }
    if (verdict === 'useful') {
      memory.feedbackUseful = (memory.feedbackUseful ?? 0) + 1;
      memory.importance = Math.min(1, memory.importance + 0.05);
    } else {
      memory.feedbackUseless = (memory.feedbackUseless ?? 0) + 1;
      memory.importance = Math.max(0.05, memory.importance - 0.08);
    }
    const queryType = memory.lastRecalledQuery ? queryTypeOf(memory.lastRecalledQuery) : memory.category;
    const bucket = this.calibration[queryType] ?? { useful: 0, useless: 0 };
    if (verdict === 'useful') bucket.useful += 1;
    else bucket.useless += 1;
    this.calibration[queryType] = bucket;
    this.pending.calibration = true;
    memory.lastFeedbackAt = new Date().toISOString();
    this.queuePut(memory.id);
    this.bump();
    return memory;
  }

  evict() {
    if (this.memories.length <= MAX_MEMORIES) return;
    const now = Date.now();
    const weight = (memory) => {
      const ageDays = Math.max(0, (now - Date.parse(memory.updatedAt)) / 86400000);
      const recency = Math.max(0, 1 - ageDays / 180);
      const noteBoost = memory.kind === 'note' ? 0.3 : 0;
      const pinBoost = memory.pinned ? 2 : 0;
      const feedback = (memory.feedbackUseful ?? 0) * 0.06 - (memory.feedbackUseless ?? 0) * 0.08;
      return pinBoost + memory.importance * 0.45 + recency * 0.25 + noteBoost + feedback + Math.min(0.08, (memory.mergedCount ?? 0) * 0.02);
    };
    const sorted = [...this.memories].sort((left, right) => weight(left) - weight(right));
    const remove = sorted.slice(0, this.memories.length - MAX_MEMORIES);
    for (const memory of remove) this.remove(memory.id, { persist: false });
    this.bump();
  }

  remove(id, { persist = true } = {}) {
    this.assertWritable();
    const memory = this.byId.get(id);
    if (memory === undefined) return false;
    this.dropMemory(memory);
    this.queueDelete(id);
    if (persist) this.bump();
    return true;
  }

  async clear() {
    this.assertWritable();
    await this.backupNow('pre-clear').catch(() => {});
    this.pending.clear = true;
    this.pending.puts.clear();
    this.pending.deletes.clear();
    this.pending.recalls = [];
    this.pending.calibration = false;
    this.memories = [];
    this.byId.clear();
    this.byHash.clear();
    this.recallLog = [];
    this.rebuildIndex();
    await this.flush({ throwOnError: true });
  }

  async close() {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      await this.flush();
    } finally {
      await this.releaseLock();
    }
  }

  buildQueryProfile(queryText, context = '') {
    const normalized = normalizeQuery(queryText);
    const rawTokens = [...new Set(tokenize(normalized))];
    const vocab = new Set();
    if (this.config.queryExpansion) {
      for (const token of this.postings.keys()) {
        if (/^[a-z][a-z0-9_\-.]{2,}$/.test(token)) vocab.add(token);
      }
    }
    const tokens = [];
    const corrections = [];
    for (const token of rawTokens) {
      const acronym = this.config.queryExpansion ? ACRONYMS.get(token) : undefined;
      if (acronym !== undefined) {
        corrections.push({ from: token, to: acronym, reason: 'acronym' });
        for (const part of tokenize(acronym)) tokens.push(part);
        continue;
      }
      if (this.config.queryExpansion && /^[a-z][a-z0-9_\-.]{4,}$/.test(token) && !this.postings.has(token)) {
        let best;
        let bestDistance = 3;
        for (const candidate of vocab) {
          if (Math.abs(candidate.length - token.length) > 2) continue;
          const distance = editDistance(token, candidate);
          if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
        if (best !== undefined && bestDistance <= (token.length >= 8 ? 2 : 1)) {
          corrections.push({ from: token, to: best, reason: 'typo' });
          tokens.push(best);
          continue;
        }
      }
      tokens.push(token);
    }
    let profileText = [normalized, ...corrections.map((item) => item.to)].filter(Boolean).join(' ');
    // Short prompts often omit the topic ("那怎么设置？"). Use the previous user
    // prompt only as a weak local hint; it never becomes a second recall target.
    if (tokens.length < 6 && normalized.length < 14 && String(context ?? '').trim().length > 0) {
      profileText = `${profileText} ${trimText(context, 140)}`.trim();
    }
    return {
      text: profileText,
      normalized,
      tokens: [...new Set(tokens)],
      corrections,
      language: languageOf(normalized),
      type: queryTypeOf(normalized),
    };
  }

  scoreLegacy(queryText) {
    const queryTokens = [...new Set(tokenize(queryText))].slice(0, 28);
    if (queryTokens.length === 0) return [];

    // Each original token is a concept. Exact matches weigh 1.0; synonyms are
    // a second chance at 0.55 so they can rescue a rephrasing without letting
    // a single loose synonym outrank a direct hit.
    const terms = new Map();
    expandQueryConcepts(queryTokens).forEach((concept, source) => {
      concept.forEach((term, position) => {
        const entry = terms.get(term) ?? { weight: 0, sources: new Set(), exact: false };
        entry.weight = Math.max(entry.weight, position === 0 ? 1 : 0.55);
        entry.sources.add(source);
        if (position === 0) entry.exact = true;
        terms.set(term, entry);
      });
    });

    const availableConcepts = new Set();
    for (const [term, entry] of terms) {
      if (!this.postings.has(term)) continue;
      for (const source of entry.sources) availableConcepts.add(source);
    }

    const total = Math.max(1, this.memories.length);
    const averageLength = Math.max(1, this.totalLength / total);
    const categoryScores = categoryQueryScores(queryText);
    const candidates = new Map();
    for (const [term, entry] of terms) {
      const bucket = this.postings.get(term);
      if (bucket === undefined) continue;
      const idf = Math.log(1 + (total - bucket.size + 0.5) / (bucket.size + 0.5));
      for (const [id, termFrequency] of bucket) {
        const length = this.docLengths.get(id) ?? averageLength;
        const bm25 = (termFrequency * 2.2) / (termFrequency + 1.2 * (0.25 + 0.75 * length / averageLength));
        const row = candidates.get(id) ?? { id, matchedExact: 0, matchedWeight: 0, sources: new Set(), score: 0, bestIdf: 0 };
        row.matchedExact += entry.exact ? 1 : 0;
        row.matchedWeight += entry.weight;
        for (const source of entry.sources) row.sources.add(source);
        row.score += idf * bm25 * entry.weight;
        row.bestIdf = Math.max(row.bestIdf, idf);
        candidates.set(id, row);
      }
    }

    const queryVector = featureVector(queryText);
    const rows = [];
    const rowById = new Map();
    for (const candidate of candidates.values()) {
      const memory = this.byId.get(candidate.id);
      if (memory === undefined) continue;
      const coverage = candidate.sources.size / Math.max(1, availableConcepts.size);
      if (candidate.matchedExact === 0 && candidate.matchedWeight < 0.55) continue;
      if (coverage < 0.2) continue;
      const vector = this.vectors.get(memory.id) ?? featureVector(`${memory.text} ${memory.tags.join(' ')}`);
      const similarity = cosineSimilarity(queryVector, vector);
      let tagWeight = 0;
      for (const tag of memory.tags) tagWeight += terms.get(tag)?.weight ?? 0;
      const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updatedAt)) / 86400000);
      const recency = Math.exp(-ageDays / 120);
      const quality = (feedbackRatio(memory) - 0.5) * 0.18 + Math.min(0.05, Math.log1p(memory.hits ?? 0) * 0.012);
      const categoryBoost = Math.min(0.16, (categoryScores.get(memory.category) ?? 0) * 0.05);
      const score = candidate.score * (0.55 + 0.45 * coverage)
        + Math.min(0.35, tagWeight * 0.12)
        + memory.importance * 0.24
        + recency * 0.12
        + quality
        + categoryBoost
        + similarity * VECTOR_BLEND;
      const row = {
        memory,
        score,
        coverage: Math.max(coverage, similarity),
        matched: candidate.matchedExact,
        fuzzy: false,
        vector: similarity,
      };
      rows.push(row);
      rowById.set(memory.id, row);
    }

    // Vector-only candidates: text that shares no exact token (typos, word
    // order, loose paraphrases) can still be rescued by cosine similarity.
    // The threshold is deliberately high; this is a supplement, not a
    // replacement for the concept gate above.
    for (const memory of this.memories) {
      if (rowById.has(memory.id) || isSuppressed(memory)) continue;
      const vector = this.vectors.get(memory.id) ?? featureVector(`${memory.text} ${memory.tags.join(' ')}`);
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity < VECTOR_MIN_SIMILARITY) continue;
      let tagWeight = 0;
      for (const tag of memory.tags) tagWeight += terms.get(tag)?.weight ?? 0;
      const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updatedAt)) / 86400000);
      const recency = Math.exp(-ageDays / 120);
      const quality = (feedbackRatio(memory) - 0.5) * 0.18 + Math.min(0.05, Math.log1p(memory.hits ?? 0) * 0.012);
      const categoryBoost = Math.min(0.16, (categoryScores.get(memory.category) ?? 0) * 0.05);
      const score = similarity * VECTOR_ONLY_WEIGHT
        + Math.min(0.35, tagWeight * 0.12)
        + memory.importance * 0.24
        + recency * 0.12
        + quality
        + categoryBoost;
      const row = {
        memory,
        score,
        coverage: similarity,
        matched: 0,
        fuzzy: true,
        vector: similarity,
      };
      rows.push(row);
      rowById.set(memory.id, row);
    }
    return rows.sort((left, right) => right.score - left.score);
  }

  scoreCandidates(queryText, { context = '' } = {}) {
    const profile = this.buildQueryProfile(queryText, context);
    if (this.config.recallMode === 'hybrid') return { profile, rows: this.scoreHybrid(profile) };
    // Legacy mode must keep its pre-0.9 behavior exactly: no acronym/typo
    // rewriting and no previous-prompt context. Hybrid is opt-in.
    return { profile, rows: this.scoreLegacy(queryText) };
  }

  scoreHybrid(profile) {
    const base = this.scoreLegacy(profile.text);
    const baseById = new Map(base.map((row, index) => [row.memory.id, { row, rank: index }]));
    const queryVector = featureVector(profile.text);
    const querySemantic = semanticFeatureVector(profile.text);
    const vectorRows = [];
    for (const memory of this.memories) {
      if (memory.blocked || isSuppressed(memory)) continue;
      const vector = this.vectors.get(memory.id) ?? featureVector(`${memory.text} ${memory.tags.join(' ')}`);
      let similarity = cosineSimilarity(queryVector, vector);
      if (this.config.semantic) {
        const semantic = this.semanticVectors.get(memory.id) ?? semanticFeatureVector(memory.text, memory.category);
        similarity = similarity * 0.7 + cosineSimilarity(querySemantic, semantic) * 0.3;
      }
      if (similarity < 0.18) continue;
      vectorRows.push({ memory, similarity });
    }
    vectorRows.sort((left, right) => right.similarity - left.similarity);
    const vectorRank = new Map(vectorRows.slice(0, 80).map((row, index) => [row.memory.id, index]));

    const ids = new Set([...baseById.keys(), ...vectorRank.keys()]);
    const queryTerms = new Set(profile.tokens);
    for (const concept of expandQueryConcepts(profile.tokens)) {
      for (const term of concept) queryTerms.add(term);
    }
    const categoryScores = categoryQueryScores(profile.text);
    const rows = [];
    for (const id of ids) {
      const memory = this.byId.get(id);
      if (memory === undefined || memory.blocked || isSuppressed(memory)) continue;
      const baseEntry = baseById.get(id);
      const baseRow = baseEntry?.row;
      const vectorEntry = vectorRows.find((row) => row.memory.id === id);
      const similarity = vectorEntry?.similarity ?? 0;
      // A vector-only hit has no lexical anchor. Keep the bar high so a
      // semantically generic note ("对话") cannot hijack unrelated queries.
      if (baseRow === undefined && similarity < 0.3) continue;
      const bm25Rank = baseEntry?.rank ?? 80;
      const vRank = vectorRank.get(id) ?? 80;
      // Tag/category is a third weak leg. It lets an exact or expanded
      // concept term break ties without overpowering lexical matches.
      let tagHits = 0;
      for (const tag of memory.tags) if (queryTerms.has(tag)) tagHits += 1;
      const categoryHit = categoryScores.get(memory.category) ?? 0;
      if (baseRow !== undefined) {
        // BM25 already contains this signal; keep the leg rank stable.
        tagHits += categoryHit * 0.5;
      }
      const tagRank = Math.max(0, 60 - Math.round(tagHits * 20));
      const rrf = 0.62 / (60 + bm25Rank) + 0.28 / (60 + vRank) + 0.1 / (60 + tagRank);
      const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updatedAt)) / 86400000);
      const recency = Math.exp(-ageDays / 120);
      const quality = (feedbackRatio(memory) - 0.5) * 0.12 + Math.min(0.04, Math.log1p(memory.hits ?? 0) * 0.01);
      const categoryBoost = Math.min(0.08, categoryHit * 0.03);
      // A plan/time question should prefer plan memories even when a person or
      // project note also mentions the noun ("仓库"). Keep this narrow and
      // intent-based so ordinary chit-chat is not pulled into plan memories.
      const planIntent = /什么时候|何时|计划|版本|上线|同步|推送|状态|发布/.test(profile.normalized);
      const wantsPlan = memory.category === 'plan' && (profile.type === 'plan' || planIntent);
      const personIntent = /谁|名字|账号|所有者|作者|联系人|负责人|owner|who|whose/i.test(profile.normalized);
      const wantsPerson = memory.category === 'person' && (profile.type === 'person' || personIntent);
      const wantsConversation = memory.category === 'conversation' && queryTerms.has('对话');
      const typeBoost = wantsPlan || wantsPerson || wantsConversation ? 0.06 : 0;
      const pinBoost = memory.pinned ? 0.12 : 0;
      const score = rrf * 60 + memory.importance * 0.12 + recency * 0.08 + quality + categoryBoost + typeBoost + pinBoost;
      const reasons = [];
      if (baseRow !== undefined) reasons.push('bm25');
      if (vRank < 80) reasons.push('vector');
      if (tagHits > 0) reasons.push('tag');
      if (categoryHit > 0) reasons.push('category');
      if (typeBoost > 0) reasons.push('intent');
      if (memory.pinned) reasons.push('pinned');
      rows.push({
        memory,
        score,
        bm25: baseRow?.score ?? 0,
        vector: similarity,
        coverage: Math.max(baseRow?.coverage ?? 0, similarity),
        matched: baseRow?.matched ?? 0,
        fuzzy: baseRow === undefined,
        reasons,
      });
    }
    return rows.sort((left, right) => right.score - left.score);
  }

  explain(queryText, { context = '', limit = 8 } = {}) {
    const { profile, rows } = this.scoreCandidates(queryText, { context });
    return {
      mode: this.config.recallMode,
      query: profile.normalized,
      corrections: profile.corrections,
      type: profile.type,
      rows: rows.slice(0, Math.max(1, Math.min(12, limit))).map((row) => ({
        id: row.memory.id,
        text: trimText(row.memory.text, 220),
        category: row.memory.category,
        kind: row.memory.kind,
        pinned: row.memory.pinned,
        blocked: row.memory.blocked,
        suppressed: isSuppressed(row.memory),
        score: Number(row.score.toFixed(4)),
        bm25: Number((row.bm25 ?? 0).toFixed(4)),
        vector: Number((row.vector ?? 0).toFixed(4)),
        coverage: Number((row.coverage ?? 0).toFixed(4)),
        reasons: row.reasons ?? [],
      })),
    };
  }

  setFlags(id, { pinned, blocked } = {}) {
    this.assertWritable();
    const raw = String(id ?? '').trim().replace(/^#/, '');
    const memory = this.byId.get(raw) ?? [...this.byId.values()].find((row) => row.id.startsWith(raw));
    if (memory === undefined) throw Object.assign(new Error('memory not found'), { status: 404, code: 'not-found' });
    if (typeof pinned === 'boolean') memory.pinned = pinned;
    if (typeof blocked === 'boolean') memory.blocked = blocked;
    memory.updatedAt = new Date().toISOString();
    this.queuePut(memory.id);
    this.bump();
    return memory;
  }

  setCategory(id, category) {
    this.assertWritable();
    const raw = String(id ?? '').trim().replace(/^#/, '');
    const memory = this.byId.get(raw) ?? [...this.byId.values()].find((row) => row.id.startsWith(raw));
    if (memory === undefined) throw Object.assign(new Error('memory not found'), { status: 404, code: 'not-found' });
    const normalized = normalizeCategory(category);
    if (normalized === undefined) throw Object.assign(new Error('unknown memory category'), { status: 400, code: 'bad-request' });
    memory.category = normalized;
    memory.categoryConfidence = 1;
    memory.categoryScores = { [normalized]: 1 };
    memory.categoryAlternatives = [];
    memory.categorySource = 'user';
    memory.topic = topicOf(memory.text, memory.tags, normalized);
    memory.updatedAt = new Date().toISOString();
    this.unindexMemory(memory);
    this.byHash.delete(memory.hash);
    memory.hash = hashText(memory.text);
    this.byHash.set(memory.hash, memory);
    this.indexMemory(memory);
    this.queuePut(memory.id);
    this.bump();
    return memory;
  }

  logRecall(sessionId, profile, rows) {
    const top = rows[0];
    const entry = {
      at: new Date().toISOString(),
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      query: trimText(profile.normalized, 180),
      type: profile.type,
      mode: this.config.recallMode,
      ids: rows.map((row) => row.memory.id),
      topScore: top === undefined ? 0 : Number(top.score.toFixed(4)),
      margin: rows.length < 2 ? 0 : Number((rows[0].score - rows[1].score).toFixed(4)),
      corrections: profile.corrections,
    };
    this.recallLog.push(entry);
    if (this.recallLog.length > RECALL_LOG_MAX) this.recallLog.splice(0, this.recallLog.length - RECALL_LOG_MAX);
    return entry;
  }

  recall(queryText, { sessionId, exclude, context = '', project } = {}) {
    const { profile, rows } = this.scoreCandidates(queryText, { context });
    if (project !== undefined && project.length > 0) {
      for (const row of rows) {
        if (row.memory.project !== project) continue;
        row.score += 0.08;
        if (Array.isArray(row.reasons) && !row.reasons.includes('project')) row.reasons.push('project');
      }
      rows.sort((left, right) => right.score - left.score);
    }
    if (rows.length === 0) return [];
    const minScore = this.config.recallMode === 'hybrid'
      ? Math.max(0.32, this.config.minScore * 0.52)
      : this.config.minScore;
    const minCoverage = this.config.recallMode === 'hybrid'
      ? Math.min(this.config.minCoverage, 0.22)
      : this.config.minCoverage;
    const eligible = [];
    for (const row of rows) {
      const memory = row.memory;
      if (memory.blocked || isSuppressed(memory)) continue;
      if (memory.source.sessionId !== undefined && memory.source.sessionId === sessionId) continue;
      if (exclude?.has(memory.id)) continue;
      if (row.coverage < minCoverage || row.score < minScore) continue;
      eligible.push(row);
    }
    if (eligible.length === 0) return [];
    // A margin gate prevents a weak, ambiguous top hit from being injected.
    // Legacy keeps its historical behavior; hybrid is deliberately stricter.
    if (this.config.recallMode === 'hybrid' && eligible.length >= 2) {
      const margin = eligible[0].score - eligible[1].score;
      if (margin < this.config.margin && eligible[0].score < minScore + 0.18) return [];
    }
    const picked = [];
    for (const row of eligible) {
      if (this.config.diversity > 0 && picked.length > 0) {
        let tooSimilar = false;
        for (const previous of picked) {
          if (textSimilarity(previous.memory.text, row.memory.text) > 1 - this.config.diversity) {
            tooSimilar = true;
            break;
          }
        }
        if (tooSimilar) continue;
      }
      picked.push(row);
      if (picked.length >= Math.max(1, Math.min(5, this.config.maxItems))) break;
    }
    if (picked.length === 0) return [];
    const entry = this.logRecall(sessionId, profile, picked);
    this.queueRecall(entry);
    for (const row of picked) {
      row.memory.hits += 1;
      row.memory.lastHitAt = new Date().toISOString();
      row.memory.lastRecalledQuery = trimText(profile.normalized, 180);
      this.queuePut(row.memory.id);
    }
    this.bump();
    return picked.map((row) => row.memory);
  }

  coreMemories(limit = 2) {
    return this.memories
      .filter((memory) => memory.pinned && !memory.blocked && !isSuppressed(memory))
      .sort((left, right) => (right.importance - left.importance) || (Date.parse(right.updatedAt) - Date.parse(left.updatedAt)))
      .slice(0, Math.max(0, Math.min(3, limit)));
  }

  noteHits(ids) {
    if (!this.writable) return;
    const at = new Date().toISOString();
    let touched = false;
    for (const id of ids) {
      const memory = this.byId.get(id);
      if (memory === undefined) continue;
      memory.hits += 1;
      memory.lastHitAt = at;
      this.queuePut(memory.id);
      touched = true;
    }
    if (touched) this.bump();
  }

  search(queryText, limit = 5) {
    const { rows: scored } = this.scoreCandidates(queryText);
    const seen = new Set();
    const rows = [];
    for (const row of scored) {
      if (row.memory.blocked || row.score <= 0.01 || seen.has(row.memory.id)) continue;
      seen.add(row.memory.id);
      rows.push(row.memory);
      if (rows.length >= Math.max(1, Math.min(20, limit))) break;
    }
    return rows;
  }

  list(limit = 400) {
    return [...this.memories]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(1000, limit)));
  }

  /**
   * Relationship graph data for the 3D view. Nodes are individual memories;
   * edges are weighted text/category/tag similarity. Keeping the edge build
   * here means the browser receives one coherent snapshot and never needs the
   * full vector index.
   */
  graph(limit = 400) {
    const all = [...this.memories].filter((memory) => !memory.blocked);
    const ordered = all
      .sort((left, right) => {
        const leftWeight = (left.hits ?? 0) + (left.mergedCount ?? 0) * 2 + (left.pinned ? 2 : 0);
        const rightWeight = (right.hits ?? 0) + (right.mergedCount ?? 0) * 2 + (right.pinned ? 2 : 0);
        if (rightWeight !== leftWeight) return rightWeight - leftWeight;
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })
      .slice(0, Math.max(1, Math.min(GRAPH_LIMIT_MAX, limit)));
    const nodes = ordered.map((memory) => {
      const mentions = (memory.hits ?? 0)
        + (memory.mergedCount ?? 0) * 2
        + (memory.feedbackUseful ?? 0)
        + (memory.kind === 'episode' ? 1 : 0)
        + (memory.pinned ? 1 : 0);
      return {
        id: memory.id,
        text: trimText(memory.text, 520),
        tags: memory.tags,
        kind: memory.kind,
        role: memory.role,
        category: normalizeCategory(memory.category) ?? 'uncategorized',
        categoryLabel: CATEGORY_META[normalizeCategory(memory.category) ?? 'uncategorized'].label,
        color: CATEGORY_META[normalizeCategory(memory.category) ?? 'uncategorized'].color,
        mentions,
        hits: memory.hits ?? 0,
        mergedCount: memory.mergedCount ?? 0,
        pinned: memory.pinned === true,
        importance: memory.importance ?? 0.5,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const tokenSets = new Map();
    for (const memory of ordered) {
      tokenSets.set(memory.id, new Set(tokenize(strippedRoleText(memory.text))));
    }
    const vectorFor = (memory) => this.vectors.get(memory.id) ?? featureVector(memory.text);
    const pairs = [];
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      const left = ordered[leftIndex];
      const leftVector = vectorFor(left);
      const leftTokens = tokenSets.get(left.id);
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const right = ordered[rightIndex];
        const rightTokens = tokenSets.get(right.id);
        let intersection = 0;
        for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
        const union = leftTokens.size + rightTokens.size - intersection;
        const jaccard = union === 0 ? 0 : intersection / union;
        const cosine = Math.max(0, cosineSimilarity(leftVector, vectorFor(right)));
        let weight = cosine * 0.62 + jaccard * 0.38;
        const leftCategory = byId.get(left.id).category;
        const rightCategory = byId.get(right.id).category;
        if (leftCategory === rightCategory) weight += 0.035;
        const sharedTags = left.tags.filter((tag) => right.tags.includes(tag)).length;
        weight += Math.min(0.06, sharedTags * 0.02);
        if (weight < GRAPH_EDGE_MIN) continue;
        pairs.push({ source: left.id, target: right.id, weight: Math.min(1, weight) });
      }
    }
    // Keep each node's strongest few links so weak background similarity does
    // not turn the view into a hairball.
    const perNode = new Map();
    for (const pair of pairs.sort((left, right) => right.weight - left.weight)) {
      const left = perNode.get(pair.source) ?? [];
      const right = perNode.get(pair.target) ?? [];
      if (left.length >= GRAPH_NEIGHBORS && right.length >= GRAPH_NEIGHBORS) continue;
      left.push(pair);
      right.push(pair);
      perNode.set(pair.source, left);
      perNode.set(pair.target, right);
    }
    const seen = new Set();
    const edges = [];
    for (const list of perNode.values()) {
      for (const pair of list) {
        const key = `${pair.source}\u0000${pair.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ ...pair, weight: Number(pair.weight.toFixed(4)) });
      }
    }
    edges.sort((left, right) => right.weight - left.weight);
    const categories = CATEGORY_ORDER.map((key) => ({
      key,
      label: CATEGORY_META[key].label,
      color: CATEGORY_META[key].color,
      count: nodes.filter((node) => node.category === key).length,
    })).filter((entry) => entry.count > 0);
    return {
      nodes,
      edges,
      categories,
      total: all.length,
      shown: nodes.length,
      hidden: Math.max(0, all.length - nodes.length),
      generatedAt: new Date().toISOString(),
    };
  }

  stats() {
    const tags = new Map();
    const categories = new Map();
    let recalls = 0;
    let feedbackUseful = 0;
    let feedbackUseless = 0;
    let merged = 0;
    let suppressed = 0;
    for (const memory of this.memories) {
      for (const tag of memory.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
      categories.set(memory.category, (categories.get(memory.category) ?? 0) + 1);
      recalls += memory.hits ?? 0;
      feedbackUseful += memory.feedbackUseful ?? 0;
      feedbackUseless += memory.feedbackUseless ?? 0;
      merged += memory.mergedCount ?? 0;
      if (isSuppressed(memory)) suppressed += 1;
    }
    const feedbackTotal = feedbackUseful + feedbackUseless;
    return {
      count: this.memories.length,
      notes: this.memories.filter((memory) => memory.kind === 'note').length,
      dialogues: this.memories.filter((memory) => memory.kind === 'dialogue').length,
      episodes: this.memories.filter((memory) => memory.kind === 'episode').length,
      pinned: this.memories.filter((memory) => memory.pinned).length,
      blocked: this.memories.filter((memory) => memory.blocked).length,
      tags: tags.size,
      compressed: this.memories.filter((memory) => memory.compressed).length,
      savedChars: this.memories.reduce((total, memory) => total + Math.max(0, (memory.originalLength ?? memory.text.length) - memory.text.length), 0),
      recalls,
      feedbackUseful,
      feedbackUseless,
      feedbackTotal,
      usefulRate: feedbackTotal > 0 ? feedbackUseful / feedbackTotal : null,
      merged,
      suppressed,
      config: { ...this.config },
      recallLog: this.recallLog.slice(-20),
      encrypted: !this.locked && this.key !== null,
      locked: this.locked,
      readOnly: this.readOnly,
      lockOwner: this.lockOwner?.pid ?? null,
      encryption: this.locked ? 'locked' : 'aes-256-gcm',
      storage: 'jsonl',
      revision: this.revision,
      journalEntries: this.journalEntries,
      journalBytes: this.journalBytes,
      journalFile: this.journalFile,
      backupDir: this.backupDir,
      backupKeep: BACKUP_KEEP,
      lastBackupAt: this.lastBackupAt || null,
      lastPersistAt: this.lastPersistAt,
      persistError: this.lastPersistError?.message ?? null,
      persistFailures: this.persistFailures,
      categories: CATEGORY_ORDER.map((key) => ({
        key,
        label: CATEGORY_META[key].label,
        color: CATEGORY_META[key].color,
        count: categories.get(key) ?? 0,
      })),
      updatedAt: this.memories.reduce((latest, memory) => (memory.updatedAt > latest ? memory.updatedAt : latest), ''),
    };
  }
}

function textBlocks(message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Return the locally capturable summary of one message. Only genuine typed
 * prompts and final model replies qualify: runtime context, skill catalogs,
 * time snapshots, tool results, plugin notices and tool-call chatter must
 * never pollute the shared memory pool.
 */
function messageText(message) {
  return dialoguePayload(message)?.text ?? '';
}

function rawUserText(message) {
  if (message === null || typeof message !== 'object') return '';
  if (message.role !== 'user' || message.source?.kind !== 'user') return '';
  return textBlocks(message);
}

function buildRecallText(memories, coreMemories = []) {
  const lines = [
    '<system-reminder>',
    'Shared memory pool from earlier local conversations. Use only if relevant; do not mention this reminder.',
  ];
  const render = (memory) => {
    const day = memory.createdAt.slice(0, 10);
    const tags = memory.tags.length > 0 ? ` tags:${memory.tags.join('/')}` : '';
    const project = memory.project === undefined ? '' : ` project:${memory.project}`;
    return `- #${memory.id} [${memory.kind}, ${day}${project}${tags}] ${promptSafeText(trimText(memory.text, RECALL_SNIPPET_CHARS))}`;
  };
  if (coreMemories.length > 0) {
    lines.push('Core memories the user pinned (always prefer these):');
    for (const memory of coreMemories) lines.push(render(memory));
  }
  if (memories.length > 0) {
    lines.push('Possibly relevant memories:');
    for (const memory of memories) lines.push(render(memory));
  }
  lines.push('</system-reminder>');
  const text = lines.join('\n');
  return text.length <= RECALL_MESSAGE_MAX_CHARS ? text : `${text.slice(0, RECALL_MESSAGE_MAX_CHARS - 1)}…`;
}

function formatDate(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.slice(0, 10);
}

function writeJson(res, status, body) {
  if (res.headersSent === true) {
    res.destroy?.();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

function writeError(res, error) {
  writeJson(res, error?.status ?? 500, {
    ok: false,
    error: { code: error?.code ?? 'internal', message: error?.message ?? 'memory store failed' },
  });
}

async function readJsonBody(req, maxBytes = API_BODY_MAX) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413, code: 'too-large' });
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400, code: 'bad-request' });
  }
}

function textRender(value) {
  return [{ type: 'text', text: value }];
}

export function apply(ctx) {
  const store = new MemoryStore(
    dshHomePath('storages', 'dsh-memory', 'memories.json'),
    dshHomePath('storages', 'dsh-memory', 'key.bin'),
    dshHomePath('storages', 'dsh-memory', 'config.json'),
  );
  const loaded = store.open();
  // Key per-session bookkeeping by the durable session id, not by the Session
  // object: a resumed or rehydrated session may hand us a fresh object, and an
  // object-keyed map would then forget what was already captured/recalled.
  const recalledBySession = new Map();
  const capturedBySession = new Map();
  const coreInjectedBySession = new Map();
  const TRACKED_SESSIONS = 256;

  const stateFor = (map, sessionId, create) => {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown';
    let state = map.get(key);
    if (state === undefined) {
      state = create();
      map.set(key, state);
      if (map.size > TRACKED_SESSIONS) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    }
    return state;
  };

  const recallFor = (sessionId) => stateFor(recalledBySession, sessionId, () => new Set());
  const captureFor = (sessionId) => stateFor(capturedBySession, sessionId, () => ({ ids: new Set(), seeded: false }));

  ctx.effect(() => {
    void loaded.then(() => {
      if (store.locked) {
        ctx.logger?.warn?.('dsh-memory: store is locked: %s', store.loadError?.message ?? 'unknown reason');
        return;
      }
      ctx.logger?.info?.('dsh-memory: %d memories from %s', store.memories.length, store.file);
      if (store.readOnly) {
        ctx.logger?.warn?.('dsh-memory: read-only; writer owner is pid %s', store.lockOwner?.pid ?? 'unknown');
      }
    }).catch((error) => {
      ctx.logger?.warn?.('dsh-memory: store load failed');
      ctx.logger?.warn?.(error);
    });
    return () => {
      void store.close();
    };
  }, 'dsh-memory: store lifecycle');

  ctx.systemPrompt.section({
    name: 'dsh-memory',
    order: 48,
    text: [
      '## Shared memory',
      'All local conversations share one persistent memory pool; relevant items may be injected automatically. Use `memory` only for durable facts or preferences; never secrets.',
    ].join('\n'),
  });

  ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Shared local memory across conversations. search|save|forget|feedback; save only durable facts or preferences.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'save', 'forget', 'feedback'],
        description: 'search | save | forget | feedback',
      },
      query: {
        type: 'string',
        description: 'Search text (action=search).',
      },
      text: {
        type: 'string',
        description: 'Memory text to store (action=save); keep it short and self-contained.',
      },
      tags: {
        type: 'string',
        description: 'Optional comma-separated tags (action=save).',
      },
      id: {
        type: 'string',
        description: 'Memory id, with or without # (action=forget|feedback).',
      },
      verdict: {
        type: 'string',
        enum: ['useful', 'useless'],
        description: 'Feedback verdict (action=feedback): useful | useless.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => textRender(value),
    },
    execute: async (args, exec) => {
      await loaded;
      store.assertReadable();
      if (args.action !== 'search') store.assertWritable();
      if (args.action === 'save') {
        const text = trimText(args.text ?? args.query, NOTE_MAX_CHARS);
        if (text.length === 0) throw new Error('memory save needs non-empty text');
        const memory = store.add({
          text,
          tags: normalizeTags(args.tags ?? ''),
          kind: 'note',
          importance: 0.85,
          source: {
            sessionId: exec.agent?.session?.id,
            cwd: exec.agent?.session?.header?.cwd,
          },
        });
        await store.flush({ throwOnError: true });
        return `Saved memory #${memory.id}: ${trimText(memory.text, 140)}`;
      }
      if (args.action === 'forget') {
        const raw = String(args.id ?? '').trim().replace(/^#/, '');
        if (raw.length === 0) throw new Error('memory forget needs an id');
        const memory = store.byId.get(raw) ?? [...store.byId.values()].find((row) => row.id.startsWith(raw));
        if (memory === undefined) return `No memory matches #${raw}.`;
        store.remove(memory.id);
        await store.flush({ throwOnError: true });
        return `Deleted memory #${memory.id}.`;
      }
      if (args.action === 'feedback') {
        const raw = String(args.id ?? '').trim().replace(/^#/, '');
        if (raw.length === 0) throw new Error('memory feedback needs an id');
        const memory = store.rate(raw, String(args.verdict ?? '').trim());
        return `Marked memory #${memory.id} as ${args.verdict} (useful ${memory.feedbackUseful} / useless ${memory.feedbackUseless}).`;
      }
      const query = trimText(args.query ?? args.text, 500);
      if (query.length === 0) throw new Error('memory search needs a query');
      const rows = store.search(query, 6);
      if (rows.length === 0) return `No memories matched "${trimText(query, 80)}".`;
      return [
        `Found ${rows.length} memory${rows.length === 1 ? '' : 'ies'} for "${trimText(query, 80)}":`,
        ...rows.map((memory) => `- #${memory.id} [${memory.kind}/${CATEGORY_META[memory.category]?.label ?? memory.category}, ${formatDate(memory.createdAt)}${memory.tags.length ? `, tags:${memory.tags.join('/')}` : ''}${memory.hits ? `, recalled:${memory.hits}` : ''}${memory.mergedCount ? `, merged:${memory.mergedCount}` : ''}${isSuppressed(memory) ? ', suppressed' : ''}] ${trimText(memory.text, 260)}`),
      ].join('\n');
    },
  }));

  // Capture final assistant replies as soon as they are appended, so the last
  // reply of a conversation is not lost when no next turn ever starts.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return;
    const message = event.data?.message;
    const payload = dialoguePayload(message);
    if (payload === undefined) return;
    const sessionId = session?.id;
    const captured = captureFor(sessionId);
    if (typeof message.id === 'string') captured.ids.add(message.id);
    void loaded.then(() => {
      if (store.locked || store.readOnly || !store.config.capture) return;
      store.add({
        text: payload.text,
        tags: autoTags(payload.summary),
        kind: 'dialogue',
        role: 'assistant',
        importance: 0.35,
        source: { sessionId, cwd: session?.header?.cwd },
        compressed: payload.compressed,
        originalLength: payload.originalLength,
      });
    }).catch(() => {});
  });

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    await loaded;
    if (store.locked) return decision;

    const session = agent.session;
    const sessionId = session?.id;
    const source = { sessionId, cwd: session?.header?.cwd };

    // Automatic capture is a default, local-only feature: every genuine user
    // prompt and every final assistant reply is written to the pool without a
    // button, a tool call, or a model round-trip. The seen-set keeps the first
    // pre-step of a restored session from backfilling its whole history.
    const captured = captureFor(sessionId);
    if (!captured.seeded) {
      captured.seeded = true;
      const lastUser = [...messages].reverse().find((message) => rawUserText(message).length > 0);
      for (const message of messages) {
        if (message !== lastUser) captured.ids.add(message.id);
      }
    }

    const fresh = [];
    const visit = (message) => {
      if (message === null || typeof message !== 'object') return;
      if (typeof message.id !== 'string' || captured.ids.has(message.id)) return;
      captured.ids.add(message.id);
      const payload = dialoguePayload(message);
      if (payload === undefined) return;
      if (payload.role === 'user' && payload.summary.startsWith('/')) return;
      fresh.push(payload);
    };
    for (const message of decision.messages) visit(message);
    for (const message of messages) visit(message);
    if (store.config.capture && store.writable) {
      for (const item of fresh) {
        store.add({
          text: item.text,
          tags: autoTags(item.summary),
          kind: 'dialogue',
          role: item.role,
          importance: item.role === 'assistant' ? 0.35 : 0.4,
          source,
          compressed: item.compressed,
          originalLength: item.originalLength,
        });
      }
    }

    // Recall is intentionally rare: only the first step of a turn, and only
    // from the latest user prompt. Pinned memories are the exception: they are
    // the user's explicit core profile and are injected once per session.
    if (step !== 1 || decision.messages.length === 0) return decision;
    const latest = [...decision.messages].reverse().find((message) => rawUserText(message).length > 0);
    const query = latest === undefined ? '' : rawUserText(latest);

    const recalled = recallFor(sessionId);
    const coreState = stateFor(coreInjectedBySession, sessionId, () => ({ done: false }));
    const core = coreState.done ? [] : store.coreMemories(2);
    for (const memory of core) recalled.add(memory.id);

    let hits = [];
    if (query.length >= 6) {
      const previousUser = [...decision.messages]
        .reverse()
        .filter((message) => message !== latest)
        .find((message) => rawUserText(message).length > 0);
      hits = store.recall(query, {
        sessionId,
        exclude: recalled,
        context: previousUser === undefined ? '' : rawUserText(previousUser),
        project: projectName(session?.header?.cwd),
      });
    }
    if (hits.length === 0 && core.length === 0) return decision;
    // A reminder already injected earlier in this batch means we are done for
    // this step. Historical reminders from previous turns must not block new
    // recall, so only inspect the tail of the entering messages.
    if (decision.messages.slice(-2).some((message) => message.source?.kind === SOURCE_KIND)) {
      if (core.length > 0) coreState.done = true;
      return decision;
    }

    for (const memory of hits) recalled.add(memory.id);
    if (core.length > 0) {
      coreState.done = true;
      store.noteHits(core.map((memory) => memory.id));
    }
    const recallMessage = createUserMessage({
      content: [{ type: 'text', text: buildRecallText(hits, core) }],
      source: { kind: SOURCE_KIND, form: 'recall' },
    });
    const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message));
    const entered = decision.messages.toSpliced(lastClaimed + 1, 0, recallMessage);
    return { ...decision, messages: entered };
  }, { prepend: true });

  // The 3D renderer is served by the host for one reason: the embedded panel
  // and the detached window must share the exact same code and auth context.
  const viewAssets = new Map([
    ['/dsh-memory/view', ['graph3d.html', 'text/html; charset=utf-8']],
    ['/dsh-memory/view.css', ['graph3d.css', 'text/css; charset=utf-8']],
    ['/dsh-memory/view.js', ['graph3d.js', 'text/javascript; charset=utf-8']],
  ]);
  const viewCache = new Map();
  for (const [viewPath, [fileName, contentType]] of viewAssets) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: viewPath,
      handler: async (req, res) => {
        if (ctx.connection.requestRejection(req) !== undefined) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('forbidden');
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('method not allowed');
          return;
        }
        try {
          let body = viewCache.get(fileName);
          if (body === undefined) {
            body = await readFile(new URL(`./${fileName}`, import.meta.url), 'utf8');
            viewCache.set(fileName, body);
          }
          res.writeHead(200, {
            'content-type': contentType,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          res.end(req.method === 'HEAD' ? '' : body);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`view asset failed: ${error?.message ?? 'unknown error'}`);
        }
      },
    }), `dsh-memory: ${viewPath}`);
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : '';
      if (method.length === 0 || method.includes('/')) {
        writeError(res, Object.assign(new Error('unknown memory API method'), { status: 404, code: 'not-found' }));
        return;
      }
      try {
        await loaded;
        store.assertReadable();
        const payload = await readJsonBody(req, method === 'import' ? Math.ceil(BACKUP_IMPORT_MAX * 4 / 3) + 4096 : API_BODY_MAX);
        if (method === 'graph') {
          writeOk(res, store.graph(payload.limit ?? 400));
          return;
        }
        if (method === 'list') {
          const items = store.list(payload.limit ?? 400).map((memory) => ({
            id: memory.id,
            text: memory.text,
            tags: memory.tags,
            kind: memory.kind,
            role: memory.role,
            episodeKey: memory.episodeKey,
            hasReply: memory.hasReply,
            category: memory.category,
            categoryConfidence: memory.categoryConfidence,
            categoryScores: memory.categoryScores,
            categoryAlternatives: memory.categoryAlternatives,
            categorySource: memory.categorySource,
            topic: memory.topic,
            project: memory.project,
            entities: memory.entities,
            language: memory.language,
            importance: memory.importance,
            compressed: memory.compressed,
            originalLength: memory.originalLength,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            hits: memory.hits,
            lastHitAt: memory.lastHitAt,
            feedbackUseful: memory.feedbackUseful,
            feedbackUseless: memory.feedbackUseless,
            lastFeedbackAt: memory.lastFeedbackAt,
            mergedCount: memory.mergedCount,
            suppressed: isSuppressed(memory),
            pinned: memory.pinned,
            blocked: memory.blocked,
            sessionId: memory.source.sessionId,
          }));
          writeOk(res, { items, stats: store.stats(), version: store.version });
          return;
        }
        if (method === 'config') {
          if (payload.patch !== undefined) await store.updateConfig(payload.patch ?? {});
          writeOk(res, { config: store.config, stats: store.stats() });
          return;
        }
        if (method === 'backups') {
          writeOk(res, { items: await store.listBackups(), stats: store.stats() });
          return;
        }
        if (method === 'backup') {
          const name = await store.backupNow('manual');
          writeOk(res, { name, items: await store.listBackups(), stats: store.stats() });
          return;
        }
        if (method === 'verify') {
          writeOk(res, await store.verifyBackup(String(payload.name ?? '')));
          return;
        }
        if (method === 'export') {
          writeOk(res, await store.exportBackup(String(payload.name ?? '')));
          return;
        }
        if (method === 'import') {
          const name = await store.importBackup(String(payload.data ?? ''));
          writeOk(res, { imported: true, name, items: await store.listBackups(), stats: store.stats() });
          return;
        }
        if (method === 'restore') {
          if (payload.confirm !== true) throw Object.assign(new Error('restore needs confirm=true'), { status: 400, code: 'bad-request' });
          const stats = await store.restoreBackup(String(payload.name ?? ''));
          writeOk(res, { restored: true, items: await store.listBackups(), stats });
          return;
        }
        if (method === 'recall') {
          const query = trimText(payload.query, 500);
          if (query.length === 0) throw Object.assign(new Error('recall needs a query'), { status: 400, code: 'bad-request' });
          const explanation = store.explain(query, { context: payload.context, limit: payload.limit ?? 8 });
          writeOk(res, explanation);
          return;
        }
        if (method === 'flags') {
          const memory = store.setFlags(payload.id, { pinned: payload.pinned, blocked: payload.blocked });
          await store.flush({ throwOnError: true });
          writeOk(res, { memory: { id: memory.id, pinned: memory.pinned, blocked: memory.blocked }, stats: store.stats() });
          return;
        }
        if (method === 'classify') {
          const memory = store.setCategory(payload.id, String(payload.category ?? ''));
          await store.flush({ throwOnError: true });
          writeOk(res, {
            memory: {
              id: memory.id,
              category: memory.category,
              categoryConfidence: memory.categoryConfidence,
              categoryScores: memory.categoryScores,
              categoryAlternatives: memory.categoryAlternatives,
              categorySource: memory.categorySource,
            },
            stats: store.stats(),
          });
          return;
        }
        if (method === 'add') {
          const memory = store.add({
            text: payload.text,
            tags: normalizeTags(payload.tags ?? ''),
            kind: 'note',
            importance: payload.importance ?? 0.8,
            source: { sessionId: payload.sessionId, cwd: payload.cwd },
          });
          if (memory === undefined) throw Object.assign(new Error('memory text is empty'), { status: 400, code: 'bad-request' });
          await store.flush({ throwOnError: true });
          writeOk(res, { memory: { id: memory.id, text: memory.text, tags: memory.tags, kind: memory.kind, category: memory.category, categoryConfidence: memory.categoryConfidence, categoryScores: memory.categoryScores, categoryAlternatives: memory.categoryAlternatives, categorySource: memory.categorySource, importance: memory.importance, mergedCount: memory.mergedCount, createdAt: memory.createdAt, updatedAt: memory.updatedAt } });
          return;
        }
        if (method === 'feedback') {
          const memory = store.rate(String(payload.id ?? ''), String(payload.verdict ?? ''));
          await store.flush({ throwOnError: true });
          writeOk(res, {
            memory: {
              id: memory.id,
              text: memory.text,
              importance: memory.importance,
              feedbackUseful: memory.feedbackUseful,
              feedbackUseless: memory.feedbackUseless,
              suppressed: isSuppressed(memory),
            },
            stats: store.stats(),
          });
          return;
        }
        if (method === 'delete') {
          const id = String(payload.id ?? '').replace(/^#/, '');
          const memory = store.byId.get(id) ?? [...store.byId.values()].find((row) => row.id.startsWith(id));
          if (memory === undefined) throw Object.assign(new Error('memory not found'), { status: 404, code: 'not-found' });
          store.remove(memory.id);
          await store.flush({ throwOnError: true });
          writeOk(res, { removed: memory.id });
          return;
        }
        if (method === 'clear') {
          if (payload.confirm !== true) throw Object.assign(new Error('clear needs confirm=true'), { status: 400, code: 'bad-request' });
          await store.clear();
          writeOk(res, { cleared: true });
          return;
        }
        throw Object.assign(new Error(`unknown memory API method "${method}"`), { status: 404, code: 'not-found' });
      } catch (error) {
        writeError(res, error);
      }
    },
  }), 'dsh-memory: /dsh-memory/api routes');
}
