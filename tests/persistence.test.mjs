import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { callApi, closeStore, makeTempHome, openStore, removeHome, sleep } from './helper.mjs';

const home = await makeTempHome('dsh-memory-persist-');
process.env.DSH_HOME = home;
const journal = join(home, 'storages', 'dsh-memory', 'memories.json.journal.jsonl');
const ctx = await openStore();
const tool = ctx.tools.get('memory');
const exec = { agent: { session: { id: 'persist-test', header: { cwd: home } } } };

const first = await tool.execute({ action: 'save', text: '持久化确认：这条在返回成功前必须已经写入日志。' }, exec);
assert.match(first, /^Saved memory #/);
let listed = await callApi(ctx, 'list');
assert.equal(listed.items.length, 1);
assert.ok(listed.stats.lastPersistAt, 'successful save must set lastPersistAt');

// Make the journal path a directory: the next append must fail. The tool must
// not report success, and the in-memory store must expose the failure.
await rm(journal, { force: true });
await mkdir(journal);
await assert.rejects(
  tool.execute({ action: 'save', text: '写入失败测试：这次落盘必须失败。' }, exec),
  (error) => error.code === 'persist-failed',
);
listed = await callApi(ctx, 'list');
assert.ok(listed.stats.persistError, 'failed write must be visible in stats');
assert.ok(listed.stats.persistFailures > 0);

// Removing the obstruction lets the scheduled retry flush the queued events.
await rm(journal, { recursive: true, force: true });
await sleep(6500);
listed = await callApi(ctx, 'list');
assert.equal(listed.stats.persistError, null);
assert.ok(listed.items.length >= 2, 'retry must persist queued events');
const retry = await tool.execute({ action: 'save', text: '恢复写入测试：日志路径已恢复正常。' }, exec);
assert.match(retry, /^Saved memory #/);
listed = await callApi(ctx, 'list');
assert.ok(listed.items.length >= 3);

await closeStore(ctx);
await removeHome(home);
console.log(JSON.stringify({ ok: true, savedBeforeReturn: true, failureRejected: true, retrySucceeded: true }));
