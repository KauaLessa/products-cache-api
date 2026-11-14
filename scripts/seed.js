// Populates the database with N products, replacing any existing data.
//
// Usage:
//   node scripts/seed.js                 # 10000 products (default)
//   node scripts/seed.js --count 50000
//   SEED_COUNT=50000 node scripts/seed.js
//
// The data is deterministic: the same count always produces exactly the same
// products (same names, prices, description sizes). This keeps load test runs
// comparable and lets the report state the exact dataset that was used.

const mongoose = require('mongoose');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const Product = require('../src/models/Product');
const Counter = require('../src/models/Counter');
const { PRODUCT_ID_SEQUENCE } = require('../src/repositories/productRepository');

const DEFAULT_COUNT = 10_000;
const BATCH_SIZE = 1_000;
const DESCRIPTION_LENGTH = 200;
const RANDOM_SEED = 42;
const CATEGORIES = ['books', 'electronics', 'games', 'home', 'kitchen', 'sports', 'toys', 'tools'];

function parseCount() {
  const flagIndex = process.argv.indexOf('--count');
  const raw = flagIndex !== -1 ? process.argv[flagIndex + 1] : process.env.SEED_COUNT;
  if (raw === undefined) return DEFAULT_COUNT;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid count: "${raw}" (must be an integer >= 1)`);
  }
  return count;
}

// Small seeded PRNG (mulberry32). Math.random() can't be seeded, and we
// want reproducible data.
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildProduct(productId, random) {
  const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
  const base = `Product ${productId} (${category}). `;
  return {
    productId,
    name: `Product ${productId}`,
    category,
    // Fixed-size description so every document has roughly the same size.
    description: base.repeat(Math.ceil(DESCRIPTION_LENGTH / base.length)).slice(0, DESCRIPTION_LENGTH),
    price: Math.round((1 + random() * 999) * 100) / 100,
    stock: Math.floor(random() * 1000),
    version: 1,
  };
}

async function seed() {
  const count = parseCount();
  const random = createRandom(RANDOM_SEED);

  await connectMongo();
  console.log(`[seed] database: ${mongoose.connection.name}, products: ${count}`);

  await Product.deleteMany({});
  await Product.syncIndexes(); // make sure the unique index on productId exists

  const startedAt = Date.now();
  for (let start = 1; start <= count; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, count);
    const batch = [];
    for (let id = start; id <= end; id++) batch.push(buildProduct(id, random));
    await Product.insertMany(batch, { ordered: false });
    console.log(`[seed] inserted ${end}/${count}`);
  }

  // New products created through the API continue after the seeded ones.
  await Counter.updateOne({ _id: PRODUCT_ID_SEQUENCE }, { $set: { seq: count } }, { upsert: true });

  const stats = await mongoose.connection.db.command({ collStats: Product.collection.collectionName });
  console.log(
    `[seed] done in ${Date.now() - startedAt} ms — ` +
      `${stats.count} documents, avg size ${stats.avgObjSize} bytes, ` +
      `total ${(stats.size / 1024 / 1024).toFixed(2)} MB`,
  );
}

seed()
  .catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectMongo().catch(() => {}));
