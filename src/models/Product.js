// Product schema: defines WHAT a product is (fields, types, indexes).
// HOW products are read/written lives in the repository.

const { Schema, model } = require('mongoose');

const productSchema = new Schema(
  {
    productId: { type: Number, required: true, unique: true, min: 1 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },
    category: { type: String, required: true, trim: true, maxlength: 100 },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0 },
    version: { type: Number, required: true, default: 1, min: 1 },
  },
  {
    timestamps: true, // createdAt / updatedAt
    versionKey: false, 
  },
);

module.exports = model('Product', productSchema);
