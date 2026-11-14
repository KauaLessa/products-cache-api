// Cache key format, defined in a single place.
// The prefix (CACHE_KEY_PREFIX) is applied explicitly here, so keys look exactly
// the same in the code, in redis-cli and in the report: e.g. "products-api:product:42".

const config = require('../config/env');

function productKey(productId) {
  return `${config.cache.keyPrefix}product:${productId}`;
}

// Product list pages use a "generation" counter for invalidation:
//   - the counter lives in listGenerationKey() (no TTL);
//   - each page is stored under a key that contains the current generation,
//     e.g. "products-api:products:list:v7:p3:l20";
//   - every write INCRements the counter, so readers start using v8 keys and all v7
//     pages become unreachable at once (they disappear when their TTL expires).
function listGenerationKey() {
  return `${config.cache.keyPrefix}products:list:gen`;
}

function productListKey(generation, page, limit) {
  return `${config.cache.keyPrefix}products:list:v${generation}:p${page}:l${limit}`;
}

module.exports = { productKey, listGenerationKey, productListKey };
