#!/bin/bash -l
# Run every minute by clevercloud/cron.json, on every instance of the app.
# "bash -l" loads the app environment (REDIS_URL, INSTANCE_NUMBER…), as the Clever Cloud cron doc asks.
cd "$(dirname "$0")/.." || exit 1
exec node src/cron.js cron.json
