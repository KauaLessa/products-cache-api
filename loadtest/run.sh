#!/usr/bin/env bash
# Runs a k6 script against the API and saves, per run (RESULTS=results by default,
# a folder inside loadtest/):
#   $RESULTS/<name>-k6.json   client view (k6 summary)
#   $RESULTS/<name>-api.json  API view (GET /metrics): hits, misses, load on MongoDB
#
# Scripts (SCRIPT=...):
#   read       (default) read load, one run per key distribution in DIST and per
#              number of clients in VUS_LIST
#   staleness  one sequential client: write, then read until the new version shows up
#
# Settings come from environment variables, or from loadtest/aws.env when it exists
# (see aws.env.example); a variable on the command line wins over the file.
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
#   VUS_LIST="10 50 100" DIST="hotset uniform" DURATION=60s PRODUCTS=10000 loadtest/run.sh
#   SCRIPT=staleness ITERATIONS=5 loadtest/run.sh
#   REDIS_URL=rediss://<elasticache endpoint>:6379 loadtest/run.sh   # AWS (TLS)
#   REDIS_URL= loadtest/run.sh                                       # do not flush
#   RESULTS=results-aws loadtest/run.sh                              # another results folder

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=loadtest/common.sh
. "$DIR/common.sh"

K6_IMAGE="${K6_IMAGE:-grafana/k6:1.3.0}"
SCRIPT="${SCRIPT:-read}"
VUS_LIST="${VUS_LIST:-10}"
DIST="${DIST:-hotset}"

case "$SCRIPT" in
  read)
    for D in $DIST; do
      case "$D" in hotset | uniform) ;; *) echo "unknown DIST '$D' (use hotset and/or uniform)" >&2; exit 1 ;; esac
    done
    ;;
  staleness) VUS_LIST=1; DIST=- ;; # a single sequential client; no key distribution
  *) echo "unknown SCRIPT '$SCRIPT' (use read or staleness)" >&2; exit 1 ;;
esac

read_api_config

for D in $DIST; do
  for VUS in $VUS_LIST; do
    if [ "$SCRIPT" = "read" ]; then
      NAME="${LABEL}-${D}-${VUS}vus-$(date +%Y%m%d-%H%M%S)"
    else
      NAME="${LABEL}-${SCRIPT}-$(date +%Y%m%d-%H%M%S)"
    fi
    echo "=== $NAME"

    flush_cache

    docker run --rm --network host --user "$(id -u):$(id -g)" \
      -v "$DIR:/loadtest" \
      -e API_URL="$API_URL" -e VUS="$VUS" -e DIST="$D" \
      -e PRODUCTS="${PRODUCTS:-10000}" -e DURATION="${DURATION:-60s}" \
      -e WARMUP_SECONDS="${WARMUP_SECONDS:-10}" \
      -e ITERATIONS="${ITERATIONS:-5}" -e POLL_MS="${POLL_MS:-100}" \
      -e MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-120}" \
      "$K6_IMAGE" run --summary-export "/loadtest/$RESULTS/$NAME-k6.json" "/loadtest/$SCRIPT.js"

    curl -fsS "$API_URL/metrics" > "$DIR/$RESULTS/$NAME-api.json"
  done
done
