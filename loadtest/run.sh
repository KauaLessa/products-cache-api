#!/usr/bin/env bash
# Runs a k6 script against the API and saves, per run:
#   results/<name>-k6.json   client view (k6 summary)
#   results/<name>-api.json  API view (GET /metrics): hits, misses, load on MongoDB
#
# Scripts (SCRIPT=...):
#   read       (default) read load, one run per number of clients in VUS_LIST
#   staleness  one sequential client: write, then read until the new version shows up
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
#   SCRIPT=staleness ITERATIONS=5 loadtest/run.sh
#   REDIS_URL=rediss://<elasticache endpoint>:6379 loadtest/run.sh   # AWS (TLS)
#   REDIS_URL= loadtest/run.sh                                       # do not flush

set -euo pipefail

K6_IMAGE="${K6_IMAGE:-grafana/k6:1.3.0}"
REDIS_CLI_IMAGE="${REDIS_CLI_IMAGE:-redis:7.4-alpine}"
API_URL="${API_URL:-http://localhost:3000}"
REDIS_URL="${REDIS_URL-redis://localhost:6379}" # set but empty = do not flush
SCRIPT="${SCRIPT:-read}"
VUS_LIST="${VUS_LIST:-10}"
DIST="${DIST:-hotset}"

case "$SCRIPT" in
  read) ;;
  staleness) VUS_LIST=1 ;; # always a single sequential client
  *) echo "unknown SCRIPT '$SCRIPT' (use read or staleness)" >&2; exit 1 ;;
esac

DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/results"

# The API reports how it is configured, so file names cannot disagree with the setup.
METRICS="$(curl -fsS "$API_URL/metrics")"
STRATEGY="$(sed -E 's/.*"strategy":"([^"]+)".*/\1/' <<< "$METRICS")"
LABEL="$STRATEGY"
if grep -q '"invalidateOnWrite":false' <<< "$METRICS"; then LABEL="$STRATEGY-noinvalidate"; fi

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
  if [ "$SCRIPT" = "read" ]; then
    NAME="${LABEL}-${DIST}-${VUS}vus-$(date +%Y%m%d-%H%M%S)"
  else
    NAME="${LABEL}-${SCRIPT}-$(date +%Y%m%d-%H%M%S)"
  fi
  echo "=== $NAME"

  flush_cache

  docker run --rm --network host --user "$(id -u):$(id -g)" \
    -v "$DIR:/loadtest" \
    -e API_URL="$API_URL" -e VUS="$VUS" -e DIST="$DIST" \
    -e PRODUCTS="${PRODUCTS:-10000}" -e DURATION="${DURATION:-60s}" \
    -e WARMUP_SECONDS="${WARMUP_SECONDS:-10}" \
    -e ITERATIONS="${ITERATIONS:-5}" -e POLL_MS="${POLL_MS:-100}" \
    -e MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-120}" \
    "$K6_IMAGE" run --summary-export "/loadtest/results/$NAME-k6.json" "/loadtest/$SCRIPT.js"

  curl -fsS "$API_URL/metrics" > "$DIR/results/$NAME-api.json"
done
