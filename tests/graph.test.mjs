import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-memory-graph3d-'));
process.env.DSH_HOME = DSH_HOME;
const INSTALL_HOME = process.env.DSH_MEMORY_HOME ?? join(homedir(), '.dsh');
const HOST = process.env.DSH_MEMORY_HOST ?? join(INSTALL_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-memory', 'lib', 'index.js');
const { apply } = await import(`${pathToFileURL(HOST).href}?t=${Date.now()}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const routes = new Map();
const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
  on() { return () => {}; },
  systemPrompt: { section() { return () => {}; } },
  tools: { register() { return () => {}; } },
  webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {}; } },
  connection: { requestRejection() { return undefined; } },
};
apply(ctx);
await sleep(250);

async function call(method, payload = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = 'POST';
  req.url = `/dsh-memory/api/${method}`;
  let status = 0;
  let body = '';
  const res = {
    writeHead(value) { status = value; },
    end(chunk) { body += chunk?.toString?.() ?? ''; },
  };
  await routes.get('/dsh-memory/api')(req, res);
  const parsed = body.length > 0 ? JSON.parse(body) : {};
  if (status >= 400 || parsed.ok === false) throw new Error(parsed.error?.message ?? `HTTP ${status}`);
  return parsed.value;
}

async function get(path) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = path;
  let status = 0;
  let type = '';
  let body = '';
  const res = {
    writeHead(value, headers = {}) { status = value; type = headers['content-type'] ?? ''; },
    end(chunk) { body += chunk?.toString?.() ?? ''; },
  };
  await routes.get(path)(req, res);
  return { status, type, body };
}

const textA = '项目使用 Node.js 24 和 Windows 11，插件数据保存在本机，发布前要检查加密和备份。';
const textB = '发布插件前检查本机加密存储和备份，运行环境是 Windows 11。';
const textC = '主人喜欢深色主题和简洁界面，不喜欢堆太多装饰。';
await call('add', { text: textA, tags: '项目,环境,node' });
await call('add', { text: '项目使用 Node.js 24 和 Windows 11，插件数据保存在本机，发布前必须检查加密和备份。', tags: '项目,环境,node' });
await call('add', { text: textB, tags: '项目,发布,备份' });
await call('add', { text: textC, tags: '偏好,界面,主题' });
await sleep(450);

const graph = await call('graph', { limit: 50 });
if (!Array.isArray(graph.nodes) || graph.nodes.length !== 3) throw new Error(`nodes ${graph.nodes?.length}`);
if (!Array.isArray(graph.edges) || graph.edges.length < 1) throw new Error('no weighted edges');
for (const edge of graph.edges) {
  if (!(edge.weight > 0 && edge.weight <= 1)) throw new Error(`bad weight ${edge.weight}`);
}
const duplicate = graph.nodes.find((node) => node.mergedCount > 0);
if (duplicate === undefined) throw new Error('mergedCount not exposed');
if (!(duplicate.mentions >= 2)) throw new Error(`mentions not weighted: ${duplicate.mentions}`);
if (!graph.categories.every((category) => typeof category.color === 'string')) throw new Error('category colors missing');

const html = await get('/dsh-memory/view');
const css = await get('/dsh-memory/view.css');
const js = await get('/dsh-memory/view.js');
if (html.status !== 200 || !html.body.includes('记忆图谱') || !html.body.includes('/dsh-memory/view.js')) throw new Error('view html missing');
if (css.status !== 200 || !css.body.includes('.legend')) throw new Error('view css missing');
if (js.status !== 200 || !js.body.includes('__DSM_GRAPH__')) throw new Error('view js missing');
if (!js.body.includes('edgeWidth')) throw new Error('edge thickness hook missing');

for (const dispose of disposers.reverse()) await dispose?.();
await sleep(100);
await rm(DSH_HOME, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  maxWeight: Math.max(...graph.edges.map((edge) => edge.weight)),
  mentions: duplicate.mentions,
  categories: graph.categories.length,
  view: { html: html.status, css: css.status, js: js.status },
}));
