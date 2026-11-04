/**
 * dsh-memory — one shared memory pool for every local DSH conversation.
 *
 * Host half: a small JSON-backed store, zero-token conversation capture,
 * bounded automatic recall, a model-facing `memory` tool, and the
 * `/dsh-memory/api` routes used by the sidebar panel.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
const MAX_MEMORIES = 2500;
const CAPTURE_MAX_CHARS = 600;
const SUMMARY_MAX_CHARS = 240;
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

/**
 * Local extractive summary: no model call, no token cost. It keeps the highest
 * information sentences plus the opening request, drops boilerplate, and
 * bounds the result to SUMMARY_MAX_CHARS before encryption.
 */
function summarizeDialogue(raw, role) {
  const cleaned = cleanDialogueText(raw);
  if (cleaned.length === 0) return { text: '', compressed: false, originalLength: 0 };
  if (cleaned.length <= SUMMARY_MAX_CHARS) {
    return { text: cleaned, compressed: cleaned.length < String(raw ?? '').length, originalLength: String(raw ?? '').length };
  }

  const seen = new Set();
  const pieces = splitSentences(cleaned)
    .filter((sentence) => !BOILERPLATE_RE.test(sentence))
    .filter((sentence) => {
      const key = sentence.replace(/\s+/g, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (pieces.length === 0) {
    return { text: `${cleaned.slice(0, SUMMARY_MAX_CHARS - 1)}…`, compressed: true, originalLength: cleaned.length };
  }

  const counts = new Map();
  for (const token of tokenize(cleaned)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const scored = pieces.map((sentence, index) => {
    const unique = new Set(tokenize(sentence));
    let score = 0;
    for (const token of unique) score += counts.get(token) ?? 0;
    score /= Math.sqrt(Math.max(4, sentence.length));
    if (index === 0) score += role === 'user' ? 3 : 1.4;
    if (index === 1) score += role === 'user' ? 1.2 : 0.4;
    if (/[？?]/.test(sentence)) score += 0.25;
    if (/(建议|结论|因此|所以|需要|可以|步骤|注意|关键|默认|结果|偏好)/.test(sentence)) score += 0.35;
    return { sentence, index, score };
  });

  const picked = [];
  // The opening user sentence carries the request; never drop it just because
  // a repeated later sentence happens to share more common tokens.
  if (role === 'user' && scored[0] !== undefined) picked.push(scored[0]);
  for (const item of [...scored].sort((left, right) => right.score - left.score)) {
    if (picked.length >= 3) break;
    if (picked.some((row) => row.index === item.index)) continue;
    picked.push(item);
  }
  picked.sort((left, right) => left.index - right.index);
  let output = '';
  for (const item of picked) {
    const next = output.length === 0 ? item.sentence : `${output} ${item.sentence}`;
    if (next.length > SUMMARY_MAX_CHARS - 1) continue;
    output = next;
  }
  if (output.length < 24) output = pieces.slice(0, 2).join(' ');
  if (output.length > SUMMARY_MAX_CHARS) output = `${output.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
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
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);
const CATEGORY_ALIASES = new Map();
for (const key of CATEGORY_ORDER) CATEGORY_ALIASES.set(key, key);
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
};

function normalizeCategory(value) {
  const key = trimText(value, 24).toLowerCase();
  if (key.length === 0) return undefined;
  return CATEGORY_ALIASES.get(key);
}

function classifyCategory(text, tags, kind) {
  for (const tag of tags) {
    const category = normalizeCategory(tag);
    if (category !== undefined) return category;
  }
  const lower = String(text ?? '').toLowerCase();
  let best = '';
  let bestScore = 0;
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const word of words) {
      if (lower.includes(word)) score += word.length >= 3 ? 1.4 : 1;
    }
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  if (best.length > 0) return best;
  return kind === 'note' ? 'fact' : 'conversation';
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


function createMemory({ text, tags, kind = 'note', importance = 0.7, source = {}, hash, category, compressed = false, originalLength, role, episodeKey }) {
  const now = new Date().toISOString();
  const normalizedTags = normalizeTags(tags);
  const cleanText = trimText(text, kind === 'note' ? NOTE_MAX_CHARS : CAPTURE_MAX_CHARS);
  const normalizedCategory = normalizeCategory(category) ?? classifyCategory(cleanText, normalizedTags, kind);
  return {
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    text: cleanText,
    tags: normalizedTags,
    kind,
    role: role === 'user' || role === 'assistant' || role === 'episode' ? role : undefined,
    episodeKey: typeof episodeKey === 'string' ? episodeKey : undefined,
    hasReply: false,
    category: normalizedCategory,
    topic: topicOf(cleanText, normalizedTags, normalizedCategory),
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

class MemoryStore {
  constructor(file, keyFile, configFile) {
    this.file = file;
    this.keyFile = keyFile;
    this.configFile = configFile;
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
    this.version = 0;
    this.ready = false;
    this.config = { ...DEFAULT_CONFIG };
    this.recallLog = [];
    this.calibration = {};
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
    await mkdir(join(this.configFile, '..'), { recursive: true });
    const temporary = `${this.configFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.config, null, 2), 'utf8');
    await rename(temporary, this.configFile);
    return this.config;
  }

  assertWritable() {
    if (this.locked) throw new MemoryLockedError(this.loadError?.message ?? 'memory store is locked');
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
        await writeFile(this.keyFile, key, { mode: 0o600, flag: 'wx' });
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

  async load() {
    let raw;
    let encrypted = false;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.loadError = error;
        this.locked = true;
        return;
      }
      try {
        await this.ensureKey();
      } catch (keyError) {
        this.loadError = keyError;
        this.locked = true;
        return;
      }
      this.ready = true;
      this.rebuildIndex();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      encrypted = parsed?.format === STORE_FORMAT && parsed.encrypted === true;
      const payload = encrypted ? JSON.parse(await this.decryptEnvelope(parsed)) : parsed;
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.memories) ? payload.memories : [];
      if (Array.isArray(payload?.recallLog)) this.recallLog = payload.recallLog.slice(-RECALL_LOG_MAX);
      if (payload?.calibration !== null && typeof payload?.calibration === 'object') this.calibration = payload.calibration;
      for (const row of rows) this.adopt(row);
      if (!encrypted) {
        // A legacy plaintext store is readable once, then immediately rewritten
        // as an encrypted envelope. No plaintext copy is left behind.
        await this.ensureKey();
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
    this.ready = true;
    this.rebuildIndex();
    if (!encrypted && !this.locked) this.bump();
  }

  adopt(row) {
    if (row === null || typeof row !== 'object') return;
    const text = trimText(row.text, NOTE_MAX_CHARS);
    if (text.length === 0) return;
    const kind = row.kind === 'episode' ? 'episode' : row.kind === 'dialogue' ? 'dialogue' : 'note';
    const tags = normalizeTags(row.tags);
    const category = normalizeCategory(row.category) ?? classifyCategory(text, tags, kind);
    const memory = {
      id: typeof row.id === 'string' && row.id.length > 0 ? row.id : randomUUID().replace(/-/g, '').slice(0, 8),
      text,
      tags,
      kind,
      role: row.role === 'user' || row.role === 'assistant' || row.role === 'episode' ? row.role : undefined,
      episodeKey: typeof row.episodeKey === 'string' ? row.episodeKey : undefined,
      hasReply: row.hasReply === true,
      category,
      topic: typeof row.topic === 'string' && row.topic.length > 0 ? trimText(row.topic, 32) : topicOf(text, tags, category),
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

  bump() {
    if (this.locked) return;
    this.version += 1;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 300);
    this.persistTimer.unref?.();
  }

  async flush() {
    if (this.locked) return;
    await this.ensureKey();
    const rows = this.memories.map((memory) => ({ ...memory }));
    const payload = JSON.stringify({
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      memories: rows,
      recallLog: this.recallLog.slice(-RECALL_LOG_MAX),
      calibration: this.calibration,
    });
    const envelope = this.encryptPayload(payload);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(envelope), 'utf8');
      await rename(temporary, this.file);
    }).catch(() => {});
    await this.writeChain;
  }

  add({ text, tags, kind = 'note', importance, source, hash, compressed = false, originalLength, role, episodeKey, pinned, blocked }) {
    this.assertWritable();
    const clean = trimText(text, kind === 'note' ? NOTE_MAX_CHARS : CAPTURE_MAX_CHARS);
    if (clean.length === 0) return undefined;
    const contentHash = hash ?? hashText(clean);
    const existing = this.byHash.get(contentHash);
    if (existing !== undefined) {
      existing.updatedAt = new Date().toISOString();
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
    memory.lastFeedbackAt = new Date().toISOString();
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
    this.byId.delete(id);
    this.byHash.delete(memory.hash);
    this.memories = this.memories.filter((row) => row.id !== id);
    this.unindexMemory(memory);
    if (persist) this.bump();
    return true;
  }

  clear() {
    this.assertWritable();
    this.memories = [];
    this.byId.clear();
    this.byHash.clear();
    this.rebuildIndex();
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
      const wantsConversation = memory.category === 'conversation' && queryTerms.has('对话');
      const typeBoost = wantsPlan || wantsConversation ? 0.06 : 0;
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
    this.bump();
    return memory;
  }

  logRecall(sessionId, profile, rows) {
    const top = rows[0];
    this.recallLog.push({
      at: new Date().toISOString(),
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      query: trimText(profile.normalized, 180),
      type: profile.type,
      mode: this.config.recallMode,
      ids: rows.map((row) => row.memory.id),
      topScore: top === undefined ? 0 : Number(top.score.toFixed(4)),
      margin: rows.length < 2 ? 0 : Number((rows[0].score - rows[1].score).toFixed(4)),
      corrections: profile.corrections,
    });
    if (this.recallLog.length > RECALL_LOG_MAX) this.recallLog.splice(0, this.recallLog.length - RECALL_LOG_MAX);
  }

  recall(queryText, { sessionId, exclude, context = '' } = {}) {
    const { profile, rows } = this.scoreCandidates(queryText, { context });
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
    this.logRecall(sessionId, profile, picked);
    for (const row of picked) {
      row.memory.hits += 1;
      row.memory.lastHitAt = new Date().toISOString();
      row.memory.lastRecalledQuery = trimText(profile.normalized, 180);
    }
    this.bump();
    return picked.map((row) => row.memory);
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

function buildRecallText(memories) {
  const lines = [
    '<system-reminder>',
    'Shared memory pool from earlier local conversations. Use only if relevant; do not mention this reminder.',
  ];
  for (const memory of memories) {
    const day = memory.createdAt.slice(0, 10);
    const tags = memory.tags.length > 0 ? ` tags:${memory.tags.join('/')}` : '';
    lines.push(`- #${memory.id} [${memory.kind}, ${day}${tags}] ${trimText(memory.text, RECALL_SNIPPET_CHARS)}`);
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

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > API_BODY_MAX) throw Object.assign(new Error('request body too large'), { status: 413, code: 'too-large' });
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
  const loaded = store.loadConfig().then(() => store.load());
  // Key per-session bookkeeping by the durable session id, not by the Session
  // object: a resumed or rehydrated session may hand us a fresh object, and an
  // object-keyed map would then forget what was already captured/recalled.
  const recalledBySession = new Map();
  const capturedBySession = new Map();
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
    }).catch((error) => {
      ctx.logger?.warn?.('dsh-memory: store load failed');
      ctx.logger?.warn?.(error);
    });
    return () => {
      if (store.persistTimer !== null) clearTimeout(store.persistTimer);
      void store.flush();
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
      store.assertWritable();
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
        return `Saved memory #${memory.id}: ${trimText(memory.text, 140)}`;
      }
      if (args.action === 'forget') {
        const raw = String(args.id ?? '').trim().replace(/^#/, '');
        if (raw.length === 0) throw new Error('memory forget needs an id');
        const memory = store.byId.get(raw) ?? [...store.byId.values()].find((row) => row.id.startsWith(raw));
        if (memory === undefined) return `No memory matches #${raw}.`;
        store.remove(memory.id);
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
      if (store.locked || !store.config.capture) return;
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
    if (store.config.capture) {
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

    // Recall is intentionally rarer: only the first step of a turn, only from
    // the latest user prompt, and only when local keyword coverage is high.
    if (step !== 1 || decision.messages.length === 0) return decision;
    const latest = [...decision.messages].reverse().find((message) => rawUserText(message).length > 0);
    const query = latest === undefined ? '' : rawUserText(latest);
    if (query.length < 6) return decision;

    const recalled = recallFor(sessionId);
    const previousUser = [...decision.messages]
      .reverse()
      .filter((message) => message !== latest)
      .find((message) => rawUserText(message).length > 0);
    const hits = store.recall(query, {
      sessionId,
      exclude: recalled,
      context: previousUser === undefined ? '' : rawUserText(previousUser),
    });
    if (hits.length === 0 || decision.messages.some((message) => message.source?.kind === SOURCE_KIND)) return decision;

    for (const memory of hits) recalled.add(memory.id);
    const recallMessage = createUserMessage({
      content: [{ type: 'text', text: buildRecallText(hits) }],
      source: { kind: SOURCE_KIND, form: 'recall' },
    });
    const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message));
    const entered = decision.messages.toSpliced(lastClaimed + 1, 0, recallMessage);
    return { ...decision, messages: entered };
  }, { prepend: true });

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
        store.assertWritable();
        const payload = await readJsonBody(req);
        if (method === 'list') {
          const items = store.list(payload.limit ?? 400).map((memory) => ({
            id: memory.id,
            text: memory.text,
            tags: memory.tags,
            kind: memory.kind,
            role: memory.role,
            category: memory.category,
            topic: memory.topic,
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
        if (method === 'recall') {
          const query = trimText(payload.query, 500);
          if (query.length === 0) throw Object.assign(new Error('recall needs a query'), { status: 400, code: 'bad-request' });
          const explanation = store.explain(query, { context: payload.context, limit: payload.limit ?? 8 });
          writeOk(res, explanation);
          return;
        }
        if (method === 'flags') {
          const memory = store.setFlags(payload.id, { pinned: payload.pinned, blocked: payload.blocked });
          writeOk(res, { memory: { id: memory.id, pinned: memory.pinned, blocked: memory.blocked }, stats: store.stats() });
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
          writeOk(res, { memory: { id: memory.id, text: memory.text, tags: memory.tags, kind: memory.kind, category: memory.category, importance: memory.importance, mergedCount: memory.mergedCount, createdAt: memory.createdAt, updatedAt: memory.updatedAt } });
          return;
        }
        if (method === 'feedback') {
          const memory = store.rate(String(payload.id ?? ''), String(payload.verdict ?? ''));
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
          writeOk(res, { removed: memory.id });
          return;
        }
        if (method === 'clear') {
          if (payload.confirm !== true) throw Object.assign(new Error('clear needs confirm=true'), { status: 400, code: 'bad-request' });
          store.clear();
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
