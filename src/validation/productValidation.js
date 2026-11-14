// Request validation rules (express-validator).
//
// Each exported array is a chain of middlewares: the rules check and sanitize
// the input (e.g. "15" -> 15) and the final `validate` middleware rejects the
// request with 400 if anything is wrong. Controllers then read only the
// validated, sanitized values via matchedData(), so unexpected fields never
// reach the database.

const { body, param, query, checkExact, validationResult } = require('express-validator');

const productId = param('id')
  .isInt({ min: 1 })
  .withMessage('id must be a positive integer')
  .toInt();

// Starts a body field chain: required fields get an explicit "is required"
// message; optional ones are skipped when absent. `bail()` stops at the first
// failed rule, so each field reports at most one message.
function field(name, required) {
  const chain = body(name);
  return required ? chain.exists().withMessage(`${name} is required`).bail() : chain.optional();
}

// Field rules shared by create (required = true) and update (required = false).
const fields = {
  name: (required) => field('name', required)
    .isString().withMessage('name must be a string').bail().trim()
    .isLength({ min: 1, max: 200 }).withMessage('name must have 1-200 characters'),
  description: (required) => field('description', required)
    .isString().withMessage('description must be a string').bail()
    .isLength({ max: 2000 }).withMessage('description must have at most 2000 characters'),
  category: (required) => field('category', required)
    .isString().withMessage('category must be a string').bail().trim()
    .isLength({ min: 1, max: 100 }).withMessage('category must have 1-100 characters'),
  price: (required) => field('price', required)
    .isFloat({ min: 0 }).withMessage('price must be a number >= 0').toFloat(),
  stock: (required) => field('stock', required)
    .isInt({ min: 0 }).withMessage('stock must be an integer >= 0').toInt(),
};

// Rejects the request with 400 and the list of problems, if any.
function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  res.status(400).json({
    error: 'Validation failed',
    details: result.array().map((e) => ({
      // e.path is '' for rules on the whole body; unknown-field errors list several fields.
      field: e.path || e.fields?.map((f) => f.path).join(', ') || 'body',
      message: e.msg,
    })),
  });
}

// Body for create: all required fields must be present.
const createRules = [
  checkExact(
    [
      fields.name(true),
      fields.description(false),
      fields.category(true),
      fields.price(true),
      fields.stock(true),
    ],
    { message: 'Unknown fields are not allowed (productId and version are managed by the API)' },
  ),
  validate,
];

// Body for update: partial update, any subset of fields (but at least one).
const updateRules = [
  productId,
  checkExact(
    [
      fields.name(false),
      fields.description(false),
      fields.category(false),
      fields.price(false),
      fields.stock(false),
    ],
    { message: 'Unknown fields are not allowed (productId and version are managed by the API)' },
  ),
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Object.keys(value).length === 0) {
      throw new Error('Request body must contain at least one field to update');
    }
    return true;
  }),
  validate,
];

const idRules = [productId, validate];

const listRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('page must be an integer >= 1').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be an integer between 1 and 100').toInt(),
  validate,
];

module.exports = {
  createRules,
  updateRules,
  idRules,
  listRules,
};
