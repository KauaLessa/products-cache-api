// Builds the Express application (routes and middlewares) without starting the server.
// Keeping app.js separate from server.js lets us test the app later without opening a port.
//
// The cache strategy is injected (created in server.js from CACHE_STRATEGY), so the
// app itself does not know which caching policy is in use.

const express = require('express');
const healthRoutes = require('./routes/health');
const { createProductRoutes } = require('./routes/products');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

function createApp({ productStrategy }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRoutes);
  app.use('/products', createProductRoutes(productStrategy));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
