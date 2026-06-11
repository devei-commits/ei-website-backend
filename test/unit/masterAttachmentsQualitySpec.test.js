const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deleteQualitySpecFile,
  isValidStoredName,
  resolveStoredFilePath,
  saveQualitySpecFile,
} = require('../../src/masterAttachments/qualitySpecStorage');

describe('masterAttachments quality-spec storage', () => {
  let previousDir;

  beforeEach(() => {
    previousDir = process.env.MASTER_ATTACHMENTS_DIR;
    process.env.MASTER_ATTACHMENTS_DIR = path.join(os.tmpdir(), `ei-master-att-${Date.now()}`);
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.MASTER_ATTACHMENTS_DIR;
    else process.env.MASTER_ATTACHMENTS_DIR = previousDir;
  });

  it('rejects path traversal in stored names', () => {
    expect(isValidStoredName('../evil.pdf')).toBe(false);
    expect(resolveStoredFilePath('../evil.pdf')).toBeNull();
  });

  it('saves and deletes a pdf file', () => {
    const saved = saveQualitySpecFile(Buffer.from('%PDF-1.4'), {
      originalname: 'coa.pdf',
      mimetype: 'application/pdf',
      size: 8,
    });
    expect(saved.url).toContain('/api/v1/master-attachments/quality-spec/');
    expect(isValidStoredName(saved.storedName)).toBe(true);
    const abs = resolveStoredFilePath(saved.storedName);
    expect(abs).toBeTruthy();
    expect(fs.existsSync(abs)).toBe(true);
    deleteQualitySpecFile(saved.storedName);
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('rejects disallowed extensions', () => {
    expect(() =>
      saveQualitySpecFile(Buffer.from('x'), { originalname: 'virus.exe', mimetype: 'application/octet-stream' })
    ).toThrow(/not allowed/i);
  });
});
