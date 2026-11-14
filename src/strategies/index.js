// Strategy factory: builds the cache strategy selected by CACHE_STRATEGY.
// Adding a new policy = writing a new class and registering it here.

const NoCacheStrategy = require('./NoCacheStrategy');
const CacheAsideStrategy = require('./CacheAsideStrategy');

const STRATEGIES = {
  none: NoCacheStrategy,
  'cache-aside': CacheAsideStrategy,
  // 'write-through': WriteThroughStrategy,  (step 6)
};

function createStrategy(name, dependencies) {
  const Strategy = STRATEGIES[name];
  if (!Strategy) {
    throw new Error(
      `Cache strategy "${name}" is not implemented yet ` +
        `(available: ${Object.keys(STRATEGIES).join(', ')})`,
    );
  }
  return new Strategy(dependencies);
}

module.exports = { createStrategy };
