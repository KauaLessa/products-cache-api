// Redis / ElastiCache client (ioredis), built only from config (src/config/env.js).
// Switching from local Redis to ElastiCache is an .env change:
//   REDIS_TLS=true           -> in-transit encryption
//   REDIS_CLUSTER_MODE=true  -> cluster mode enabled / ElastiCache Serverless
//   REDIS_USERNAME/PASSWORD  -> RBAC user / AUTH token

const { Redis, Cluster } = require('ioredis');
const config = require('../config/env');

// Reconnect forever, waiting a bit longer each time (capped at 2s).
function retryStrategy(times) {
  return Math.min(times * 200, 2000);
}

function createRedisClient() {
  const { host, port, username, password, tls, clusterMode, connectTimeoutMs, commandTimeoutMs } =
    config.redis;

  const connectionOptions = {
    username,
    password,
    tls: tls ? {} : undefined,
    connectTimeout: connectTimeoutMs,
    // A slow/unreachable Redis must not slow the API down: commands give up after this.
    commandTimeout: commandTimeoutMs,
    // Fail fast: no retries per command (the reconnect loop keeps running in the background).
    maxRetriesPerRequest: 0,
  };

  // Fail fast while disconnected: commands are rejected immediately instead of
  // waiting in an in-memory queue.
  const commonOptions = { lazyConnect: true, enableOfflineQueue: false };

  const client = clusterMode
    ? new Cluster([{ host, port }], {
        ...commonOptions,
        clusterRetryStrategy: retryStrategy,
        // ElastiCache TLS certificates are issued for hostnames, not IPs: keep the
        // hostname instead of resolving it, or the TLS handshake fails.
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: connectionOptions,
      })
    : new Redis({ ...commonOptions, ...connectionOptions, host, port, retryStrategy });

  logStateChanges(client, `${host}:${port}${clusterMode ? ' (cluster)' : ''}${tls ? ' (tls)' : ''}`);
  return client;
}

// Logs only state transitions (up -> down -> up), not every failed reconnect attempt,
// so a Redis outage under load does not flood the logs.
function logStateChanges(client, target) {
  let up = false;
  let downLogged = false;

  client.on('ready', () => {
    up = true;
    downLogged = false;
    console.log(`[redis] connected to ${target}`);
  });

  const markDown = (reason) => {
    if (downLogged) return;
    downLogged = true;
    console.warn(`[redis] ${up ? 'connection lost' : 'unavailable'} (${reason}); retrying in background`);
    up = false;
  };

  client.on('error', (err) => markDown(err.message || err.code || 'error'));
  client.on('close', () => {
    if (up) markDown('connection closed');
  });
}

// Tries to connect, but never prevents the API from starting: without Redis the
// cached strategies degrade to reading straight from MongoDB (X-Cache: BYPASS).
async function connectRedis(client) {
  try {
    await client.connect();
  } catch {
    // Already logged by logStateChanges; ioredis keeps retrying on its own.
  }
}

async function disconnectRedis(client) {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  console.log('[redis] disconnected');
}

module.exports = { createRedisClient, connectRedis, disconnectRedis };
