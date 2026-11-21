// Write-through: every write updates the cache with the new value, so readers never
// need a miss to see it.
//
// Read:  same as cache-aside (inherited). Write-through alone only defines writes;
//        combined with lazy loading and a TTL it is the full pattern AWS recommends:
//        data never written since the cache started is loaded on a miss, and keys that
//        are no longer read expire by themselves.
// Write order:
//        1. write to MongoDB (the source of truth). If it fails, the cache is untouched
//           and the client gets the error.
//        2. SET the product key with the new value (fresh TTL).
//        3. bump the list generation: a list page cannot be updated in place.
// Partial failure (MongoDB written, cache SET failed): the old value may still be in
//        Redis. We try to DEL it, so the next read is a miss that loads the new value.
//        If the DEL fails too (Redis down), the old value can be served until its TTL
//        expires. The write itself still succeeds: MongoDB holds the truth.
// No atomicity: steps 1 and 2 are two separate systems. Between them, readers get the
//        old value; and two concurrent writers can SET in the opposite order of their
//        MongoDB writes, leaving the older value cached until the TTL (step 7).
//
// CACHE_INVALIDATE_ON_WRITE does not apply here: updating the cache on writes is the
// strategy itself.

const CacheAsideStrategy = require('./CacheAsideStrategy');
const { productKey } = require('../cache/keys');

class WriteThroughStrategy extends CacheAsideStrategy {
  constructor(dependencies) {
    super({ ...dependencies, invalidateOnWrite: true });
    this.name = 'write-through';
  }

  // A new product is cached right away: its first read is already a hit.
  async create(data) {
    const product = await this.repository.create(data);
    await Promise.all([this.writeToCache(product), this.invalidateLists()]);
    return product;
  }

  async update(productId, changes) {
    const product = await this.repository.update(productId, changes);
    if (product) await Promise.all([this.writeToCache(product), this.invalidateLists()]);
    return product;
  }

  // remove() is inherited: there is no new value to write, so the key is deleted.

  async writeToCache(product) {
    const key = productKey(product.productId);
    if (await this.cache.set(key, product)) return;

    const deleted = await this.cache.del(key);
    console.warn(
      `[write-through] cache SET failed for product ${product.productId} (version ${product.version}); ` +
        (deleted
          ? 'old value deleted, the next read loads it from the database'
          : `DEL failed too, an old value may be served until its TTL expires`),
    );
  }
}

module.exports = WriteThroughStrategy;
