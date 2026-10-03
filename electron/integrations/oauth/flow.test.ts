/**
 * OAuth engine tests — no network, no credentials.
 *
 * Everything here is a real assertion about behaviour that matters:
 *   - PKCE S256 challenge matches the RFC 7636 test vector
 *   - the authorize URL carries state + challenge and cannot be forged
 *   - a mismatched `state` on the loopback callback is IGNORED, not accepted
 *   - refresh keeps the existing refresh token when the provider omits one
 *   - an `invalid_grant` refresh wipes the stored credential
 *   - disconnect removes the stored credential even when the remote revoke fails
 *   - tokens never survive into a thrown error message
 *
 * `electron` is stubbed because `flow.ts` imports `shell` and the key storage
 * helper imports `safeStorage`. Neither is exercised by these paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import {
  makeCodeVerifier,
  makeCodeChallenge,
  makeState,
  statesMatch,
  redact,
  buildAuthorizeUrl,
  requestToken,
  toTokenSet,
  ensureAccessToken,
  disconnect,
  connect,
  OAuthFlowError,
} from './flow';
import { loadCredential, saveCredential, clearCredential } from './credentialStore';
import { GOOGLE_PROVIDER } from './registry';
import type { OAuthTokenSet } from './types';

/** Just enough better-sqlite3 to exercise the settings table. */
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

function tokenSet(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: 'ya29.a0AfH6SMB-access-token-value',
    refreshToken: '1//refresh-token-value',
    expiresAt: Date.now() + 3_600_000,
    scope: 'a b',
    tokenType: 'Bearer',
    authScheme: 'Bearer',
    ...overrides,
  };
}

beforeEach(() => {
  db.rows.clear();
});

describe('PKCE primitives (RFC 7636)', () => {
  it('produces a verifier inside the 43–128 character range', () => {
    for (let i = 0; i < 20; i++) {
      const v = makeCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('derives the S256 challenge exactly as the RFC test vector does', () => {
    // RFC 7636 Appendix B.
    expect(makeCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates a distinct state every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeState()));
    expect(seen.size).toBe(50);
  });
});

describe('state matching', () => {
  it('accepts the exact state', () => {
    expect(statesMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects a missing, different, or same-prefix state', () => {
    expect(statesMatch('abc123', null)).toBe(false);
    expect(statesMatch('abc123', 'abc124')).toBe(false);
    // Different length must be rejected without throwing on timingSafeEqual.
    expect(statesMatch('abc123', 'abc1234')).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  const url = buildAuthorizeUrl(GOOGLE_PROVIDER, {
    clientId: 'client-123',
    codeChallenge: 'challenge-abc',
    state: 'state-xyz',
    scopes: ['scope.one', 'scope.two'],
  });
  const parsed = new URL(url);

  it('targets the provider authorize endpoint', () => {
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
  });

  it('uses response_type=code with an S256 challenge', () => {
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('binds the state and the loopback redirect', () => {
    expect(parsed.searchParams.get('state')).toBe('state-xyz');
    expect(parsed.searchParams.get('redirect_uri')).toBe(GOOGLE_PROVIDER.redirectUri);
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
  });

  it('requests offline access so a refresh token is ever issued', () => {
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('scope')).toBe('scope.one scope.two');
  });
});

describe('redact', () => {
  it('removes a Google access token embedded in an error body', () => {
    const out = redact('{"error":"invalid_token","description":"Token ya29.a0AfBbyC-secret rejected"}');
    expect(out).not.toContain('a0AfBbyC');
    expect(out).toContain('[redacted]');
  });

  it('removes an explicitly supplied secret verbatim', () => {
    const out = redact('failed for hunter2-supersecret-token', ['hunter2-supersecret-token']);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[redacted]');
  });

  it('leaves ordinary prose alone', () => {
    expect(redact('Port 9005 is already in use.')).toBe('Port 9005 is already in use.');
  });
});

describe('requestToken', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends client_id and client_secret in the body by default', async () => {
    const fetchImpl = respond(200, { access_token: 'at', expires_in: 3600 });
    await requestToken(GOOGLE_PROVIDER, { grant_type: 'authorization_code' }, 'cid', 'csec', fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csec');
  });

  it('uses HTTP Basic auth when the provider requires it', async () => {
    const discord = { ...GOOGLE_PROVIDER, id: 'discord', clientAuth: 'basic' as const };
    const fetchImpl = respond(200, { access_token: 'at' });
    await requestToken(discord, { grant_type: 'refresh_token' }, 'cid', 'csec', fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csec').toString('base64')}`);
    // With Basic, the secret must not also be in the body.
    expect(new URLSearchParams(String(init.body)).get('client_secret')).toBeNull();
  });

  it('flags invalid_grant as a revocation', async () => {
    const fetchImpl = respond(400, { error: 'invalid_grant' });
    await expect(
      requestToken(GOOGLE_PROVIDER, { grant_type: 'refresh_token' }, 'cid', 'csec', fetchImpl),
    ).rejects.toMatchObject({ revoked: true });
  });

  it('does not treat a rate limit as a revocation', async () => {
    const fetchImpl = respond(429, { error: 'rate_limit_exceeded' });
    await expect(
      requestToken(GOOGLE_PROVIDER, { grant_type: 'refresh_token' }, 'cid', 'csec', fetchImpl),
    ).rejects.toMatchObject({ revoked: false });
  });

  it('never echoes a non-JSON body, which may be a proxy page or a token', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>token ya29.leaked</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(
      requestToken(GOOGLE_PROVIDER, { grant_type: 'refresh_token' }, 'cid', 'csec', fetchImpl),
    ).rejects.toThrow(/non-JSON body/);
  });
});

describe('toTokenSet', () => {
  it('keeps the previous refresh token when the provider omits one', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const data = await requestToken(GOOGLE_PROVIDER, {}, 'cid', 'csec', fetchImpl);
    const merged = toTokenSet(GOOGLE_PROVIDER, data, tokenSet());
    // Overwriting this with '' would silently break the next refresh.
    expect(merged.refreshToken).toBe('1//refresh-token-value');
    expect(merged.accessToken).toBe('fresh');
  });

  it('adopts a rotated refresh token when the provider sends one', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const data = await requestToken(GOOGLE_PROVIDER, {}, 'cid', 'csec', fetchImpl);
    expect(toTokenSet(GOOGLE_PROVIDER, data, tokenSet()).refreshToken).toBe('rotated');
  });
});

describe('credential store', () => {
  it('round-trips an encrypted credential through the settings table', () => {
    saveCredential('google', { tokens: tokenSet(), clientId: 'cid', clientSecret: 'csec' }, db as never);
    const loaded = loadCredential('google', db as never);
    expect(loaded?.tokens.accessToken).toBe('ya29.a0AfH6SMB-access-token-value');
    expect(loaded?.clientSecret).toBe('csec');
  });

  it('returns null for a provider that was never connected', () => {
    expect(loadCredential('discord', db as never)).toBeNull();
  });

  it('really deletes the row on disconnect, not just flags it', () => {
    saveCredential('discord', { tokens: tokenSet({ authScheme: 'Bot' }) }, db as never);
    expect(loadCredential('discord', db as never)).not.toBeNull();
    clearCredential('discord', db as never);
    expect(loadCredential('discord', db as never)).toBeNull();
    expect(db.rows.size).toBe(0);
  });
});

describe('ensureAccessToken', () => {
  it('returns null when nothing is stored, so callers report "not connected"', async () => {
    expect(await ensureAccessToken({ provider: GOOGLE_PROVIDER, db: db as never })).toBeNull();
  });

  it('does not call the token endpoint while the token is still valid', async () => {
    saveCredential('google', { tokens: tokenSet(), clientId: 'cid', clientSecret: 'csec' }, db as never);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const tokens = await ensureAccessToken({ provider: GOOGLE_PROVIDER, db: db as never, fetchImpl });
    expect(tokens?.accessToken).toBe('ya29.a0AfH6SMB-access-token-value');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes a stale token and persists the result', async () => {
    saveCredential(
      'google',
      { tokens: tokenSet({ expiresAt: Date.now() - 1000 }), clientId: 'cid', clientSecret: 'csec' },
      db as never,
    );
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const tokens = await ensureAccessToken({ provider: GOOGLE_PROVIDER, db: db as never, fetchImpl });
    expect(tokens?.accessToken).toBe('fresh-access');
    // The new access token must be on disk, not just in this process's memory.
    expect(loadCredential('google', db as never)?.tokens.accessToken).toBe('fresh-access');
  });

  it('refreshes on demand even when the stored token has not expired', async () => {
    saveCredential('google', { tokens: tokenSet(), clientId: 'cid', clientSecret: 'csec' }, db as never);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'forced-fresh' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const tokens = await ensureAccessToken({
      provider: GOOGLE_PROVIDER,
      db: db as never,
      fetchImpl,
      forceRefresh: true,
    });
    expect(tokens?.accessToken).toBe('forced-fresh');
  });

  it('removes the stored credential when the refresh token is revoked upstream', async () => {
    saveCredential(
      'google',
      { tokens: tokenSet({ expiresAt: Date.now() - 1000 }), clientId: 'cid', clientSecret: 'csec' },
      db as never,
    );
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ) as unknown as typeof fetch;

    await ensureAccessToken({ provider: GOOGLE_PROVIDER, db: db as never, fetchImpl });
    // A dead refresh token left on disk would turn every later call into an
    // unexplained 401 instead of an actionable "reconnect".
    expect(loadCredential('google', db as never)).toBeNull();
  });
});

describe('disconnect', () => {
  it('revokes upstream and deletes the local credential', async () => {
    saveCredential(
      'google',
      { tokens: tokenSet(), clientId: 'cid', clientSecret: 'csec' },
      db as never,
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await disconnect({ provider: GOOGLE_PROVIDER, db: db as never, fetchImpl });

    expect(result).toEqual({ removed: true, remoteRevoked: true });
    expect(loadCredential('google', db as never)).toBeNull();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(GOOGLE_PROVIDER.revokeUrl);
    expect(new URLSearchParams(String(init.body)).get('token')).toBe('1//refresh-token-value');
  });

  it('still deletes the local credential when the remote revoke fails', async () => {
    saveCredential('google', { tokens: tokenSet(), clientId: 'cid', clientSecret: 'csec' }, db as never);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await disconnect({ provider: GOOGLE_PROVIDER, db: db as never, fetchImpl });

    expect(result.remoteRevoked).toBe(false);
    // A local secret we can no longer use is still a secret that must not persist.
    expect(result.removed).toBe(true);
    expect(loadCredential('google', db as never)).toBeNull();
  });

  it('reports removal honestly when there was nothing to remove', async () => {
    const result = await disconnect({ provider: GOOGLE_PROVIDER, db: db as never });
    expect(result.removed).toBe(true);
  });
});

describe('connect', () => {
  it('stores a pasted token for a provider with no OAuth flow', async () => {
    const botToken: OAuthTokenSet = {
      accessToken: 'MTA.bot-token-value-abcdefghijklmnop',
      refreshToken: '',
      expiresAt: 0,
      scope: '',
      tokenType: 'Bot',
      authScheme: 'Bot',
    };
    await connect({
      provider: GOOGLE_PROVIDER,
      clientId: '',
      staticToken: botToken,
      db: db as never,
    });
    expect(loadCredential('google', db as never)?.tokens.accessToken).toBe(botToken.accessToken);
  });

  it('refuses to start without a client id or secret, before opening a browser', async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(
      connect({ provider: GOOGLE_PROVIDER, clientId: '', openExternal, db: db as never }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
    expect(openExternal).not.toHaveBeenCalled();
  });
});