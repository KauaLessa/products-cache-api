#!/usr/bin/env bash
# Builds tables and charts from loadtest/results/ into loadtest/results/charts/.
# Runs loadtest/plot.py in Docker (Python + matplotlib), so nothing needs to be installed.
# The image is built on the first run and reused afterwards.
#
# Usage:
#   loadtest/plot.sh                 # uses loadtest/results/
#   loadtest/plot.sh results-aws     # another folder inside loadtest/

set -euo pipefail

IMAGE="${PLOT_IMAGE:-products-api-loadtest-plot:1}"
DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS="${1:-results}"

if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  docker build -q -t "$IMAGE" -f "$DIR/plot.Dockerfile" "$DIR" > /dev/null
fi

docker run --rm --user "$(id -u):$(id -g)" -e MPLCONFIGDIR=/tmp \
  -v "$DIR:/loadtest" "$IMAGE" "/loadtest/$RESULTS"
