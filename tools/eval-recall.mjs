/**
 * Offline recall evaluation for dsh-memory 0.9.
 *
 * Seeds a labeled pool, then measures Hit@1, Hit@2, MRR and false-positive
 * rate for legacy vs hybrid. No model calls; every query is local.
 *
 * Usage: node tools/eval-recall.mjs [--json]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-memory-eval-'));
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
    effect(fn) { const dispose = fn(); return () => dispose?.(); },
    systemPrompt: { section() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; }, get(name) { return tools.get(name); } },
    on(event, handler) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(handler); },
    webServer: { register(options) { route = options.handler; return () => {}; } },
    connection: { requestRejection() { return undefined; } },
  };
}

const ctx = makeCtx();
apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 250));

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
  if (status !== 200) throw new Error(`${method} ${status}: ${text}`);
  return JSON.parse(text).value;
}

const SEED = [
  { id: 'pref-dark', text: '用户喜欢深色主题，界面要简洁克制，不要堆太多装饰。', tags: '偏好,界面,主题', category: 'preference', queries: ['我喜欢什么界面风格？', '深色模式还是浅色模式？', '主题偏好是什么？'] },
  { id: 'pref-table', text: '总结汇报要使用中文表格，表头包含结论、风险和下一步。', tags: '偏好,总结,表格', category: 'preference', queries: ['总结应该用什么格式？', '汇报要不要用表格？', '输出总结的偏好？'] },
  { id: 'pref-emoji', text: '回复不要使用 emoji 表情符号，保持克制。', tags: '偏好,回复,风格', category: 'preference', queries: ['回复能用 emoji 吗？', '表情符号偏好？', '聊天风格有什么要求？'] },
  { id: 'proj-memory', text: 'dsh-memory 插件为本机所有对话提供共享记忆池，并在侧边栏展示图谱。', tags: '项目,dsh-memory,插件', category: 'project', queries: ['记忆插件是什么？', '共享记忆池怎么实现？', 'dsh-memory 是做什么的？'] },
  { id: 'proj-graph', text: '图谱优化使用按分类采样、隐藏节点 +N 标记和搜索高亮，控制大记忆池的渲染规模。', tags: '项目,图谱,性能', category: 'project', queries: ['图谱节点太多怎么优化？', '大规模记忆的图谱性能？', '分类采样是什么？'] },
  { id: 'proj-crypto', text: '记忆文件使用 AES-256-GCM 加密，密钥保存在本机 key.bin，不进入模型上下文。', tags: '项目,加密,安全', category: 'project', queries: ['记忆数据怎么加密？', '密钥保存在哪里？', 'AES-GCM 用在什么地方？'] },
  { id: 'env-node', text: '开发环境是 Windows 11、Node.js 24 和 pnpm，编辑器使用 VS Code。', tags: '环境,windows,node', category: 'environment', queries: ['开发环境是什么？', 'Node 版本是多少？', '操作系统是什么？'] },
  { id: 'env-powershell', text: 'PowerShell 5.1 默认按 ANSI 读取 UTF-8 文件，中文会显示乱码；请求体乱码是测试工具问题。', tags: '环境,powershell,编码', category: 'environment', queries: ['中文乱码是什么原因？', 'PowerShell 编码问题？', '请求体乱码？'] },
  { id: 'env-cdp', text: 'UI 验证使用 headless Edge 和 CDP 截图，避免锁屏和 stale screenshot 问题。', tags: '环境,edge,cdp', category: 'environment', queries: ['无头浏览器怎么做截图验证？', 'CDP 用来做什么？', '为什么用 Edge？'] },
  { id: 'plan-release', text: '0.9.0 计划加入混合召回、回合记忆、召回测试面板和置顶/屏蔽。', tags: '计划,发布,0.9', category: 'plan', queries: ['下个版本要做什么？', '0.9 的发布计划？', '混合召回什么时候上线？'] },
  { id: 'plan-push', text: 'GitHub 推送在 443 端口连接失败时暂停，等网络恢复后重试 origin main。', tags: '计划,github,推送', category: 'plan', queries: ['代码推送状态？', 'GitHub 连不上怎么办？', '远程仓库什么时候同步？'] },
  { id: 'plan-eval', text: '召回评测使用 60 条标注查询，计算 Hit@1、Hit@2、MRR 和误召回率。', tags: '计划,评测,召回', category: 'plan', queries: ['召回怎么评测？', 'Hit@2 是什么？', '误召回率怎么算？'] },
  { id: 'person-github', text: 'GitHub 账号是 Alive-Kenan，公开仓库是 Alive-Kenan/dsh-memory。', tags: '人物,github,账号', category: 'person', queries: ['GitHub 账号是什么？', '仓库所有者是谁？', 'dsh-memory 的远程地址？'] },
  { id: 'person-name', text: '用户名字是柯楠，GitHub 显示名是 Alive-Kenan。', tags: '人物,名字,用户', category: 'person', queries: ['用户叫什么名字？', '主人是谁？', '账号显示名是什么？'] },
  { id: 'person-model', text: '默认模型是 deepseek-account / deepseek-flash，推理强度 high。', tags: '人物,模型,默认', category: 'person', queries: ['默认模型是什么？', '用哪个模型？', '推理强度是多少？'] },
  { id: 'fact-store', text: '记忆数据保存在 $DSH_HOME/storages/dsh-memory/memories.json，配置文件是同目录的 config.json。', tags: '事实,存储,路径', category: 'fact', queries: ['记忆文件在哪里？', '数据存储位置？', 'config.json 放在哪？'] },
  { id: 'fact-aes', text: '加密使用 32 字节密钥和 12 字节 IV，认证标签单独存放，AAD 是 dsh-memory:v2。', tags: '事实,加密,参数', category: 'fact', queries: ['密钥长度是多少？', 'IV 多长？', 'AAD 是什么？'] },
  { id: 'fact-port', text: 'Desktop GUI 通过 127.0.0.1 随机端口访问，端口每次重启都会变化。', tags: '事实,端口,gui', category: 'fact', queries: ['GUI 地址是什么？', '本地端口会变吗？', '127.0.0.1 是什么？'] },
  { id: 'conv-graph', text: '用户要求图谱更炫酷、分类更详细；后来要求图谱与规模优化。', tags: '对话,图谱,需求', category: 'conversation', queries: ['用户对图谱提过什么要求？', '分类为什么要更详细？', '图谱规模优化是谁提的？'] },
  { id: 'conv-capture', text: '用户要求自动记录本机对话，不要添加任何按键，并把这作为默认功能。', tags: '对话,自动记录,默认', category: 'conversation', queries: ['自动记录是默认功能吗？', '为什么没有添加入口？', '对话怎么进入记忆池？'] },
];

const NEGATIVE = [
  '东京明天天气如何？',
  '中午吃什么比较好？',
  '帮我看看股票行情。',
  '写一个 Python 快速排序。',
  '推荐一部科幻电影。',
  '明天几点日落？',
  '把这句话翻译成法语。',
  '讲个笑话。',
  '机票价格是多少？',
  '手机电量怎么省？',
];

for (const item of SEED) {
  const saved = await api('add', { text: item.text, tags: item.tags, importance: 0.85 });
  item.id = saved.memory.id;
}
await new Promise((resolve) => setTimeout(resolve, 350));

function metrics(predictions, cases) {
  let hit1 = 0;
  let hit2 = 0;
  let rr = 0;
  let falsePositive = 0;
  let injectedChars = 0;
  for (const { query, expected, rows } of predictions) {
    if (expected === null) {
      if (rows.length > 0) falsePositive += 1;
      continue;
    }
    const rank = rows.findIndex((row) => row.id === expected) + 1;
    if (rank === 1) hit1 += 1;
    if (rank > 0 && rank <= 2) hit2 += 1;
    if (rank > 0) rr += 1 / rank;
    injectedChars += rows.slice(0, 2).reduce((sum, row) => sum + Math.min(180, row.text.length), 0);
  }
  const positives = cases.filter((item) => item.expected !== null).length;
  return {
    positives,
    hit1: hit1 / positives,
    hit2: hit2 / positives,
    mrr: rr / positives,
    falsePositiveRate: falsePositive / (cases.length - positives),
    avgInjectedChars: injectedChars / positives,
  };
}

async function evaluate(mode) {
  await api('config', { patch: { recallMode: mode } });
  const cases = [];
  for (const item of SEED) {
    for (const query of item.queries) cases.push({ query, expected: item.id, label: item.id });
  }
  for (const query of NEGATIVE) cases.push({ query, expected: null, label: 'negative' });
  const predictions = [];
  for (const testCase of cases) {
    const explanation = await api('recall', { query: testCase.query, limit: 8 });
    predictions.push({ ...testCase, rows: explanation.rows });
  }
  return { mode, ...metrics(predictions, cases), predictions };
}

const legacy = await evaluate('legacy');
const hybrid = await evaluate('hybrid');
const summary = {
  ok: true,
  queries: legacy.positives + NEGATIVE.length,
  legacy: { hit1: legacy.hit1, hit2: legacy.hit2, mrr: legacy.mrr, falsePositiveRate: legacy.falsePositiveRate, avgInjectedChars: legacy.avgInjectedChars },
  hybrid: { hit1: hybrid.hit1, hit2: hybrid.hit2, mrr: hybrid.mrr, falsePositiveRate: hybrid.falsePositiveRate, avgInjectedChars: hybrid.avgInjectedChars },
};

console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes('--details')) {
  for (const mode of [legacy, hybrid]) {
    console.log(`\n${mode.mode.toUpperCase()}`);
    for (const row of mode.predictions) {
      const rank = row.expected === null ? (row.rows.length > 0 ? 'FP' : 'ok') : (row.rows.findIndex((r) => r.id === row.expected) + 1 || 'miss');
      console.log(`${String(rank).padEnd(4)} ${row.query}  -> ${row.rows.slice(0, 2).map((r) => r.category).join(',')}`);
    }
  }
}
await rm(DSH_HOME, { recursive: true, force: true });
