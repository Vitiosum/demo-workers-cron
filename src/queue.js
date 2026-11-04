// The job queue, on plain Redis data structures. Every key starts with PREFIX ("so:").
//
//   so:waiting          LIST   job ids waiting; posted with LPUSH, taken from the right with BLMOVE
//   so:active:<worker>  LIST   the job a worker holds; still there if the worker crashes, so nothing is lost
//   so:retry            ZSET   failed jobs, scored by the time they may run again
//   so:done / so:dead   LIST   finished jobs, newest first; dead = failed MAX_ATTEMPTS times
//   so:job:<id>         HASH   one job: type, status, attempt, worker, progress, log
//   so:workers          ZSET   worker names, scored by their last heartbeat
//   so:events           LIST   the last Redis commands, shown on the page
import { PREFIX, MAX_ATTEMPTS, QUEUE_LIMIT } from './config.js';
import { TYPES, describe } from './jobs.js';

export const K = {
  seq: `${PREFIX}seq`,
  waiting: `${PREFIX}waiting`,
  retry: `${PREFIX}retry`,
  done: `${PREFIX}done`,
  dead: `${PREFIX}dead`,
  counters: `${PREFIX}counters`,
  history: `${PREFIX}history`,
  events: `${PREFIX}events`,
  workers: `${PREFIX}workers`,
  seeded: `${PREFIX}seeded`,
  crashCooldown: `${PREFIX}crash:cooldown`,
  cronRuns: `${PREFIX}cron:runs`,
  cronLast: `${PREFIX}cron:last`,
  job: (id) => `${PREFIX}job:${id}`,
  result: (id) => `${PREFIX}result:${id}`,
  active: (worker) => `${PREFIX}active:${worker}`,
  worker: (worker) => `${PREFIX}worker:${worker}`,
  crash: (worker) => `${PREFIX}crash:${worker}`,
  cronLock: (minute) => `${PREFIX}cron:lock:${minute}`,
};

const JOB_TTL = 6 * 3600; // a job hash lives 6 hours
export const RESULT_TTL = 3600;

// Record a command on the page's "Redis wire". Chainable on a MULTI.
export function event(tx, who, cmd, result = '') {
  return tx.lPush(K.events, JSON.stringify({ t: Date.now(), who, cmd, result })).lTrim(K.events, 0, 59);
}

// Post one job. plan: "normal", "flaky" (fails twice, then succeeds) or "poison" (always fails).
export async function enqueue(r, type, plan = 'normal', who = 'web') {
  if (!TYPES[type]) throw new Error(`unknown job type ${type}`);
  const n = await r.incr(K.seq);
  const id = `J-${String(n).padStart(4, '0')}`;
  const job = {
    id, type, plan,
    title: describe(type, id),
    status: 'waiting',
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    createdAt: Date.now(),
    log: '[]',
  };
  const tx = r.multi()
    .hSet(K.job(id), job)
    .expire(K.job(id), JOB_TTL)
    .lPush(K.waiting, id)
    .hIncrBy(K.counters, 'posted', 1);
  await event(tx, who, `LPUSH ${K.waiting} ${id}`, `${TYPES[type].label}${plan === 'normal' ? '' : ` (${plan})`}`).exec();
  return id;
}

export async function queueIsFull(r) {
  return (await r.lLen(K.waiting)) >= QUEUE_LIMIT;
}

// A dead job goes back to the queue with a fresh set of attempts.
export async function requeue(r, id, who = 'web') {
  const removed = await r.lRem(K.dead, 0, id);
  if (!removed) return false;
  const tx = r.multi()
    .hSet(K.job(id), { status: 'waiting', attempt: 0, plan: 'normal', error: '', progress: 0, step: '' })
    .expire(K.job(id), JOB_TTL)
    .rPush(K.waiting, id);
  await event(tx, who, `LREM ${K.dead} 0 ${id} · RPUSH ${K.waiting} ${id}`, 'requeued at the head of the queue').exec();
  return true;
}

// Retries whose time has come go back to the head of the queue. ZREM makes sure only one worker moves each job.
export async function promoteDueRetries(r, who) {
  const due = await r.zRangeByScore(K.retry, 0, Date.now(), { LIMIT: { offset: 0, count: 20 } });
  for (const id of due) {
    if (await r.zRem(K.retry, id)) {
      const tx = r.multi().hSet(K.job(id), { status: 'waiting', dueAt: '' }).rPush(K.waiting, id);
      await event(tx, who, `ZREM ${K.retry} ${id} · RPUSH ${K.waiting} ${id}`, 'retry due').exec();
    }
  }
}

// Jobs held by a worker that is gone are put back at the head of the queue.
export async function recoverActive(r, worker, who, reason) {
  const recovered = [];
  for (;;) {
    const id = await r.lMove(K.active(worker), K.waiting, 'RIGHT', 'RIGHT');
    if (!id) break;
    await appendLog(r, id, { outcome: 'recovered', note: reason });
    const tx = r.multi().hSet(K.job(id), { status: 'waiting', progress: 0, step: '' }).hIncrBy(K.counters, 'recovered', 1);
    await event(tx, who, `LMOVE ${K.active(worker)} ${K.waiting} RIGHT RIGHT`, `${id} recovered: ${reason}`).exec();
    recovered.push(id);
  }
  return recovered;
}

// Workers that stopped beating for 15 s are gone (instance removed, process stopped for good).
export async function reapGoneWorkers(r, self, who) {
  const stale = await r.zRangeByScore(K.workers, 0, Date.now() - 15000);
  for (const worker of stale) {
    if (worker === self) continue;
    if (await r.zRem(K.workers, worker)) {
      await recoverActive(r, worker, who, `worker ${worker} stopped answering`);
      await r.expire(K.worker(worker), 600);
    }
  }
}

export async function appendLog(r, id, entry) {
  const raw = await r.hGet(K.job(id), 'log');
  const log = raw ? JSON.parse(raw) : [];
  log.push({ at: Date.now(), ...entry });
  await r.hSet(K.job(id), 'log', JSON.stringify(log.slice(-8)));
}

function parseJob(h) {
  if (!h || !h.id) return null;
  return {
    id: h.id, type: h.type, plan: h.plan, title: h.title, status: h.status,
    attempt: Number(h.attempt || 0), maxAttempts: Number(h.maxAttempts || MAX_ATTEMPTS),
    worker: h.worker || null, instance: h.instance ?? null,
    progress: Number(h.progress || 0), step: h.step || '',
    error: h.error || '', summary: h.summary || '',
    createdAt: Number(h.createdAt || 0), startedAt: Number(h.startedAt || 0), finishedAt: Number(h.finishedAt || 0),
    dueAt: Number(h.dueAt || 0), durationMs: Number(h.durationMs || 0),
    log: h.log ? JSON.parse(h.log) : [],
  };
}

// Everything the page shows, read in one round of pipelined commands.
export async function snapshot(r) {
  const now = Date.now();
  const [waitingIds, waitingCount, retry, doneIds, deadIds, deadCount, workerScores, counters, cronRuns, cronLast, events] = await Promise.all([
    r.lRange(K.waiting, -30, -1),
    r.lLen(K.waiting),
    r.zRangeWithScores(K.retry, 0, 19),
    r.lRange(K.done, 0, 7),
    r.lRange(K.dead, 0, 11),
    r.lLen(K.dead),
    r.zRangeWithScores(K.workers, 0, -1),
    r.hGetAll(K.counters),
    r.lRange(K.cronRuns, 0, 39),
    r.get(K.cronLast),
    r.lRange(K.events, 0, 24),
  ]);

  const recent = workerScores.filter((w) => now - w.score < 120000);
  const workerHashes = await Promise.all(recent.map((w) => r.hGetAll(K.worker(w.value))));
  const workers = recent.map((w, i) => {
    const h = workerHashes[i];
    return {
      name: w.value, instance: h.instance ?? null, instanceId: h.instanceId || '', host: h.host || '',
      pid: Number(h.pid || 0), startedAt: Number(h.startedAt || 0), starts: Number(h.starts || 1),
      processed: Number(h.processed || 0), failed: Number(h.failed || 0), current: h.current || null,
      beatAt: w.score, alive: now - w.score < 8000, cmd: h.cmd || '',
    };
  }).sort((a, b) => String(a.instance).localeCompare(String(b.instance)) || a.name.localeCompare(b.name));

  const ids = new Set([...waitingIds, ...retry.map((x) => x.value), ...doneIds, ...deadIds, ...workers.map((w) => w.current).filter(Boolean)]);
  const jobs = new Map();
  const hashes = await Promise.all([...ids].map((id) => r.hGetAll(K.job(id))));
  for (const h of hashes) { const j = parseJob(h); if (j) jobs.set(j.id, j); }
  const get = (id) => jobs.get(id);

  return {
    now,
    waiting: { count: waitingCount, next: waitingIds.slice().reverse().map(get).filter(Boolean) },
    active: workers.filter((w) => w.current).map((w) => get(w.current)).filter(Boolean),
    retry: retry.map((x) => get(x.value)).filter(Boolean),
    done: doneIds.map(get).filter(Boolean),
    dead: { count: deadCount, jobs: deadIds.map(get).filter(Boolean) },
    workers,
    counters: {
      posted: Number(counters.posted || 0), done: Number(counters.done || 0),
      failedAttempts: Number(counters.failed || 0), dead: Number(counters.dead || 0),
      recovered: Number(counters.recovered || 0),
    },
    cron: { runs: cronRuns.map((x) => JSON.parse(x)), last: cronLast ? JSON.parse(cronLast) : null },
    events: events.map((x) => JSON.parse(x)),
  };
}
