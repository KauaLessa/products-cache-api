// Builds the Express application (routes and middlewares) without starting the server.
// Keeping app.js separate from server.js lets us test the app later without opening a port.

const express = require('express');
const healthRoutes = require('./routes/health');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use('/health', healthRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
