// Cache service: the only layer that talks to Redis.
// Concerns shared by every cache strategy live here, not in the strategies:
//   - JSON serialization
//   - TTL (CACHE_TTL_SECONDS) on every write
//   - Redis failures never throw: they are reported as a status/boolean, so the
//     strategies can fall back to MongoDB (graceful degradation).

const config = require('../config/env');

function createCacheService(client) {
  const ttlSeconds = config.cache.ttlSeconds;

  // Command-level errors are logged once per outage, like the connection log in redisClient.js.
  let failing = false;
  function reportFailure(operation, err) {
    if (failing) return;
    failing = true;
    console.warn(`[cache] ${operation} failed (${err.message}); falling back to the database`);
  }
  function reportSuccess() {
    if (failing) console.log('[cache] commands succeeding again');
    failing = false;
  }

  return {
    // Returns { status: 'hit', value } | { status: 'miss' } | { status: 'error' }.
    async get(key) {
      let raw;
      try {
        raw = await client.get(key);
        reportSuccess();
      } catch (err) {
        reportFailure('GET', err);
        return { status: 'error' };
      }
      if (raw === null) return { status: 'miss' };
      try {
        return { status: 'hit', value: JSON.parse(raw) };
      } catch {
        console.warn(`[cache] invalid JSON in key ${key}; treating as a miss`);
        return { status: 'miss' };
      }
    },

    // SET with expiration (EX): the key disappears by itself after ttlSeconds.
    // Returns true when the value was stored.
    async set(key, value) {
      try {
        await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        reportSuccess();
        return true;
      } catch (err) {
        reportFailure('SET', err);
        return false;
      }
    },

    // Returns true when the command ran (whether or not the key existed).
    async del(key) {
      try {
        await client.del(key);
        reportSuccess();
        return true;
      } catch (err) {
        reportFailure('DEL', err);
        return false;
      }
    },

    // Atomic increment (creates the key with value 1 if missing). No TTL is set:
    // used for counters that must outlive the cached values they version.
    // Returns the new value, or null if Redis failed.
    async incr(key) {
      try {
        const value = await client.incr(key);
        reportSuccess();
        return value;
      } catch (err) {
        reportFailure('INCR', err);
        return null;
      }
    },

    // Real round trip to Redis. Used by /health.
    async ping() {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createCacheService };
