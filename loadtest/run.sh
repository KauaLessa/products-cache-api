#!/usr/bin/env bash
# Runs loadtest/read.js once per number of concurrent clients and saves, per run:
#   results/<name>-k6.json   client view: latency percentiles (per X-Cache), throughput
#   results/<name>-api.json  API view (GET /metrics): hits, misses, load on MongoDB
#
# Before each run the cache is emptied (FLUSHDB), so every run starts from the same
# state: otherwise keys left by the previous run (still within their TTL) inflate
# the hit rate of the next one. redis-cli also runs from Docker.
#
# k6 runs from its official Docker image (nothing to install). --network host makes
# the same command work locally (API_URL=http://localhost:3000) and on an EC2 inside
# the VPC (API_URL=http://<API private IP>:3000).
#
# Usage:
#   loadtest/run.sh
#   VUS_LIST="10 50 100" DURATION=60s DIST=hotset PRODUCTS=10000 loadtest/run.sh
#   REDIS_URL=rediss://<elasticache endpoint>:6379 loadtest/run.sh   # AWS (TLS)
#   REDIS_URL= loadtest/run.sh                                       # do not flush

set -euo pipefail

K6_IMAGE="${K6_IMAGE:-grafana/k6:1.3.0}"
REDIS_CLI_IMAGE="${REDIS_CLI_IMAGE:-redis:7.4-alpine}"
API_URL="${API_URL:-http://localhost:3000}"
REDIS_URL="${REDIS_URL-redis://localhost:6379}" # set but empty = do not flush
VUS_LIST="${VUS_LIST:-10}"
DIST="${DIST:-hotset}"

DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/results"

STRATEGY="$(curl -fsS "$API_URL/metrics" | sed -E 's/.*"strategy":"([^"]+)".*/\1/')"

# Empties the whole Redis database: use a Redis/ElastiCache dedicated to the tests.
flush_cache() {
  if [ "$STRATEGY" = "none" ]; then return; fi
  if [ -z "$REDIS_URL" ]; then
    echo "warning: REDIS_URL is empty, cache NOT flushed (keys from earlier runs may remain)"
    return
  fi
  docker run --rm --network host "$REDIS_CLI_IMAGE" redis-cli -u "$REDIS_URL" FLUSHDB > /dev/null
  echo "cache flushed ($REDIS_URL)"
}

for VUS in $VUS_LIST; do
  NAME="${STRATEGY}-${DIST}-${VUS}vus-$(date +%Y%m%d-%H%M%S)"
  echo "=== $NAME"

  flush_cache

  docker run --rm --network host --user "$(id -u):$(id -g)" \
    -v "$DIR:/loadtest" \
    -e API_URL="$API_URL" -e VUS="$VUS" -e DIST="$DIST" \
    -e PRODUCTS="${PRODUCTS:-10000}" -e DURATION="${DURATION:-60s}" \
    -e WARMUP_SECONDS="${WARMUP_SECONDS:-10}" \
    "$K6_IMAGE" run --summary-export "/loadtest/results/$NAME-k6.json" /loadtest/read.js

  curl -fsS "$API_URL/metrics" > "$DIR/results/$NAME-api.json"
done
