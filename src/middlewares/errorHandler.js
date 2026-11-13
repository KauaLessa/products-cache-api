// Central error handler. In Express 5, errors thrown inside async handlers
// reach this middleware automatically, with no try/catch needed in each route.

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Malformed JSON in the request body (thrown by express.json()).
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  // Errors that already carry their own status (e.g. 400, 404) are passed to the client.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
  });
}

module.exports = errorHandler;
