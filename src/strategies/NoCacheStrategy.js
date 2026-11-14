// Baseline strategy: no cache at all. Every operation goes straight to the
// repository (MongoDB). Load tests with this strategy measure the raw capacity
// of the API + database, which the cached strategies are compared against.
//
// Strategy interface (shared by every cache strategy):
//   getById(id)          -> { data: product | null, cacheStatus: 'HIT' | 'MISS' | 'BYPASS' }
//   list({ page, limit }) -> { data: { items, total, page, limit }, cacheStatus }
//   create(data)         -> product
//   update(id, changes)  -> product | null
//   remove(id)           -> boolean

class NoCacheStrategy {
  constructor({ repository }) {
    this.name = 'none';
    this.repository = repository;
  }

  async getById(productId) {
    const data = await this.repository.findById(productId);
    return { data, cacheStatus: 'BYPASS' };
  }

  async list(params) {
    const data = await this.repository.list(params);
    return { data, cacheStatus: 'BYPASS' };
  }

  async create(data) {
    return this.repository.create(data);
  }

  async update(productId, changes) {
    return this.repository.update(productId, changes);
  }

  async remove(productId) {
    return this.repository.remove(productId);
  }
}

module.exports = NoCacheStrategy;
