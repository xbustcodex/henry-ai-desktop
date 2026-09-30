/**
 * Settings — Handles all settings, provider, conversation, message, and cost CRUD.
 *
 * IPC channels match what preload.ts exposes to the renderer:
 *   settings:getAll, settings:save, providers:getAll, providers:save,
 *   conversations:getAll, conversations:create, conversations:update,
 *   conversations:delete, messages:getAll, messages:save,
 *   cost:getAll
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { encryptKey, decryptKey, migrateProviderKeys } from './_keyStorage';
import { log } from '../lib/log';

export function registerSettingsHandlers(db: Database.Database, getMainWindow?: () => import('electron').BrowserWindow | null) {
  // Encrypt any plaintext keys left over from before this feature shipped.
  // Safe to call every launch — already-encrypted rows are detected by prefix.
  migrateProviderKeys(db);

  // ── Settings ────────────────────────────────────────────────

  // Returns a Record<string, string>
  ipcMain.handle('settings:getAll', () => {
    try {
      const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
      const settings: Record<string, string> = {};
      rows.forEach((row) => { settings[row.key] = row.value; });
      return settings;
    } catch (e) { console.error('[settings:getAll]', e); return {}; }
  });

  ipcMain.handle('settings:save', (_, data: { key: string; value: string }) => {
    try {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).run(data.key, data.value);
      return true;
    } catch (e) { console.error('[settings:save]', e); return false; }
  });

  // ── Providers ───────────────────────────────────────────────

  ipcMain.handle('providers:getAll', () => {
    const rows = db.prepare('SELECT * FROM providers ORDER BY name').all() as any[];
    // Decrypt keys before sending to the renderer — encryption is at-rest only.
    return rows.map((p) => ({ ...p, api_key: decryptKey(p.api_key || ''), apiKey: decryptKey(p.api_key || '') }));
  });

  ipcMain.handle(
    'providers:save',
    (
      _,
      provider: {
        id: string;
        name: string;
        apiKey?: string;
        api_key?: string;
        enabled: boolean | number;
        models: string;
      }
    ) => {
      try {
        const rawKey = provider.apiKey || provider.api_key || '';
        const encryptedKey = encryptKey(rawKey);
        const enabled = provider.enabled ? 1 : 0;
        db.prepare(
          `INSERT INTO providers (id, name, api_key, enabled, models, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           api_key = excluded.api_key,
           enabled = excluded.enabled,
           models = excluded.models,
           updated_at = datetime('now')`
        ).run(provider.id, provider.name, encryptedKey, enabled, provider.models || '[]');
        log.debug('[providers:save] saved', provider.id);
        // Immediately inject into renderer localStorage so chat picks it up without restart.
        // NOTE: localStorage itself is not encrypted — this is plaintext in Chromium's data store.
        // A future hardening pass should remove keys from localStorage entirely and have the
        // renderer call providers:getAll via IPC on each request instead.
        try {
          const allProviders = db.prepare('SELECT id, name, api_key, enabled, models FROM providers').all() as any[];
          const lsData = allProviders.map((p: any) => {
            const plain = decryptKey(p.api_key || '');
            return {
              id: p.id, name: p.name,
              api_key: plain, apiKey: plain,
              enabled: Boolean(p.enabled), models: p.models || '[]',
            };
          });
          const script = `try { localStorage.setItem('henry:providers', '${JSON.stringify(lsData).replace(/'/g, "\'")}'); } catch(e) { console.warn('[Henry] localStorage sync failed', e); }`;
          getMainWindow?.()?.webContents.executeJavaScript(script).catch(() => {});
        } catch { /* non-critical */ }
        return { ok: true };
      } catch (e: unknown) {
        console.error('[providers:save] FAILED:', e instanceof Error ? e.message : String(e));
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  );

  // ── Conversations ───────────────────────────────────────────

  ipcMain.handle('conversations:getAll', () => {
    try { return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all(); }
    catch (e) { console.error('[conversations:getAll]', e); return []; }
  });

  ipcMain.handle('conversations:create', (_, title: string) => {
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, title) VALUES (?, ?)'
    ).run(id, title);
    return { id, title, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  });

  ipcMain.handle('conversations:update', (_, data: { id: string; title: string }) => {
    db.prepare(
      "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(data.title, data.id);
    return true;
  });

  ipcMain.handle('conversations:delete', (_, id: string) => {
    // memory_facts and conversation_summaries reference conversations WITHOUT
    // ON DELETE CASCADE, so the DELETE threw FOREIGN KEY constraint failed —
    // and because the message delete had already run outside a transaction, the
    // thread was left half-deleted and permanently undeletable. Clear the
    // dependents explicitly and make it all-or-nothing.
    const clear = db.transaction((convId: string) => {
      for (const table of ['messages', 'memory_facts', 'conversation_summaries', 'message_attachments']) {
        try {
          db.prepare(`DELETE FROM "${table}" WHERE conversation_id = ?`).run(convId);
        } catch {
          // Table absent in this database — nothing to clean up.
        }
      }
      db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
    });
    clear(id);
    return true;
  });

  // ── Messages ────────────────────────────────────────────────

  ipcMain.handle('messages:getAll', (_, conversationId: string) => {
    try { return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId); }
    catch (e) { console.error('[messages:getAll]', e); return []; }
  });

  ipcMain.handle(
    'messages:save',
    (
      _,
      message: {
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        model?: string;
        provider?: string;
        tokens_used?: number;
        cost?: number;
        engine?: string;
      }
    ) => {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, provider, tokens_used, cost, engine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        message.id,
        message.conversation_id,
        message.role,
        message.content,
        message.model || null,
        message.provider || null,
        message.tokens_used || 0,
        message.cost || 0,
        message.engine || null
      );

      // Update conversation timestamp
      db.prepare(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
      ).run(message.conversation_id);

      // Log cost if applicable
      if (message.cost && message.cost > 0) {
        db.prepare(
          `INSERT INTO cost_log (provider, model, tokens_input, tokens_output, cost, conversation_id)
         VALUES (?, ?, 0, ?, ?, ?)`
        ).run(
          message.provider || '',
          message.model || '',
          message.tokens_used || 0,
          message.cost,
          message.conversation_id
        );
      }

      return true;
    }
  );

  // ── Cost Tracking ───────────────────────────────────────────

  ipcMain.handle('cost:getAll', (_, period?: string) => {
    let query = 'SELECT * FROM cost_log';

    if (period === '7d') {
      query += " WHERE created_at > datetime('now', '-7 days')";
    } else if (period === '30d') {
      query += " WHERE created_at > datetime('now', '-30 days')";
    }

    query += ' ORDER BY created_at DESC';
    return db.prepare(query).all();
  });
}
