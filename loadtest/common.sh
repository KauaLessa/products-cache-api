# Shared by run.sh and invalidation-demo.sh (sourced, not executed). The caller sets DIR
# (the loadtest/ folder) before sourcing it.

# Optional settings file for a test environment, e.g. AWS (copy aws.env.example).
# KEY=VALUE lines, no quotes. A variable given on the command line wins over the file,
# so "RESULTS=results-aws-cold loadtest/run.sh" still works.
SETTINGS_FILE="$DIR/aws.env"
if [ -f "$SETTINGS_FILE" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in '' | \#*) continue ;; esac
    if [ -z "${!key+x}" ]; then export "$key=$value"; fi
  done < "$SETTINGS_FILE"
  echo "settings: $SETTINGS_FILE"
fi

REDIS_CLI_IMAGE="${REDIS_CLI_IMAGE:-redis:7.4-alpine}"
API_URL="${API_URL:-http://localhost:3000}"
REDIS_URL="${REDIS_URL-redis://localhost:6379}" # set but empty = do not flush
RESULTS="${RESULTS:-results}"                   # folder inside loadtest/
mkdir -p "$DIR/$RESULTS"

# The API reports how it is configured, so file names cannot disagree with the setup.
# Sets STRATEGY, LABEL (strategy, plus -noinvalidate when invalidation is off) and
# TTL (empty with the none strategy).
read_api_config() {
  local metrics
  if ! metrics="$(curl -fsS "$API_URL/metrics")"; then
    echo "cannot reach the API at $API_URL" >&2
    exit 1
  fi
  STRATEGY="$(sed -E 's/.*"strategy":"([^"]+)".*/\1/' <<< "$metrics")"
  LABEL="$STRATEGY"
  if grep -q '"invalidateOnWrite":false' <<< "$metrics"; then LABEL="$STRATEGY-noinvalidate"; fi
  TTL="$(grep -oE '"ttlSeconds":[0-9]+' <<< "$metrics" | cut -d: -f2 || true)"
}

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
