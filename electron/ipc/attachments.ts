/**
 * Chat attachments — files attached to a conversation message.
 *
 * Bytes are stored on disk under <userData>/attachments/<uuid>.<ext> and
 * indexed in the `message_attachments` table. The renderer never receives a
 * filesystem path: it gets an opaque id, and reads bytes back through
 * `attachments:get`. That keeps the sandboxed filesystem IPC surface
 * (which is deliberately restricted to the workspace) out of the picture.
 */

import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';

/** 25 MB per attachment — enough for a document, small enough to stay local. */
const MAX_BYTES = 25 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

interface AttachmentRecord {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  file_name: string;
  mime_type: string | null;
  byte_size: number;
  created_at: string;
}

function attachmentDir(): string {
  const dir = path.join(app.getPath('userData'), 'attachments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve an attachment id to its on-disk path, refusing anything that is not
 * a bare uuid-ext filename. Ids come from the renderer, so this is the trust
 * boundary that keeps a crafted id from escaping the attachments directory.
 */
function resolveStoredPath(storedName: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(storedName) || storedName.includes('..')) {
    throw new Error('Invalid attachment reference.');
  }
  return path.join(attachmentDir(), storedName);
}

export function registerAttachmentHandlers(db: Database.Database): void {
  /**
   * Store bytes and return the record. Accepts either a base64 string or a
   * Uint8Array so the renderer can hand over a File without a JSON round-trip
   * penalty for large blobs.
   */
  ipcMain.handle(
    'attachments:save',
    async (
      _e,
      input: {
        fileName: string;
        mimeType?: string;
        data: string | Uint8Array;
        conversationId?: string;
        messageId?: string;
      },
    ) => {
      try {
        const bytes =
          typeof input.data === 'string'
            ? Buffer.from(input.data, 'base64')
            : Buffer.from(input.data);

        if (bytes.byteLength === 0) {
          return { ok: false, error: 'Attachment is empty.' };
        }
        if (bytes.byteLength > MAX_BYTES) {
          return {
            ok: false,
            error: `Attachment is ${(bytes.byteLength / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB.`,
          };
        }

        const id = crypto.randomUUID();
        const ext =
          MIME_EXT[input.mimeType ?? ''] ??
          (path.extname(input.fileName || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'bin');
        const storedName = `${id}.${ext}`;
        const dest = resolveStoredPath(storedName);

        await fs.promises.writeFile(dest, bytes);

        try {
          db.prepare(
            `INSERT INTO message_attachments
               (id, conversation_id, message_id, file_name, mime_type, byte_size, stored_name)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
          id,
            input.conversationId ?? null,
            input.messageId ?? null,
            input.fileName || 'attachment',
            input.mimeType ?? null,
            bytes.byteLength,
            storedName,
          );
        } catch (insertErr) {
          // Without this the bytes stayed on disk with no index row, so nothing
          // could ever delete them — up to 25 MB orphaned per failure.
          try { fs.unlinkSync(dest); } catch { /* best effort */ }
          throw insertErr;
        }

        return { ok: true, attachment: db.prepare('SELECT id, conversation_id, message_id, file_name, mime_type, byte_size, created_at FROM message_attachments WHERE id = ?').get(id) };
      } catch (e: unknown) {
        console.error('[attachments:save]', e);
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  /**
   * Link saved attachments to the message they were sent with.
   *
   * The conversation id is backfilled here too: files queued on a brand-new
   * chat are saved before handleSend creates the conversation, so they would
   * otherwise be stranded with a NULL conversation_id and never show up in
   * listAttachments() for the thread.
   */
  ipcMain.handle(
    'attachments:linkToMessage',
    (_e, ids: string[], messageId: string, conversationId?: string) => {
      if (conversationId) {
        const stmt = db.prepare(
          'UPDATE message_attachments SET message_id = ?, conversation_id = ? WHERE id = ?',
        );
        for (const id of ids) stmt.run(messageId, conversationId, id);
      } else {
        const stmt = db.prepare('UPDATE message_attachments SET message_id = ? WHERE id = ?');
        for (const id of ids) stmt.run(messageId, id);
      }
      return { ok: true, count: ids.length };
    },
  );

  ipcMain.handle('attachments:list', (_e, conversationId: string) => {
    return db
      .prepare(
        'SELECT id, conversation_id, message_id, file_name, mime_type, byte_size, created_at FROM message_attachments WHERE conversation_id = ? ORDER BY created_at ASC',
      )
      .all(conversationId) as AttachmentRecord[];
  });

  ipcMain.handle('attachments:listForMessage', (_e, messageId: string) => {
    return db
      .prepare(
        'SELECT id, conversation_id, message_id, file_name, mime_type, byte_size, created_at FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC',
      )
      .all(messageId) as AttachmentRecord[];
  });

  /** Read bytes back for preview. Returns a data URL so the renderer can use it directly. */
  ipcMain.handle('attachments:get', async (_e, id: string) => {
    try {
      const row = db
        .prepare('SELECT stored_name, mime_type, file_name FROM message_attachments WHERE id = ?')
        .get(id) as { stored_name: string; mime_type: string | null; file_name: string } | undefined;
      if (!row) return { ok: false, error: 'Attachment not found.' };

      const bytes = await fs.promises.readFile(resolveStoredPath(row.stored_name));
      const mime = row.mime_type || 'application/octet-stream';
      return {
        ok: true,
        mimeType: mime,
        fileName: row.file_name,
        byteSize: bytes.byteLength,
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      };
    } catch (e: unknown) {
      console.error('[attachments:get]', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('attachments:delete', (_e, id: string) => {
    try {
      const row = db.prepare('SELECT stored_name FROM message_attachments WHERE id = ?').get(id) as { stored_name: string } | undefined;
      if (row) {
        // Resolve OUTSIDE the unlink try. `resolveStoredPath` throws
        // 'Invalid media reference.' for a hostile stored_name, and swallowing
        // that here would delete the row, leave the bytes on disk and report
        // success — the caller would believe the file was removed when it was
        // not. Only a genuine ENOENT is ignorable, so that is all the catch
        // below covers. Same fix as mediaLibrary.ts, which had the identical bug.
        const target = resolveStoredPath(row.stored_name);
        try { fs.unlinkSync(target); } catch { /* file already gone */ }
      }
      db.prepare('DELETE FROM message_attachments WHERE id = ?').run(id);
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Open with the OS default application. */
  ipcMain.handle('attachments:open', async (_e, id: string) => {
    try {
      const row = db.prepare('SELECT stored_name, file_name FROM message_attachments WHERE id = ?').get(id) as { stored_name: string; file_name: string } | undefined;
      if (!row) return { ok: false, error: 'Attachment not found.' };
      const { shell } = await import('electron');
      const full = resolveStoredPath(row.stored_name);
      const err = await shell.openPath(full);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
