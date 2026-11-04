/**
 * dsh-memory — one shared memory pool for every local DSH conversation.
 *
 * Host half: a small JSON-backed store, zero-token conversation capture,
 * bounded automatic recall, a model-facing `memory` tool, and the
 * `/dsh-memory/api` routes used by the sidebar panel.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

export const name = 'dsh-memory';
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection'];

const STORE_VERSION = 1;
const MAX_MEMORIES = 2500;
const CAPTURE_MAX_CHARS = 600;
const NOTE_MAX_CHARS = 4000;
const RECALL_MAX_ITEMS = 2;
const RECALL_SNIPPET_CHARS = 180;
const RECALL_MESSAGE_MAX_CHARS = 760;
const RECALL_MIN_COVERAGE = 0.34;
const RECALL_MIN_SCORE = 1.2;
const API_PREFIX = '/dsh-memory/api';
const API_BODY_MAX = 64 * 1024;
const SOURCE_KIND = 'plugin:dsh-memory';

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

function createMemory({ text, tags, kind = 'note', importance = 0.7, source = {}, hash, category }) {
  const now = new Date().toISOString();
  const normalizedTags = normalizeTags(tags);
  const cleanText = trimText(text, kind === 'note' ? NOTE_MAX_CHARS : CAPTURE_MAX_CHARS);
  return {
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    text: cleanText,
    tags: normalizedTags,
    kind,
    category: normalizeCategory(category) ?? classifyCategory(cleanText, normalizedTags, kind),
    importance: Math.max(0, Math.min(1, Number(importance) || 0)),
    hash: hash ?? hashText(text),
    createdAt: now,
    updatedAt: now,
    source: {
      sessionId: source.sessionId,
      cwd: source.cwd,
    },
    hits: 0,
    lastHitAt: null,
  };
}

class MemoryStore {
  constructor(file) {
    this.file = file;
    this.memories = [];
    this.byId = new Map();
    this.byHash = new Map();
    this.postings = new Map();
    this.docLengths = new Map();
    this.totalLength = 0;
    this.writeChain = Promise.resolve();
    this.persistTimer = null;
    this.version = 0;
    this.ready = false;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.memories) ? parsed.memories : [];
      for (const row of rows) this.adopt(row);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt store must not take the whole plugin down: keep a copy and start empty.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // ignore
        }
      }
    }
    this.ready = true;
    this.rebuildIndex();
  }

  adopt(row) {
    if (row === null || typeof row !== 'object') return;
    const text = trimText(row.text, NOTE_MAX_CHARS);
    if (text.length === 0) return;
    const kind = row.kind === 'dialogue' ? 'dialogue' : 'note';
    const tags = normalizeTags(row.tags);
    const memory = {
      id: typeof row.id === 'string' && row.id.length > 0 ? row.id : randomUUID().replace(/-/g, '').slice(0, 8),
      text,
      tags,
      kind,
      category: normalizeCategory(row.category) ?? classifyCategory(text, tags, kind),
      importance: Math.max(0, Math.min(1, Number(row.importance) || 0.6)),
      hash: typeof row.hash === 'string' && row.hash.length > 0 ? row.hash : hashText(text),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
      source: {
        sessionId: typeof row.source?.sessionId === 'string' ? row.source.sessionId : undefined,
        cwd: typeof row.source?.cwd === 'string' ? row.source.cwd : undefined,
      },
      hits: Number.isFinite(row.hits) ? row.hits : 0,
      lastHitAt: typeof row.lastHitAt === 'string' ? row.lastHitAt : null,
    };
    if (this.byId.has(memory.id) || this.byHash.has(memory.hash)) return;
    this.memories.push(memory);
    this.byId.set(memory.id, memory);
    this.byHash.set(memory.hash, memory);
  }

  rebuildIndex() {
    this.postings.clear();
    this.docLengths.clear();
    this.totalLength = 0;
    for (const memory of this.memories) this.indexMemory(memory);
    this.bump();
  }

  indexMemory(memory) {
    const tokens = tokenize(`${memory.text} ${memory.tags.join(' ')}`);
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
    for (const bucket of this.postings.values()) bucket.delete(memory.id);
  }

  bump() {
    this.version += 1;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 300);
    this.persistTimer.unref?.();
  }

  async flush() {
    const rows = this.memories.map((memory) => ({ ...memory }));
    const payload = JSON.stringify({ version: STORE_VERSION, updatedAt: new Date().toISOString(), memories: rows }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, this.file);
    }).catch(() => {});
    await this.writeChain;
  }

  add({ text, tags, kind = 'note', importance, source, hash }) {
    const clean = trimText(text, kind === 'note' ? NOTE_MAX_CHARS : CAPTURE_MAX_CHARS);
    if (clean.length === 0) return undefined;
    const contentHash = hash ?? hashText(clean);
    const existing = this.byHash.get(contentHash);
    if (existing !== undefined) {
      existing.updatedAt = new Date().toISOString();
      this.bump();
      return existing;
    }
    const memory = createMemory({ text: clean, tags: tags?.length ? tags : autoTags(clean), kind, importance: importance ?? (kind === 'note' ? 0.8 : 0.4), source, hash: contentHash });
    this.memories.push(memory);
    this.byId.set(memory.id, memory);
    this.byHash.set(memory.hash, memory);
    this.indexMemory(memory);
    this.evict();
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
      return memory.importance * 0.45 + recency * 0.25 + noteBoost;
    };
    const sorted = [...this.memories].sort((left, right) => weight(left) - weight(right));
    const remove = sorted.slice(0, this.memories.length - MAX_MEMORIES);
    for (const memory of remove) this.remove(memory.id, { persist: false });
    this.bump();
  }

  remove(id, { persist = true } = {}) {
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
    this.memories = [];
    this.byId.clear();
    this.byHash.clear();
    this.rebuildIndex();
  }

  scoreCandidates(queryText) {
    const queryTokens = [...new Set(tokenize(queryText))].slice(0, 28);
    if (queryTokens.length === 0) return [];
    const total = Math.max(1, this.memories.length);
    const averageLength = Math.max(1, this.totalLength / total);
    const candidates = new Map();
    for (const token of queryTokens) {
      const bucket = this.postings.get(token);
      if (bucket === undefined) continue;
      const idf = Math.log(1 + (total - bucket.size + 0.5) / (bucket.size + 0.5));
      for (const [id, termFrequency] of bucket) {
        const length = this.docLengths.get(id) ?? averageLength;
        const bm25 = (termFrequency * 2.2) / (termFrequency + 1.2 * (0.25 + 0.75 * length / averageLength));
        const row = candidates.get(id) ?? { id, matched: 0, score: 0, bestIdf: 0 };
        row.matched += 1;
        row.score += idf * bm25;
        row.bestIdf = Math.max(row.bestIdf, idf);
        candidates.set(id, row);
      }
    }
    const rows = [];
    for (const candidate of candidates.values()) {
      const memory = this.byId.get(candidate.id);
      if (memory === undefined) continue;
      const coverage = candidate.matched / queryTokens.length;
      if (candidate.matched < Math.min(2, queryTokens.length) && candidate.bestIdf < 3.2) continue;
      if (coverage < 0.28) continue;
      const tagHits = memory.tags.filter((tag) => queryTokens.includes(tag)).length;
      const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updatedAt)) / 86400000);
      const recency = Math.max(0, 1 - ageDays / 365);
      const score = candidate.score * (0.55 + 0.45 * coverage) + Math.min(0.35, tagHits * 0.12) + memory.importance * 0.22 + recency * 0.08;
      rows.push({ memory, score, coverage, matched: candidate.matched });
    }
    return rows.sort((left, right) => right.score - left.score);
  }

  recall(queryText, { sessionId, exclude } = {}) {
    const scored = this.scoreCandidates(queryText);
    const picked = [];
    for (const row of scored) {
      const memory = row.memory;
      if (memory.source.sessionId !== undefined && memory.source.sessionId === sessionId) continue;
      if (exclude?.has(memory.id)) continue;
      if (row.coverage < RECALL_MIN_COVERAGE || row.score < RECALL_MIN_SCORE) continue;
      picked.push(memory);
      if (picked.length >= RECALL_MAX_ITEMS) break;
    }
    return picked;
  }

  search(queryText, limit = 5) {
    const scored = this.scoreCandidates(queryText);
    const seen = new Set();
    const rows = [];
    for (const row of scored) {
      if (row.score <= 0.01 || seen.has(row.memory.id)) continue;
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
    for (const memory of this.memories) {
      for (const tag of memory.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
      categories.set(memory.category, (categories.get(memory.category) ?? 0) + 1);
    }
    return {
      count: this.memories.length,
      notes: this.memories.filter((memory) => memory.kind === 'note').length,
      dialogues: this.memories.filter((memory) => memory.kind === 'dialogue').length,
      tags: tags.size,
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
 * Return the locally capturable text of one message. Only genuine typed
 * prompts and final model replies qualify: runtime context, skill catalogs,
 * time snapshots, tool results, plugin notices and tool-call chatter must
 * never pollute the shared memory pool.
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const kind = message.source?.kind;
  if (message.role === 'user' && kind === 'user') {
    const raw = textBlocks(message);
    return raw.length === 0 ? '' : `用户：${raw}`;
  }
  if (message.role === 'assistant' && kind === 'model') {
    const blocks = Array.isArray(message.content) ? message.content : [];
    // Intermediate assistant turns that call tools are not durable knowledge.
    if (blocks.some((block) => block?.type === 'tool-call')) return '';
    const raw = textBlocks(message);
    return raw.length === 0 ? '' : `助手：${raw}`;
  }
  return '';
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
  const store = new MemoryStore(dshHomePath('storages', 'dsh-memory', 'memories.json'));
  const loaded = store.load();
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
    description: 'Shared local memory across conversations. search|save|forget; save only durable facts or preferences.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'save', 'forget'],
        description: 'search | save | forget',
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
        description: 'Memory id, with or without # (action=forget).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => textRender(value),
    },
    execute: async (args, exec) => {
      await loaded;
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
      const query = trimText(args.query ?? args.text, 500);
      if (query.length === 0) throw new Error('memory search needs a query');
      const rows = store.search(query, 6);
      if (rows.length === 0) return `No memories matched "${trimText(query, 80)}".`;
      return [
        `Found ${rows.length} memory${rows.length === 1 ? '' : 'ies'} for "${trimText(query, 80)}":`,
        ...rows.map((memory) => `- #${memory.id} [${memory.kind}/${CATEGORY_META[memory.category]?.label ?? memory.category}, ${formatDate(memory.createdAt)}${memory.tags.length ? `, tags:${memory.tags.join('/')}` : ''}] ${trimText(memory.text, 260)}`),
      ].join('\n');
    },
  }));

  // Capture final assistant replies as soon as they are appended, so the last
  // reply of a conversation is not lost when no next turn ever starts.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return;
    const message = event.data?.message;
    const text = messageText(message);
    if (text.length < 8) return;
    const raw = text.replace(/^助手：/, '').trim();
    if (raw.length === 0) return;
    const sessionId = session?.id;
    const captured = captureFor(sessionId);
    if (typeof message.id === 'string') captured.ids.add(message.id);
    void loaded.then(() => {
      store.add({
        text: trimText(text, CAPTURE_MAX_CHARS),
        tags: autoTags(raw),
        kind: 'dialogue',
        importance: 0.35,
        source: { sessionId, cwd: session?.header?.cwd },
      });
    }).catch(() => {});
  });

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    await loaded;

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
      const text = messageText(message);
      if (text.length < 8) return;
      const raw = text.replace(/^(用户|助手)：/, '').trim();
      if (raw.length === 0 || raw.startsWith('/')) return;
      fresh.push({ text, raw, role: message.role });
    };
    for (const message of decision.messages) visit(message);
    for (const message of messages) visit(message);
    for (const item of fresh) {
      store.add({
        text: trimText(item.text, CAPTURE_MAX_CHARS),
        tags: autoTags(item.raw),
        kind: 'dialogue',
        importance: item.role === 'assistant' ? 0.35 : 0.4,
        source,
      });
    }

    // Recall is intentionally rarer: only the first step of a turn, only from
    // the latest user prompt, and only when local keyword coverage is high.
    if (step !== 1 || decision.messages.length === 0) return decision;
    const latest = [...decision.messages].reverse().find((message) => rawUserText(message).length > 0);
    const query = latest === undefined ? '' : rawUserText(latest);
    if (query.length < 6) return decision;

    const recalled = recallFor(sessionId);
    const hits = store.recall(query, { sessionId, exclude: recalled });
    if (hits.length === 0 || decision.messages.some((message) => message.source?.kind === SOURCE_KIND)) return decision;

    for (const memory of hits) {
      recalled.add(memory.id);
      memory.hits += 1;
      memory.lastHitAt = new Date().toISOString();
    }
    store.bump();
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
        const payload = await readJsonBody(req);
        if (method === 'list') {
          const items = store.list(payload.limit ?? 400).map((memory) => ({
            id: memory.id,
            text: memory.text,
            tags: memory.tags,
            kind: memory.kind,
            category: memory.category,
            importance: memory.importance,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            hits: memory.hits,
            sessionId: memory.source.sessionId,
          }));
          writeOk(res, { items, stats: store.stats(), version: store.version });
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
          writeOk(res, { memory: { id: memory.id, text: memory.text, tags: memory.tags, kind: memory.kind, category: memory.category, importance: memory.importance, createdAt: memory.createdAt, updatedAt: memory.updatedAt } });
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
