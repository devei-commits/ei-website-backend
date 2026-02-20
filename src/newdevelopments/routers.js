const express = require('express');
const router = express.Router();
const { 
  createNewdevelopment, 
  getNewdevelopments, 
  getNewdevelopmentById 
} = require('./controller');

router.post('/', createNewdevelopment);
router.get('/', getNewdevelopments);
router.get('/:id', getNewdevelopmentById);

module.exports = router;
