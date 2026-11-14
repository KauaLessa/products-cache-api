// Builds the Express application (routes and middlewares) without starting the server.
// Keeping app.js separate from server.js lets us test the app later without opening a port.
//
// The cache strategy is injected (created in server.js from CACHE_STRATEGY), so the
// app itself does not know which caching policy is in use. The cache service (or
// null with CACHE_STRATEGY=none) is injected only so /health can report Redis.

const express = require('express');
const { createHealthRoutes } = require('./routes/health');
const { createProductRoutes } = require('./routes/products');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

function createApp({ productStrategy, cache = null }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', createHealthRoutes({ cache }));
  app.use('/products', createProductRoutes(productStrategy));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
