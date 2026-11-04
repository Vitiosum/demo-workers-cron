// The worker. Clever Cloud starts it next to the web server on every instance:
//   CC_WORKER_COMMAND="node src/worker.js"
// It runs as a systemd service; if it exits with an error, systemd starts it again (CC_WORKER_RESTART=on-failure).
import { connect } from './redis.js';
import { K, event, appendLog, promoteDueRetries, recoverActive, reapGoneWorkers, RESULT_TTL } from './queue.js';
import { TYPES, failureFor, produce } from './jobs.js';
import { instance, workerName as me, FLAKY_RATE, JOB_SPEED, RETRY_BASE_SECONDS } from './config.js';

const who = `worker ${me} · i${instance.number}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Interrupted extends Error {}

let current = null; // the job id this worker holds
let working = null; // the promise of that job
let stopping = false;

const r = await connect('worker');
const blocking = r.duplicate(); // BLMOVE blocks its connection: it gets one of its own
blocking.on('error', (err) => { if (!stopping) console.error(`[worker] redis (blocking): ${err.message}`); });
await blocking.connect();

async function register() {
  const previousPid = await r.hGet(K.worker(me), 'pid');
  const tx = r.multi()
    .hSet(K.worker(me), { name: me, instance: instance.number, instanceId: instance.id, host: instance.host, pid: process.pid, startedAt: Date.now(), current: '', cmd: 'node src/worker.js' })
    .hIncrBy(K.worker(me), 'starts', 1)
    .persist(K.worker(me))
    .zAdd(K.workers, { score: Date.now(), value: me });
  const [, starts] = await event(tx, who, `HINCRBY ${K.worker(me)} starts 1`, `worker started · pid ${process.pid}`).exec();
  // A job still in our own "active" list means the previous process died while holding it.
  const recovered = await recoverActive(r, me, who, `worker process ${previousPid || '?'} died while holding it`);
  console.log(`[worker] ${me} started on instance ${instance.number} (pid ${process.pid}, start #${starts})${recovered.length ? `; recovered ${recovered.join(', ')}` : ''}`);
}

// Sleep through a step, checking for a crash request or a stop signal four times a second.
async function pause(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(Math.min(250, end - Date.now()));
    if (stopping) throw new Interrupted();
    if (await r.get(K.crash(me))) await crashNow();
  }
}

// The "Crash a worker" button: exit with code 1 in the middle of a job, like an out-of-memory kill would.
async function crashNow() {
  await r.del(K.crash(me));
  await event(r.multi(), who, `GET ${K.crash(me)}`, `crash requested · exit 1${current ? ` while holding ${current}` : ''}`).exec();
  console.error(`[worker] crash requested from the page: exiting with code 1${current ? ` while holding ${current}` : ''}`);
  process.exit(1);
}

async function work(id) {
  const key = K.job(id);
  const job = await r.hGetAll(key);
  if (!job.id) { await r.lRem(K.active(me), 0, id); return; } // expired meanwhile
  const type = TYPES[job.type];
  const attempt = await r.hIncrBy(key, 'attempt', 1);
  const started = Date.now();
  const tx = r.multi()
    .hSet(key, { status: 'active', worker: me, instance: instance.number, startedAt: started, progress: 0, step: type.steps[0][0], error: '', dueAt: '' })
    .hSet(K.worker(me), 'current', id);
  await event(tx, who, `BLMOVE ${K.waiting} ${K.active(me)} RIGHT LEFT 2`, `${id} · attempt ${attempt}/${job.maxAttempts}`).exec();

  const failure = failureFor(job, attempt, FLAKY_RATE);
  try {
    for (const [i, [label, ms]] of type.steps.entries()) {
      await r.hSet(key, { step: label, progress: Math.round((i / type.steps.length) * 100) });
      await pause(ms / JOB_SPEED);
      if (failure && failure.atStep === i) throw new Error(failure.error);
    }
  } catch (err) {
    if (err instanceof Interrupted) { await r.hIncrBy(key, 'attempt', -1); return; } // interrupted, not failed: shutdown() hands it back
    return fail(job, attempt, err.message);
  }
  return succeed(job, attempt, started);
}

async function succeed(job, attempt, started) {
  const { id } = job;
  const ms = Date.now() - started;
  const result = produce(job);
  await appendLog(r, id, { attempt, worker: me, instance: instance.number, outcome: 'done', ms });
  const tx = r.multi()
    .hSet(K.job(id), { status: 'done', progress: 100, step: 'Done', finishedAt: Date.now(), durationMs: ms, summary: result.summary })
    .hSet(K.result(id), { contentType: result.contentType, body: result.body })
    .expire(K.result(id), RESULT_TTL)
    .lRem(K.active(me), 0, id)
    .lPush(K.done, id).lTrim(K.done, 0, 49)
    .hIncrBy(K.counters, 'done', 1)
    .hIncrBy(K.worker(me), 'processed', 1)
    .hSet(K.worker(me), 'current', '')
    .lPush(K.history, JSON.stringify({ at: Date.now(), id, outcome: 'done', ms, instance: instance.number })).lTrim(K.history, 0, 999);
  await event(tx, who, `LREM ${K.active(me)} 0 ${id} · LPUSH ${K.done} ${id}`, `done in ${(ms / 1000).toFixed(1)} s · ${result.summary}`).exec();
}

async function fail(job, attempt, error) {
  const { id } = job;
  const max = Number(job.maxAttempts);
  await appendLog(r, id, { attempt, worker: me, instance: instance.number, outcome: 'failed', error });
  const tx = r.multi()
    .hSet(K.job(id), { error, progress: 0, step: '' })
    .lRem(K.active(me), 0, id)
    .hSet(K.worker(me), 'current', '')
    .hIncrBy(K.counters, 'failed', 1)
    .hIncrBy(K.worker(me), 'failed', 1)
    .lPush(K.history, JSON.stringify({ at: Date.now(), id, outcome: 'failed', instance: instance.number })).lTrim(K.history, 0, 999);
  if (attempt < max) {
    // Exponential backoff: 3 s, then 6 s.
    const delay = RETRY_BASE_SECONDS * 1000 * 2 ** (attempt - 1);
    const dueAt = Date.now() + delay;
    tx.hSet(K.job(id), { status: 'retry', dueAt }).zAdd(K.retry, { score: dueAt, value: id });
    await event(tx, who, `ZADD ${K.retry} ${dueAt} ${id}`, `${error} · retry in ${delay / 1000} s`).exec();
  } else {
    tx.hSet(K.job(id), { status: 'dead', finishedAt: Date.now() })
      .lPush(K.dead, id).lTrim(K.dead, 0, 49)
      .hIncrBy(K.counters, 'dead', 1)
      .lPush(K.history, JSON.stringify({ at: Date.now(), id, outcome: 'dead', instance: instance.number }));
    await event(tx, who, `LPUSH ${K.dead} ${id}`, `${error} · gave up after ${attempt} attempts`).exec();
  }
}

// Heartbeat, due retries, and jobs left behind by workers that are gone.
let ticks = 0;
const housekeeping = setInterval(async () => {
  try {
    if (++ticks % 2 === 0) await r.zAdd(K.workers, { score: Date.now(), value: me });
    await promoteDueRetries(r, who);
    if (ticks % 5 === 0) await reapGoneWorkers(r, me, who);
  } catch (err) {
    console.error(`[worker] housekeeping: ${err.message}`);
  }
}, 1000);

// SIGTERM comes with a deployment or a scale-down: hand the current job back, then stop.
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(housekeeping);
  console.log(`[worker] ${signal}: handing back ${current || 'nothing'} and stopping`);
  try {
    await Promise.race([working, sleep(3000)]);
    blocking.destroy();
    await recoverActive(r, me, who, `worker stopped (${signal}) and handed it back`);
    await r.multi().zRem(K.workers, me).hSet(K.worker(me), 'current', '').exec();
    await r.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Anything unexpected: exit with an error and let Clever Cloud restart the worker.
process.on('unhandledRejection', (err) => { console.error(`[worker] ${err?.stack || err}`); process.exit(1); });

await register();
while (!stopping) {
  let id = null;
  try {
    id = await blocking.blMove(K.waiting, K.active(me), 'RIGHT', 'LEFT', 2);
  } catch (err) {
    if (stopping) break;
    console.error(`[worker] BLMOVE: ${err.message}`);
    await sleep(1000);
    continue;
  }
  if (!id) {
    if (!stopping && (await r.get(K.crash(me)))) await crashNow();
    continue;
  }
  current = id;
  working = work(id);
  await working;
  current = null;
}
