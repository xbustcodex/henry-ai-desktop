/**
 * Media library — a local shelf of imported images, audio and documents.
 *
 * Chat attachments answer "what did I send in this message"; this answers
 * "what media do I have on hand", which is what the cover studio, the book
 * engine and the writer tools need. Files are chosen through the OS file
 * dialog and copied into Henry's own storage, so the library keeps working
 * if the original is moved or deleted.
 */

import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export type MediaKind = 'image' | 'audio' | 'document';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  file_name: string;
  stored_name: string;
  mime_type: string | null;
  byte_size: number;
  created_at: string;
}

const MAX_BYTES = 100 * 1024 * 1024;

const FILTERS: Record<MediaKind, Electron.FileFilter[]> = {
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'] }],
  audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }],
  document: [
    { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'docx', 'xlsx', 'pptx', 'csv', 'json'] },
    { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'png', 'jpg', 'zip'] },
  ],
};

const EXT_KIND: Record<string, MediaKind> = {};
for (const ext of FILTERS.image[0].extensions) EXT_KIND[ext] = 'image';
for (const ext of FILTERS.audio[0].extensions) EXT_KIND[ext] = 'audio';
for (const group of FILTERS.document) {
  for (const ext of group.extensions) {
    // The document group deliberately overlaps (a .png can be picked as part
    // of "Files"), but it must not reclassify an image or an audio file.
    if (!EXT_KIND[ext]) EXT_KIND[ext] = 'document';
  }
}

function mediaDir(): string {
  const dir = path.join(app.getPath('userData'), 'media');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveStoredPath(storedName: string): string {
  // `..` is load-bearing here and is NOT covered by the regex: `.` sits inside
  // `[A-Za-z0-9._-]`, so `..` matches the pattern perfectly well. It needs its
  // own clause, without which a corrupt row resolves to the parent of the media
  // directory and `media:delete` unlinks whatever sits beside it.
  //
  // `.` is refused for the same reason from the other direction: `path.join(dir,
  // '.')` is `dir` itself, so it names the media DIRECTORY rather than a file in
  // it. It stays inside the root, so it is not an escape — but it is still not a
  // file name, and handing it to `unlinkSync` produces a failure the caller
  // would otherwise read as success.
  if (!/^[A-Za-z0-9._-]+$/.test(storedName) || storedName.includes('..') || storedName === '.') {
    throw new Error('Invalid media reference.');
  }
  return path.join(mediaDir(), storedName);
}

export function registerMediaLibraryHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_library (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('image','audio','document')),
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_media_library_kind ON media_library(kind, created_at DESC);
  `);

  /** Native picker → copy into Henry's storage → index the row. */
  ipcMain.handle(
    'media:import',
    async (_e, opts: { kind?: MediaKind } = {}) => {
      try {
        const kind = opts.kind ?? 'image';
        const parent = getWindow();
        const result = parent
          ? await dialog.showOpenDialog(parent, {
              title: 'Import media',
              properties: ['openFile', 'multiSelections'],
              filters: FILTERS[kind] ?? FILTERS.document,
            })
          : await dialog.showOpenDialog({
              title: 'Import media',
              properties: ['openFile', 'multiSelections'],
              filters: FILTERS[kind] ?? FILTERS.document,
            });

        if (result.canceled || result.filePaths.length === 0) {
          return { ok: true, imported: [] as MediaItem[], cancelled: true };
        }

        const imported: MediaItem[] = [];
        const skipped: string[] = [];
        for (const src of result.filePaths) {
          let stat: fs.Stats;
          try {
            stat = fs.statSync(src);
          } catch {
            skipped.push(path.basename(src));
            continue;
          }
          if (!stat.isFile()) { skipped.push(path.basename(src)); continue; }
          if (stat.size > MAX_BYTES) {
            skipped.push(`${path.basename(src)} (over ${MAX_BYTES / 1048576} MB)`);
            continue;
          }

          const ext = (path.extname(src).replace(/^\./, '') || 'bin').toLowerCase();
          const resolvedKind = EXT_KIND[ext] ?? kind;
          const id = crypto.randomUUID();
          const storedName = `${id}.${ext.replace(/[^A-Za-z0-9]/g, '') || 'bin'}`;
          try {
            await fs.promises.copyFile(src, resolveStoredPath(storedName));
          } catch (e: unknown) {
            skipped.push(`${path.basename(src)} (${e instanceof Error ? e.message : 'copy failed'})`);
            continue;
          }

          db.prepare(
            `INSERT INTO media_library (id, kind, file_name, stored_name, mime_type, byte_size)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(id, resolvedKind, path.basename(src), storedName, guessMime(ext), stat.size);

          imported.push(
            db.prepare('SELECT * FROM media_library WHERE id = ?').get(id) as MediaItem,
          );
        }

        return { ok: true, imported, skipped };
      } catch (e: unknown) {
        console.error('[media:import]', e);
        return { ok: false, error: e instanceof Error ? e.message : String(e), imported: [] as MediaItem[] };
      }
    },
  );

  ipcMain.handle('media:list', (_e, opts: { kind?: MediaKind; limit?: number } = {}) => {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    if (opts.kind) {
      return db
        .prepare('SELECT * FROM media_library WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
        .all(opts.kind, limit) as MediaItem[];
    }
    return db
      .prepare('SELECT * FROM media_library ORDER BY created_at DESC LIMIT ?')
      .all(limit) as MediaItem[];
  });

  ipcMain.handle('media:counts', () => {
    const rows = db
      .prepare('SELECT kind, COUNT(*) AS n FROM media_library GROUP BY kind')
      .all() as { kind: MediaKind; n: number }[];
    const out: Record<MediaKind, number> = { image: 0, audio: 0, document: 0 };
    for (const r of rows) out[r.kind] = r.n;
    return out;
  });

  /** Read bytes back as a data URL (image preview, audio playback). */
  ipcMain.handle('media:get', async (_e, id: string) => {
    try {
      const row = db.prepare('SELECT * FROM media_library WHERE id = ?').get(id) as MediaItem | undefined;
      if (!row) return { ok: false, error: 'Media not found.' };
      const bytes = await fs.promises.readFile(resolveStoredPath(row.stored_name));
      const mime = row.mime_type || 'application/octet-stream';
      return { ok: true, mimeType: mime, fileName: row.file_name, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('media:open', async (_e, id: string) => {
    try {
      const row = db.prepare('SELECT stored_name FROM media_library WHERE id = ?').get(id) as { stored_name: string } | undefined;
      if (!row) return { ok: false, error: 'Media not found.' };
      const err = await shell.openPath(resolveStoredPath(row.stored_name));
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Show the file in the OS file manager, so "where is this?" has an answer. */
  ipcMain.handle('media:reveal', async (_e, id: string) => {
    try {
      const row = db.prepare('SELECT stored_name FROM media_library WHERE id = ?').get(id) as { stored_name: string } | undefined;
      if (!row) return { ok: false, error: 'Media not found.' };
      shell.showItemInFolder(resolveStoredPath(row.stored_name));
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('media:delete', (_e, id: string) => {
    try {
      const row = db.prepare('SELECT stored_name FROM media_library WHERE id = ?').get(id) as { stored_name: string } | undefined;
      // Resolved OUTSIDE the unlink try/catch, deliberately.
      //
      // `fs.unlinkSync` throws ENOENT when the file is genuinely already gone,
      // and that is worth ignoring. But it was also catching what
      // `resolveStoredPath` throws for an invalid stored name, which is a
      // REFUSAL and not an "already gone". Swallowing it meant a hostile or
      // corrupt `stored_name` deleted the library row and returned `{ok:true}`
      // for a file that was never touched — the caller was told the delete
      // succeeded while the bytes stayed on disk.
      const target = row ? resolveStoredPath(row.stored_name) : null;
      if (target) {
        try { fs.unlinkSync(target); } catch { /* already gone */ }
      }
      db.prepare('DELETE FROM media_library WHERE id = ?').run(id);
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  zip: 'application/zip',
};

function guessMime(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}
