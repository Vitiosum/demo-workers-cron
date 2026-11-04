// The same minute report without cron.json: a second worker that wakes up at the start of every minute.
// For deployments where clevercloud/cron.json is not read, such as a monorepo deployed with APP_FOLDER:
//   CC_WORKER_COMMAND_1="node src/scheduler.js"
// It takes the same Redis lock, so it can even run next to cron.json without printing twice.
import { connect } from './redis.js';
import { minuteReport } from './report.js';
import { instance } from './config.js';

const r = await connect('scheduler');
const stop = async () => { await r.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

console.log(`[scheduler] started on instance ${instance.number} (pid ${process.pid})`);
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 60000 - (Date.now() % 60000)));
  try {
    const { run, report } = await minuteReport(r, 'scheduler');
    console.log(report
      ? `[scheduler] ${run.minute} report printed by instance ${run.instance}: ${report.done} done`
      : `[scheduler] ${run.minute} skipped, instance ${run.holder?.instance} already printed it`);
  } catch (err) {
    console.error(`[scheduler] ${err.message}`);
  }
}
