// k6 read load test: GET /products/:id with a known key distribution.
//
// Lives outside the API on purpose: it only sends HTTP requests, so the same script
// runs locally and on AWS (only API_URL changes). Run it through loadtest/run.sh.
//
// Flow:
//   setup()   warm-up (one client, same key distribution), then POST /metrics/reset,
//             so the API counters cover exactly the measured phase.
//   default   each virtual user (VU) reads in a loop, with no pause (closed model).
//
// Parameters (environment variables):
//   API_URL         default http://localhost:3000
//   PRODUCTS        number of seeded products (ids 1..N), default 10000
//   VUS             concurrent clients, default 10
//   DURATION        measured phase, default 60s
//   WARMUP_SECONDS  warm-up length, default 10 (0 = measure a cold cache)
//   DIST            hotset (80% of reads go to the first 20% of ids) | uniform

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:3000';
const PRODUCTS = Number(__ENV.PRODUCTS || 10000);
const WARMUP_SECONDS = Number(__ENV.WARMUP_SECONDS ?? 10);
const DIST = __ENV.DIST || 'hotset';

const HOT_KEYS = Math.max(1, Math.floor(PRODUCTS * 0.2)); // the 20% "popular" products
const HOT_TRAFFIC = 0.8; // share of reads that go to them

// Fixed request name: without it k6 tags every request with its URL, creating one
// time series per product id (high memory use on long runs).
const READ_PARAMS = { tags: { name: 'GET /products/:id' } };

// Own metrics, recorded only in the measured phase: k6's built-in http_req_* metrics
// also include the warm-up requests made in setup().
const readLatency = new Trend('read_latency', true); // tagged with cache: HIT | MISS | BYPASS
const reads = new Counter('reads');
const hotReads = new Counter('hot_reads');

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '60s',
  setupTimeout: `${WARMUP_SECONDS + 30}s`,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Always-true thresholds: they only make the summary show the latency per X-Cache value.
  thresholds: {
    'read_latency{cache:HIT}': ['max>=0'],
    'read_latency{cache:MISS}': ['max>=0'],
    'read_latency{cache:BYPASS}': ['max>=0'],
  },
};

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 80/20: with 80% chance a hot id (1..20% of N), otherwise a cold one (the other 80%).
// The cold draw excludes the hot ids, so exactly 80% of the reads hit the hot set.
function pickProductId() {
  if (DIST === 'uniform') return randomInt(1, PRODUCTS);
  return Math.random() < HOT_TRAFFIC ? randomInt(1, HOT_KEYS) : randomInt(HOT_KEYS + 1, PRODUCTS);
}

export function setup() {
  const end = Date.now() + WARMUP_SECONDS * 1000;
  let warmupRequests = 0;
  while (Date.now() < end) {
    http.get(`${API}/products/${pickProductId()}`, READ_PARAMS);
    warmupRequests += 1;
  }
  const reset = http.post(`${API}/metrics/reset`);
  if (reset.status !== 204) throw new Error(`POST /metrics/reset failed: ${reset.status}`);
  console.log(`warm-up: ${warmupRequests} requests in ${WARMUP_SECONDS}s, metrics reset`);
}

export default function () {
  const id = pickProductId();
  const res = http.get(`${API}/products/${id}`, READ_PARAMS);
  check(res, { 'status is 200': (r) => r.status === 200 });

  readLatency.add(res.timings.duration, { cache: res.headers['X-Cache'] || 'NONE' });
  reads.add(1);
  if (id <= HOT_KEYS) hotReads.add(1);
}
