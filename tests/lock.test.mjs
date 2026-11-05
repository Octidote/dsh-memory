import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callApi, closeStore, makeTempHome, openStore, removeHome } from './helper.mjs';

const home = await makeTempHome('dsh-memory-lock-');
process.env.DSH_HOME = home;
const lockFile = join(home, 'storages', 'dsh-memory', 'memories.json.lock');
const readLock = async () => JSON.parse(await readFile(lockFile, 'utf8'));
const writeLock = async (owner) => writeFile(lockFile, JSON.stringify(owner), 'utf8');

const first = await openStore();
const owner = await readLock();
assert.equal(owner.pid, process.pid);

// A live writer with an old lock must keep ownership. Age alone is not stale.
owner.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
await writeLock(owner);
const second = await openStore();
let stats = await callApi(second, 'list');
assert.equal(stats.stats.readOnly, true, 'live writer with 25h-old lock must remain read-only');
await assert.rejects(callApi(second, 'add', { text: 'must be rejected' }), (error) => error.code === 'read-only');
await closeStore(second);

// Same PID with an old lock is still alive: do not steal from another store.
owner.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
await writeLock(owner);
const third = await openStore();
stats = await callApi(third, 'list');
assert.equal(stats.stats.readOnly, true, 'same-PID live lock must not be stolen after 5 minutes');
await closeStore(third);

// The original writer still works after competing stores were closed.
await callApi(first, 'add', { text: 'original writer still works' });
await closeStore(first);

// A genuinely dead PID can be taken over.
await writeLock({
  pid: 999999,
  instance: 'dead-owner',
  createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
});
const fourth = await openStore();
stats = await callApi(fourth, 'list');
assert.equal(stats.stats.readOnly, false, 'dead PID lock should be taken over');
await callApi(fourth, 'add', { text: 'taken over cleanly' });
await closeStore(fourth);

await removeHome(home);
console.log(JSON.stringify({ ok: true, liveOldLock: 'read-only', samePidOldLock: 'read-only', deadPid: 'taken-over' }));
