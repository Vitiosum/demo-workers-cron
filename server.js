// The web side. It never does the work itself: it posts jobs to Redis and shows the board.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './src/redis.js';
import { K, enqueue, requeue, snapshot, queueIsFull, event } from './src/queue.js';
import { TYPES } from './src/jobs.js';
import { PORT, QUEUE_LIMIT, instance, platform } from './src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const who = `web · i${instance.number}`;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/cc-brand.css': ['cc-brand.css', 'text/css; charset=utf-8'],
  '/cc-logo.svg': ['cc-logo.svg', 'image/svg+xml'],
  '/cc-badge.svg': ['cc-badge.svg', 'image/svg+xml'],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// Redis is reached lazily, so /health answers even when the add-on is down.
let redisPromise = null;
function redis() {
  redisPromise ??= connect('web').catch((err) => { redisPromise = null; throw err; });
  return redisPromise;
}

const send = (res, status, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON expected'), { status: 415 });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2048) throw Object.assign(new Error('body too large'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}

// What each button posts. "rush" is a burst of twelve ordinary jobs.
const KINDS = {
  export: [['export', 'normal']],
  email: [['email', 'normal']],
  thumbnail: [['thumbnail', 'normal']],
  import: [['import', 'normal']],
  flaky: [['email', 'flaky']],
  poison: [['import', 'poison']],
  rush: Array.from({ length: 12 }, (_, i) => [Object.keys(TYPES)[i % 4], 'normal']),
};

async function postJobs(req, res) {
  const { kind } = await readJson(req);
  if (!KINDS[kind]) return send(res, 400, { error: `kind must be one of ${Object.keys(KINDS).join(', ')}` });
  const r = await redis();
  if (await queueIsFull(r)) return send(res, 429, { error: `the queue already holds ${QUEUE_LIMIT} jobs, wait for the workers` });
  const ids = [];
  for (const [type, plan] of KINDS[kind]) ids.push(await enqueue(r, type, plan, who));
  send(res, 201, { ids });
}

// Ask one worker to exit with code 1, preferably one holding a job. At most one crash every 10 s.
async function crashWorker(req, res) {
  await readJson(req);
  const r = await redis();
  const state = await snapshot(r);
  const alive = state.workers.filter((w) => w.alive);
  if (!alive.length) return send(res, 409, { error: 'no worker is running' });
  if ((await r.set(K.crashCooldown, '1', { condition: 'NX', expiration: { type: 'EX', value: 10 } })) !== 'OK') {
    return send(res, 429, { error: 'a worker was just crashed, give Clever Cloud a few seconds to restart it' });
  }
  const busy = alive.filter((w) => w.current);
  const pool = busy.length ? busy : alive;
  const target = pool[Math.floor(Math.random() * pool.length)];
  const tx = r.multi().set(K.crash(target.name), '1', { expiration: { type: 'EX', value: 30 } });
  await event(tx, who, `SET ${K.crash(target.name)} 1 EX 30`, `asking ${target.name} on instance ${target.instance} to crash`).exec();
  send(res, 202, { worker: target.name, instance: target.instance, holding: target.current });
}

async function deepHealth(res) {
  try {
    const r = await redis();
    const started = Date.now();
    await r.ping();
    const [workers, cronLast] = await Promise.all([r.zRangeByScore(K.workers, Date.now() - 8000, '+inf'), r.get(K.cronLast)]);
    const lastReport = cronLast ? JSON.parse(cronLast) : null;
    const body = {
      redis: { ok: true, pingMs: Date.now() - started },
      workers: { alive: workers.length },
      cron: { lastReportSecondsAgo: lastReport ? Math.round((Date.now() - lastReport.at) / 1000) : null },
    };
    send(res, workers.length ? 200 : 503, { status: workers.length ? 'ok' : 'no worker alive', ...body });
  } catch (err) {
    send(res, 503, { status: 'redis unreachable', error: err.message });
  }
}

async function serveResult(res, id) {
  const r = await redis();
  const result = await r.hGetAll(K.result(id));
  if (!result.body) return send(res, 404, 'This result has expired (results are kept for one hour).\n', 'text/plain; charset=utf-8');
  const ext = { 'text/csv': 'csv', 'image/svg+xml': 'svg' }[result.contentType.split(';')[0]] || 'txt';
  send(res, 200, result.body, result.contentType, {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Content-Disposition': `inline; filename="${id}.${ext}"`,
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    const headers = p === '/' ? { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' } : { 'Cache-Control': 'public, max-age=300' };
    return send(res, 200, await readFile(path.join(here, 'public', file)), type, headers);
  }
  if (req.method === 'GET' && p === '/health') return send(res, 200, { status: 'ok', instance: instance.number });
  if (req.method === 'GET' && p === '/health/deep') return deepHealth(res);
  if (req.method === 'GET' && p === '/api/state') {
    const state = await snapshot(await redis());
    return send(res, 200, { ...state, servedBy: { instance: instance.number, instanceId: instance.id }, platform: platform(), queueLimit: QUEUE_LIMIT });
  }
  if (req.method === 'POST' && p === '/api/jobs') return postJobs(req, res);
  if (req.method === 'POST' && p === '/api/crash') return crashWorker(req, res);
  const requeueMatch = p.match(/^\/api\/jobs\/(J-\d{1,9})\/requeue$/);
  if (req.method === 'POST' && requeueMatch) {
    await readJson(req);
    const ok = await requeue(await redis(), requeueMatch[1], who);
    return send(res, ok ? 202 : 404, ok ? { id: requeueMatch[1] } : { error: 'not in the dead letter office' });
  }
  const resultMatch = p.match(/^\/results\/(J-\d{1,9})$/);
  if (req.method === 'GET' && resultMatch) return serveResult(res, resultMatch[1]);
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!err.status) console.error(`[web] ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) send(res, err.status || (err instanceof SyntaxError ? 400 : 503), { error: err.status || err instanceof SyntaxError ? err.message : 'Redis is not reachable' });
  });
});

// Seed: the first start posts one job of each kind, so the board is never empty. Idempotent (SET NX).
async function seed() {
  try {
    const r = await redis();
    if ((await r.set(K.seeded, String(Date.now()), { condition: 'NX' })) === 'OK') {
      for (const type of Object.keys(TYPES)) await enqueue(r, type, 'normal', `${who} (seed)`);
      console.log('[web] seed: posted one job of each kind');
    }
  } catch (err) {
    console.error(`[web] seed skipped: ${err.message}`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[web] listening on 0.0.0.0:${PORT} (instance ${instance.number})`);
  seed();
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
