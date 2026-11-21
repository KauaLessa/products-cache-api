// Entry point: connects to dependencies, starts the HTTP server and
// handles graceful shutdown (important inside containers).

const config = require('./config/env');
const { createApp } = require('./app');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { createRedisClient, connectRedis, disconnectRedis } = require('./cache/redisClient');
const { createCacheService } = require('./cache/cacheService');
const { createStrategy } = require('./strategies');
const productRepository = require('./repositories/productRepository');
const { createMetrics } = require('./metrics/metrics');
const { instrument, cacheOutcome, sourceOutcome } = require('./metrics/instrument');

async function start() {
  // The no-cache baseline does not create a Redis client at all: it neither depends
  // on Redis nor pays any cost for it.
  const usesCache = config.cache.strategy !== 'none';

  // Cache settings that change the results. CACHE_INVALIDATE_ON_WRITE only applies to
  // cache-aside (write-through always updates the cache on writes).
  const settings = usesCache
    ? {
        ttlSeconds: config.cache.ttlSeconds,
        ...(config.cache.strategy === 'cache-aside' && {
          invalidateOnWrite: config.cache.invalidateOnWrite,
        }),
      }
    : null;
  const metrics = createMetrics({ strategy: config.cache.strategy, settings });
  const redisClient = usesCache ? createRedisClient() : null;
  const cacheService = redisClient ? createCacheService(redisClient) : null;

  // The strategy receives counting wrappers of the cache and the repository (same
  // methods, same results), so the metrics need no change in any strategy.
  // ping is left out: it serves /health, not the workload.
  const cache =
    cacheService &&
    instrument(cacheService, { component: 'cache', metrics, outcome: cacheOutcome, skip: ['ping'] });
  const repository = instrument(productRepository, {
    component: 'source',
    metrics,
    outcome: sourceOutcome,
  });

  // Built before connecting so an unknown/unimplemented strategy fails immediately.
  const productStrategy = createStrategy(config.cache.strategy, {
    repository,
    cache,
    invalidateOnWrite: config.cache.invalidateOnWrite,
  });
  const app = createApp({ productStrategy, metrics, cache });

  // MongoDB is the source of truth: the API refuses to start without it.
  // Redis is optional: if it is down the API starts anyway and reconnects later.
  await Promise.all([connectMongo(), redisClient ? connectRedis(redisClient) : null]);

  const server = app.listen(config.app.port, (err) => {
    if (err) throw err;
    const cacheInfo = settings
      ? `, ttl: ${settings.ttlSeconds}s` +
        ('invalidateOnWrite' in settings ? `, invalidate on write: ${settings.invalidateOnWrite}` : '')
      : '';
    console.log(
      `[api] listening on port ${config.app.port} ` +
        `(env: ${config.app.nodeEnv}, cache strategy: ${config.cache.strategy}${cacheInfo})`,
    );
  });

  // Docker sends SIGTERM when stopping a container (Ctrl+C sends SIGINT).
  // We stop accepting connections, wait for in-flight requests to finish
  // and only then close the database and cache connections.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down...`);

    // If something hangs, force exit after 10s.
    setTimeout(() => process.exit(1), 10_000).unref();

    server.close(async () => {
      await Promise.all([disconnectMongo(), redisClient ? disconnectRedis(redisClient) : null]);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[api] failed to start:', err.message);
  process.exit(1);
});
