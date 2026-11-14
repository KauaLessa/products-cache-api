// Product controller: translates HTTP <-> strategy.
// It knows about requests, responses, status codes and headers, but nothing
// about caching or MongoDB: that is the strategy's job.

const { matchedData } = require('express-validator');

function notFound() {
  const err = new Error('Product not found');
  err.status = 404;
  return err;
}

function createProductController(strategy) {
  return {
    async list(req, res) {
      const { page = 1, limit = 20 } = matchedData(req, { locations: ['query'] });
      res.json(await strategy.list({ page, limit }));
    },

    async getById(req, res) {
      const { id } = matchedData(req, { locations: ['params'] });
      const { data, cacheStatus } = await strategy.getById(id);
      // Where the data came from: HIT (cache), MISS (cache miss, loaded from DB)
      // or BYPASS (cache not used). Lets clients and tests observe the cache.
      res.set('X-Cache', cacheStatus);
      if (!data) throw notFound();
      res.json(data);
    },

    async create(req, res) {
      const data = matchedData(req, { locations: ['body'] });
      const product = await strategy.create(data);
      res.status(201).location(`/products/${product.productId}`).json(product);
    },

    async update(req, res) {
      const { id } = matchedData(req, { locations: ['params'] });
      const changes = matchedData(req, { locations: ['body'] });
      const product = await strategy.update(id, changes);
      if (!product) throw notFound();
      res.json(product);
    },

    async remove(req, res) {
      const { id } = matchedData(req, { locations: ['params'] });
      const deleted = await strategy.remove(id);
      if (!deleted) throw notFound();
      res.status(204).end();
    },
  };
}

module.exports = { createProductController };
