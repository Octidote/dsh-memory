import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'Octidote/dsh-memory';
const ASSET = 'dsh-memory-update.json';
const MAX_BYTES = 4 * 1024 * 1024;
const CHECK_INTERVAL = 15 * 60 * 1000;
const REQUIRED_FILES = [
  'package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js',
  'lib/update.js', 'lib/graph3d.html', 'lib/graph3d.css', 'lib/graph3d.js',
];
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function isNewer(next, current) {
  if (!VERSION.test(next) || !VERSION.test(current)) return false;
  const installed = current.split('.').map(Number);
  const difference = next.split('.').map((part, index) => Number(part) - installed[index]);
  return difference.find((value) => value !== 0) > 0;
}

export function validateUpdate(bundle, version) {
  const files = bundle?.files;
  if (bundle?.format !== 1 || files === null || typeof files !== 'object' || Array.isArray(files)
    || !REQUIRED_FILES.every((file) => Object.hasOwn(files, file))
    || !Object.entries(files).every(([file, content]) => typeof content === 'string'
      && (REQUIRED_FILES.includes(file) || /^lib\/[a-z0-9][a-z0-9._-]*\.(?:js|css|html)$/i.test(file)))
    || new Set(Object.keys(files).map((file) => file.toLowerCase())).size !== Object.keys(files).length) {
    throw new Error('更新包文件清单无效');
  }
  const manifest = JSON.parse(files['package.json']);
  if (manifest.name !== 'dsh-memory' || manifest.version !== version
    || manifest.main !== 'lib/index.js' || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('更新包与发布版本不匹配');
  }
  return files;
}

async function readAsset(response, size) {
  if (!response.ok || response.body === null) throw new Error(`下载更新失败（HTTP ${response.status}）`);
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > size) throw new Error('更新包超出发布大小');
    chunks.push(chunk);
  }
  if (received !== size) throw new Error('更新包下载不完整');
  return Buffer.concat(chunks);
}

async function replacePlugin(root, files, installedVersion) {
  const parent = dirname(root);
  if (basename(root) !== 'dsh-memory' || basename(parent) !== 'node_modules') {
    throw new Error('请在 DSH 已安装的插件中更新');
  }
  const work = join(parent, '.dsh-memory-update');
  const stage = join(work, 'next');
  const backup = join(work, 'previous');
  await mkdir(work);
  let keepBackup = false;
  let installed = false;
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== 'dsh-memory' || manifest.version !== installedVersion) {
      throw new Error('磁盘上的插件版本已变化，请重启 DSH');
    }
    await mkdir(join(stage, 'lib'), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(stage, file), content, { flag: 'wx' });
    }
    await rename(root, backup);
    try {
      await rename(stage, root);
      installed = true;
    } catch (error) {
      try {
        await rename(backup, root);
      } catch {
        keepBackup = true;
        throw new Error(`更新恢复失败，旧插件保存在 ${backup}`, { cause: error });
      }
      throw error;
    }
  } finally {
    if (!keepBackup) {
      await rm(work, { recursive: true, force: true }).catch((error) => {
        if (!installed) throw error;
      });
    }
  }
}

export function createUpdater({
  root = resolve(fileURLToPath(new URL('../', import.meta.url))),
  request = globalThis.fetch,
} = {}) {
  const current = readFile(join(root, 'package.json'), 'utf8').then((text) => JSON.parse(text).version);
  let lastCheck = 0;
  let lookup;
  let installing;
  let pendingVersion = null;

  async function latest(currentVersion) {
    const response = await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-memory' },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
    const release = await response.json();
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (release.draft || release.prerelease || !isNewer(version, currentVersion)) return null;
    const tag = release.tag_name;
    const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/${ASSET}`;
    const asset = release.assets?.find((item) => item.name === ASSET && item.state === 'uploaded'
      && item.browser_download_url === url && /^sha256:[a-f0-9]{64}$/.test(item.digest)
      && Number.isInteger(item.size) && item.size > 0 && item.size <= MAX_BYTES);
    return asset ? { version, url, size: asset.size, digest: asset.digest.slice(7) } : null;
  }

  function check(currentVersion) {
    if (lookup === undefined || Date.now() - lastCheck >= CHECK_INTERVAL) {
      lastCheck = Date.now();
      lookup = latest(currentVersion);
    }
    return lookup;
  }

  return {
    async status() {
      const currentVersion = await current;
      const release = pendingVersion === null ? await check(currentVersion) : null;
      return { currentVersion, availableVersion: release?.version ?? null, pendingVersion };
    },
    async install(expectedVersion) {
      if (pendingVersion !== null) return { pendingVersion };
      if (installing !== undefined) return installing;
      installing = (async () => {
        const currentVersion = await current;
        const release = await check(currentVersion);
        if (release === null || release.version !== expectedVersion) {
          throw new Error('可用版本已变化，请重新检查更新');
        }
        const response = await request(release.url, { signal: AbortSignal.timeout(30000) });
        const bytes = await readAsset(response, release.size);
        if (createHash('sha256').update(bytes).digest('hex') !== release.digest) {
          throw new Error('更新包校验失败');
        }
        const files = validateUpdate(JSON.parse(bytes.toString('utf8')), release.version);
        await replacePlugin(root, files, currentVersion);
        pendingVersion = release.version;
        return { pendingVersion };
      })();
      try {
        return await installing;
      } finally {
        installing = undefined;
      }
    },
  };
}
