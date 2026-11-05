import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function installedHome() {
  return process.env.DSH_MEMORY_HOME ?? join(homedir(), '.dsh');
}

export function installedHost() {
  return process.env.DSH_MEMORY_HOST
    ?? join(installedHome(), 'profiles', 'desktop', 'node_modules', 'dsh-memory', 'lib', 'index.js');
}

export function makeTempHome(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function loadApply() {
  const host = installedHost();
  if (!existsSync(host)) {
    throw new Error(`plugin is not installed at ${host}; run "node scripts/install.mjs desktop" first, or set DSH_MEMORY_HOST`);
  }
  const module = await import(`${pathToFileURL(host).href}?t=${Date.now()}`);
  return module.apply;
}

export function makeCtx() {
  const tools = new Map();
  const disposers = [];
  let route;
  const ctx = {
    disposers,
    logger: { info() {}, warn() {}, error() {} },
    route: () => route,
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    on() { return () => {}; },
    systemPrompt: { section() { return () => {}; } },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {}; },
      get(name) { return tools.get(name); },
    },
    webServer: {
      register(spec) { route = spec.handler; return () => {}; },
    },
    connection: { requestRejection() { return undefined; } },
  };
  return ctx;
}

export async function openStore() {
  const apply = await loadApply();
  const ctx = makeCtx();
  apply(ctx);
  await sleep(250);
  return ctx;
}

export async function closeStore(ctx) {
  for (const dispose of ctx.disposers.reverse()) await dispose?.();
  await sleep(80);
}

export async function callApi(ctx, method, payload = {}) {
  const body = JSON.stringify(payload);
  const req = {
    method: 'POST',
    url: `/dsh-memory/api/${method}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
  let status = 0;
  let text = '';
  const res = {
    writeHead(value) { status = value; },
    end(chunk) { text += chunk?.toString?.() ?? ''; },
  };
  await ctx.route()(req, res);
  const parsed = text.length > 0 ? JSON.parse(text) : {};
  if (status >= 400 || parsed.ok === false) {
    const error = new Error(parsed.error?.message ?? `HTTP ${status}`);
    error.code = parsed.error?.code ?? `http-${status}`;
    error.status = status;
    throw error;
  }
  return parsed.value;
}

export async function removeHome(home) {
  await rm(home, { recursive: true, force: true });
}
