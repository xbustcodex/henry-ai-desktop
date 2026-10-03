/**
 * Credential-at-rest tests.
 *
 * The other integration tests run with safeStorage unavailable (the headless
 * fallback), so they cannot prove encryption. This file mocks safeStorage as
 * *available* and asserts the thing that actually matters: a stored OAuth
 * token is never written to the settings table in plaintext, and a blob this
 * machine cannot decrypt is reported as "not connected" rather than being sent
 * to a provider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ encrypted: true }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => h.encrypted,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import {
  loadCredential,
  saveCredential,
  clearCredential,
  describeCredential,
  hasCredential,
  credentialKey,
} from './credentialStore';
import type { OAuthTokenSet } from './types';

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

const tokens: OAuthTokenSet = {
  accessToken: 'ya29.a0AfB6SMB-super-secret-access-token',
  refreshToken: '1//super-secret-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scope: 'https://www.googleapis.com/auth/gmail.send',
  tokenType: 'Bearer',
  authScheme: 'Bearer',
};

beforeEach(() => {
  db.rows.clear();
  h.encrypted = true;
});

describe('credential at rest', () => {
  it('keys the row per provider so two integrations never collide', () => {
    expect(credentialKey('google')).toBe('oauth:google');
    expect(credentialKey('discord')).toBe('oauth:discord');
  });

  it('never writes the token or the client secret in plaintext', () => {
    saveCredential('google', { tokens, clientId: 'cid', clientSecret: 'GOCSPX-super-secret' }, db as never);
    const row = db.rows.get('oauth:google') ?? '';
    expect(row).not.toContain('ya29.a0AfB6SMB-super-secret-access-token');
    expect(row).not.toContain('1//super-secret-refresh-token');
    expect(row).not.toContain('GOCSPX-super-secret');
    // The encryption helper's own wire format is what we expect to see.
    expect(row.startsWith('enc:v1:')).toBe(true);
  });

  it('still decrypts it on read', () => {
    saveCredential('google', { tokens, clientId: 'cid', clientSecret: 'GOCSPX-super-secret' }, db as never);
    const loaded = loadCredential('google', db as never);
    expect(loaded?.tokens.accessToken).toBe('ya29.a0AfB6SMB-super-secret-access-token');
    expect(loaded?.clientSecret).toBe('GOCSPX-super-secret');
    expect(loaded?.updatedAt).toBeGreaterThan(0);
  });

  it('reports an undecryptable blob as no connection rather than returning garbage', () => {
    saveCredential('google', { tokens }, db as never);
    // A different machine, or a rotated OS keychain: the ciphertext is there
    // but this process cannot read it. Sending it to a provider would 401.
    h.encrypted = false;
    expect(hasCredential('google', db as never)).toBe(false);
    expect(describeCredential('google', db as never).connected).toBe(false);
  });

  it('describes a connection without any token material', () => {
    saveCredential('google', { tokens }, db as never);
    const described = describeCredential('google', db as never);
    expect(described).toMatchObject({ connected: true, hasRefreshToken: true, expired: false });
    expect(JSON.stringify(described)).not.toContain('ya29');
    expect(JSON.stringify(described)).not.toContain('refresh-token');
  });

  it('marks an expired token as expired but still counts as connected', () => {
    // A refresh token is still a connection: the agent can recover from it.
    saveCredential('google', { tokens: { ...tokens, expiresAt: Date.now() - 1000 } }, db as never);
    expect(describeCredential('google', db as never)).toMatchObject({
      connected: true,
      expired: true,
      hasRefreshToken: true,
    });
  });

  it('deletes the row on clear, leaving nothing to recover', () => {
    saveCredential('google', { tokens }, db as never);
    expect(clearCredential('google', db as never)).toBe(true);
    expect(db.rows.size).toBe(0);
    expect(loadCredential('google', db as never)).toBeNull();
  });
});