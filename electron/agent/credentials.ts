/**
 * Agent credential store — a main-process-only home for secrets the agent's
 * TOOLS may use but the model must never see.
 *
 * Why this exists: parity row 4.19 claimed provider keys were "encrypted at
 * rest via safeStorage" (true — `electron/ipc/_keyStorage.ts`) but no agent
 * credential surface was ever exercised. Every kit that needed a secret grew
 * its own private read of a raw `settings` row (`github.ts`, `quickbooks.ts`,
 * `slicer.ts`), each re-deriving the decrypt-and-don't-log logic and none of
 * them offering the model anything safe to ask. This module is the ONE such
 * surface so a tool can answer "is this connected?" without a value crossing
 * into a payload.
 *
 * Storage — deliberately boring: the existing `settings` key/value table, one
 * row per scope, value encrypted with `encryptKey` from `_keyStorage.ts`.
 * There is NO second crypto path here and NO new table: a second crypto path
 * is how plaintext ends up on disk, and a new table would fork the backup /
 * migration story `database.ts` already owns.
 *
 * Threat model, and what each function is for:
 *   - `getCredential` returns the secret. MAIN PROCESS ONLY. It is not
 *     reachable from a tool's return payload, from an error string, or from
 *     anything that reaches the renderer. A kit calls it immediately before an
 *     outbound request and lets the value fall out of scope.
 *   - `credentialStatus` / `listCredentialScopes` return booleans and the scope
 *     name ONLY — no value, no prefix, no length. These are the renderer- and
 *     model-safe surfaces, and the only ones any tool should expose.
 *   - Nothing here logs. Error strings name the scope and the reason, never
 *     the secret.
 *
 * Encryption availability: `safeStorage` is unavailable on headless Linux, and
 * `encryptKey` then falls back to writing the value in the clear (its
 * documented behaviour, shared with every provider key in the app). We do not
 * paper over that: a credential written in that mode is reported as
 * `encrypted_at_rest: false` so `credential_status` tells the user their
 * secret is on disk in plaintext instead of implying keychain protection.
 */

import type Database from "better-sqlite3";
import { decryptKey, encryptKey, isEncrypted } from "../ipc/_keyStorage";

/** Settings-table namespace. A colon separates it from the scope. */
export const CREDENTIAL_PREFIX = "agent_cred:";

/** Upper bound on a stored secret — a credential is a token, not a payload. */
export const MAX_SECRET_LENGTH = 16384;

/** Upper bound on a scope name, and on how many scopes we ever report. */
const MAX_SCOPE_LENGTH = 64;
const MAX_SCOPES = 200;

/**
 * A scope is a stable, human-readable label for one secret ("github",
 * "openai", "stripe_test"). Restricted to lowercase alphanumerics plus
 * `_ - .` so it can never collide with the `agent_cred:` namespacing (a colon
 * would let `a:b` address a different namespace) or carry whitespace into a
 * LIKE pattern or a log line.
 */
const SCOPE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Metadata about one credential. Contains no secret material, by construction. */
export interface CredentialStatus {
  /** The scope this describes (never a settings key). */
  scope: string;
  /** A non-empty value is stored for this scope. */
  configured: boolean;
  /** The stored row is in `enc:v1:` form — i.e. protected by the OS keychain. */
  encrypted_at_rest: boolean;
  /**
   * The stored value can actually be decrypted into a usable secret right now.
   * False while `configured` is true means the row is corrupt or was written on
   * a machine whose keychain is gone: the user must re-enter the secret.
   */
  usable: boolean;
}

export type ScopeCheck =
  | { ok: true; scope: string }
  | { ok: false; error: string };

export type SetCredentialResult =
  | { ok: true; scope: string; encrypted_at_rest: boolean }
  | { ok: false; error: string };

/**
 * Validate a scope name. Callers that build a scope from model input must go
 * through this rather than interpolating: an out-of-shape scope is rejected,
 * not sanitised into something that silently addresses a different credential.
 */
export function validateScope(scope: unknown): ScopeCheck {
  if (typeof scope !== "string") {
    return { ok: false, error: "scope must be a string" };
  }
  if (scope.length === 0 || scope.trim() !== scope || scope.trim() === "") {
    return { ok: false, error: "scope must not be empty or whitespace" };
  }
  if (scope.length > MAX_SCOPE_LENGTH) {
    return {
      ok: false,
      error: `scope must be at most ${MAX_SCOPE_LENGTH} characters`,
    };
  }
  if (!SCOPE_RE.test(scope)) {
    return {
      ok: false,
      error:
        "scope may contain only lowercase letters, digits, '_', '-' and '.', " +
        "and must start with a letter or digit",
    };
  }
  return { ok: true, scope };
}

/** The settings key a scope is stored under. Internal — not a safe thing to show. */
function settingKey(scope: string): string {
  return CREDENTIAL_PREFIX + scope;
}

/** Raw stored value for a scope, or null when no row exists. Never logs. */
function readStored(db: Database.Database, scope: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(settingKey(scope)) as { value?: unknown } | undefined;
  const value = row?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Store (or replace) the secret for a scope, encrypted at rest.
 *
 * Returns whether the write landed and whether the row ended up encrypted —
 * `encrypted_at_rest: false` is the honest report on a machine where
 * safeStorage is unavailable, and is not treated as an error because provider
 * keys behave the same way.
 *
 * The secret is never echoed, logged, or included in an error string.
 */
export function setCredential(
  db: Database.Database,
  scope: unknown,
  secret: unknown,
): SetCredentialResult {
  const check = validateScope(scope);
  if (!check.ok) return { ok: false, error: check.error };
  if (typeof secret !== "string") {
    return { ok: false, error: `credential for "${check.scope}" must be a string` };
  }
  if (secret.trim() === "") {
    return { ok: false, error: `credential for "${check.scope}" must not be empty` };
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return {
      ok: false,
      error: `credential for "${check.scope}" exceeds ${MAX_SECRET_LENGTH} characters`,
    };
  }

  const stored = encryptKey(secret);
  if (!stored) {
    // encryptKey returns '' only for empty input; treat it as a failed write
    // rather than persisting an unusable row that would read as "configured".
    return { ok: false, error: `could not encode credential for "${check.scope}"` };
  }

  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(settingKey(check.scope), stored);

  return {
    ok: true,
    scope: check.scope,
    encrypted_at_rest: isEncrypted(stored),
  };
}

/**
 * Decrypt and return the secret for a scope — MAIN PROCESS USE ONLY.
 *
 * Returns null for: no row, an unreadable scope, a corrupt/undecryptable
 * value, or a value that decrypts to nothing. It never throws and never logs;
 * a corrupt row is indistinguishable from "not configured" to the caller,
 * which is the safe direction.
 */
export function getCredential(
  db: Database.Database,
  scope: unknown,
): string | null {
  const check = validateScope(scope);
  if (!check.ok) return null;
  let stored: string | null;
  try {
    stored = readStored(db, check.scope);
  } catch {
    return null;
  }
  if (stored === null) return null;
  try {
    // decryptKey passes legacy plaintext rows through unchanged and swallows
    // decrypt failures by returning '' — both handled as "no usable secret".
    const secret = decryptKey(stored);
    return secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}

/**
 * Remove the credential row for a scope. Returns true when a row was deleted,
 * false when there was nothing to delete or the write failed. A failed delete
 * is NOT silently reported as success, so "forget my token" can never claim to
 * have wiped a row that is still on disk.
 */
export function deleteCredential(db: Database.Database, scope: unknown): boolean {
  const check = validateScope(scope);
  if (!check.ok) return false;
  try {
    const res = db
      .prepare("DELETE FROM settings WHERE key = ?")
      .run(settingKey(check.scope));
    return Number(res?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Renderer/model-safe description of one credential: booleans and the scope
 * name, nothing else. An unknown scope is a normal state (`configured: false`),
 * not an error.
 */
export function credentialStatus(
  db: Database.Database,
  scope: unknown,
): CredentialStatus {
  const check = validateScope(scope);
  if (!check.ok) {
    // Report on the caller's scope as given (never a settings key) so a bad
    // scope is visibly not configured instead of throwing.
    return {
      scope: typeof scope === "string" ? scope : "",
      configured: false,
      encrypted_at_rest: false,
      usable: false,
    };
  }
  let stored: string | null;
  try {
    stored = readStored(db, check.scope);
  } catch {
    stored = null;
  }
  if (stored === null) {
    return {
      scope: check.scope,
      configured: false,
      encrypted_at_rest: false,
      usable: false,
    };
  }
  const encrypted = isEncrypted(stored);
  const usable = (() => {
    try {
      return decryptKey(stored).length > 0;
    } catch {
      return false;
    }
  })();
  return {
    scope: check.scope,
    configured: true,
    encrypted_at_rest: encrypted,
    usable,
  };
}

/**
 * Every scope that has a credential row, in name order and bounded. The
 * underlying value is never read, so this cannot leak a secret even if one is
 * stored in the clear.
 *
 * Unlike the single-scope readers this propagates a DB failure instead of
 * degrading to an empty list: "nothing is configured" and "the database is
 * unreachable" lead the user to opposite actions, so a caller (a tool) has to
 * be able to tell them apart and say so.
 */
export function listCredentialScopes(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?",
    )
    .all(`${CREDENTIAL_PREFIX}%`, MAX_SCOPES) as Array<{ key?: unknown }>;
  const scopes: string[] = [];
  for (const row of rows) {
    if (typeof row.key !== "string") continue;
    const scope = row.key.slice(CREDENTIAL_PREFIX.length);
    // Defence in depth: only report names that pass the same rule setCredential
    // enforces, so a hand-edited row can never smuggle another namespace in.
    if (!validateScope(scope).ok) continue;
    scopes.push(scope);
  }
  return scopes;
}
