// The minute report: a scheduled task that must run once per minute, whatever the number of instances.
// Clever Cloud runs clevercloud/cron.json on EVERY instance of the app. Each run tries to take a Redis lock
// for its minute (SET NX); the first one prints the report, the others record that they were skipped.
import { K, event } from './queue.js';
import { instance } from './config.js';

// Crons fire at second 0 on every instance; rounding to the nearest minute absorbs small clock differences.
export function minuteStamp(now = Date.now()) {
  return `${new Date(Math.round(now / 60000) * 60000).toISOString().slice(0, 16)}Z`;
}

export async function minuteReport(r, source, now = Date.now()) {
  const minute = minuteStamp(now);
  const me = { instance: instance.number, instanceId: instance.id, host: instance.host, source, pid: process.pid };
  const who = `${source === 'cron.json' ? 'cron' : 'scheduler'} · i${instance.number}`;
  const lock = K.cronLock(minute);

  const won = (await r.set(lock, JSON.stringify(me), { condition: 'NX', expiration: { type: 'EX', value: 120 } })) === 'OK';
  const holder = won ? me : JSON.parse((await r.get(lock)) || 'null');
  const run = {
    minute, at: now, ...me,
    outcome: won ? 'printed' : 'skipped',
    holder: holder ? { instance: holder.instance, instanceId: holder.instanceId, source: holder.source } : null,
  };
  const tx = r.multi().lPush(K.cronRuns, JSON.stringify(run)).lTrim(K.cronRuns, 0, 59);
  await event(tx, who, `SET ${lock} NX EX 120`, won ? 'OK · this instance prints the report' : `nil · instance ${holder?.instance ?? '?'} already printed it`).exec();
  if (!won) return { run, report: null };

  const [history, waiting, retry, workers] = await Promise.all([
    r.lRange(K.history, 0, 999),
    r.lLen(K.waiting),
    r.zCard(K.retry),
    r.zRangeByScore(K.workers, now - 8000, '+inf'),
  ]);
  const lastMinute = history.map((h) => JSON.parse(h)).filter((h) => h.at >= now - 60000);
  const done = lastMinute.filter((h) => h.outcome === 'done');
  const byInstance = {};
  for (const h of done) byInstance[h.instance] = (byInstance[h.instance] || 0) + 1;
  const report = {
    minute, at: now, by: me,
    done: done.length,
    failedAttempts: lastMinute.filter((h) => h.outcome === 'failed').length,
    dead: lastMinute.filter((h) => h.outcome === 'dead').length,
    avgMs: done.length ? Math.round(done.reduce((sum, h) => sum + h.ms, 0) / done.length) : 0,
    byInstance, waiting, retry, workers: workers.length,
  };
  await event(r.multi().set(K.cronLast, JSON.stringify(report)), who, `SET ${K.cronLast} <report>`, `${report.done} done · ${report.failedAttempts} failed attempts this minute`).exec();
  return { run, report };
}
