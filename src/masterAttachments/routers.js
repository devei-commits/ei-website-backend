const express = require('express');
const multer = require('multer');
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  uploadQualitySpecAttachment,
  downloadQualitySpecAttachment,
  removeQualitySpecAttachment,
} = require('./controller');

const router = express.Router();

const MAX_UPLOAD_BYTES = Number(process.env.MASTER_ATTACHMENT_MAX_BYTES) || 20 * 1024 * 1024;

const requireMasterAttachments = [
  isAuthenticated,
  requireModule('raw-materials-management', 'packaging-management'),
];

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
}).single('file');

function uploadQualitySpecSafe(req, res, next) {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File too large (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`
          : err.message || 'Upload failed';
      return res.status(400).json({ success: false, message });
    }
    return next();
  });
}

router.post('/quality-spec', requireMasterAttachments, uploadQualitySpecSafe, uploadQualitySpecAttachment);
router.get('/quality-spec/:storedName', requireMasterAttachments, downloadQualitySpecAttachment);
router.delete('/quality-spec/:storedName', requireMasterAttachments, removeQualitySpecAttachment);

module.exports = router;
