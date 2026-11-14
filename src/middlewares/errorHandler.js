// Central error handler. In Express 5, errors thrown inside async handlers
// reach this middleware automatically, with no try/catch needed in each route.

const mongoose = require('mongoose');

// Driver/mongoose errors that mean "the database is unreachable right now".
const DB_UNAVAILABLE_ERRORS = new Set([
  'DatabaseUnavailableError', // thrown by assertConnected() in src/db/mongo.js
  'MongooseServerSelectionError',
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
]);

function isDatabaseUnavailable(err) {
  if (DB_UNAVAILABLE_ERRORS.has(err.name)) return true;
  // With bufferCommands=false, mongoose throws immediately when disconnected.
  return mongoose.connection.readyState !== 1 && err instanceof mongoose.Error;
}

function errorHandler(err, req, res, next) {
  // Malformed JSON in the request body (thrown by express.json()).
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  // Schema validation failed in mongoose (safety net: express-validator should catch most cases first).
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    });
  }

  if (isDatabaseUnavailable(err)) {
    console.error('[error] database unavailable:', err.message);
    return res.status(503).json({ error: 'Service unavailable: database is unreachable' });
  }

  // Errors that already carry their own status (e.g. 400, 404) are passed to the client.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
  });
}

module.exports = errorHandler;
