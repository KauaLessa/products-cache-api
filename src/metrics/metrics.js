// In-memory metrics of this API instance, exposed as plain JSON by GET /metrics.
//
// Only counters, no latency: end-to-end latency percentiles and throughput are measured
// by the load generator (k6), which sees what the user sees (network, queueing). The
// API counts what only it can see:
//   - per route: requests, status codes and the X-Cache result (HIT / MISS / BYPASS)
//   - per cache command: hit / miss / error (from the cacheService results)
//   - per source (MongoDB) operation: ok / error -> load on the source
//
// Counters are per process: with several API instances, add the counts up.
// POST /metrics/reset clears everything, so a load test can discard its warm-up.

const CACHE_STATUSES = ['HIT', 'MISS', 'BYPASS'];

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

// HIT/MISS/BYPASS counts plus the two derived ratios:
//   hitRate         = HIT / (HIT + MISS): how well the strategy works when the cache is
//                     used. BYPASS is left out (cache not consulted), the same definition
//                     as Redis keyspace_hits and CloudWatch CacheHitRate.
//   servedFromCache = HIT / all reads: how much of the read traffic the cache actually
//                     absorbed (BYPASS counts as a miss). Differs only when Redis fails.
function cacheSummary(counts) {
  const { HIT, MISS, BYPASS } = counts;
  return {
    HIT,
    MISS,
    BYPASS,
    hitRate: ratio(HIT, HIT + MISS),
    servedFromCache: ratio(HIT, HIT + MISS + BYPASS),
  };
}

function emptyCacheCounts() {
  return { HIT: 0, MISS: 0, BYPASS: 0 };
}

// counters[group][name][outcome] += 1, creating the levels on first use.
function increment(counters, group, name, outcome) {
  counters[group] ??= {};
  counters[group][name] ??= {};
  counters[group][name][outcome] = (counters[group][name][outcome] ?? 0) + 1;
}

function createMetrics({ strategy, settings = null }) {
  let since;
  let requests; // { "GET /products/:id": { count, status: { 200: n }, cache: { HIT, MISS, BYPASS } } }
  let calls; // { cache: { get: { hit: n, miss: n } }, source: { findById: { ok: n } } }

  function reset() {
    since = new Date();
    requests = {};
    calls = {};
  }
  reset();

  return {
    reset,

    // cacheStatus is the X-Cache value, or undefined for writes (they set no X-Cache).
    recordRequest(route, statusCode, cacheStatus) {
      requests[route] ??= { count: 0, status: {}, cache: null };
      const entry = requests[route];
      entry.count += 1;
      entry.status[statusCode] = (entry.status[statusCode] ?? 0) + 1;
      if (CACHE_STATUSES.includes(cacheStatus)) {
        entry.cache ??= emptyCacheCounts();
        entry.cache[cacheStatus] += 1;
      }
    },

    // component: 'cache' (Redis commands) or 'source' (MongoDB repository operations).
    recordCall(component, operation, outcome) {
      increment(calls, component, operation, outcome);
    },

    snapshot() {
      const reads = emptyCacheCounts();
      const routes = {};
      for (const [route, entry] of Object.entries(requests)) {
        routes[route] = {
          count: entry.count,
          status: { ...entry.status },
          ...(entry.cache && { cache: cacheSummary(entry.cache) }),
        };
        if (entry.cache) for (const s of CACHE_STATUSES) reads[s] += entry.cache[s];
      }
      const readCount = reads.HIT + reads.MISS + reads.BYPASS;

      // Every repository call is one unit of work requested from MongoDB (whether it
      // succeeded or failed). Reads that reach the source: findById and list.
      // readsPerReadRequest only uses the reads MongoDB answered ('ok'): a read that
      // fails in MongoDB (503) carries no X-Cache, so it is not in readCount either.
      const source = calls.source ?? {};
      const total = (operation) =>
        Object.values(source[operation] ?? {}).reduce((sum, n) => sum + n, 0);
      const sourceTotal = Object.keys(source).reduce((sum, op) => sum + total(op), 0);
      const sourceReads = (source.findById?.ok ?? 0) + (source.list?.ok ?? 0);

      return {
        strategy,
        // Cache settings that change the results (TTL, invalidation), so every saved
        // snapshot says how it was measured. null with CACHE_STRATEGY=none.
        settings,
        since: since.toISOString(),
        windowSeconds: Number(((Date.now() - since.getTime()) / 1000).toFixed(1)),
        // Totals over every read route (the ones that answer with X-Cache).
        reads: { count: readCount, ...cacheSummary(reads) },
        requests: routes,
        // null with CACHE_STRATEGY=none: there is no Redis client at all.
        cache: strategy === 'none' ? null : { commands: structuredClone(calls.cache ?? {}) },
        source: {
          operations: structuredClone(source),
          total: sourceTotal,
          // ~1.0 without cache; the closer to 0, the more the cache shields MongoDB.
          readsPerReadRequest: ratio(sourceReads, readCount),
        },
      };
    },
  };
}

module.exports = { createMetrics };
