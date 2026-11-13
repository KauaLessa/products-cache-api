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

module.exports = { connectMongo, disconnectMongo, pingMongo };
