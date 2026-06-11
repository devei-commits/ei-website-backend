const fs = require('fs');
const path = require('path');
const {
  deleteQualitySpecFile,
  resolveStoredFilePath,
  saveQualitySpecFile,
} = require('./qualitySpecStorage');

async function uploadQualitySpecAttachment(req, res, next) {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded (multipart field name: file)',
      });
    }
    const saved = saveQualitySpecFile(req.file.buffer, {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
    return res.status(201).json({
      success: true,
      message: 'File uploaded',
      data: saved,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

async function downloadQualitySpecAttachment(req, res, next) {
  try {
    const storedName = String(req.params.storedName || '').trim();
    const abs = resolveStoredFilePath(storedName);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    const downloadName = storedName.includes('-')
      ? storedName.slice(storedName.indexOf('-') + 1)
      : storedName;
    res.setHeader('Content-Disposition', `inline; filename="${downloadName.replace(/"/g, '')}"`);
    return res.sendFile(abs);
  } catch (err) {
    return next(err);
  }
}

async function removeQualitySpecAttachment(req, res, next) {
  try {
    const storedName = String(req.params.storedName || '').trim();
    deleteQualitySpecFile(storedName);
    return res.json({ success: true, message: 'File deleted' });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

module.exports = {
  uploadQualitySpecAttachment,
  downloadQualitySpecAttachment,
  removeQualitySpecAttachment,
};
