/**
 * Playwright vs WebDriver BiDi: the same scenarios on both drivers of the
 * built `web()` engine, through the engine-contract hooks the runner and the
 * agent loop call (`init`, `startAttempt`, `session.open`, `observe`,
 * `locate`, `perform`, `artifacts.screenshot`). Serves the testbed app and a
 * synthetic heavy page itself, so nothing leaves the machine.
 *
 *   pnpm build
 *   node packages/web/bench/bidi.ts [--iterations 20] [--browsers chromium,firefox] [--out bidi-results.json]
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { EngineHandle, LocatorExpression, NodeRef, OperationContext, SemanticNode } from 'e2e/engine';
import { web } from '../dist/index.js';

const { values } = parseArgs({
  options: {
    iterations: { type: 'string', default: '20' },
    'cold-iterations': { type: 'string', default: '10' },
    browsers: { type: 'string', default: 'chromium,firefox' },
    drivers: { type: 'string', default: 'playwright,bidi' },
    out: { type: 'string', default: path.join(path.dirname(fileURLToPath(import.meta.url)), 'bidi-results.json') },
  },
});
const ITERATIONS = Number(values.iterations);
const COLD_ITERATIONS = Number(values['cold-iterations']);
const BROWSERS = values.browsers.split(',') as ('chromium' | 'firefox')[];
const DRIVERS = values.drivers.split(',') as ('playwright' | 'bidi')[];
const TESTBED_PORT = 4291;
const HEAVY_PORT = 4292;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A page of 1,500 table rows, each with a checkbox, a text field, and a button: ~9k elements, an admin-grid-sized DOM. */
function heavyPage(): string {
  const rows = Array.from({ length: 1500 }, (_, index) =>
    `<tr><td><input type="checkbox" aria-label="Select row ${index}"></td><td>Customer ${index}</td><td>customer${index}@example.com</td>` +
    `<td><input aria-label="Note ${index}" placeholder="Note"></td><td><button>Open ${index}</button></td></tr>`,
  ).join('');
  return `<!doctype html><title>Heavy</title><main><h1>Customers</h1><label>Search <input placeholder="Search customers"></label>` +
    `<button id="go">Search</button><output role="status" aria-label="Result"></output><table><tbody>${rows}</tbody></table></main>` +
    `<script>document.getElementById('go').onclick = () => { document.querySelector('output').textContent = 'searched ' + document.querySelector('input[placeholder="Search customers"]').value; };</script>`;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

async function waitForHttp(url: string): Promise<void> {
  for (let poll = 0; poll < 100; poll += 1) {
    if (await fetch(url).then((response) => response.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} never answered`);
}

const operation = (timeoutMs = 30_000): OperationContext => ({ signal: AbortSignal.timeout(timeoutMs), timeoutMs });

const string = (value: string, exact = false) => ({ kind: 'string' as const, value, exact });
const role = (value: string, name?: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: string(value, true), ...(name === undefined ? {} : { name: string(name) }) },
});
const label = (value: string): LocatorExpression => ({ kind: 'query', query: { kind: 'label', value: string(value, true) } });

/** One engine with an attempt running, and the hooks the scenarios call. */
interface Driven {
  readonly engine: EngineHandle;
  open(url: string): Promise<void>;
  locateOne(expression: LocatorExpression): Promise<NodeRef>;
  close(): Promise<void>;
}

function engineFor(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox'): EngineHandle {
  return web({ driver, browser });
}

async function boot(engine: EngineHandle): Promise<void> {
  await engine.init!({
    app: { site: `http://127.0.0.1:${TESTBED_PORT}` },
    projectRoot: ROOT,
    headed: false,
    signal: AbortSignal.timeout(120_000),
  } as never);
}

async function attempt(engine: EngineHandle): Promise<void> {
  await engine.startAttempt!({
    attemptId: 'bench',
    artifactsDir: mkdtempSync(path.join(os.tmpdir(), 'e2e-bench-')),
    resolveSecret: async () => '',
    signal: AbortSignal.timeout(120_000),
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });
}

const cleanup = () => ({ signal: AbortSignal.timeout(30_000), timeoutMs: 30_000 });

async function driven(engine: EngineHandle): Promise<Driven> {
  await boot(engine);
  await attempt(engine);
  return {
    engine,
    open: (url) => engine.session!.open!(url, operation()),
    locateOne: async (expression) => {
      const nodes = await engine.locate!(expression, operation());
      if (nodes.length !== 1) throw new Error(`expected one match, got ${nodes.length}`);
      return nodes[0]!.ref;
    },
    close: async () => {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    },
  };
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** Every node of an observation tree, depth first. */
function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

function find(root: SemanticNode, predicate: (node: SemanticNode) => boolean): NodeRef {
  const node = flatten(root).find(predicate);
  if (node === undefined) throw new Error('node not found in observation');
  return node.ref;
}

/** Resident memory (MB) of this process and every descendant, and each one's CPU seconds so far by pid. */
function processTree(): { rssMb: number; cpu: Map<number, number> } {
  const lines = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' }).trim().split('\n');
  const rows = lines.map((line) => {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
    const parts = (cpu ?? '0').split(':').map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), seconds };
  });
  const tree = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
  }
  const members = rows.filter((row) => tree.has(row.pid));
  return {
    rssMb: members.reduce((total, row) => total + row.rss, 0) / 1024,
    cpu: new Map(members.map((row) => [row.pid, row.seconds])),
  };
}

/**
 * Peak memory and CPU of the process tree across samples. A renderer that
 * exits between samples keeps the CPU it showed last, so the total is a
 * floor: work done after a process's last sample is missed.
 */
class ResourceMeter {
  private peakRss = 0;
  private readonly baseline: Map<number, number>;
  private readonly seen = new Map<number, number>();

  constructor() {
    this.baseline = processTree().cpu;
  }

  sample(): void {
    const { rssMb, cpu } = processTree();
    this.peakRss = Math.max(this.peakRss, rssMb);
    for (const [pid, seconds] of cpu) this.seen.set(pid, Math.max(this.seen.get(pid) ?? 0, seconds));
  }

  result(): { peakRssMb: number; cpuSeconds: number } {
    let total = 0;
    for (const [pid, seconds] of this.seen) total += seconds - (this.baseline.get(pid) ?? 0);
    return { peakRssMb: this.peakRss, cpuSeconds: total };
  }
}

type Samples = Record<string, number[]>;

function record(samples: Samples, name: string, ms: number): void {
  (samples[name] ??= []).push(ms);
}

const testbed = (page: string) => `http://127.0.0.1:${TESTBED_PORT}${page}`;
const HEAVY = `http://127.0.0.1:${HEAVY_PORT}/`;

/** The agent-style flow: observe, pick a node from the tree, act, observe again, ten steps on the todos page. */
async function agentFlow(d: Driven): Promise<void> {
  const { engine } = d;
  await d.open(testbed('/todos'));
  for (const title of ['Write spec', 'Ship runner', 'Review PR']) {
    const before = await engine.observe!(operation());
    const field = find(before.root, (node) => node.name === 'New todo');
    await engine.perform!(field, { kind: 'fill', value: title, sensitive: false }, operation());
    const after = await engine.observe!(operation());
    await engine.perform!(find(after.root, (node) => node.role === 'button' && node.name === 'Add'), { kind: 'tap' }, operation());
  }
  const listed = await engine.observe!(operation(), { pixels: true });
  await engine.perform!(find(listed.root, (node) => node.role === 'checkbox' && node.name === 'Ship runner'), { kind: 'tap' }, operation());
  const done = await engine.observe!(operation());
  if (!flatten(done.root).some((node) => node.text?.includes('2 remaining') === true || node.name?.includes('2 remaining') === true)) {
    throw new Error('agent flow did not reach its goal');
  }
}

async function runWarm(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox'): Promise<{ samples: Samples; resources: Record<string, number> }> {
  const samples: Samples = {};
  const d = await driven(engineFor(driver, browser));
  const { engine } = d;
  const meter = new ResourceMeter();
  const sample = () => meter.sample();
  const nodeCpu = process.cpuUsage();
  try {
    for (let index = 0; index < ITERATIONS; index += 1) {
      record(samples, 'new context + page (startAttempt → first open)', await time(async () => {
        await engine.endAttempt!(cleanup());
        await attempt(engine);
        await d.open(testbed('/'));
      }));
      record(samples, 'navigate: testbed /forms', await time(() => d.open(testbed('/forms'))));
      record(samples, 'observe: testbed /forms', await time(() => engine.observe!(operation())));
      record(samples, 'locate role+name: testbed /forms', await time(() => d.locateOne(role('button', 'Save profile'))));
      record(samples, 'click/type sequence: forms (5 actions)', await time(async () => {
        await engine.perform!(await d.locateOne(label('Full name')), { kind: 'fill', value: 'Ada Lovelace', sensitive: false }, operation());
        await engine.perform!(await d.locateOne(label('City')), { kind: 'tap' }, operation());
        await engine.keyboard!.type('Warsaw', { replace: false }, operation());
        await engine.perform!(await d.locateOne(label('Email notifications')), { kind: 'check' }, operation());
        await engine.perform!(await d.locateOne(role('button', 'Save profile')), { kind: 'tap' }, operation());
      }));
      record(samples, 'screenshot: testbed /forms', await time(() => engine.artifacts!.screenshot(undefined, operation())));
      record(samples, 'navigate: testbed /scroll (8k px)', await time(() => d.open(testbed('/scroll'))));
      record(samples, 'navigate: heavy page (9k elements)', await time(() => d.open(HEAVY)));
      record(samples, 'observe: heavy page', await time(() => engine.observe!(operation())));
      record(samples, 'observe + pixels: heavy page', await time(() => engine.observe!(operation(), { pixels: true })));
      record(samples, 'locate role+name: heavy page', await time(() => d.locateOne(role('button', 'Open 1499'))));
      record(samples, 'locate + fill + tap: heavy page', await time(async () => {
        await engine.perform!(await d.locateOne({ kind: 'query', query: { kind: 'placeholder', value: string('Search customers', true) } }), { kind: 'fill', value: 'acme', sensitive: false }, operation());
        await engine.perform!(await d.locateOne(role('button', 'Search')), { kind: 'tap' }, operation());
      }));
      record(samples, 'screenshot: heavy page', await time(() => engine.artifacts!.screenshot(undefined, operation())));
      sample();
      // The first look at a small page after a 3k-node observation: Playwright releases the old generation's element handles here.
      await d.open(testbed('/forms'));
      record(samples, 'observe: /forms right after a heavy observation', await time(() => engine.observe!(operation())));
      sample();
      record(samples, 'agent flow: todos (10 observe/act steps)', await time(async () => {
        await engine.endAttempt!(cleanup());
        await attempt(engine);
        await agentFlow(d);
      }));
      sample();
    }
    sample();
  } finally {
    await d.close();
  }
  const cpu = process.cpuUsage(nodeCpu);
  const { peakRssMb, cpuSeconds } = meter.result();
  return {
    samples,
    resources: {
      'peak RSS, node + browser (MB)': peakRssMb,
      'node CPU, warm loop (s)': (cpu.user + cpu.system) / 1e6,
      'node + browser CPU, warm loop (s, floor)': cpuSeconds,
    },
  };
}

async function runCold(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox'): Promise<Samples> {
  const samples: Samples = {};
  for (let index = 0; index < COLD_ITERATIONS; index += 1) {
    const engine = engineFor(driver, browser);
    record(samples, 'cold launch (init)', await time(() => boot(engine)));
    record(samples, 'cold first page (startAttempt → open /forms → observe)', await time(async () => {
      await attempt(engine);
      await engine.session!.open!(testbed('/forms'), operation());
      await engine.observe!(operation());
    }));
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  }
  return samples;
}

function stats(list: number[]): { p50: number; p95: number; mean: number; n: number } {
  const sorted = list.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: at(0.5), p95: at(0.95), mean: list.reduce((a, b) => a + b, 0) / list.length, n: list.length };
}

const app = spawn(process.execPath, ['app/server.mjs'], {
  cwd: path.join(ROOT, 'apps/testbed'),
  env: { ...process.env, PORT: String(TESTBED_PORT) },
  stdio: 'ignore',
});
const heavy = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(heavyPage());
});
await listen(heavy, HEAVY_PORT);
const results: Record<string, { samples: Record<string, ReturnType<typeof stats>>; resources?: Record<string, number> }> = {};
try {
  await waitForHttp(testbed('/'));
  for (const browser of BROWSERS) {
    for (const driver of DRIVERS) {
      const key = `${driver}/${browser}`;
      process.stderr.write(`${key}: cold\n`);
      const cold = await runCold(driver, browser);
      process.stderr.write(`${key}: warm\n`);
      const warm = await runWarm(driver, browser);
      const merged = { ...cold, ...warm.samples };
      results[key] = { samples: Object.fromEntries(Object.entries(merged).map(([name, list]) => [name, stats(list)])), resources: warm.resources };
    }
  }
} finally {
  app.kill();
  heavy.close();
}

const meta = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}`,
  node: process.version,
  iterations: ITERATIONS,
  coldIterations: COLD_ITERATIONS,
};
writeFileSync(values.out, JSON.stringify({ meta, results }, null, 2));

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));
for (const browser of BROWSERS) {
  const keys = DRIVERS.map((driver) => `${driver}/${browser}`);
  const names = Object.keys(results[keys[0]!]!.samples);
  console.log(`\n### ${browser}\n`);
  console.log(`| Scenario (ms) | ${keys.map((key) => `${key.split('/')[0]} p50 / p95 / mean`).join(' | ')} | BiDi vs PW (p50) |`);
  console.log(`| --- | ${keys.map(() => '---').join(' | ')} | --- |`);
  for (const name of names) {
    const cells = keys.map((key) => {
      const s = results[key]!.samples[name]!;
      return `${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.mean)}`;
    });
    const pw = results[`playwright/${browser}`]?.samples[name]?.p50;
    const bidi = results[`bidi/${browser}`]?.samples[name]?.p50;
    const ratio = pw !== undefined && bidi !== undefined ? `${(bidi / pw).toFixed(2)}x` : '';
    console.log(`| ${name} | ${cells.join(' | ')} | ${ratio} |`);
  }
  for (const resource of Object.keys(results[keys[0]!]!.resources ?? {})) {
    console.log(`| ${resource} | ${keys.map((key) => fmt(results[key]!.resources![resource]!)).join(' | ')} | |`);
  }
}
console.log(`\n${JSON.stringify(meta)}`);
