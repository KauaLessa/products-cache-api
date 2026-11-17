// Builds the Express application (routes and middlewares) without starting the server.
// Keeping app.js separate from server.js lets us test the app later without opening a port.
//
// The cache strategy is injected (created in server.js from CACHE_STRATEGY), so the
// app itself does not know which caching policy is in use. The cache service (or
// null with CACHE_STRATEGY=none) is injected only so /health can report Redis.
// The metrics registry is injected too: the request counter is registered before
// every route so it also sees requests that end in errors.

const express = require('express');
const { createHealthRoutes } = require('./routes/health');
const { createMetricsRoutes } = require('./routes/metrics');
const { createProductRoutes } = require('./routes/products');
const requestMetrics = require('./middlewares/requestMetrics');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

function createApp({ productStrategy, metrics, cache = null }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestMetrics(metrics));
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', createHealthRoutes({ cache }));
  app.use('/metrics', createMetricsRoutes(metrics));
  app.use('/products', createProductRoutes(productStrategy));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
