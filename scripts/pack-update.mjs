import { readFile, readdir, writeFile } from 'node:fs/promises';
import { validateUpdate } from '../lib/update.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: npm run pack:update -- <path>/dsh-memory-update.json');

const root = new URL('../', import.meta.url);
const entries = await readdir(new URL('lib/', root), { withFileTypes: true });
const paths = ['package.json', 'cordis.patch.yml', ...entries.filter((entry) => entry.isFile()).map((entry) => 'lib/' + entry.name)];
const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [
  path,
  await readFile(new URL(path, root), 'utf8'),
])));
const bundle = { format: 1, files };
const { version } = JSON.parse(files['package.json']);
validateUpdate(bundle, version);
await writeFile(output, JSON.stringify(bundle), { flag: 'wx' });
console.log(`Packaged dsh-memory v${version} -> ${output}`);
