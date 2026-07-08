const express = require('express');
const router = express.Router();
const {
  listQualitySpecRules,
  resolveQualitySpecRules,
  upsertQualitySpecRule,
  deleteQualitySpecRule,
} = require('./controller');

router.get('/resolve', resolveQualitySpecRules);
router.get('/', listQualitySpecRules);
router.put('/', upsertQualitySpecRule);
router.delete('/:id', deleteQualitySpecRule);

module.exports = router;
