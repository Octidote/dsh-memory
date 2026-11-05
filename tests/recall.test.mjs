/**
 * Recall-quality functional test for dsh-memory 0.9.
 *
 * Covers hybrid/legacy modes, acronyms, typo correction, context hints,
 * episode capture, margin/MMR, explain/config/flags API, and pin/block.
 * Imports the physically installed mtest copy so @deepseek-ai/* resolves.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-memory-v9-'));
process.env.DSH_HOME = DSH_HOME;
const INSTALL_HOME = process.env.DSH_MEMORY_HOME ?? join(homedir(), '.dsh');
const HOST = process.env.DSH_MEMORY_HOST ?? join(INSTALL_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-memory', 'lib', 'index.js');
const { apply } = await import(`${pathToFileURL(HOST).href}?t=${Date.now()}`);

function makeCtx() {
  const handlers = new Map();
  const tools = new Map();
  let route;
  return {
    handlers,
    tools,
    route: () => route,
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
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
    webServer: { register(options) { route = options.handler; return () => {}; } },
    connection: { requestRejection() { return undefined; } },
  };
}

function message(role, text, id, sourceKind = role === 'user' ? 'user' : 'model') {
  return { id, role, source: { kind: sourceKind }, content: [{ type: 'text', text }] };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ctx = makeCtx();
apply(ctx);
await wait(250);

async function api(method, payload) {
  const body = JSON.stringify(payload ?? {});
  const req = {
    method: 'POST',
    url: `/dsh-memory/api/${method}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    writeHead(code) { status = code; this.headersSent = true; },
    end(chunk) { text += chunk ?? ''; },
    destroy() {},
  };
  await ctx.route()(req, res);
  if (status !== 200) throw new Error(`${method} failed ${status}: ${text}`);
  return JSON.parse(text).value;
}

async function preStep(sessionId, text, context = [], step = 1) {
  const user = message('user', text, `u-${sessionId}-${Date.now()}-${Math.random()}`);
  const messages = [...context, user];
  const handler = ctx.handlers.get('agent/pre-step')[0];
  return handler({
    agent: { session: { id: sessionId, header: { cwd: 'C:/work' } }, inbox: {} },
    messages,
    step,
    signal: { aborted: false },
  }, async () => ({ kind: 'enter', messages }));
}

function recalled(decision) {
  return decision.messages.filter((row) => row.source?.kind === 'plugin:dsh-memory');
}

const memory = ctx.tools.get('memory');
await memory.execute({ action: 'save', text: '用户喜欢深色主题，界面要简洁克制，不要堆太多装饰。', tags: '偏好,界面,主题' }, { agent: { session: { id: 'seed' } } });
await memory.execute({ action: 'save', text: '每周一上午十点开产品会议，讨论记忆插件的下一步计划。', tags: '会议,计划' }, { agent: { session: { id: 'seed' } } });
await memory.execute({ action: 'save', text: '开发环境是 Node.js 24 和 Windows 11，数据全部保存在本机。', tags: '环境,windows,node' }, { agent: { session: { id: 'seed' } } });
await memory.execute({ action: 'save', text: 'Kubernetes 集群使用 k8s 部署，入口配置放在 deploy 目录。', tags: 'kubernetes,部署' }, { agent: { session: { id: 'seed' } } });
await wait(400);

const config = await api('config', { patch: { recallMode: 'hybrid', capture: false, margin: 0.02, diversity: 0.22 } });
if (config.config.recallMode !== 'hybrid') throw new Error('hybrid mode was not saved');

const checks = [];
async function recallCheck(name, query, expected, options = {}) {
  const decision = await preStep(`q-${name}`, query);
  const rows = recalled(decision);
  const text = rows.map((row) => row.content[0].text).join('\n');
  const ok = expected ? rows.length > 0 && (!expected || text.includes(expected)) : rows.length === 0;
  checks.push({ name, ok, query, rows: rows.length, expected: expected || '(none)' });
  if (!ok) console.error(`FAIL ${name}: query=${query} rows=${rows.length}\n${text}`);
}

await recallCheck('synonym', '暗黑风格怎么设置？', '深色主题');
await recallCheck('meeting', '下次会议怎么安排？', '产品会议');
await recallCheck('environment', '开发环境是什么版本？', 'Node.js 24');
await recallCheck('acronym', 'k8s 怎么部署？', 'Kubernetes');
await recallCheck('typo', 'kubernetis 怎么用？', 'Kubernetes');
await recallCheck('negative-weather', '东京明天天气如何？', '');
await recallCheck('negative-food', '中午吃什么比较好？', '');

// The short follow-up should use the previous prompt as a context hint.
const contextUser = message('user', '我很在意界面的视觉风格，喜欢深色主题。', 'ctx-u');
const contextDecision = await preStep('q-context', '那具体怎么设置？', [contextUser]);
const contextRows = recalled(contextDecision);
checks.push({ name: 'context-hint', ok: contextRows.length > 0, query: '那具体怎么设置？', rows: contextRows.length, expected: '深色主题' });
if (contextRows.length === 0) console.error('FAIL context-hint');

// Explain payload should expose score/reason details for the UI test panel.
const explanation = await api('recall', { query: '暗黑风格', limit: 6 });
checks.push({ name: 'explain', ok: explanation.rows.length > 0 && explanation.rows[0].reasons.length > 0, query: '暗黑风格', rows: explanation.rows.length, expected: 'reasons' });

// Pin/block API + recall suppression.
const first = explanation.rows[0];
await api('flags', { id: first.id, pinned: true });
const pinnedExplain = await api('recall', { query: '暗黑风格', limit: 6 });
checks.push({ name: 'pin', ok: pinnedExplain.rows.some((row) => row.id === first.id && row.pinned === true), query: '暗黑风格', rows: pinnedExplain.rows.length, expected: 'pinned' });
await api('flags', { id: first.id, pinned: false, blocked: true });
const blockedDecision = await preStep('q-blocked', '暗黑风格怎么设置？');
checks.push({ name: 'block', ok: recalled(blockedDecision).length === 0, query: '暗黑风格怎么设置？', rows: recalled(blockedDecision).length, expected: 'blocked' });

// Episode capture: a user prompt plus its final assistant reply become one episode.
await api('config', { patch: { capture: true, recallMode: 'hybrid' } });
const episodeUser = message('user', '我新增了一个明确偏好：以后所有总结都用中文表格呈现。', 'ep-u');
await preStep('episode-session', episodeUser.content[0].text);
const assistantEvent = ctx.handlers.get('session/event')[0];
assistantEvent({ id: 'episode-session', header: { cwd: 'C:/work' } }, {
  type: 'assistant/message',
  data: { message: message('assistant', '明白。以后所有总结都会使用中文表格呈现，并在表头标注关键字段、结论、风险和下一步行动，方便你快速浏览和比较不同方案。'.repeat(4), 'ep-a') },
});
await wait(400);
const list = await api('list', { limit: 30 });
if (process.env.DEBUG_EPISODE === '1') console.error(list.items.map((item) => ({ kind: item.kind, role: item.role, text: item.text, sessionId: item.sessionId })));
const episode = list.items.find((item) => item.kind === 'episode' && item.text.includes('中文表格'));
checks.push({ name: 'episode', ok: episode !== undefined, query: '中文表格', rows: episode ? 1 : 0, expected: 'episode' });
if (episode) {
  const episodeDecision = await preStep('q-episode', '总结用什么格式？');
  checks.push({ name: 'episode-recall', ok: recalled(episodeDecision).some((row) => row.content[0].text.includes('中文表格')), query: '总结格式', rows: recalled(episodeDecision).length, expected: '中文表格' });
}

// Legacy mode must remain usable as a fallback; switching is persisted.
await api('flags', { id: first.id, blocked: false });
await api('config', { patch: { recallMode: 'legacy' } });
const legacyConfig = JSON.parse(await readFile(join(DSH_HOME, 'storages', 'dsh-memory', 'config.json'), 'utf8'));
checks.push({ name: 'legacy-switch', ok: legacyConfig.recallMode === 'legacy', query: '-', rows: 0, expected: 'legacy' });
const legacyDecision = await preStep('q-legacy', '暗黑风格怎么设置？');
checks.push({ name: 'legacy-recall', ok: recalled(legacyDecision).length > 0, query: '暗黑风格', rows: recalled(legacyDecision).length, expected: 'legacy hit' });

const failures = checks.filter((check) => !check.ok);
console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
await rm(DSH_HOME, { recursive: true, force: true });
if (failures.length > 0) process.exitCode = 1;
