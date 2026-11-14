// MongoDB connection via mongoose.

const mongoose = require('mongoose');
const config = require('../config/env');

// No buffering: if the database is down, operations fail immediately instead of
// waiting in a queue.
mongoose.set('bufferCommands', false);

async function connectMongo() {
  await mongoose.connect(config.mongo.uri, {
    maxPoolSize: config.mongo.maxPoolSize,
    serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
  });
  console.log(`[mongo] connected (max pool size: ${config.mongo.maxPoolSize})`);
}

async function disconnectMongo() {
  await mongoose.disconnect();
  console.log('[mongo] disconnected');
}

// Thrown when an operation is attempted while MongoDB is known to be down.
class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database is unreachable');
    this.name = 'DatabaseUnavailableError';
    this.status = 503;
  }
}

// Fails fast when the driver already knows the connection is down. Without this,
// each query would wait serverSelectionTimeoutMS (5s by default) before failing,
// piling up requests under load. The driver reconnects on its own when Mongo returns.
function assertConnected() {
  if (mongoose.connection.readyState !== 1) throw new DatabaseUnavailableError();
}

// Sends a real ping to the server. Used by /health.
async function pingMongo() {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  connectMongo,
  disconnectMongo,
  pingMongo,
  assertConnected,
  DatabaseUnavailableError,
};
