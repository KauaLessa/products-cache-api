// GET /health: reports whether the API and its dependencies are up.
// Responds 200 when everything is fine and 503 when a dependency is down,
// so Docker (or a load balancer) can tell whether the container is healthy.

const { Router } = require('express');
const { pingMongo } = require('../db/mongo');

const router = Router();

router.get('/', async (req, res) => {
  const mongoUp = await pingMongo();

  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? 'ok' : 'degraded',
    services: {
      mongo: mongoUp ? 'up' : 'down',
    },
  });
});

module.exports = router;
