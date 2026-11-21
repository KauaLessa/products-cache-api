#!/usr/bin/env bash
# Switches the API's cache configuration and restarts its container. Meant for the API
# EC2 on AWS (docs/deploy-aws.md), where the api service runs from compose.yaml alone.
#
# It edits CACHE_STRATEGY, CACHE_TTL_SECONDS and CACHE_INVALIDATE_ON_WRITE in .env,
# recreates the container and prints the configuration the API started with.
#
# Usage:
#   scripts/api-config.sh <none|cache-aside|write-through> [ttl seconds] [invalidate on write]
#   scripts/api-config.sh cache-aside              # ttl 60, invalidate on write true
#   scripts/api-config.sh cache-aside 5 false      # no invalidation: stale reads until the TTL

set -euo pipefail

usage() {
  echo "usage: $0 <none|cache-aside|write-through> [ttl seconds, default 60] [true|false, default true]" >&2
  exit 1
}

STRATEGY="${1:-}"
TTL="${2:-60}"
INVALIDATE="${3:-true}"

case "$STRATEGY" in none | cache-aside | write-through) ;; *) usage ;; esac
[[ "$TTL" =~ ^[1-9][0-9]*$ ]] || usage
case "$INVALIDATE" in true | false) ;; *) usage ;; esac

cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo ".env not found in $(pwd) (see docs/deploy-aws.md, step 9)" >&2
  exit 1
fi

set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}
set_env CACHE_STRATEGY "$STRATEGY"
set_env CACHE_TTL_SECONDS "$TTL"
set_env CACHE_INVALIDATE_ON_WRITE "$INVALIDATE"

echo "restarting the API..."
if ! docker compose -f compose.yaml up -d --force-recreate --wait api; then
  echo "the API did not become healthy; see: docker compose -f compose.yaml logs api" >&2
  exit 1
fi
docker compose -f compose.yaml logs --no-log-prefix api | grep listening | tail -1
