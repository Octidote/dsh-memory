/**
 * Security / compression regression for dsh-memory.
 *
 * Imports the installed desktop copy so @deepseek-ai/* resolves exactly the way
 * DSH resolves it at runtime. Uses a throwaway DSH_HOME.
 */
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-memory-security-'));
process.env.DSH_HOME = DSH_HOME;

const INSTALL_HOME = process.env.DSH_MEMORY_HOME ?? join(homedir(), '.dsh');
const HOST = process.env.DSH_MEMORY_HOST ?? join(INSTALL_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-memory', 'lib', 'index.js');
const { apply } = await import(`${pathToFileURL(HOST).href}?t=${Date.now()}`);

function makeCtx() {
  const handlers = new Map();
  const tools = new Map();
  const disposers = [];
  return {
    handlers,
    tools,
    disposers,
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    systemPrompt: { section() { return () => {}; } },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {}; },
      get(name) { return tools.get(name); },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    webServer: { register() { return () => {}; } },
    connection: { requestRejection() { return undefined; } },
  };
}

function message(role, text, id, sourceKind) {
  return {
    id,
    role,
    source: { kind: sourceKind ?? (role === 'user' ? 'user' : 'model') },
    content: [{ type: 'text', text }],
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closeCtx = async (ctx) => {
  for (const dispose of ctx.disposers.reverse()) await dispose?.();
};

function decodeEnvelope(envelope, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('dsh-memory:v2'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

async function readCiphertext(file) {
  let raw = '';
  try {
    raw += await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    raw += await readFile(`${file}.journal.jsonl`, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return raw;
}

async function decryptStore(file, keyFile) {
  const key = await readFile(keyFile);
  let memories = [];
  let revision = 0;
  try {
    const snapshot = decodeEnvelope(JSON.parse(await readFile(file, 'utf8')), key);
    memories = Array.isArray(snapshot.memories) ? snapshot.memories : [];
    revision = Number(snapshot.revision) || 0;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let journal = '';
  try {
    journal = await readFile(`${file}.journal.jsonl`, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const line of journal.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event;
    try {
      event = decodeEnvelope(JSON.parse(trimmed), key);
    } catch {
      continue;
    }
    if (!(Number(event.revision) > revision)) continue;
    revision = Number(event.revision);
    if (event.op === 'clear') memories = [];
    else if (event.op === 'delete') memories = memories.filter((memory) => memory.id !== event.id);
    else if (event.op === 'put' && event.memory !== null && typeof event.memory === 'object') {
      memories = memories.filter((memory) => memory.id !== event.memory.id && memory.hash !== event.memory.hash);
      memories.push(event.memory);
    }
  }
  return { memories };
}

const ctx = makeCtx();
apply(ctx);
await wait(100);

const storeFile = join(DSH_HOME, 'storages', 'dsh-memory', 'memories.json');
const keyFile = join(DSH_HOME, 'storages', 'dsh-memory', 'key.bin');

const longUser = [
  '我更喜欢深色主题，界面要简洁克制，不要堆太多装饰。',
  '我的临时 API key 是 sk-abcdefghijklmnop1234567890，密码：hunter2。',
  '这些是持久偏好，请记住，不要每次都问我。',
  '后面还有很多重复的说明，用来验证摘要而不是全文保存。'.repeat(8),
].join('');

const user1 = message('user', longUser, 'u1', 'user');
const preStep = ctx.handlers.get('agent/pre-step')[0];
const next = async () => ({ kind: 'enter', messages: [user1] });
const decision1 = await preStep({
  agent: { session: { id: 's1', header: { cwd: 'C:/work' } }, inbox: {} },
  messages: [user1],
  step: 1,
  signal: { aborted: false },
}, next);
await wait(700);

const rawStore = await readCiphertext(storeFile);
if (!rawStore.startsWith('{"format":"dsh-memory"')) throw new Error('store is not encrypted envelope');
if (rawStore.includes('sk-abcdefghijklmnop') || rawStore.includes('hunter2') || rawStore.includes('深色主题')) {
  throw new Error('plaintext leaked into store file');
}
const key = await readFile(keyFile);
if (key.length !== 32) throw new Error('key size is not 32 bytes');

const decoded = await decryptStore(storeFile, keyFile);
const first = decoded.memories[0];
if (first === undefined) throw new Error('user message was not captured');
if (first.text.length > 420) throw new Error(`summary is too long: ${first.text.length}`);
if (first.compressed !== true) throw new Error('long user message is not marked compressed');
if (first.text.includes('sk-abcdefghijklmnop') || first.text.includes('hunter2')) throw new Error('secret not redacted');
const allText = decoded.memories.map((row) => `${row.text} ${(row.tags ?? []).join(' ')}`).join('\n');
if (allText.includes('sk-abcdefghijklmnop') || allText.includes('hunter2')) throw new Error('secret leaked into another field');

const sessionEvent = ctx.handlers.get('session/event')[0];
sessionEvent({ id: 's1', header: { cwd: 'C:/work' } }, {
  type: 'assistant/message',
  data: { message: message('assistant', '好的', 'a0', 'model') },
});
await wait(100);

const longAssistant = '结论：建议使用本地摘要而不是全文保存，因为记忆池只负责提醒关键事实。' + '另外，召回只注入两条摘要，避免 token 浪费。'.repeat(12);
sessionEvent({ id: 's1', header: { cwd: 'C:/work' } }, {
  type: 'assistant/message',
  data: { message: message('assistant', longAssistant, 'a1', 'model') },
});
await wait(700);

const afterAssistant = await decryptStore(storeFile, keyFile);
if (afterAssistant.memories.length !== 1) throw new Error(`user+assistant should merge into one episode, got ${afterAssistant.memories.length} memories`);
const assistantMemory = afterAssistant.memories[0];
if (assistantMemory.kind !== 'episode' || assistantMemory.hasReply !== true) throw new Error('long assistant reply did not merge into an episode');
if (!assistantMemory.text.includes('助手：')) throw new Error('episode is missing the assistant summary');
if (assistantMemory.text.length > 760 || assistantMemory.compressed !== true) throw new Error('episode summary bounds failed');

const user2 = message('user', '之前说的深色主题偏好是什么？', 'u2', 'user');
const next2 = async () => ({ kind: 'enter', messages: [user2] });
const decision2 = await preStep({
  agent: { session: { id: 's2', header: { cwd: 'C:/work' } }, inbox: {} },
  messages: [user2],
  step: 1,
  signal: { aborted: false },
}, next2);
if (!decision2.messages.some((row) => row.source?.kind === 'plugin:dsh-memory')) {
  console.error('summary:', first.text, 'tags:', first.tags);
  throw new Error('relevant memory was not recalled');
}
await closeCtx(ctx);

const ctx2 = makeCtx();
apply(ctx2);
await wait(100);
const search = ctx2.tools.get('memory');
const result = await search.execute({ action: 'search', query: '深色主题' }, { agent: { session: { id: 's3' } } });
if (!String(result).includes('深色主题')) throw new Error('search after reload failed');
await closeCtx(ctx2);

const stats = JSON.parse(await readCiphertext(storeFile).then((raw) => raw.split('\n').find((line) => line.trim().length > 0) ?? '{}'));
if (stats.encrypted !== true) throw new Error('envelope flag missing');

// Legacy plaintext stores must be adopted then rewritten as ciphertext.
try {
  await rename(storeFile, `${storeFile}.enc`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await rm(`${storeFile}.journal.jsonl`, { force: true });
await rm(keyFile, { force: true });
await writeFile(storeFile, JSON.stringify({
  version: 1,
  memories: [{
    id: 'legacy1',
    text: '用户：旧版明文记忆，必须在首次加载后立即加密。',
    tags: ['旧版'],
    kind: 'note',
    importance: 0.8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }],
}), 'utf8');
const ctxLegacy = makeCtx();
apply(ctxLegacy);
await wait(900);
const migratedRaw = await readFile(storeFile, 'utf8');
if (!migratedRaw.startsWith('{"format":"dsh-memory"')) throw new Error('legacy store was not encrypted');
if (migratedRaw.includes('旧版明文记忆')) throw new Error('legacy plaintext remained in store');
const migrated = await decryptStore(storeFile, keyFile);
if (!migrated.memories.some((row) => row.id === 'legacy1')) throw new Error('legacy record was lost during migration');
await closeCtx(ctxLegacy);

// Missing key must lock the store without destroying the encrypted file.
await rename(keyFile, `${keyFile}.bak`);
const ctx3 = makeCtx();
apply(ctx3);
await wait(100);
let locked = false;
try {
  await ctx3.tools.get('memory').execute({ action: 'search', query: '深色主题' }, { agent: { session: { id: 's4' } } });
} catch (error) {
  locked = error?.code === 'locked' || String(error?.message).includes('locked') || String(error?.message).includes('key');
}
if (!locked) throw new Error('missing key did not lock the store');
await closeCtx(ctx3);
await rename(`${keyFile}.bak`, keyFile);

await rm(DSH_HOME, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  encrypted: true,
  firstText: first.text,
  firstLength: first.text.length,
  assistantLength: assistantMemory.text.length,
  memoryCount: afterAssistant.memories.length,
  recall: true,
  lockedWithoutKey: true,
}, null, 2));
