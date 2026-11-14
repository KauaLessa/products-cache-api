const Product = require('../models/Product');
const Counter = require('../models/Counter');
const { assertConnected } = require('../db/mongo');

const PRODUCT_ID_SEQUENCE = 'productId';

// Fields hidden from callers: Mongo's internal _id is an implementation detail.
const PROJECTION = { _id: 0 };

async function nextProductId() {
  const counter = await Counter.findOneAndUpdate(
    { _id: PRODUCT_ID_SEQUENCE },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return counter.seq;
}

async function findById(productId) {
  assertConnected();
  return Product.findOne({ productId }, PROJECTION).lean();
}

async function list({ page = 1, limit = 20 } = {}) {
  assertConnected();
  const [items, total] = await Promise.all([
    Product.find({}, PROJECTION)
      .sort({ productId: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Product.estimatedDocumentCount(),
  ]);
  return { items, total, page, limit };
}

async function create(data) {
  assertConnected();
  const productId = await nextProductId();
  const doc = await Product.create({ ...data, productId, version: 1 });
  return findById(doc.productId);
}

// Applies a partial update and bumps "version" in the same atomic operation.
// Returns the updated product, or null if it does not exist.
async function update(productId, changes) {
  assertConnected();
  return Product.findOneAndUpdate(
    { productId },
    { $set: changes, $inc: { version: 1 } },
    { returnDocument: 'after', runValidators: true, projection: PROJECTION },
  ).lean();
}

// Returns true if a product was deleted, false if it did not exist.
async function remove(productId) {
  assertConnected();
  const result = await Product.deleteOne({ productId });
  return result.deletedCount === 1;
}

module.exports = {
  findById,
  list,
  create,
  update,
  remove,
  PRODUCT_ID_SEQUENCE,
};
