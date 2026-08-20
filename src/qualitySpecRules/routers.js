const express = require('express');
const router = express.Router();
const {
  listQualitySpecRules,
  resolveQualitySpecRules,
  upsertQualitySpecRule,
  deleteQualitySpecRule,
  listPmRuleScopes,
} = require('./controller');

router.get('/resolve', resolveQualitySpecRules);
router.get('/pm-scopes', listPmRuleScopes);
router.get('/', listQualitySpecRules);
router.put('/', upsertQualitySpecRule);
router.delete('/:id', deleteQualitySpecRule);

module.exports = router;
