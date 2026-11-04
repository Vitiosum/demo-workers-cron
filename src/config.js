// Settings and identity, read once from the environment.
import os from 'node:os';

const env = process.env;
const num = (value, fallback) => (value === undefined || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value));

// The Redis add-on injects REDIS_URL into every linked app: the web server, the workers and the cron all read it.
export const REDIS_URL = env.REDIS_URL || 'redis://127.0.0.1:6379';
export const PREFIX = env.QUEUE_PREFIX || 'so:';

export const MAX_ATTEMPTS = num(env.MAX_ATTEMPTS, 3);
export const RETRY_BASE_SECONDS = num(env.RETRY_BASE_SECONDS, 3); // 3 s, then 6 s
export const FLAKY_RATE = num(env.FLAKY_RATE, 0.08); // share of ordinary jobs that hit a transient error
export const JOB_SPEED = num(env.JOB_SPEED, 1); // 10 = ten times faster (tests)
export const QUEUE_LIMIT = num(env.QUEUE_LIMIT, 300);
export const PORT = num(env.PORT, 8080);

// Clever Cloud numbers the instances of an app (INSTANCE_NUMBER = 0, 1…) and gives each one an INSTANCE_ID.
const instanceId = env.INSTANCE_ID || os.hostname();
export const instance = {
  number: env.INSTANCE_NUMBER ?? 'local',
  id: instanceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8),
  host: os.hostname(),
};

// A worker keeps the same name when Clever Cloud restarts it on the same instance: its restarts can be counted.
export const workerName = env.WORKER_NAME || `w-${instance.id}`;

// Only these platform variables are ever shown on the page.
export function platform() {
  return {
    CC_APP_NAME: env.CC_APP_NAME || null,
    APP_ID: env.APP_ID || null,
    INSTANCE_NUMBER: env.INSTANCE_NUMBER ?? null,
    INSTANCE_TYPE: env.INSTANCE_TYPE || null,
    CC_PRETTY_INSTANCE_NAME: env.CC_PRETTY_INSTANCE_NAME || null,
    CC_COMMIT_ID: env.CC_COMMIT_ID ? env.CC_COMMIT_ID.slice(0, 7) : null,
    CC_DEPLOYMENT_ID: env.CC_DEPLOYMENT_ID || null,
  };
}
