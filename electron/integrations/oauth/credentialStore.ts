/**
 * Persistent, encrypted OAuth credential storage.
 *
 * The pre-existing `electron/ipc/googleAuth.ts` held its token set in two
 * module-level variables. Two consequences, both real:
 *   1. Credentials died with the process, so "connect" had to be redone on
 *      every launch — and any agent tool running in a later process could
 *      never see them, which is exactly why row 10.1 was PARTIAL.
 *   2. There was no second module that *could* read them, so building an agent
 *      tool on top would have required editing that file's internals.
 *
 * This store fixes both: one row per provider in the existing `settings` table,
 * encrypted with the same `safeStorage` helper every provider API key already
 * uses (`_keyStorage.ts`). No new keychain, no second store, no plaintext.
 *
 * The DB handle is always explicit. Every caller already has one — agent tools
 * receive it in their `AgentContext`, and the IPC handlers are handed a getter
 * at registration — and a store that quietly reached for a global would hide a
 * wiring bug until a token silently failed to persist.
 */

import type Database from 'better-sqlite3';
import { encryptKey, decryptKey } from '../../ipc/_keyStorage';
import { registerSecret } from '../../ipc/appLog';
import type { OAuthTokenSet } from './types';

/** Settings-table key for a provider's stored credential. */
export function credentialKey(providerId: string): string {
  return `oauth:${providerId}`;
}

export interface StoredCredential {
  tokens: OAuthTokenSet;
  /** The app's own OAuth client id. Not secret; kept with the credential so a
   *  refresh does not depend on the renderer passing it back in. */
  clientId?: string;
  /** Encrypted inside the same blob as the tokens — never leaves the main process. */
  clientSecret?: string;
  /** Epoch ms the row was written. Stamped by `saveCredential`. */
  updatedAt?: number;
}

function readSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? '';
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

/**
 * Read a provider's stored credential. Returns null for "never connected",
 * "disconnected", and "undecryptable" alike — a blob this machine cannot read
 * is not a credential, and reporting it as one would send the agent into a
 * request that is guaranteed to 401.
 */
export function loadCredential(
  providerId: string,
  db: Database.Database,
): StoredCredential | null {
  let stored: string;
  try {
    stored = readSetting(db, credentialKey(providerId));
  } catch {
    // A locked, migrating, or unwritable database is indistinguishable from
    // "no credential" as far as a caller is concerned — and throwing here would
    // take down a tool turn over something the user can fix by reconnecting.
    return null;
  }
  if (!stored) return null;
  let json: string;
  try {
    json = decryptKey(stored);
  } catch {
    return null;
  }
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<StoredCredential>;
    const tokens = parsed.tokens;
    if (!tokens || typeof tokens.accessToken !== 'string' || !tokens.accessToken) return null;
    return {
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: typeof tokens.refreshToken === 'string' ? tokens.refreshToken : '',
        expiresAt: Number(tokens.expiresAt) || 0,
        scope: typeof tokens.scope === 'string' ? tokens.scope : '',
        tokenType: tokens.tokenType || 'Bearer',
        authScheme: tokens.authScheme || 'Bearer',
        account: tokens.account,
      },
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) a provider's credential, encrypted at rest.
 *
 * The stored values are also registered with the app log's literal-secret set.
 * That is belt and braces, and it is needed: `redactLogs`' pattern rules catch
 * JWTs, Google `ya29.` tokens, and long hex blobs, but a Discord bot token is
 * an opaque string no heuristic can recognise. Registering the exact value is
 * the only thing that guarantees it cannot reach a log line, and the policy
 * flag is honoured by the log layer either way.
 */
export function saveCredential(
  providerId: string,
  credential: StoredCredential,
  db: Database.Database,
): boolean {
  try {
    writeSetting(
      db,
      credentialKey(providerId),
      encryptKey(JSON.stringify({ ...credential, updatedAt: Date.now() })),
    );
    registerSecret(credential.tokens.accessToken);
    registerSecret(credential.tokens.refreshToken);
    registerSecret(credential.clientSecret);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge a refreshed token set into the stored credential. Providers that rotate
 * the refresh token send a new one; providers that don't omit the field, and in
 * that case the existing refresh token must be kept — overwriting it with ''
 * would silently break the next refresh.
 */
export function updateTokens(
  providerId: string,
  tokens: OAuthTokenSet,
  db: Database.Database,
): boolean {
  const existing = loadCredential(providerId, db);
  if (!existing) return false;
  return saveCredential(providerId, { ...existing, tokens }, db);
}

/**
 * Delete a provider's stored credential. This is the only removal path, so
 * "disconnect" and "the refresh token was revoked" both genuinely wipe the row
 * rather than leaving a usable secret behind.
 */
export function clearCredential(providerId: string, db: Database.Database): boolean {
  try {
    db.prepare('DELETE FROM settings WHERE key = ?').run(credentialKey(providerId));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when long-term credentials exist, even if the access token has expired —
 * a refresh token is still a connection.
 */
export function hasCredential(providerId: string, db: Database.Database): boolean {
  return loadCredential(providerId, db) !== null;
}

/**
 * A renderer-safe description of a connection. Contains no token material:
 * the renderer gets this from `integration:status` and must never be able to
 * reconstruct a credential from it.
 */
export function describeCredential(
  providerId: string,
  db: Database.Database,
): {
  connected: boolean;
  hasRefreshToken: boolean;
  expired: boolean;
  expiresAt: number | null;
  scope: string | null;
  updatedAt: number | null;
} {
  const cred = loadCredential(providerId, db);
  if (!cred) {
    return {
      connected: false,
      hasRefreshToken: false,
      expired: false,
      expiresAt: null,
      scope: null,
      updatedAt: null,
    };
  }
  return {
    connected: true,
    hasRefreshToken: Boolean(cred.tokens.refreshToken),
    expired: cred.tokens.expiresAt > 0 && cred.tokens.expiresAt <= Date.now(),
    expiresAt: cred.tokens.expiresAt || null,
    scope: cred.tokens.scope || null,
    updatedAt: cred.updatedAt || null,
  };
}