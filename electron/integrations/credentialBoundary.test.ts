/**
 * The IPC credential boundary.
 *
 * The claim under test is blunt: **no channel in the integration layer ever
 * returns a token, a refresh token, or a client secret to the renderer** — not
 * on the happy path, and not in an error envelope.
 *
 * The error paths are the ones that matter. A happy-path test only proves the
 * reply is clean when nothing went wrong; the realistic leak is an error
 * string that interpolates the credential it was trying to use ("Discord
 * rejected token MTA.abc…"), which is exactly the shape a provider's own error
 * body takes. Each failure mode below is provoked deliberately rather than
 * assumed.
 *
 * No network, no real credentials. The "credential" is a distinctive sentinel
 * so a substring match is unambiguous.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  // Stands in for the user's browser. It reads the `state` and PKCE challenge
  // out of the authorize URL the engine built and "approves" by hitting the
  // loopback callback — which is precisely what Google does. Driving the real
  // listener is what lets these tests reach a genuine token exchange.
  shell: { openExternal: vi.fn(async () => undefined) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { shell } from 'electron';
import { registerIntegrationHandlers } from './ipc';
import { loadCredential, saveCredential } from './oauth/credentialStore';
import { DISCORD_PROVIDER, GOOGLE_PROVIDER } from './oauth/registry';
import { OAuthFlowError, redact } from './oauth/flow';

class FakeDb {
  readonly rows = new Map<string, string>();
  broken = false;
  prepare(sql: string) {
    if (this.broken) throw new Error('database is locked');
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
const window = { webContents: { send: (c: string, p: unknown) => h.sent.push({ channel: c, payload: p }) } };

const call = <T = Record<string, unknown>>(channel: string, payload?: unknown): Promise<T> =>
  h.handlers.get(channel)?.({}, payload) as Promise<T>;

/** A token no other string in the codebase could contain. */
const SENTINEL_TOKEN = 'MTk5OTk5OTk5OTk5.SENTINEL-bot-token-DO-NOT-LEAK-abcdefghijklmnop';
const SENTINEL_SECRET = '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T-LEAK';
const SENTINEL_REFRESH = '1//SENTINEL-refresh-token-DO-NOT-LEAK';

/**
 * The assertion, applied uniformly. It checks the whole reply — including every
 * nested object and array — for the sentinel in any form, and also for the
 * field names a token would arrive under.
 */
function assertNoCredentialLeak(value: unknown, label: string): void {
  const serialised = JSON.stringify(value ?? null);
  expect(serialised, `${label} leaked the access token`).not.toContain(SENTINEL_TOKEN);
  expect(serialised, `${label} leaked the client secret`).not.toContain(SENTINEL_SECRET);
  expect(serialised, `${label} leaked the refresh token`).not.toContain(SENTINEL_REFRESH);
  // Field names too: a reply carrying `accessToken: undefined` still tells a
  // caller that a token is the contract.
  expect(serialised, `${label} exposed a credential-shaped field`).not.toMatch(
    /"(access_?[Tt]oken|refresh_?[Tt]oken|client_?[Ss]ecret|clientSecret|authorization)"\s*:\s*"(?!\[redacted)/,
  );
}

function seedGoogleCredential(): void {
  saveCredential(
    GOOGLE_PROVIDER.id,
    {
      tokens: {
        accessToken: SENTINEL_TOKEN,
        refreshToken: SENTINEL_REFRESH,
        expiresAt: Date.now() + 3_600_000,
        scope: 'a b',
        tokenType: 'Bearer',
        authScheme: 'Bearer',
      },
      clientId: 'cid-123',
      clientSecret: SENTINEL_SECRET,
    },
    db as never,
  );
}

beforeEach(() => {
  h.handlers.clear();
  h.sent.length = 0;
  db.rows.clear();
  db.broken = false;
  vi.mocked(shell.openExternal).mockReset();
  // Approve every connect by default; individual tests override this.
  vi.mocked(shell.openExternal).mockImplementation((url: string) => {
    const state = new URL(url).searchParams.get('state');
    // `http.request` rather than `fetch`, because several of these tests stub
    // the global fetch to stand in for the provider's token endpoint — using it
    // here would deliver the callback to the stub instead of the listener.
    const req = http.request(
      {
        host: '127.0.0.1',
        port: GOOGLE_PROVIDER.callbackPort,
        path: `${GOOGLE_PROVIDER.callbackPath}?code=test-authorization-code&state=${encodeURIComponent(state ?? '')}`,
      },
      (res) => {
        res.resume();
      },
    );
    req.on('error', () => undefined);
    req.end();
    // The engine is waiting on this request, not the other way round.
    return Promise.resolve();
  });
  registerIntegrationHandlers(() => db as never, () => window as never);
});

// ── integration:list ────────────────────────────────────────────────────────

describe('integration:list — no credential reaches the renderer', () => {
  it('stays clean with nothing connected', async () => {
    assertNoCredentialLeak(await call('integration:list'), 'integration:list (empty)');
  });

  it('stays clean with a credential stored', async () => {
    seedGoogleCredential();
    assertNoCredentialLeak(await call('integration:list'), 'integration:list (connected)');
  });
});

// ── integration:status ──────────────────────────────────────────────────────

describe('integration:status — no credential reaches the renderer', () => {
  it('reports an unconnected provider without touching a credential', async () => {
    assertNoCredentialLeak(await call('integration:status'), 'integration:status (unconnected)');
  });

  it('reports a connected provider without its token', async () => {
    seedGoogleCredential();
    const all = await call<Array<Record<string, unknown>>>('integration:status');
    // The useful part: it really is reporting connected.
    expect(all.find((p) => p.id === 'google')).toMatchObject({
      connected: true,
      hasRefreshToken: true,
    });
    assertNoCredentialLeak(all, 'integration:status (connected)');
  });

  it('does not leak when the settings table itself is unreadable', async () => {
    db.broken = true;
    // The realistic failure: a locked or migrating database. The reply must
    // degrade to "not connected", not throw something carrying the key.
    let reply: unknown;
    try {
      reply = await call('integration:status');
    } catch (e) {
      reply = { thrown: e instanceof Error ? e.message : String(e) };
    }
    expect(reply).toBeDefined();
    assertNoCredentialLeak(reply, 'integration:status (db failure)');
  });
});

// ── integration:setToken ────────────────────────────────────────────────────

describe('integration:setToken — no credential reaches the renderer', () => {
  it('does not echo a stored token back on success', async () => {
    const reply = await call('integration:setToken', {
      providerId: 'discord',
      token: SENTINEL_TOKEN,
    });
    expect(reply).toMatchObject({ ok: true });
    assertNoCredentialLeak(reply, 'integration:setToken (success)');
  });

  it('does not echo the token when it fails the shape check', async () => {
    // The validator's own message must not quote the rejected value back.
    const reply = await call('integration:setToken', {
      providerId: 'discord',
      token: `${SENTINEL_TOKEN} has spaces`,
    });
    expect(reply.ok).toBe(false);
    assertNoCredentialLeak(reply, 'integration:setToken (malformed)');
  });

  it('does not echo the token when the provider is unknown', async () => {
    const reply = await call('integration:setToken', {
      providerId: 'myspace',
      token: SENTINEL_TOKEN,
    });
    expect(reply.ok).toBe(false);
    assertNoCredentialLeak(reply, 'integration:setToken (unknown provider)');
  });

  it('does not echo the token when the store refuses to write it', async () => {
    // The store is where a credential is most likely to be interpolated into a
    // failure message, because that is the frame holding it.
    db.broken = true;
    let reply: unknown;
    try {
      reply = await call('integration:setToken', { providerId: 'discord', token: SENTINEL_TOKEN });
    } catch (e) {
      reply = { thrown: e instanceof Error ? e.message : String(e) };
    }
    assertNoCredentialLeak(reply, 'integration:setToken (store failure)');
  });

  it('writes the token to the encrypted store rather than leaving it in memory', async () => {
    await call('integration:setToken', { providerId: 'discord', token: SENTINEL_TOKEN });
    // It is persisted, which is the point — but under the per-provider key, so
    // it is discoverable only by code that already has the DB handle.
    expect([...db.rows.keys()]).toEqual(['oauth:discord']);
    expect(loadCredential(DISCORD_PROVIDER.id, db as never)?.tokens.accessToken).toBe(SENTINEL_TOKEN);
  });
});

// ── integration:connect ─────────────────────────────────────────────────────

describe('integration:connect — no credential reaches the renderer', () => {
  it('reports a missing client id without one', async () => {
    const reply = await call('integration:connect', {
      providerId: 'google',
      clientId: '',
      clientSecret: SENTINEL_SECRET,
    });
    expect(reply.ok).toBe(false);
    assertNoCredentialLeak(reply, 'integration:connect (no client id)');
  });

  it('reports a missing client secret without quoting the one it was sent', async () => {
    const reply = await call('integration:connect', {
      providerId: 'google',
      clientId: 'cid-123',
      clientSecret: '',
    });
    expect(reply.ok).toBe(false);
    assertNoCredentialLeak(reply, 'integration:connect (no client secret)');
  });

  it('does not leak when the provider echoes the credential back in an error', async () => {
    // The realistic worst case: a provider (or an intercepting proxy) returns
    // the secret in its error body, and the handler forwards it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: `client_secret "${SENTINEL_SECRET}" was rejected`,
          }),
          { status: 401 },
        ),
      ),
    );
    const reply = await call('integration:connect', {
      providerId: 'google',
      clientId: 'cid-123',
      clientSecret: SENTINEL_SECRET,
    });
    expect(reply.ok).toBe(false);
    assertNoCredentialLeak(reply, 'integration:connect (provider error echo)');
  });

  it('does not leak a real token when the exchange succeeds', async () => {
    // The success path is the other half: the handler holds a live access token
    // at that moment and must still keep it out of the reply.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: SENTINEL_TOKEN, expires_in: 3600 }), { status: 200 }),
      ),
    );
    const reply = await call('integration:connect', {
      providerId: 'google',
      clientId: 'cid-123',
      clientSecret: SENTINEL_SECRET,
    });
    expect(reply).toMatchObject({ ok: true, connected: true });
    assertNoCredentialLeak(reply, 'integration:connect (success)');
    // It was genuinely persisted — the reply is simply not where it lives.
    expect(loadCredential(GOOGLE_PROVIDER.id, db as never)?.tokens.accessToken).toBe(SENTINEL_TOKEN);
  });

  it('does not leak when the browser cannot be opened', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce(
      new Error(`could not launch: ${SENTINEL_SECRET}`),
    );
    const reply = await call('integration:connect', {
      providerId: 'google',
      clientId: 'cid-123',
      clientSecret: SENTINEL_SECRET,
    });
    expect(reply.ok).toBe(false);
    assertNoCredentialLeak(reply, 'integration:connect (browser failed)');
  });

  it('rejects an unknown provider before any credential is read', async () => {
    const reply = await call('integration:connect', {
      providerId: 'myspace',
      clientId: 'cid-123',
      clientSecret: SENTINEL_SECRET,
    });
    expect(reply).toMatchObject({ ok: false });
    assertNoCredentialLeak(reply, 'integration:connect (unknown provider)');
  });
});

// ── integration:disconnect ──────────────────────────────────────────────────

describe('integration:disconnect — no credential reaches the renderer', () => {
  it('does not echo the token it just deleted', async () => {
    seedGoogleCredential();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const reply = await call('integration:disconnect', { providerId: 'google' });
    expect(reply).toMatchObject({ ok: true, removed: true });
    assertNoCredentialLeak(reply, 'integration:disconnect (success)');
  });

  it('does not leak when the remote revoke fails and reports the token', async () => {
    seedGoogleCredential();
    // A revoke endpoint answering with the token it was asked to revoke.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'could not revoke', token: SENTINEL_REFRESH }), {
          status: 400,
        }),
      ),
    );

    const reply = await call('integration:disconnect', { providerId: 'google' });
    expect(reply).toMatchObject({ ok: true, removed: true });
    assertNoCredentialLeak(reply, 'integration:disconnect (remote error)');
  });

  it('reports removal honestly when the delete itself fails', async () => {
    seedGoogleCredential();
    db.broken = true;
    let reply: unknown;
    try {
      reply = await call('integration:disconnect', { providerId: 'google' });
    } catch (e) {
      reply = { thrown: e instanceof Error ? e.message : String(e) };
    }
    // The honest bit: it must not claim a disconnect that did not happen.
    expect(reply).toMatchObject({ ok: false });
    expect(String((reply as { error?: string }).error)).toMatch(/still be on disk/i);
    assertNoCredentialLeak(reply, 'integration:disconnect (delete failed)');
  });
});

// ── The renderer-facing event ───────────────────────────────────────────────

describe('integration:changed event', () => {
  it('carries only a provider id, never a credential', async () => {
    seedGoogleCredential();
    await call('integration:disconnect', { providerId: 'google' });
    for (const event of h.sent) assertNoCredentialLeak(event, `event ${event.channel}`);
    expect(h.sent.every((e) => e.channel === 'integration:changed')).toBe(true);
  });
});

// ── redact() is the choke point the above relies on ─────────────────────────

describe('redact() covers the error shapes the handlers can produce', () => {
  it('strips a client secret quoted inside a provider error description', () => {
    const out = redact(`client_secret "${SENTINEL_SECRET}" was rejected`);
    expect(out).not.toContain('SENTINEL');
  });

  it('strips a bearer-prefixed token and leaves the prefix readable', () => {
    const out = redact(`upstream said: Bearer ${SENTINEL_TOKEN}`);
    expect(out).not.toContain('SENTINEL');
    expect(out).toContain('Bearer');
  });

  it('strips an opaque secret only when the caller supplies it', () => {
    // No pattern can guess an opaque token, and pretending otherwise would be
    // the dangerous kind of confident. The engine's contract is that every
    // frame holding the secret passes it in as an explicit extra.
    const opaque = `provider rejected ${SENTINEL_TOKEN}`;
    expect(redact(opaque)).toContain('SENTINEL');
    expect(redact(opaque, [SENTINEL_TOKEN])).not.toContain('SENTINEL');
  });

  it('an OAuthFlowError built from a leaky message is redacted at construction', () => {
    const err = new OAuthFlowError('discord', `bad Bearer ${SENTINEL_TOKEN}`);
    expect(err.message).not.toContain('SENTINEL');
  });
});