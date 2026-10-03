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
import { encryptKey, decryptKey, migrateProviderKeys, canEncrypt } from './_keyStorage';
import { guardedEvent, revokeChannelApprovals } from './validation';
import { setOpencodeZenCredential } from '../coder/opencode';
import { log } from '../lib/log';
import {
  DEFAULT_POLICY,
  POLICY_KEYS,
  clearPin,
  getSecurityPolicy,
  initSecurityPolicy,
  isLocked,
  policyFlag,
  reload as reloadSecurityPolicy,
  setPin,
  setSecurityPolicy,
  unlock,
  hasPin,
  type PolicyKey,
} from './securityPolicy';
import {
  clearLogs,
  exportLogs,
  getRetentionDays,
  initAppLog,
  logStats,
  queryLogs,
  registerSecret,
  setRetentionDays,
  type LogQuery,
} from './appLog';

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

  ipcMain.handle('settings:save', guardedEvent('settings:save', (_event, data: { key: string; value: string }) => {
    try {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).run(data.key, data.value);
      // Tell the renderer a setting changed. Previously nothing was notified,
      // so panels had to poll or simply miss the update.
      try {
        getMainWindow?.()?.webContents.send('settings:changed', { key: data.key, value: data.value });
      } catch (e) {
        console.warn('[settings:save] could not broadcast change', e);
      }
      return true;
    } catch (e) { console.error('[settings:save]', e); return false; }
  }));

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
        // OpenCode Zen authenticates with OPENCODE_API_KEY, which the opencode
        // CLI only sees in its child environment. Push the saved key there now
        // so it takes effect without a restart — otherwise the key would be
        // stored and then silently ignored.
        if (provider.id === 'opencode-zen') {
          setOpencodeZenCredential(rawKey);
        }
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         model = excluded.model,
         provider = excluded.provider,
         tokens_used = excluded.tokens_used,
         cost = excluded.cost,
         engine = excluded.engine`
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

  registerSecurityAndPrivacyHandlers(db);
}

// ── Security / privacy / logs ───────────────────────────────────────────────

/**
 * Tables each "clear my data" scope touches.
 *
 * Every table is listed inside a try/catch at the call site because the schema
 * is created incrementally across releases and an older database may not have
 * every one. A missing table means there is nothing stored to clear, which is
 * the correct outcome for a deletion request — never an error.
 */
const CLEAR_TABLES: Record<string, string[]> = {
  conversations: ['messages', 'message_attachments', 'conversations'],
  messages: ['messages', 'message_attachments'],
  memory: [
    'memory_facts',
    'memory_summaries',
    'personal_memory',
    'project_memory',
    'session_memory',
    'narrative_memory',
    'relationship_memory',
    'memory_graph_edges',
    'conversation_summaries',
  ],
  analytics: ['cost_log', 'health_logs', 'habit_logs', 'automation_runs', 'tool_calls'],
  attachments: ['message_attachments', 'attachments'],
  media: ['media_library', 'media'],
  logs: ['app_logs'],
};

function registerSecurityAndPrivacyHandlers(db: Database.Database): void {
  // Attach the log store and hand it every provider key currently on disk, so
  // a key that does not match any known prefix is still redacted.
  initAppLog(db);
  try {
    const rows = db.prepare('SELECT api_key FROM providers').all() as Array<{ api_key: string }>;
    for (const r of rows) registerSecret(decryptKey(r.api_key || ''));
  } catch {
    /* no providers table yet — nothing to protect */
  }

  // ── Security policy ─────────────────────────────────────────

  /** Everything the Security and Privacy panels need to render, in one call. */
  ipcMain.handle('security:get', () => ({
    policy: getSecurityPolicy(),
    defaults: DEFAULT_POLICY,
    keys: POLICY_KEYS,
    hasPin: hasPin(),
    locked: isLocked(),
    encryptionAvailable: canEncrypt(),
  }));

  /**
   * Flip one switch.
   *
   * `appLock` is refused without a PIN: enabling it with no credential would
   * lock the user out of their own data with no way back in. That check lives
   * here rather than in the panel so it cannot be bypassed by calling IPC
   * directly.
   */
  ipcMain.handle('security:set', async (_e, data: { key: string; value: boolean }) => {
    if (!POLICY_KEYS.includes(data.key as PolicyKey)) {
      return { ok: false, error: 'unknown_policy_key' };
    }
    const key = data.key as PolicyKey;
    if (key === 'appLock' && data.value && !hasPin()) {
      return { ok: false, error: 'pin_required' };
    }
    const ok = setSecurityPolicy(key, data.value);
    // Revoking approvals on EVERY policy change — not just when a protection
    // is switched off — means a grant can never outlive the policy state it
    // was issued under. The cost is one extra confirmation after an unrelated
    // switch flips; the benefit is that no stale approval survives a re-read.
    if (ok) revokeChannelApprovals();
    return { ok, policy: getSecurityPolicy() };
  });

  /** Set or replace the lock PIN. Stores a scrypt hash, never the PIN. */
  ipcMain.handle('security:setPin', async (_e, data: { pin: string }) => {
    const ok = await setPin(data.pin);
    return { ok, hasPin: hasPin() };
  });

  ipcMain.handle('security:clearPin', () => ({ ok: clearPin(), hasPin: hasPin() }));

  ipcMain.handle('security:unlock', async (_e, data: { pin: string }) => unlock(data.pin));

  // ── Privacy ────────────────────────────────────────────────

  /** What is stored and what would be sent. Telemetry is local-only by design. */
  ipcMain.handle('privacy:get', () => {
    const policy = getSecurityPolicy();
    return {
      policy,
      // Stated explicitly rather than left for the user to infer: Henry has no
      // outbound analytics path at all. Saying so is the feature.
      telemetry: {
        transmitsAnything: false,
        localOnly: true,
        includesModelMetadata: policy.diagnosticsMetadata,
      },
      storage: {
        conversations: policy.persistConversations,
        memory: policy.persistMemory,
        analytics: policy.persistAnalytics,
      },
    };
  });

  /**
   * Delete stored data.
 *
 * Returns a per-scope count rather than a bare boolean, so the UI can report
   * what was actually removed — and so a scope whose tables were absent is
   * visibly a no-op rather than looking like a silent failure.
   */
  ipcMain.handle('privacy:clear', (_e, data: { what: string[] }) => {
    const result: Record<string, number> = {};
    const run = db.transaction((scope: string) => {
      let removed = 0;
      for (const table of CLEAR_TABLES[scope] ?? []) {
        try {
removed += db.prepare(`DELETE FROM "${table}"`).run().changes;
        } catch {
          // Table absent in this database — nothing stored to clear.
        }
      }
      return removed;
    });
    for (const scope of data.what) {
      if (!CLEAR_TABLES[scope]) continue;
      result[scope] = run(scope);
    }
    log.info(`[privacy:clear] removed`, JSON.stringify(result));
    return { ok: true, removed: result };
  });

  // ── Application log ────────────────────────────────────────

  ipcMain.handle('logs:query', (_e, q: LogQuery = {}) => queryLogs(q));
  ipcMain.handle('logs:stats', () => logStats());
  ipcMain.handle('logs:clear', (_e, data: { before?: string }) => ({ removed: clearLogs(data.before) }));
  ipcMain.handle('logs:retention', (_e, data: { days: number }) => ({ days: setRetentionDays(data.days) }));
  ipcMain.handle('logs:retention:get', () => ({ days: getRetentionDays() }));
  ipcMain.handle('logs:export', (_e, q: LogQuery = {}) => ({ text: exportLogs(q) }));
}

// ── Re-exports so main.ts has one settings/security import site ────────────

export {
  getSecurityPolicy,
  initSecurityPolicy,
  isLocked,
  policyFlag,
  reloadSecurityPolicy,
  DEFAULT_POLICY,
  POLICY_KEYS,
};
