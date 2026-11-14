// GET /health: reports whether the API and its dependencies are up.
//   - MongoDB down -> 503: the API cannot serve most requests (it is the source of truth).
//   - Only Redis down -> 200 "degraded": the API still answers by reading MongoDB
//     (X-Cache: BYPASS). Returning 503 here would make a load balancer remove an
//     instance that still works.
//   - redis "disabled" -> CACHE_STRATEGY=none, no Redis client at all.

const { Router } = require('express');
const { pingMongo } = require('../db/mongo');

function createHealthRoutes({ cache } = {}) {
  const router = Router();

  router.get('/', async (req, res) => {
    const [mongoUp, redisUp] = await Promise.all([
      pingMongo(),
      cache ? cache.ping() : Promise.resolve(null),
    ]);

    const redisStatus = redisUp === null ? 'disabled' : redisUp ? 'up' : 'down';
    const healthy = mongoUp && redisStatus !== 'down';

    res.status(mongoUp ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      services: {
        mongo: mongoUp ? 'up' : 'down',
        redis: redisStatus,
      },
    });
  });

  return router;
}

module.exports = { createHealthRoutes };
