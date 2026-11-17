// GET /metrics: counters of this API instance since start or the last reset (JSON).
// POST /metrics/reset: clears them. A load test calls it after its warm-up, so the
// cold-cache misses of the first requests do not distort the results.

const { Router } = require('express');

function createMetricsRoutes(metrics) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(metrics.snapshot());
  });

  router.post('/reset', (req, res) => {
    metrics.reset();
    res.status(204).end();
  });

  return router;
}

module.exports = { createMetricsRoutes };
