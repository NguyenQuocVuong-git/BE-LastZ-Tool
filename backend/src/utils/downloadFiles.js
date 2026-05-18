import fs from 'fs/promises';
import path from 'path';
import { DOWNLOAD_DIR } from '../config/downloadDir.js';

/**
 * Chỉ cho phép tên file đơn (không path), không file ẩn.
 * @returns {{ fullPath: string, name: string, stat: import('fs').Stats } | null}
 */
export async function resolveDownloadFile(filename) {
  const name = path.basename(String(filename || ''));
  if (!name || name.startsWith('.') || name !== String(filename || '').trim()) {
    return null;
  }

  const fullPath = path.resolve(DOWNLOAD_DIR, name);
  const relative = path.relative(path.resolve(DOWNLOAD_DIR), fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  return { fullPath, name, stat };
}

export async function listDownloadFiles() {
  let entries;
  try {
    entries = await fs.readdir(DOWNLOAD_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const files = [];
  for (const ent of entries) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    const fullPath = path.join(DOWNLOAD_DIR, ent.name);
    const stat = await fs.stat(fullPath);
    files.push({
      name: ent.name,
      size: stat.size,
      updated_at: stat.mtime.toISOString(),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}
