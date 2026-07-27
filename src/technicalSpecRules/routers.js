const express = require('express');
const router = express.Router();
const {
  listTechnicalSpecRules,
  resolveTechnicalSpecRules,
  upsertTechnicalSpecRule,
  deleteTechnicalSpecRule,
} = require('./controller');

router.get('/resolve', resolveTechnicalSpecRules);
router.get('/', listTechnicalSpecRules);
router.put('/', upsertTechnicalSpecRule);
router.delete('/:id', deleteTechnicalSpecRule);

module.exports = router;
