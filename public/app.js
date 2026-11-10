// The Sorting Office, client side: polls /api/state every second and draws the floor.
// No framework. Lists are keyed, so only new envelopes animate.
const $ = (selector) => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';
const LABEL = { export: 'Invoice export', email: 'Welcome email', thumbnail: 'Product thumbnails', import: 'Contacts import' };

let offset = 0; // server clock minus browser clock
let state = null;
let lastReport = 0;
const serverNow = () => Date.now() + offset;

// ---------- small DOM helpers ----------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
function icon(type) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${LABEL[type] ? type : 'export'}`);
  svg.append(use);
  return svg;
}
const ink = (n) => `ink-${['0', '1', '2', 'local'].includes(String(n)) ? n : 'x'}`;
const utc = (t, withSeconds = true) => new Date(t).toISOString().slice(11, withSeconds ? 19 : 16);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Reuse the existing node for each key; only new nodes are created (and animate).
function reconcile(container, items, keyOf, render, empty) {
  const existing = new Map([...container.children].filter((c) => c.dataset.key).map((c) => [c.dataset.key, c]));
  const nodes = items.map((item) => {
    const key = keyOf(item);
    const fresh = render(item);
    const old = existing.get(key);
    if (old) { old.className = fresh.className; old.replaceChildren(...fresh.childNodes); return old; }
    fresh.dataset.key = key;
    return fresh;
  });
  if (!nodes.length && empty) nodes.push(h('li', { class: 'so-empty' }, empty));
  nodes.forEach((n, i) => { if (container.children[i] !== n) container.insertBefore(n, container.children[i] || null); });
  while (container.children.length > nodes.length) container.lastChild.remove();
}

// ---------- envelopes and rows ----------
function envelope(job, extra = {}) {
  const meta = extra.meta ?? `${LABEL[job.type]}${job.attempt ? ` · attempt ${job.attempt + (job.status === 'waiting' ? 1 : 0)} of ${job.maxAttempts}` : ''}`;
  const node = h('li', { class: `so-env ${job.plan !== 'normal' ? 'so-env--plan' : ''} ${extra.class || ''}`, 'data-plan': job.plan === 'flaky' ? 'fails twice' : job.plan === 'poison' ? 'always fails' : null },
    icon(job.type),
    h('span', { class: 'so-env__title' }, job.title),
    extra.side || h('span', { class: 'so-env__id' }, job.id),
    h('span', { class: 'so-env__meta' }, meta),
    extra.progress !== undefined ? h('span', { class: 'so-progress' }, h('span', { style: `width:${extra.progress}%` })) : null,
  );
  return node;
}

function trail(job) {
  return h('span', { class: 'so-trail', 'aria-label': job.log.map((l) => `${l.outcome} on instance ${l.instance ?? '?'}`).join(', ') },
    job.log.map((l) => h('i', { class: `${ink(l.instance)} ${l.outcome === 'failed' ? 'is-failed' : l.outcome === 'recovered' ? 'is-recovered' : ''}`, title: `${l.attempt ? `attempt ${l.attempt}: ` : ''}${l.outcome}${l.instance !== undefined ? ` on instance ${l.instance}` : ''}${l.error ? ` (${l.error})` : ''}${l.note ? ` (${l.note})` : ''}` }, l.outcome === 'failed' ? '×' : '')));
}

function doneRow(job) {
  return h('li', { class: 'so-row' },
    icon(job.type),
    h('span', { class: 'so-row__title' }, job.title),
    h('span', { class: 'so-row__side' }, trail(job), h('span', { class: 'so-time' }, utc(job.finishedAt))),
    h('span', { class: 'so-row__meta' }, `${job.id} · ${secs(job.durationMs)} · ${job.summary} · `, h('a', { href: `/results/${job.id}`, target: '_blank', rel: 'noopener' }, 'open')),
  );
}

function deadRow(job) {
  return h('li', { class: 'so-row' },
    icon(job.type),
    h('span', { class: 'so-row__title' }, `${job.id} · ${job.title}`),
    h('span', { class: 'so-row__side' }, trail(job), h('button', { class: 'so-requeue', type: 'button', onclick: () => requeue(job.id) }, 'Requeue')),
    h('span', { class: 'so-row__meta' }, `${job.attempt} attempts · ${job.error}`),
  );
}

// ---------- desks: instances and their workers ----------
function renderDesks(s) {
  const byInstance = new Map();
  for (const w of s.workers) {
    const key = `${w.instance}|${w.instanceId}`;
    if (!byInstance.has(key)) byInstance.set(key, []);
    byInstance.get(key).push(w);
  }
  const blocks = [...byInstance.values()].map((workers) => {
    const first = workers[0];
    return h('div', { class: `so-instance ${ink(first.instance)}` },
      h('div', { class: 'so-instance__head' }, h('span', { class: 'so-mark' }, String(first.instance).slice(0, 2)), `Instance ${first.instance}`, h('small', {}, first.instanceId)),
      workers.map((w) => {
        const job = s.active.find((j) => j.id === w.current);
        const restarts = w.starts - 1;
        return h('div', { class: `so-worker ${w.alive ? '' : 'so-worker--stale'}` },
          h('div', { class: 'so-worker__meta' },
            h('span', {}, h('b', {}, w.name)), h('span', {}, `pid ${w.pid}`), h('span', {}, `${w.processed} done`),
            restarts > 0 ? h('span', { class: 'so-worker__restarts' }, `restarted ${restarts}×`) : null,
            w.alive ? null : h('span', {}, 'not answering')),
          job
            ? h('ol', {}, envelope(job, { class: `so-env--active ${ink(first.instance)}`, meta: `${job.step} · attempt ${job.attempt} of ${job.maxAttempts}`, progress: job.progress }))
            : h('div', { class: 'so-idle' }, 'Waiting on ', h('code', {}, 'BLMOVE so:waiting'), ' for the next job'),
        );
      }),
    );
  });
  const desks = $('#desks');
  desks.replaceChildren(...(blocks.length ? blocks : [h('p', { class: 'so-empty' }, 'No worker is running. On Clever Cloud, check that CC_WORKER_COMMAND is set, then restart the app.')]));
}

// ---------- the minute report ----------
function renderStamps(s) {
  const now = serverNow();
  const thisMinute = Math.floor(now / 60000) * 60000;
  const count = window.innerWidth < 560 ? 5 : 8; // five minutes fit a phone
  const minutes = Array.from({ length: count }, (_, i) => thisMinute - (count - 1 - i) * 60000);
  const stamp = (t) => `${new Date(t).toISOString().slice(0, 16)}Z`;
  const rows = new Map();
  for (const run of s.cron.runs) {
    const key = `${run.instance}|${run.instanceId}`;
    if (!rows.has(key)) rows.set(key, { instance: run.instance, instanceId: run.instanceId, runs: new Map() });
    rows.get(key).runs.set(run.minute, run);
  }
  const visible = [...rows.values()].filter((row) => minutes.some((m) => row.runs.has(stamp(m))))
    .sort((a, b) => String(a.instance).localeCompare(String(b.instance)) || a.instanceId.localeCompare(b.instanceId));
  const table = $('#stamps');
  const caption = table.querySelector('caption');
  const head = h('tr', {}, h('th', {}, ''), minutes.map((m) => h('th', { scope: 'col' }, utc(m, false))));
  const body = visible.length
    ? visible.map((row) => h('tr', { class: ink(row.instance) },
      h('th', { scope: 'row' }, `Instance ${row.instance}`, h('small', {}, row.instanceId)),
      minutes.map((m) => {
        const run = row.runs.get(stamp(m));
        if (!run) return h('td', {}, h('span', { class: 'so-stamp so-stamp--none' }));
        const label = run.outcome === 'printed' ? `${utc(m, false)}: printed the report (${run.source})` : `${utc(m, false)}: fired, instance ${run.holder?.instance} had the lock (${run.source})`;
        return h('td', {}, h('span', { class: `so-stamp so-stamp--${run.outcome}`, title: label, 'aria-label': label }, run.source === 'scheduler' ? h('span', { class: 'so-stamp__src' }, 'w') : null));
      })))
    : [h('tr', {}, h('td', { colspan: count + 1, class: 'so-empty' }, 'No cron run yet. The first one fires at the next full minute.'))];
  table.replaceChildren(caption, h('thead', {}, head), h('tbody', {}, body));

  // One line that says what the stamps prove, from the last complete minute.
  const last = [...new Set(s.cron.runs.map((r) => r.minute))][0];
  const runs = s.cron.runs.filter((r) => r.minute === last);
  let note = $('.so-stamps__note');
  if (!note) { note = h('p', { class: 'so-stamps__note' }); $('.so-stamps').append(note); }
  note.replaceChildren(...(runs.length ? [
    `At ${last.slice(11, 16)} UTC the cron fired on `, h('strong', {}, `${runs.length} instance${runs.length > 1 ? 's' : ''}`),
    ` and the report was printed `, h('strong', {}, `${runs.filter((r) => r.outcome === 'printed').length} time${runs.filter((r) => r.outcome === 'printed').length > 1 ? 's' : ''}`), '.',
    runs.some((r) => r.source === 'scheduler') ? ' "w": run by the scheduler worker instead of cron.json.' : '',
  ] : []));
}

function renderReceipt(report) {
  const receipt = $('#receipt');
  if (!report) return;
  const per = Object.entries(report.byInstance).sort().map(([i, n]) => [`  by instance ${i}`, String(n)]);
  const lines = [
    ['Jobs done', String(report.done)], ...per,
    ['Failed attempts', String(report.failedAttempts)],
    ['Dead letters', String(report.dead)],
    ['Average time', report.done ? secs(report.avgMs) : '–'],
    ['Waiting now', String(report.waiting)],
    ['Back later', String(report.retry)],
    ['Workers alive', String(report.workers)],
  ];
  receipt.className = `so-receipt ${ink(report.by.instance)} ${report.at !== lastReport && lastReport ? 'is-fresh' : ''}`;
  lastReport = report.at;
  receipt.replaceChildren(
    h('h3', {}, `Minute report, ${report.minute.slice(11, 16)} UTC`),
    h('div', { class: 'so-receipt__by' }, h('span', { class: 'so-mark' }, String(report.by.instance).slice(0, 2)), `printed by instance ${report.by.instance} (${report.by.source})`),
    h('dl', {}, lines.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
  );
}

// ---------- the Redis wire ----------
function renderWire(events) {
  reconcile($('#wire'), events, (e) => `${e.t}|${e.cmd}`, (e) => {
    const instance = (e.who.match(/· i(\S+)/) || [])[1];
    return h('li', { class: ink(instance) },
      h('span', { class: 'so-wire__t' }, utc(e.t)),
      h('span', { class: 'so-wire__who' }, e.who),
      h('span', { class: 'so-wire__cmd' }, e.cmd, e.result ? h('span', {}, e.result) : null));
  });
}

function renderPlatform(s) {
  const p = s.platform;
  const rows = [
    ['Application', p.CC_APP_NAME], ['App ID', p.APP_ID], ['Instance', p.INSTANCE_NUMBER !== null ? `#${p.INSTANCE_NUMBER}${p.CC_PRETTY_INSTANCE_NAME ? ` · ${p.CC_PRETTY_INSTANCE_NAME}` : ''}` : null],
    ['Instance type', p.INSTANCE_TYPE], ['Commit', p.CC_COMMIT_ID], ['Deployment', p.CC_DEPLOYMENT_ID],
  ];
  $('#platform').replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: v ? '' : 'is-empty' }, v || 'not on Clever Cloud'))));
  $('#served-by').textContent = `page served by instance ${s.servedBy.instance}`;
}

// ---------- main render ----------
function render(s) {
  const instances = new Set(s.workers.filter((w) => w.alive).map((w) => `${w.instance}|${w.instanceId}`));
  const live = Boolean(s.platform.APP_ID); // Clever Cloud injects APP_ID; without it this is a local run
  $('#live-text').textContent = live ? `Live · ${instances.size} instance${instances.size === 1 ? '' : 's'}` : 'Local · not on Clever Cloud';
  $('#live').classList.toggle('cc-pill--live', live);
  $('#live').classList.toggle('cc-pill--muted', !live);
  $('#live .cc-dot').classList.toggle('cc-dot--muted', !live);
  $('#waiting-count').textContent = s.waiting.count;
  $('#worker-count').textContent = s.workers.filter((w) => w.alive).length;
  $('#retry-count').textContent = s.retry.length;
  $('#done-count').textContent = s.counters.done;
  $('#dead-count').textContent = s.dead.count;

  const shown = s.waiting.next.slice(0, 9);
  const tray = $('#tray');
  reconcile(tray, shown, (j) => j.id, (j) => envelope(j), 'The tray is empty. Post a job above.');
  if (s.waiting.count > shown.length) tray.append(h('li', { class: 'so-more' }, `+ ${s.waiting.count - shown.length} more in the tray`));

  renderDesks(s);
  reconcile($('#retry'), s.retry, (j) => `${j.id}|${j.attempt}`, (j) => envelope(j, {
    side: h('span', { class: 'so-countdown', 'data-due': j.dueAt }, `in ${Math.max(0, (j.dueAt - serverNow()) / 1000).toFixed(1)} s`),
    meta: h('span', {}, `attempt ${j.attempt} of ${j.maxAttempts} failed: `, h('span', { class: 'so-err' }, j.error)),
  }), 'Nothing to retry.');
  reconcile($('#done'), s.done, (j) => j.id, doneRow, 'Nothing delivered yet.');
  reconcile($('#dead'), s.dead.jobs, (j) => j.id, deadRow, 'No dead letters. Post a job that always fails to see one arrive.');
  renderStamps(s);
  renderReceipt(s.cron.last);
  renderWire(s.events);
  renderPlatform(s);
}

async function poll() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    state = await res.json();
    offset = state.now - Date.now();
    $('#live').classList.remove('cc-pill--muted');
    render(state);
  } catch (err) {
    $('#live-text').textContent = 'Reconnecting';
    $('#live').classList.add('cc-pill--muted');
  } finally {
    setTimeout(poll, 1000);
  }
}

// ---------- actions ----------
function toast(text, error = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('is-error', error);
}
async function post(url, body = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
document.querySelectorAll('[data-kind]').forEach((button) => button.addEventListener('click', async () => {
  try {
    const { ids } = await post('/api/jobs', { kind: button.dataset.kind });
    toast(ids.length > 1 ? `Posted ${ids.length} jobs, ${ids[0]} to ${ids.at(-1)}.` : `Posted ${ids[0]}.`);
  } catch (err) { toast(err.message, true); }
}));
$('#crash').addEventListener('click', async () => {
  try {
    const r = await post('/api/crash');
    toast(`Asked ${r.worker} on instance ${r.instance} to exit with code 1${r.holding ? ` while holding ${r.holding}` : ''}. Watch Clever Cloud start it again.`);
  } catch (err) { toast(err.message, true); }
});
async function requeue(id) {
  try { await post(`/api/jobs/${id}/requeue`); toast(`${id} is back at the head of the tray.`); } catch (err) { toast(err.message, true); }
}

// ---------- the clock: second hand, minute hand, next run ----------
(function clock() {
  const ticks = $('#ticks');
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 * Math.PI) / 180;
    const inner = i === 0 ? 72 : i % 5 === 0 ? 78 : 84;
    const line = document.createElementNS(SVG, 'line');
    line.setAttribute('x1', 100 + inner * Math.sin(a)); line.setAttribute('y1', 100 - inner * Math.cos(a));
    line.setAttribute('x2', 100 + 90 * Math.sin(a)); line.setAttribute('y2', 100 - 90 * Math.cos(a));
    line.setAttribute('class', `so-clock__tick ${i === 0 ? 'so-clock__tick--zero' : i % 5 === 0 ? 'so-clock__tick--hour' : ''}`);
    ticks.append(line);
  }
  const tick = () => {
    const now = new Date(serverNow());
    const s = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
    $('#hand-s').setAttribute('transform', `rotate(${s * 6} 100 100)`);
    $('#hand-m').setAttribute('transform', `rotate(${(now.getUTCMinutes() + s / 60) * 6} 100 100)`);
    $('#clock-utc').textContent = now.toISOString().slice(11, 19);
    $('#next-run').textContent = `next run in ${Math.ceil(60 - s)} s`;
    document.querySelectorAll('.so-countdown').forEach((c) => { c.textContent = `in ${Math.max(0, (Number(c.dataset.due) - serverNow()) / 1000).toFixed(1)} s`; });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}());

poll();
