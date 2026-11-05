import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-memory-jsonl-'));
process.env.DSH_HOME = DSH_HOME;
const INSTALL_HOME = process.env.DSH_MEMORY_HOME ?? join(homedir(), '.dsh');
const HOST = process.env.DSH_MEMORY_HOST ?? join(INSTALL_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-memory', 'lib', 'index.js');
const { apply } = await import(`${pathToFileURL(HOST).href}?t=${Date.now()}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCtx() {
  const disposers = [];
  let api;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    disposers,
    get api() { return api; },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
    on() { return () => {}; },
    systemPrompt: { section() { return () => {}; } },
    tools: { register() { return () => {}; } },
    webServer: { register(spec) { api = spec.handler; return () => {}; } },
    connection: { requestRejection() { return undefined; } },
  };
  return ctx;
}

async function close(ctx) {
  for (const dispose of ctx.disposers.reverse()) await dispose?.();
  await sleep(150);
}

async function call(ctx, method, payload = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = 'POST';
  req.url = `/dsh-memory/api/${method}`;
  let status = 0;
  let body = '';
  const res = {
    writeHead(value) { status = value; },
    end(chunk) { body += chunk?.toString?.() ?? ''; },
  };
  await ctx.api(req, res);
  const parsed = body.length > 0 ? JSON.parse(body) : {};
  if (status >= 400 || parsed.ok === false) {
    const error = new Error(parsed.error?.message ?? `HTTP ${status}`);
    error.code = parsed.error?.code;
    throw error;
  }
  return parsed.value;
}

async function openStore() {
  const ctx = makeCtx();
  apply(ctx);
  await sleep(250);
  return ctx;
}

const storeDir = join(DSH_HOME, 'storages', 'dsh-memory');
const storeFile = join(storeDir, 'memories.json');
const journalFile = `${storeFile}.journal.jsonl`;

let ctx = await openStore();
let list = await call(ctx, 'list', { limit: 20 });
if (list.stats.storage !== 'jsonl') throw new Error(`storage is not jsonl: ${list.stats.storage}`);
for (let index = 0; index < 8; index += 1) {
  await call(ctx, 'add', { text: `journal record ${index} unique-${Math.random().toString(36).slice(2)}`, tags: 'test,jsonl' });
}
await sleep(700);
const journalRaw = await readFile(journalFile, 'utf8');
const journalLines = journalRaw.trim().split('\n').filter(Boolean);
if (journalLines.length < 8) throw new Error(`expected at least 8 journal lines, got ${journalLines.length}`);
await close(ctx);

ctx = await openStore();
list = await call(ctx, 'list', { limit: 200 });
if (list.stats.count < 8) throw new Error(`journal replay lost records: ${list.stats.count}`);
const beforeDelete = list.stats.count;
await call(ctx, 'delete', { id: list.items[0].id });
await call(ctx, 'add', { text: `journal after delete ${Math.random().toString(36).slice(2)}`, tags: 'test,jsonl' });
await sleep(700);
await close(ctx);

ctx = await openStore();
list = await call(ctx, 'list', { limit: 200 });
if (list.stats.count !== beforeDelete) throw new Error(`delete/add replay mismatch: ${list.stats.count} vs ${beforeDelete}`);
await close(ctx);

await writeFile(journalFile, '{"partial":', { encoding: 'utf8', flag: 'a' });
ctx = await openStore();
list = await call(ctx, 'list', { limit: 200 });
if (list.stats.locked) throw new Error('torn final journal line locked the store');
if (list.stats.count !== beforeDelete) throw new Error(`torn final line affected replay: ${list.stats.count}`);
await close(ctx);

ctx = await openStore();
for (let index = 0; index < 210; index += 1) {
  await call(ctx, 'add', { text: `compaction record ${index} ${Math.random().toString(36).slice(2)}`, tags: 'test,compact' });
}
await sleep(1500);
const compactList = await call(ctx, 'list', { limit: 1000 });
// Each API write is persisted before returning, so compaction can happen at
// 200 events and leave the tail after that threshold in the journal. The
// invariant is that the journal stays below the compaction threshold.
if (compactList.stats.journalEntries >= 200) {
  throw new Error(`journal was not compacted: ${compactList.stats.journalEntries}`);
}
const journalAfter = await readFile(journalFile, 'utf8');
if (journalAfter.trim().split('\n').filter(Boolean).length >= 200) {
  throw new Error('journal was not compacted');
}
const snapshotRaw = await readFile(storeFile, 'utf8');
if (!snapshotRaw.startsWith('{"format":"dsh-memory"')) throw new Error('compacted snapshot is not an encrypted envelope');
await close(ctx);

ctx = await openStore();
const finalList = await call(ctx, 'list', { limit: 1000 });
if (finalList.stats.count !== compactList.stats.count) throw new Error(`compaction lost records: ${finalList.stats.count} vs ${compactList.stats.count}`);
await close(ctx);

// Crash after snapshot rename but before journal truncate: replaying the old
// journal must be idempotent because every event is at or below the snapshot revision.
const currentJournal = await readFile(journalFile, 'utf8');
await writeFile(journalFile, currentJournal + journalLines.join('\n') + '\n', { encoding: 'utf8' });
ctx = await openStore();
const recovered = await call(ctx, 'list', { limit: 1000 });
if (recovered.stats.count !== finalList.stats.count) {
  throw new Error(`stale journal replay duplicated records: ${recovered.stats.count} vs ${finalList.stats.count}`);
}
await close(ctx);
const snapshotInfo = await stat(storeFile);

console.log(JSON.stringify({
  ok: true,
  linesAfterBatch: journalLines.length,
  recordsAfterReplay: beforeDelete,
  compactedRecords: compactList.stats.count,
  revision: finalList.stats.revision,
  storage: finalList.stats.storage,
  snapshotBytes: snapshotInfo.size,
}, null, 2));
await rm(DSH_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
