const path = require('path');
const {
  resolveExcelFilePath,
  isWindowsDrivePath,
  windowsPathToPosixCandidates,
} = require('../../scripts/lib/resolveExcelFilePath');

describe('resolveExcelFilePath', () => {
  test('isWindowsDrivePath detects D:\\ style paths', () => {
    expect(isWindowsDrivePath('D:\\downloads\\file.xlsx')).toBe(true);
    expect(isWindowsDrivePath('relative/file.xlsx')).toBe(false);
  });

  test('Windows drive paths are not joined with cwd', () => {
    if (process.platform === 'win32') {
      const { resolved } = resolveExcelFilePath(
        'D:\\downloads\\BOM_Master_Price_List.xlsx',
        'C:\\app'
      );
      expect(resolved).toBe(path.normalize('D:\\downloads\\BOM_Master_Price_List.xlsx'));
      return;
    }
    const { resolved, tried } = resolveExcelFilePath(
      'D:\\downloads\\BOM_Master_Price_List.xlsx',
      '/usr/src/app'
    );
    expect(resolved).not.toContain('/usr/src/app/D:');
    expect(tried).toContain('/mnt/d/downloads/BOM_Master_Price_List.xlsx');
  });

  test('resolves relative paths against cwd', () => {
    const { resolved } = resolveExcelFilePath('data/sample.xlsx', '/usr/src/app');
    expect(resolved).toBe(path.resolve('/usr/src/app', 'data/sample.xlsx'));
  });

  test('windowsPathToPosixCandidates maps drive letter', () => {
    expect(windowsPathToPosixCandidates('D:\\downloads\\a.xlsx')).toEqual([
      '/mnt/d/downloads/a.xlsx',
      '/host_mnt/d/downloads/a.xlsx',
      '/d/downloads/a.xlsx',
    ]);
  });
});
