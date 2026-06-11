const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPLOAD_SUBDIR = 'quality-spec';
const MAX_STORED_NAME_LEN = 200;

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
]);

function getUploadRoot() {
  const configured = process.env.MASTER_ATTACHMENTS_DIR;
  if (configured && String(configured).trim()) {
    return path.resolve(String(configured).trim(), UPLOAD_SUBDIR);
  }
  return path.resolve(__dirname, '../../uploads', UPLOAD_SUBDIR);
}

function ensureUploadDir() {
  const root = getUploadRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sanitizeBaseName(name) {
  return (
    String(name || 'file')
      .replace(/[/\\?%*:|"<>]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 120) || 'file'
  );
}

function extensionFromName(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) return '';
  return ext;
}

function buildStoredName(originalName) {
  const ext = extensionFromName(originalName);
  const base = sanitizeBaseName(path.basename(String(originalName || 'file'), ext || path.extname(originalName)));
  const stored = `${crypto.randomUUID()}-${base}${ext}`;
  return stored.slice(0, MAX_STORED_NAME_LEN);
}

function isValidStoredName(storedName) {
  const name = String(storedName || '').trim();
  if (!name || name.length > MAX_STORED_NAME_LEN) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  const ext = path.extname(name).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function resolveStoredFilePath(storedName) {
  if (!isValidStoredName(storedName)) return null;
  const root = ensureUploadDir();
  const abs = path.resolve(root, storedName);
  if (!abs.startsWith(`${root}${path.sep}`) && abs !== root) return null;
  return abs;
}

function qualitySpecPublicPath(storedName) {
  return `/api/v1/master-attachments/quality-spec/${encodeURIComponent(storedName)}`;
}

/**
 * @param {Buffer} buffer
 * @param {{ originalname?: string; mimetype?: string; size?: number }} meta
 */
function saveQualitySpecFile(buffer, meta = {}) {
  if (!buffer?.length) {
    const err = new Error('Empty file');
    err.status = 400;
    throw err;
  }
  const originalName = String(meta.originalname || 'file').trim() || 'file';
  const ext = extensionFromName(originalName);
  if (!ext) {
    const err = new Error(
      `File type not allowed. Use: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}`
    );
    err.status = 400;
    throw err;
  }
  const storedName = buildStoredName(originalName);
  const root = ensureUploadDir();
  const absPath = path.join(root, storedName);
  fs.writeFileSync(absPath, buffer);
  return {
    storedName,
    name: originalName,
    url: qualitySpecPublicPath(storedName),
    mimeType: String(meta.mimetype || 'application/octet-stream'),
    size: Number(meta.size ?? buffer.length),
  };
}

function deleteQualitySpecFile(storedName) {
  const abs = resolveStoredFilePath(storedName);
  if (!abs) {
    const err = new Error('Invalid file id');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    const err = new Error('File not found');
    err.status = 404;
    throw err;
  }
  fs.unlinkSync(abs);
  return true;
}

module.exports = {
  ALLOWED_EXTENSIONS,
  getUploadRoot,
  ensureUploadDir,
  isValidStoredName,
  resolveStoredFilePath,
  qualitySpecPublicPath,
  saveQualitySpecFile,
  deleteQualitySpecFile,
};
