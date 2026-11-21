#!/usr/bin/env bash
# Invalidation example for the report: reads one product twice, updates it (PUT) and
# reads it again, printing X-Cache and version for every read. Shows, with the API's
# current configuration, whether the read right after a write gets the old version.
#
# The transcript is printed and saved to $RESULTS/invalidation-<label>-<timestamp>.txt
# (label = strategy, plus -noinvalidate, as in run.sh). The cache is emptied first.
#
# The last read waits TTL + 1 s when invalidation is off (to show the old value
# expiring) and 0 s otherwise; pass a number of seconds to override.
#
# Settings: same as run.sh (API_URL, REDIS_URL, RESULTS, loadtest/aws.env), plus
# PRODUCT_ID (default 42). It CHANGES the product: run it against a test database.
#
# Usage:
#   loadtest/invalidation-demo.sh
#   loadtest/invalidation-demo.sh 15

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=loadtest/common.sh
. "$DIR/common.sh"

PRODUCT_ID="${PRODUCT_ID:-42}"
read_api_config

if [ $# -gt 0 ]; then
  WAIT="$1"
elif [ "$LABEL" = "$STRATEGY-noinvalidate" ]; then
  WAIT=$((TTL + 1))
else
  WAIT=0
fi
if ! [[ "$WAIT" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 [seconds to wait before the last read]" >&2
  exit 1
fi

URL="$API_URL/products/$PRODUCT_ID"
OUT="$DIR/$RESULTS/invalidation-$LABEL-$(date +%Y%m%d-%H%M%S).txt"

# One line per read: the X-Cache header and the version in the body.
show() {
  curl -fsS -i "$URL" | tr -d '\r' | grep -iE '^x-cache|"version"' |
    sed -E 's/.*"version":([0-9]+).*/version \1/' | paste -sd' '
}

flush_cache

{
  echo "# strategy: $STRATEGY, ttl: ${TTL:+$TTL s}${TTL:-none}, label: $LABEL, product: $PRODUCT_ID, $(date -u '+%F %T') UTC"
  echo "1. read                  $(show)"
  echo "2. read                  $(show)"
  curl -fsS -o /dev/null -X PUT "$URL" -H 'content-type: application/json' \
    -d "{\"price\": $((RANDOM % 1000 + 1))}"
  echo "3. PUT (new price)       written to the database, version + 1"
  echo "4. read right after      $(show)"
  sleep "$WAIT"
  echo "5. read after ${WAIT} s$(printf '%*s' $((9 - ${#WAIT})) '')$(show)"
} | tee "$OUT"

echo "saved $OUT"
