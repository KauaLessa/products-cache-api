// k6 staleness test: after a write, for how long do readers still get the old version?
//
// One client, strictly sequential, so every read can be compared with the write that
// came right before it. Each iteration:
//   1. GET    /products/:id   makes sure the product is cached (cache-aside: MISS -> SET)
//   2. PUT    /products/:id   changes the price; the response carries the new version
//   3. GET    /products/:id   repeated every POLL_MS until the new version is returned
//
// With CACHE_INVALIDATE_ON_WRITE=true the write DELs the key, so the first read is
// already fresh (window ~0). With false, the old value is served until its TTL expires
// (window ~TTL). The window is measured from the end of the PUT to the first fresh read,
// so it is accurate to about POLL_MS.
//
// It CHANGES products (price, version): run it against a test database.
// Run it through loadtest/run.sh (SCRIPT=staleness). Use a short TTL (e.g.
// CACHE_TTL_SECONDS=5), otherwise each iteration waits up to the full TTL.
//
// Parameters (environment variables):
//   API_URL           default http://localhost:3000
//   PRODUCTS          number of seeded products (ids 1..N), default 10000
//   ITERATIONS        writes to measure, default 5
//   POLL_MS           pause between reads after a write, default 100
//   MAX_WAIT_SECONDS  give up waiting for the new version after this, default 120

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:3000';
const PRODUCTS = Number(__ENV.PRODUCTS || 10000);
const ITERATIONS = Number(__ENV.ITERATIONS || 5);
const POLL_MS = Number(__ENV.POLL_MS || 100);
const MAX_WAIT_SECONDS = Number(__ENV.MAX_WAIT_SECONDS || 120);

const READ_PARAMS = { tags: { name: 'GET /products/:id' } };
const WRITE_PARAMS = {
  headers: { 'Content-Type': 'application/json' },
  tags: { name: 'PUT /products/:id' },
};

const stalenessWindow = new Trend('staleness_window', true); // ms from write to first fresh read
const staleAfterWrite = new Rate('stale_after_write'); // was the first read after the write stale?
const staleReads = new Counter('stale_reads'); // reads that returned an older version
const writes = new Counter('writes');
const timeouts = new Counter('timeouts'); // new version not seen within MAX_WAIT_SECONDS

export const options = {
  scenarios: {
    staleness: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: `${ITERATIONS * (MAX_WAIT_SECONDS + 10)}s`,
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'count'],
};

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function readProduct(id) {
  const res = http.get(`${API}/products/${id}`, READ_PARAMS);
  check(res, { 'read status is 200': (r) => r.status === 200 });
  return res;
}

// Start from zeroed API counters, so the saved GET /metrics covers only this test.
export function setup() {
  const reset = http.post(`${API}/metrics/reset`);
  if (reset.status !== 204) throw new Error(`POST /metrics/reset failed: ${reset.status}`);
}

export default function () {
  const id = randomInt(1, PRODUCTS);

  readProduct(id); // 1. cache the current version

  const price = randomInt(100, 100000) / 100;
  const put = http.put(`${API}/products/${id}`, JSON.stringify({ price }), WRITE_PARAMS);
  if (!check(put, { 'write status is 200': (r) => r.status === 200 })) return;
  const writtenVersion = put.json('version');
  const writtenAt = Date.now();
  writes.add(1);

  // 3. Read until the API returns the version we just wrote.
  let stale = 0;
  for (;;) {
    const read = readProduct(id);
    const readVersion = read.json('version');
    if (readVersion >= writtenVersion) break;

    stale += 1;
    staleReads.add(1, { cache: read.headers['X-Cache'] || 'NONE' });
    if (Date.now() - writtenAt > MAX_WAIT_SECONDS * 1000) {
      timeouts.add(1);
      console.warn(`product ${id}: version ${writtenVersion} not seen after ${MAX_WAIT_SECONDS}s`);
      return;
    }
    sleep(POLL_MS / 1000);
  }

  const windowMs = stale === 0 ? 0 : Date.now() - writtenAt;
  staleAfterWrite.add(stale > 0);
  stalenessWindow.add(windowMs);
  console.log(`product ${id}: v${writtenVersion} written, ${stale} stale reads, window ${windowMs} ms`);
}
