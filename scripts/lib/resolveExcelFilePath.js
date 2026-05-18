/**
 * Resolve Excel path from CLI (absolute Windows/Unix, relative, quoted).
 * Inside Docker, host paths like D:\downloads\file.xlsx are not visible unless copied/mounted.
 */
const fs = require('fs');
const path = require('path');

function stripQuotes(p) {
  const s = String(p || '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function isWindowsDrivePath(p) {
  return /^[A-Za-z]:[\\/]/.test(String(p || '').trim());
}

/** @param {string} winPath e.g. D:\downloads\file.xlsx */
function windowsPathToPosixCandidates(winPath) {
  const normalized = String(winPath).trim().replace(/\\/g, '/');
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) return [];
  const drive = m[1].toLowerCase();
  const rest = m[2];
  return [
    `/mnt/${drive}/${rest}`,
    `/host_mnt/${drive}/${rest}`,
    `/${drive}/${rest}`,
  ].map((p) => p.replace(/\/+/g, '/'));
}

/**
 * @param {string} fileArg raw CLI path
 * @param {string} [cwd]
 * @returns {{ resolved: string, tried: string[] }}
 */
function resolveExcelFilePath(fileArg, cwd = process.cwd()) {
  const raw = stripQuotes(fileArg);
  if (!raw) return { resolved: '', tried: [] };

  const tried = [];

  if (path.isAbsolute(raw)) {
    const resolved = path.normalize(raw);
    tried.push(resolved);
    return { resolved, tried };
  }

  if (isWindowsDrivePath(raw)) {
    if (process.platform === 'win32') {
      const resolved = path.normalize(raw);
      tried.push(resolved);
      return { resolved, tried };
    }
    for (const candidate of windowsPathToPosixCandidates(raw)) {
      tried.push(candidate);
      if (fs.existsSync(candidate)) {
        return { resolved: candidate, tried };
      }
    }
    tried.push(path.normalize(raw));
    return { resolved: tried[0], tried };
  }

  const resolved = path.resolve(cwd, raw);
  tried.push(resolved);
  return { resolved, tried };
}

/**
 * @param {string} fileArg
 * @param {string} [cwd]
 * @returns {string|null} existing file path, or null
 */
function resolveExistingExcelFilePath(fileArg, cwd = process.cwd()) {
  const { resolved, tried } = resolveExcelFilePath(fileArg, cwd);
  if (!resolved) return null;
  if (fs.existsSync(resolved)) return resolved;
  for (const p of tried) {
    if (p !== resolved && fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  stripQuotes,
  isWindowsDrivePath,
  windowsPathToPosixCandidates,
  resolveExcelFilePath,
  resolveExistingExcelFilePath,
};
