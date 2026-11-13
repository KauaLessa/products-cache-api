// Reads environment variables once, validates them and exports a frozen object.
// The rest of the code never touches process.env directly: everything goes through here.
// If any variable is invalid, the app refuses to start (fail fast, with a clear message).

require('dotenv').config({ quiet: true });

const CACHE_STRATEGIES = ['none', 'cache-aside', 'write-through'];

const errors = [];

function str(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (defaultValue === undefined) errors.push(`${name} is required`);
    return defaultValue;
  }
  return value;
}

function int(name, defaultValue, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${name} must be an integer >= ${min} (got: "${raw}")`);
    return defaultValue;
  }
  return value;
}

function bool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  errors.push(`${name} must be "true" or "false" (got: "${raw}")`);
  return defaultValue;
}

function oneOf(name, allowed, defaultValue) {
  const value = str(name, defaultValue);
  if (value !== undefined && !allowed.includes(value)) {
    errors.push(`${name} must be one of: ${allowed.join(', ')} (got: "${value}")`);
  }
  return value;
}

const config = {
  app: {
    port: int('PORT', 3000, { min: 1 }),
    nodeEnv: str('NODE_ENV', 'development'),
  },
  mongo: {
    uri: str('MONGODB_URI'),
    maxPoolSize: int('MONGODB_MAX_POOL_SIZE', 20, { min: 1 }),
    serverSelectionTimeoutMs: int('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 5000, { min: 1 }),
  },
  cache: {
    strategy: oneOf('CACHE_STRATEGY', CACHE_STRATEGIES, 'none'),
    ttlSeconds: int('CACHE_TTL_SECONDS', 60, { min: 1 }),
    keyPrefix: str('CACHE_KEY_PREFIX', 'products-api:'),
    invalidateOnWrite: bool('CACHE_INVALIDATE_ON_WRITE', true),
  },
  redis: {
    host: str('REDIS_HOST', 'localhost'),
    port: int('REDIS_PORT', 6379, { min: 1 }),
    username: str('REDIS_USERNAME', '') || undefined,
    password: str('REDIS_PASSWORD', '') || undefined,
    tls: bool('REDIS_TLS', false),
    clusterMode: bool('REDIS_CLUSTER_MODE', false),
    connectTimeoutMs: int('REDIS_CONNECT_TIMEOUT_MS', 5000, { min: 1 }),
    commandTimeoutMs: int('REDIS_COMMAND_TIMEOUT_MS', 1000, { min: 1 }),
  },
};

if (errors.length > 0) {
  throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
}

module.exports = Object.freeze({
  ...config,
  CACHE_STRATEGIES,
});
