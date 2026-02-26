const express = require('express');
const router = express.Router();
const {
  getEnquiryTypes,
  createEnquiry,
  getMyEnquiries,
  getEnquiryById,
  updateEnquiry
} = require('./controller');

router.get('/types', getEnquiryTypes);
router.post('/', createEnquiry);
router.get('/', getMyEnquiries);
router.get('/:id', getEnquiryById);
router.put('/:id', updateEnquiry);

module.exports = router;
