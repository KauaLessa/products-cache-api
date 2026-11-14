// Entry point: connects to dependencies, starts the HTTP server and
// handles graceful shutdown (important inside containers).

const config = require('./config/env');
const { createApp } = require('./app');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { createStrategy } = require('./strategies');
const productRepository = require('./repositories/productRepository');

async function start() {
  // Built before connecting so an unknown/unimplemented strategy fails immediately.
  const productStrategy = createStrategy(config.cache.strategy, { repository: productRepository });
  const app = createApp({ productStrategy });

  await connectMongo();

  const server = app.listen(config.app.port, (err) => {
    if (err) throw err;
    console.log(
      `[api] listening on port ${config.app.port} ` +
        `(env: ${config.app.nodeEnv}, cache strategy: ${config.cache.strategy})`,
    );
  });

  // Docker sends SIGTERM when stopping a container (Ctrl+C sends SIGINT).
  // We stop accepting connections, wait for in-flight requests to finish
  // and only then close the database connection.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down...`);

    // If something hangs, force exit after 10s.
    setTimeout(() => process.exit(1), 10_000).unref();

    server.close(async () => {
      await disconnectMongo();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[api] failed to start:', err.message);
  process.exit(1);
});
