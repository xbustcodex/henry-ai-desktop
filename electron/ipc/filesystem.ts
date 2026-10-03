/**
 * Filesystem — Sandboxed file operations scoped to a workspace directory.
 *
 * IPC channels (match preload.ts):
 *   fs:readDirectory, fs:readFile, fs:writeFile
 */

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { safeResolve } from './_pathSafety';

// Extensions that are always binary — skip UTF-8 decode entirely
const BINARY_EXTS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif',
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'avi', 'mov', 'mkv',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'img', 'iso',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'db', 'sqlite', 'sqlite3',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'pyc', 'class', 'o', 'a', 'obj', 'lib',
  'sketch', 'fig', 'xcassets', 'xcarchive',
]);

/**
 * Null-byte scan — the classic Unix `file` command heuristic.
 * A null byte in the first 8000 bytes is a reliable binary indicator.
 */
function hasBinaryBytes(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function registerFilesystemHandlers(workspacePath: string) {
  // All handlers use safePath which throws on traversal — errors are caught
  // per-call. Backed by the shared safeResolve (correct prefix check + symlink
  // hardening); see electron/ipc/_pathSafety.ts.
  function safePath(requestedPath: string): string {
    return safeResolve(workspacePath, requestedPath);
  }

  // Read directory
  ipcMain.handle('fs:readDirectory', async (_, dirPath?: string) => {
    try {
      const targetDir = dirPath ? safePath(dirPath) : workspacePath;

      if (!fs.existsSync(targetDir)) {
        return { path: dirPath || '.', entries: [] };
      }

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      return {
        path: dirPath || '.',
        entries: entries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => {
            const fullPath = path.join(targetDir, e.name);
            const stat = fs.statSync(fullPath);
            return {
              name: e.name,
              path: path.relative(workspacePath, fullPath),
              isDirectory: e.isDirectory(),
              size: stat.size,
              modified: stat.mtime.toISOString(),
            };
          }),
      };
    } catch (e: unknown) {
      console.error('[fs:readDirectory]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // Read file — guards against binary content reaching the UI
  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      const target = safePath(filePath);
      if (!fs.existsSync(target)) {
        // Returned rather than thrown: a throw across the IPC boundary becomes
        // an unhandled rejection in the renderer.
        return { ok: false, error: `File not found: ${filePath}` } as never;
      }

      // Fast path: known binary extension
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (BINARY_EXTS.has(ext)) {
        return { ok: false, error: `BINARY_FILE: ${path.basename(filePath)} can't be displayed as text.` } as never;
      }

      // Read as Buffer so we can inspect bytes before decoding
      const buf = fs.readFileSync(target);

      // Null-byte scan — catches unlisted binary types (compiled files, compressed streams, etc.)
      if (hasBinaryBytes(buf)) {
        throw new Error(`BINARY_FILE: ${path.basename(filePath)} appears to be a binary file and can't be displayed as text.`);
      }

      return buf.toString('utf-8');
    } catch (e: unknown) {
      console.error('[fs:readFile]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  /** Lightweight existence check (file or directory) under workspace — no content read. */
  ipcMain.handle('fs:pathExists', async (_, filePath: string) => {
    try {
      const target = safePath(filePath);
      return fs.existsSync(target);
    } catch (e: unknown) {
      console.error('[fs:pathExists]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // Write file — preload sends { path, content }
  ipcMain.handle('fs:writeFile', async (_, data: { path: string; content: string }) => {
    try {
      const target = safePath(data.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data.content, 'utf-8');
      return true;
    } catch (e: unknown) {
      console.error('[fs:writeFile]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
}
