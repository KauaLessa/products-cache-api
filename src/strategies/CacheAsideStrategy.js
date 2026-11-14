// Cache-aside (lazy loading): the application manages the cache explicitly.
//
// Read:  1. GET the key in Redis.
//        2. HIT  -> return it (MongoDB is not touched).
//        3. MISS -> read from MongoDB, store it in Redis with a TTL, return it.
//        4. Redis unavailable -> read from MongoDB, skip the cache (BYPASS).
// Write: write to MongoDB (the source of truth) first, then invalidate: DEL the
//        product key and bump the list generation (see listGenerationKey in
//        src/cache/keys.js), so the next reads load the new values.
//        With CACHE_INVALIDATE_ON_WRITE=false nothing is invalidated and readers may
//        get stale data until the TTL expires (the staleness window demonstrated in
//        item 4 of the spec).
//
// Known race on single products (inherent to cache-aside, see step 7): reader A misses
// and reads the OLD value from MongoDB; writer B updates MongoDB and DELs the key; A then
// SETs the OLD value. The cache stays stale until the TTL expires: the TTL bounds the
// damage. List pages do not suffer from it: A would store the old page under the old
// generation, which nobody reads after B's INCR.

const { productKey, listGenerationKey, productListKey } = require('../cache/keys');

class CacheAsideStrategy {
  constructor({ repository, cache, invalidateOnWrite = true }) {
    this.name = 'cache-aside';
    this.repository = repository;
    this.cache = cache;
    this.invalidateOnWrite = invalidateOnWrite;
  }

  async getById(productId) {
    const key = productKey(productId);
    const cached = await this.cache.get(key);

    if (cached.status === 'hit') return { data: cached.value, cacheStatus: 'HIT' };

    const data = await this.repository.findById(productId);

    if (cached.status === 'error') return { data, cacheStatus: 'BYPASS' };

    // No negative caching: a missing product is not stored, so a product created
    // later is never hidden behind a cached "not found".
    // The SET is awaited (one extra round trip, only on a miss) so that right after
    // a MISS the key is guaranteed to exist: simpler to reason about and to test.
    if (data) await this.cache.set(key, data);
    return { data, cacheStatus: 'MISS' };
  }

  // Each page costs two Redis round trips on a hit: the generation, then the page.
  // Any write invalidates every page, so the hit rate of lists drops quickly as the
  // write rate grows (one of the trade-offs measured in the load tests).
  async list({ page, limit }) {
    const generation = await this.cache.get(listGenerationKey());
    if (generation.status === 'error') {
      return { data: await this.repository.list({ page, limit }), cacheStatus: 'BYPASS' };
    }

    // No counter yet (no write since Redis started): generation 0.
    const key = productListKey(generation.status === 'hit' ? generation.value : 0, page, limit);
    const cached = await this.cache.get(key);
    if (cached.status === 'hit') return { data: cached.value, cacheStatus: 'HIT' };

    const data = await this.repository.list({ page, limit });
    if (cached.status === 'error') return { data, cacheStatus: 'BYPASS' };

    await this.cache.set(key, data);
    return { data, cacheStatus: 'MISS' };
  }

  // A new productId has never been cached (no negative caching), but the new product
  // changes the list pages (total, last page): bump the list generation.
  async create(data) {
    const product = await this.repository.create(data);
    await this.invalidateLists();
    return product;
  }

  async update(productId, changes) {
    const product = await this.repository.update(productId, changes);
    if (product) await this.invalidate(productId);
    return product;
  }

  async remove(productId) {
    const deleted = await this.repository.remove(productId);
    if (deleted) await this.invalidate(productId);
    return deleted;
  }

  // If invalidation fails (Redis down) the write still succeeds: MongoDB is the source
  // of truth, and the stale cached values expire with the TTL.
  async invalidate(productId) {
    if (!this.invalidateOnWrite) return;
    await Promise.all([this.cache.del(productKey(productId)), this.invalidateLists()]);
  }

  async invalidateLists() {
    if (this.invalidateOnWrite) await this.cache.incr(listGenerationKey());
  }
}

module.exports = CacheAsideStrategy;
