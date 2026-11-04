// One Redis connection per process role. Blocking commands (BLMOVE) get their own connection.
import { createClient } from 'redis';
import { REDIS_URL } from './config.js';

export async function connect(role) {
  const client = createClient({
    url: REDIS_URL,
    socket: { connectTimeout: 5000, reconnectStrategy: (retries) => Math.min(250 * retries, 3000) },
  });
  client.on('error', (err) => console.error(`[${role}] redis: ${err.message}`));
  await client.connect();
  return client;
}
