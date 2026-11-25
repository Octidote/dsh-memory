import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater, validateUpdate } from '../lib/update.js';

const home = await mkdtemp(join(tmpdir(), 'dsh-memory-update-'));
try {
  const root = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-memory');
  const storage = join(home, 'storages', 'dsh-memory');
  await mkdir(root, { recursive: true });
  await mkdir(storage, { recursive: true });
  const oldManifest = JSON.stringify({ name: 'dsh-memory', version: '0.17.0' });
  const manifest = join(root, 'package.json');
  const memory = join(storage, 'memories.json');
  await writeFile(manifest, oldManifest);
  await writeFile(memory, 'local memory');
  const bundlePath = join(home, 'dsh-memory-update.json');
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/pack-update.mjs', import.meta.url)), bundlePath]);
  const bytes = await readFile(bundlePath);
  const bundle = JSON.parse(bytes);
  const { version } = JSON.parse(bundle.files['package.json']);
  const url = `https://github.com/Octidote/dsh-memory/releases/download/v${version}/dsh-memory-update.json`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const release = {
    tag_name: 'v' + version,
    assets: [{
      name: 'dsh-memory-update.json', state: 'uploaded', browser_download_url: url,
      size: bytes.length, digest: 'sha256:' + digest,
    }],
  };
  let downloads = 0;
  let checks = 0;
  let damaged = true;
  const request = async (address) => {
    if (address === url) {
      downloads += 1;
      const download = Buffer.from(bytes);
      if (damaged) download[0] ^= 1;
      return new Response(download);
    }
    assert.equal(address, 'https://api.github.com/repos/Octidote/dsh-memory/releases/latest');
    checks += 1;
    return Response.json(release);
  };
  const updater = createUpdater({ root, request });
  assert.deepEqual(await updater.status(), { currentVersion: '0.17.0', availableVersion: version, pendingVersion: null });
  assert.equal(downloads, 0);
  await assert.rejects(updater.install('99.0.0'), /可用版本已变化/);
  await assert.rejects(updater.install(version), /校验失败/);
  assert.equal(await readFile(manifest, 'utf8'), oldManifest);
  assert.throws(() => validateUpdate({ ...bundle, files: { ...bundle.files, 'lib/../../outside.js': '' } }, version), /文件清单无效/);
  assert.throws(() => validateUpdate(bundle, '99.0.0'), /发布版本不匹配/);

  damaged = false;
  const results = await Promise.all([updater.install(version), updater.install(version)]);
  assert.deepEqual(results, [{ pendingVersion: version }, { pendingVersion: version }]);
  assert.equal(downloads, 2);
  assert.equal(checks, 1);
  assert.deepEqual(await updater.status(), { currentVersion: '0.17.0', availableVersion: null, pendingVersion: version });
  for (const [path, contents] of Object.entries(bundle.files)) {
    assert.equal(await readFile(join(root, path), 'utf8'), contents);
  }
  assert.equal(await readFile(memory, 'utf8'), 'local memory');
  const restarted = createUpdater({ root, request });
  assert.deepEqual(await restarted.status(), { currentVersion: version, availableVersion: null, pendingVersion: null });
  const noRelease = createUpdater({ root, request: async () => new Response(null, { status: 404 }) });
  assert.equal((await noRelease.status()).availableVersion, null);
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, update: true, invalidAssetRejected: true, localMemoryPreserved: true }));
