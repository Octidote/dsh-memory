/**
 * Install dsh-memory into a DSH profile.
 *
 * The plugin must be a real directory under <profile>/node_modules: DSH's ESM
 * interception only covers real paths inside the profile, so a symlink/junction
 * to this source checkout would fail to resolve @deepseek-ai/* at boot.
 *
 * Usage: node scripts/install.mjs [profile]   (default: desktop)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..');
const profileName = process.argv[2] ?? 'desktop';
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const profile = join(dshHome, 'profiles', profileName);
const target = join(profile, 'node_modules', 'dsh-memory');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const entry of ['package.json', 'cordis.patch.yml']) {
  await cp(join(source, entry), join(target, entry));
}
await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true });

const manifestPath = join(profile, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes('dsh-memory')) manifest.dsh.profile.bundles.push('dsh-memory');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`installed dsh-memory -> ${target}`);
console.log(`profile bundles: ${manifest.dsh.profile.bundles.length}`);
console.log('restart DeepSeek Harness to load the plugin.');
