// /products routes: validation rules first, then the controller handler.

const { Router } = require('express');
const { createProductController } = require('../controllers/productController');
const { createRules, updateRules, idRules, listRules } = require('../validation/productValidation');

function createProductRoutes(strategy) {
  const controller = createProductController(strategy);
  const router = Router();

  router.get('/', listRules, controller.list);
  router.post('/', createRules, controller.create);
  router.get('/:id', idRules, controller.getById);
  // PUT accepts a partial update (any subset of fields); "version" is bumped automatically.
  router.put('/:id', updateRules, controller.update);
  router.delete('/:id', idRules, controller.remove);

  return router;
}

module.exports = { createProductRoutes };
