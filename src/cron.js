// One run of the minute report, then exit. Called every minute by clevercloud/cron.json, through bin/minute-report.sh.
import { connect } from './redis.js';
import { minuteReport } from './report.js';

const source = process.argv[2] || 'cron.json';
const timer = setTimeout(() => { console.error('[cron] timed out after 20 s'); process.exit(1); }, 20000);

const r = await connect('cron');
const { run, report } = await minuteReport(r, source);
console.log(report
  ? `[cron] ${run.minute} report printed by instance ${run.instance}: ${report.done} done, ${report.failedAttempts} failed attempts, ${report.waiting} waiting`
  : `[cron] ${run.minute} fired on instance ${run.instance}: skipped, instance ${run.holder?.instance} already printed it`);
await r.close();
clearTimeout(timer);
