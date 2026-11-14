// Sequence generator. Each document holds the last value issued for a name
// (e.g. { _id: 'productId', seq: 1000 }). Incrementing with $inc is atomic in
// MongoDB, so two API instances creating products at the same time never get
// the same id.

const { Schema, model } = require('mongoose');

const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

module.exports = model('Counter', counterSchema);
