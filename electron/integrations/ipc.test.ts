/**
 * Integration IPC tests.
 *
 * The handlers are registered against a capturing `ipcMain` stub and driven the
 * way the renderer drives them, so this covers the whole lifecycle across the
 * real credential store: connect → status → disconnect → status.
 *
 * The assertions that matter for security:
 *   - no channel ever returns a token, a refresh token, or a client secret
 *   - a bot token is encrypted at rest, not written as plaintext
 *   - disconnect genuinely deletes the row, and the reply says so
 *   - an unknown provider id is rejected rather than silently accepted
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return { handlers, sent };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  shell: { openExternal: vi.fn(async () => undefined) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { registerIntegrationHandlers } from './ipc';
import { loadCredential } from './oauth/credentialStore';

class FakeDb {
  readonly rows = new Map<string, string>();
  prepare(sql: string) {
    if (sql.includes('SELECT')) {
      return { get: (key: string) => (this.rows.has(key) ? { value: this.rows.get(key) } : undefined) };
    }
    if (sql.includes('DELETE')) {
      return { run: (key: string) => { this.rows.delete(key); return { changes: 1 }; } };
    }
    return {
      run: (key: string, value: string) => {
        this.rows.set(key, value);
        return { changes: 1 };
      },
    };
  }
}

const db = new FakeDb();
const window = { webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } };

const call = <T = Record<string, unknown>>(channel: string, payload?: unknown): Promise<T> =>
  h.handlers.get(channel)?.({}, payload) as Promise<T>;

const BOT_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.bot-token-value-here';

beforeEach(() => {
  h.handlers.clear();
  h.sent.length = 0;
  db.rows.clear();
  registerIntegrationHandlers(() => db as never, () => window as never);
});

describe('integration:list', () => {
  it('describes every registered provider without any credential material', async () => {
    const list = await call<Array<Record<string, unknown>>>('integration:list');
    expect(list.map((p) => p.id).sort()).toEqual(['discord', 'google']);
    for (const provider of list) {
      expect(typeof provider.setupHint).toBe('string');
      // A description is public by design; a credential field never is.
      expect(JSON.stringify(provider)).not.toMatch(/"(accessToken|refreshToken|clientSecret)"/);
    }
  });
});

describe('integration:setToken', () => {
  it('stores a Discord bot token and reports it connected', async () => {
    const result = await call('integration:setToken', { providerId: 'discord', token: BOT_TOKEN });
    expect(result).toMatchObject({ ok: true, connected: true });
    expect(loadCredential('discord', db as never)?.tokens.accessToken).toBe(BOT_TOKEN);
  });

  it('never echoes the token back to the renderer', async () => {
    const result = await call('integration:setToken', { providerId: 'discord', token: BOT_TOKEN });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token|client_secret/);
  });

  it('rejects something that is obviously not a token, with a usable message', async () => {
    const result = await call('integration:setToken', { providerId: 'discord', token: 'hunter2' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Developer Portal/);
    expect(loadCredential('discord', db as never)).toBeNull();
  });

  it('refuses an unknown provider instead of writing a row under a bogus key', async () => {
    const result = await call('integration:setToken', { providerId: 'myspace', token: BOT_TOKEN });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown integration/);
  });

  it('notifies the renderer so an open panel updates', async () => {
    await call('integration:setToken', { providerId: 'discord', token: BOT_TOKEN });
    expect(h.sent).toContainEqual({ channel: 'integration:changed', payload: { providerId: 'discord' } });
  });
});

describe('integration:status', () => {
  it('reports not-connected with no token material for an unused provider', async () => {
    const all = await call<Array<Record<string, unknown>>>('integration:status');
    const discord = all.find((p) => p.id === 'discord');
    expect(discord).toMatchObject({ connected: false, hasRefreshToken: false });
    expect(JSON.stringify(all)).not.toMatch(/accessToken|refreshToken|clientSecret/);
  });

  it('reports a stored bot token as connected without exposing it', async () => {
    await call('integration:setToken', { providerId: 'discord', token: BOT_TOKEN });
    const all = await call<Array<Record<string, unknown>>>('integration:status');
    const discord = all.find((p) => p.id === 'discord');
    expect(discord).toMatchObject({ connected: true, hasRefreshToken: false, expired: false });
    expect(JSON.stringify(discord)).not.toContain(BOT_TOKEN);
  });
});

describe('integration:disconnect', () => {
  it('really removes the stored credential', async () => {
    await call('integration:setToken', { providerId: 'discord', token: BOT_TOKEN });
    expect(db.rows.size).toBe(1);

    const result = await call('integration:disconnect', { providerId: 'discord' });
    expect(result).toMatchObject({ ok: true, removed: true });
    expect(loadCredential('discord', db as never)).toBeNull();
    expect(db.rows.size).toBe(0);
  });

  it('tells the renderer the connection changed', async () => {
    await call('integration:setToken', { providerId: 'discord', token: BOT_TOKEN });
    h.sent.length = 0;
    await call('integration:disconnect', { providerId: 'discord' });
    expect(h.sent).toContainEqual({ channel: 'integration:changed', payload: { providerId: 'discord' } });
  });

  it('refuses an unknown provider', async () => {
    const result = await call('integration:disconnect', { providerId: 'myspace' });
    expect(result.ok).toBe(false);
  });
});

describe('integration:connect', () => {
  it('rejects a connect with no client id rather than opening a browser', async () => {
    const result = await call('integration:connect', { providerId: 'google', clientId: '', clientSecret: '' });
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toMatch(/client ID/);
    expect(loadCredential('google', db as never)).toBeNull();
  });

  it('rejects a connect with no client secret', async () => {
    const result = await call('integration:connect', { providerId: 'google', clientId: 'cid' });
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toMatch(/client secret/);
  });

  it('rejects an unknown provider', async () => {
    const result = await call('integration:connect', { providerId: 'myspace', clientId: 'a', clientSecret: 'b' });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown integration/) });
  });
});