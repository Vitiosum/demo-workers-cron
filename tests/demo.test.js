// End-to-end checks on a throwaway local Redis: npm test (needs redis-server in the PATH).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let hasRedis = true;
try { execFileSync('redis-server', ['--version']); } catch { hasRedis = false; }

const procs = [];
let redisPort, webPort, base, env;

function start(args, extra = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  procs.push(child);
  return child;
}
const startWorker = (name, instance) => start(['src/worker.js'], { WORKER_NAME: name, INSTANCE_NUMBER: String(instance) });

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, type: res.headers.get('content-type') };
}
async function job(id) {
  const { json } = await api('GET', '/api/state');
  const all = [...json.waiting.next, ...json.active, ...json.retry, ...json.done, ...json.dead.jobs];
  return all.find((j) => j.id === id);
}
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(150);
  }
}

before(async () => {
  if (!hasRedis) return;
  redisPort = await freePort();
  webPort = await freePort();
  base = `http://127.0.0.1:${webPort}`;
  procs.push(spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }));
  await sleep(400);
  delete process.env.APP_ID; // the tests describe a local run
  env = { ...process.env, REDIS_URL: `redis://127.0.0.1:${redisPort}`, PORT: String(webPort), JOB_SPEED: '20', RETRY_BASE_SECONDS: '0.2', FLAKY_RATE: '0', QUEUE_PREFIX: 'test:' };
  start(['server.js']);
  await until(async () => (await api('GET', '/health').catch(() => ({}))).status === 200);
});

after(async () => {
  for (const p of procs) p.kill('SIGKILL');
});

const t = hasRedis ? test : test.skip;

t('health answers, deep health needs a live worker', async () => {
  assert.equal((await api('GET', '/health')).status, 200);
  assert.equal((await api('GET', '/health/deep')).status, 503);
  startWorker('w-a', 0);
  await until(async () => (await api('GET', '/health/deep')).status === 200);
});

t('the header pill reads its Live or Local label from APP_ID, never from a constant', async () => {
  assert.equal((await api('GET', '/api/state')).json.platform.APP_ID, null);
  const port = await freePort();
  start(['server.js'], { PORT: String(port), APP_ID: 'app_test' });
  const onClever = await until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()).catch(() => null));
  assert.equal(onClever.platform.APP_ID, 'app_test');
  const js = (await api('GET', '/app.js')).text;
  assert.match(js, /s\.platform\.APP_ID/);
  assert.match(js, /live \? `Live · .*: 'Local · not on Clever Cloud'/);
});

t('the seed posts one job of each kind, and they get done', async () => {
  const state = (await api('GET', '/api/state')).json;
  assert.equal(state.counters.posted, 4);
  await until(async () => (await api('GET', '/api/state')).json.counters.done >= 4);
});

t('posting is validated', async () => {
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: 'kind=export' });
  assert.equal(res.status, 415);
  assert.equal((await api('POST', '/api/jobs', { kind: 'nope' })).status, 400);
});

t('an ordinary job is done and leaves a result', async () => {
  const { json } = await api('POST', '/api/jobs', { kind: 'export' });
  const [id] = json.ids;
  const done = await until(async () => { const j = await job(id); return j?.status === 'done' && j; });
  assert.equal(done.attempt, 1);
  const result = await api('GET', `/results/${id}`);
  assert.equal(result.status, 200);
  assert.match(result.type, /text\/csv/);
  assert.equal(result.text.trim().split('\n').length, 121);
});

t('a flaky job fails twice, is retried with a delay, then succeeds', async () => {
  const [id] = (await api('POST', '/api/jobs', { kind: 'flaky' })).json.ids;
  await until(async () => (await job(id))?.status === 'retry');
  const done = await until(async () => { const j = await job(id); return j?.status === 'done' && j; });
  assert.equal(done.attempt, 3);
  assert.deepEqual(done.log.map((l) => l.outcome), ['failed', 'failed', 'done']);
});

t('a poison job lands in the dead letter office, and can be requeued', async () => {
  const [id] = (await api('POST', '/api/jobs', { kind: 'poison' })).json.ids;
  const dead = await until(async () => { const j = await job(id); return j?.status === 'dead' && j; });
  assert.equal(dead.attempt, 3);
  assert.match(dead.error, /Malformed CSV/);
  assert.equal((await api('POST', `/api/jobs/${id}/requeue`, {})).status, 202);
  await until(async () => (await job(id))?.status === 'done');
});

t('two workers share the queue', async () => {
  startWorker('w-b', 1);
  await until(async () => (await api('GET', '/api/state')).json.workers.filter((w) => w.alive).length === 2);
  const before = (await api('GET', '/api/state')).json.counters.done;
  const { ids } = (await api('POST', '/api/jobs', { kind: 'rush' })).json;
  await until(async () => (await api('GET', '/api/state')).json.counters.done >= before + ids.length);
  const s = (await api('GET', '/api/state')).json; // the page lists the last 8 delivered
  const instances = new Set(s.done.filter((j) => ids.includes(j.id)).map((j) => j.instance));
  assert.deepEqual([...instances].sort(), ['0', '1']);
});

t('a crashed worker exits with code 1; its job is recovered when it restarts', async () => {
  // Slow jobs, so the crash lands in the middle of one.
  for (const p of procs.filter((p) => p.spawnargs.includes('src/worker.js'))) { p.kill('SIGTERM'); await p.exited; }
  const slow = start(['src/worker.js'], { WORKER_NAME: 'w-c', INSTANCE_NUMBER: '0', JOB_SPEED: '1' });
  await until(async () => (await api('GET', '/api/state')).json.workers.some((w) => w.name === 'w-c' && w.alive));
  const [id] = (await api('POST', '/api/jobs', { kind: 'thumbnail' })).json.ids;
  await until(async () => (await job(id))?.status === 'active');
  assert.equal((await api('POST', '/api/crash', {})).json.worker, 'w-c');
  assert.equal(await slow.exited, 1);
  assert.equal((await job(id)).status, 'active'); // still held: nothing lost
  const again = start(['src/worker.js'], { WORKER_NAME: 'w-c', INSTANCE_NUMBER: '0', JOB_SPEED: '1' }); // what systemd does on Clever Cloud
  await until(() => again.output.includes(`recovered ${id}`));
  await until(async () => (await job(id))?.status === 'done');
  const w = (await api('GET', '/api/state')).json.workers.find((x) => x.name === 'w-c');
  assert.equal(w.starts, 2);
});

t('SIGTERM hands the current job back without counting the attempt', async () => {
  const w = procs.filter((p) => p.spawnargs.includes('src/worker.js') && p.exitCode === null).at(-1);
  const [id] = (await api('POST', '/api/jobs', { kind: 'import' })).json.ids;
  await until(async () => (await job(id))?.status === 'active', 5000);
  w.kill('SIGTERM');
  assert.equal(await w.exited, 0);
  const j = await job(id);
  assert.equal(j.status, 'waiting');
  assert.equal(j.attempt, 0);
});

t('the minute report: every instance fires, only one prints', async () => {
  Object.assign(process.env, { REDIS_URL: env.REDIS_URL, QUEUE_PREFIX: 'test:' });
  const { minuteReport } = await import('../src/report.js');
  const { connect } = await import('../src/redis.js');
  const r = await connect('test');
  const now = Date.UTC(2026, 10, 4, 12, 0, 0, 300);
  const a = await minuteReport(r, 'cron.json', now);
  const b = await minuteReport(r, 'cron.json', now + 400);
  assert.equal(a.run.outcome, 'printed');
  assert.ok(a.report);
  assert.equal(b.run.outcome, 'skipped');
  assert.equal(b.report, null);
  const next = await minuteReport(r, 'scheduler', now + 60000);
  assert.equal(next.run.outcome, 'printed');
  await r.close();
});
