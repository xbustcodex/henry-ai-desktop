/**
 * `google:*` IPC facade tests.
 *
 * The Google connect surface was live before this change and must stay live —
 * it is what Settings uses. These drive the real handlers against a capturing
 * `ipcMain` stub and an in-memory settings table, and assert the properties the
 * change was actually about:
 *
 *   - a connected credential survives being read back (it used to live in two
 *     module-level variables, so a restart lost it and nothing else could read it)
 *   - `google:startAuth` no longer hands the renderer a live access token
 *   - `google:refreshToken` performs a real round trip to the token endpoint
 *   - `google:disconnect` actually deletes the stored row
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

import { registerGoogleAuthHandlers } from './googleAuth';
import { loadCredential, saveCredential } from '../integrations/oauth/credentialStore';
import { GOOGLE_PROVIDER } from '../integrations/oauth/registry';

// The facade resolves the DB through `getDb()`. Swapping the module registry
// here is what lets the real handler run against the fake handle.
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('./database', () => ({
  getDb: () => {
    if (!state.db) throw new Error('Database not initialized.');
    return state.db;
  },
}));

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
const window = {
  webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) },
};

const call = (channel: string, payload?: unknown) =>
  h.handlers.get(channel)?.({}, payload) as Promise<Record<string, unknown>>;

function googleToken(expiresInMs: number) {
  return {
    accessToken: 'ya29.stored-access-token',
    refreshToken: '1//stored-refresh-token',
    expiresAt: Date.now() + expiresInMs,
    scope: 'https://www.googleapis.com/auth/gmail.send',
    tokenType: 'Bearer',
    authScheme: 'Bearer' as const,
  };
}

beforeEach(async () => {
  h.handlers.clear();
  h.sent.length = 0;
  db.rows.clear();
  state.db = db;
  vi.resetModules();
  const mod = await import('./googleAuth');
  mod.registerGoogleAuthHandlers(() => window as never);
});

describe('google:hasCredentials', () => {
  it('is false before connecting and true after a credential is stored', async () => {
    expect(await call('google:hasCredentials')).toBe(false);
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(3_600_000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    expect(await call('google:hasCredentials')).toBe(true);
  });

  it('is still true when the access token has expired, because a refresh token is a connection', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(-1000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    expect(await call('google:hasCredentials')).toBe(true);
  });
});

describe('google:getToken', () => {
  it('returns null and no event when nothing is stored', async () => {
    expect(await call('google:getToken')).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it('returns the stored access token without a token-endpoint call', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(3_600_000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await call('google:getToken');
    expect(result.accessToken).toBe('ya29.stored-access-token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes automatically when the token is inside the expiry margin', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(30_000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'ya29.refreshed', expires_in: 3600 }), { status: 200 }),
      ),
    );

    const result = await call('google:getToken');
    expect(result.accessToken).toBe('ya29.refreshed');
    // The refreshed token must be on disk, not just in this response.
    expect(loadCredential(GOOGLE_PROVIDER.id, db as never)?.tokens.accessToken).toBe('ya29.refreshed');
  });

  it('announces a revocation and drops the credential when refresh is refused', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(-1000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
    );

    expect(await call('google:getToken')).toBeNull();
    expect(h.sent.map((e) => e.channel)).toContain('google:tokenRevoked');
    expect(loadCredential(GOOGLE_PROVIDER.id, db as never)).toBeNull();
  });
});

describe('google:refreshToken', () => {
  it('forces a round trip even when the stored token is still valid', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(3_600_000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'ya29.forced', expires_in: 3600 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await call('google:refreshToken');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe('ya29.forced');
  });

  it('throws a reconnectable message when nothing is stored', async () => {
    await expect(call('google:refreshToken')).rejects.toThrow(/reconnect Google/i);
  });
});

describe('google:disconnect', () => {
  it('deletes the stored credential and tells the renderer', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(3_600_000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const result = await call('google:disconnect');
    expect(result).toMatchObject({ ok: true, connected: false });
    expect(loadCredential(GOOGLE_PROVIDER.id, db as never)).toBeNull();
    expect(db.rows.size).toBe(0);
    expect(h.sent.map((e) => e.channel)).toContain('google:tokenRevoked');
  });

  it('still removes the local credential when the remote revoke fails', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken(3_600_000), clientId: 'cid', clientSecret: 'sec' }, db as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await call('google:disconnect');
    expect(loadCredential(GOOGLE_PROVIDER.id, db as never)).toBeNull();
  });
});

describe('google:startAuth', () => {
  it('rejects with a client-secret message and never returns a token', async () => {
    const result = await call('google:startAuth', { clientId: 'cid', clientSecret: '' });
    expect(result).toMatchObject({ ok: false, connected: false });
    expect(String(result.error)).toMatch(/client secret/i);
    expect(JSON.stringify(result)).not.toMatch(/accessToken/);
  });

  it('rejects with a client-id message when the id is blank', async () => {
    const result = await call('google:startAuth', { clientId: '', clientSecret: 'sec' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/client ID/i);
  });
});