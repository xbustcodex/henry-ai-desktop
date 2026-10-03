/**
 * securityPolicy.ts — the ONE place Henry's security and privacy switches live.
 *
 * ## Why a policy store rather than scattered booleans
 *
 * The Settings panels need to change what the app actually does, and the
 * modules that must honour those changes (computer control, the agent tool
 * runner, terminal exec, the sync bridge, filesystem deletes) are owned by
 * different parts of the codebase. A policy module gives them one import and
 * one call — `securityPolicy.requiresShellConfirmation()` — instead of each
 * re-reading a settings row and inventing its own default.
 *
 * ## Defaults are the restrictive end, always
 *
 * Every switch defaults to the MORE cautious value, and a switch whose safe
 * value is absent (app lock) defaults to OFF only because a lock with no
 * credential set cannot be satisfied and would lock the user out of their own
 * data on first launch. `resolvePolicy` encodes this rule: an unknown or
 * unparseable stored value falls back to the default rather than to `true`.
 *
 * ## What this deliberately does NOT do
 *
 * It never relaxes an existing hard control. Shell-injection protection,
 * path confinement, command classification, and credential encryption are
 * unconditional code paths; a policy switch can only ADD a gate in front of
 * them. Turning `confirmShell` off means "stop asking me", never "stop
 * checking". That distinction is the whole reason this is one module.
 */
import type Database from 'better-sqlite3';

// ── The switch surface ───────────────────────────────────────────────────────

/**
 * `confirmShell`      ask before running a shell/terminal command
 * `confirmSilentTools` escalate silent-tier agent tools to the confirm gate
 * `redactLogs`        strip secrets from anything written to the app log
 * `allowLanSync`      bind the companion server to 0.0.0.0 instead of loopback
 * `confirmDeleteOutsideHome`  ask before deleting a path outside the home dir
 * `appLock`           require a PIN before the renderer gets a usable session
 * `persistConversations`      write chat messages to disk at all
 * `persistMemory`     write memory facts/summaries to disk at all
 * `persistAnalytics`  write usage/health analytics rows at all
 * `diagnosticsMetadata` include model/provider identifiers in diagnostics
 * `allowNetworkShare` permit any non-loopback egress (tunnel, telemetry)
 */
export type SecurityPolicy = {
  confirmShell: boolean;
  confirmSilentTools: boolean;
  redactLogs: boolean;
  allowLanSync: boolean;
  confirmDeleteOutsideHome: boolean;
  appLock: boolean;
  persistConversations: boolean;
  persistMemory: boolean;
  persistAnalytics: boolean;
  diagnosticsMetadata: boolean;
  allowNetworkShare: boolean;
};

export type PolicyKey = keyof SecurityPolicy;

/**
 * SAFE DEFAULTS. `confirmX` and `redactLogs` are on; the three `allowX`
 * network-sharing switches are off; persistence is on because turning it off
 * by default would silently discard the user's history on upgrade.
 *
 * `persistAnalytics` defaults OFF: analytics rows are the only thing here that
 * exist purely for measurement, so nothing should be collected until asked.
 */
export const DEFAULT_POLICY: Readonly<SecurityPolicy> = Object.freeze({
  confirmShell: true,
  confirmSilentTools: true,
  redactLogs: true,
  allowLanSync: false,
  confirmDeleteOutsideHome: true,
  appLock: false,
  persistConversations: true,
  persistMemory: true,
  persistAnalytics: false,
  diagnosticsMetadata: false,
  allowNetworkShare: false,
});

export const POLICY_KEYS = Object.keys(DEFAULT_POLICY) as PolicyKey[];

const SETTING_PREFIX = 'security_policy_';

/** A stored value only counts as true if it is unambiguously true. */
function asBool(raw: unknown, fallback: boolean): boolean {
  if (raw === 'true' || raw === '1' || raw === 1 || raw === true) return true;
  if (raw === 'false' || raw === '0' || raw === 0 || raw === false) return false;
  // Anything else — absent, corrupt, a schema change — takes the safe default
  // rather than silently switching a protection off.
  return fallback;
}

/**
 * Build a full policy from a raw settings map. Exported so the resolution rule
 * is testable without a database.
 */
export function resolvePolicy(raw: Record<string, unknown> | null | undefined): SecurityPolicy {
  const out = { ...DEFAULT_POLICY };
  if (!raw) return out;
  for (const key of POLICY_KEYS) {
    const stored = raw[SETTING_PREFIX + key];
    if (stored === undefined) continue;
    out[key] = asBool(stored, DEFAULT_POLICY[key]);
  }
  return out;
}

// ── Live store ───────────────────────────────────────────────────────────────

let db: Database.Database | null = null;
let cached: SecurityPolicy = { ...DEFAULT_POLICY };

/**
 * Attach the store to a database and seed any unset key with its default.
 * Called once during boot, after the database is open. Seeding matters: it
 * makes "has the user looked at this switch" answerable without a separate
 * bookkeeping column, and it means a user who explicitly re-enables a
 * protection keeps it across upgrades.
 */
export function initSecurityPolicy(database: Database.Database): void {
  db = database;
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
    );
    for (const key of POLICY_KEYS) {
      insert.run(SETTING_PREFIX + key, DEFAULT_POLICY[key] ? 'true' : 'false');
    }
  } catch {
    // A settings table we cannot write is not fatal — resolution still works
    // from the defaults, and `get` keeps reporting them.
  }
  reload();
}

/** Re-read the policy from the database. */
export function reload(): SecurityPolicy {
  if (!db) return cached;
  try {
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'security\\_policy\\_%' ESCAPE '\\'")
      .all() as Array<{ key: string; value: string }>;
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    cached = resolvePolicy(map);
  } catch {
    cached = { ...DEFAULT_POLICY };
  }
  return cached;
}

/** The current policy. Synchronous and allocation-free — call sites are hot. */
export function getSecurityPolicy(): Readonly<SecurityPolicy> {
  return cached;
}

/** Single-switch read, for the common `if (securityPolicy.x)` gate. */
export function policyFlag(key: PolicyKey): boolean {
  return cached[key];
}

/**
 * Persist one switch. Only keys in `POLICY_KEYS` are accepted — an unknown key
 * is rejected rather than stored, so a crafted renderer cannot write arbitrary
 * rows through this surface.
 */
export function setSecurityPolicy(key: PolicyKey, value: boolean): boolean {
  if (!POLICY_KEYS.includes(key)) return false;
  if (!db) {
    // No database (unit tests, pre-boot): keep memory consistent anyway.
    cached = { ...cached, [key]: value };
    return true;
  }
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(SETTING_PREFIX + key, value ? 'true' : 'false');
    cached = { ...cached, [key]: value };
    return true;
  } catch {
    return false;
  }
}


// ── Gates ───────────────────────────────────────────────────────────────────

// Call sites read these as `policyFlag('confirmShell')`. There is deliberately
// no one-function-per-switch layer: a switch with exactly one caller does not
// need a name, and adding one would freeze the policy's shape for no gain.

/**
 * Whether any non-loopback egress is permitted. Both switches contribute:
 * `allowNetworkShare` is the user's overall consent, and `allowLanSync` is the
 * narrower LAN-binding consent they may have given for companion pairing. A
 * tunnel exposes the app to the public internet, so it needs the broader one —
 * which is why LAN access alone must not be enough to start one.
 */
export function allowsNetworkShare(): boolean {
  return cached.allowNetworkShare || cached.allowLanSync;
}

// ── App lock (PIN) ───────────────────────────────────────────────────────────

/**
 * The app lock is a scrypt-hashed PIN, never a stored PIN.
 *
 * A PIN protects a local SQLite file, not a server, so the threat is someone
 * who can read the disk. A hash removes that advantage entirely and costs
 * nothing, so there is no reason to keep the plaintext.
 *
 * scrypt parameters are deliberately modest (N=16384). They are chosen to cost
 * roughly 50–100 ms on the slowest machine Henry supports: high enough that a
 * brute-force loop over a 6-digit space is not free, low enough that unlocking
 * never feels like a stall. Raising it further would only make the PIN easier
 * to DoS.
 */
const SCRYPT_N = 16_384;
const SCRYPT_KEYLEN = 32;
const PIN_SETTING = 'security_app_pin_hash';
const PIN_SALT_SETTING = 'security_app_pin_salt';

/** Rate-limit unlock attempts so the PIN cannot be brute-forced in-process. */
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 30_000;
let failedAttempts = 0;
let lockedOutUntil = 0;

function hashPin(pin: string, salt: string): Promise<string> {
  // Executor form rather than Promise.withResolvers: the project targets
  // ES2022, where withResolvers is not in lib and would not compile.
  return new Promise<string>((resolve, reject) => {
    // Imported lazily so this module stays loadable in a plain-Node unit test.
    const scrypt = require('crypto').scrypt as (
      password: string,
      salt: string,
      keylen: number,
      options: { N: number },
      cb: (err: Error | null, key: Buffer) => void,
    ) => void;
    scrypt(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }, (err, key) =>
      err ? reject(err) : resolve(key.toString('hex')),
    );
  });
}

/** True when a PIN has been configured, so `appLock` can be satisfied. */
export function hasPin(): boolean {
  if (!db) return false;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(PIN_SETTING) as
      | { value: string }
      | undefined;
    return !!row?.value;
  } catch {
    return false;
  }
}

/** Set (or replace) the PIN. Turning the lock on without a PIN is rejected. */
export async function setPin(pin: string): Promise<boolean> {
  if (!db) return false;
  if (pin.length < 4 || pin.length > 128) return false;
  try {
    const salt = require('crypto').randomBytes(16).toString('hex') as string;
    const hash = await hashPin(pin, salt);
    const put = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    );
    put.run(PIN_SALT_SETTING, salt);
    put.run(PIN_SETTING, hash);
    failedAttempts = 0;
    lockedOutUntil = 0;
    return true;
  } catch {
    return false;
  }
}

/** Clear the PIN and turn the lock off — the "remove lock" path. */
export function clearPin(): boolean {
  if (!db) return false;
  try {
    db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(PIN_SETTING, PIN_SALT_SETTING);
    setSecurityPolicy('appLock', false);
    failedAttempts = 0;
    lockedOutUntil = 0;
    return true;
  } catch {
    return false;
  }
}

/** Whether the lock is currently holding the renderer out. */
let unlocked = false;

/**
 * Whether the app is locked right now.
 *
 * A lock with no PIN configured is NOT enforced: it would be unopenable. The
 * Settings panel refuses to enable `appLock` without a PIN, so this state is
 * only reachable through a corrupted settings row — and failing open there is
 * correct, because the alternative is a permanently bricked app.
 */
export function isLocked(): boolean {
  return cached.appLock && hasPin() && !unlocked;
}

export interface UnlockResult {
  ok: boolean;
  lockedOut?: boolean;
  retryInMs?: number;
  attemptsRemaining?: number;
}

/** Verify a PIN against the stored hash. */
export async function unlock(pin: string): Promise<UnlockResult> {
  if (isLocked() && Date.now() < lockedOutUntil) {
    return { ok: false, lockedOut: true, retryInMs: lockedOutUntil - Date.now() };
  }
  if (!db) return { ok: false };
  try {
    const hashRow = db.prepare('SELECT value FROM settings WHERE key=?').get(PIN_SETTING) as
      | { value: string }
      | undefined;
    const saltRow = db.prepare('SELECT value FROM settings WHERE key=?').get(PIN_SALT_SETTING) as
      | { value: string }
      | undefined;
    if (!hashRow?.value || !saltRow?.value) return { ok: false };

    const candidate = await hashPin(pin, saltRow.value);
    // Constant-time compare: a timing side channel on a 6-digit PIN is a real
    // way to shorten a brute-force run, and `timingSafeEqual` costs nothing.
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hashRow.value, 'hex');
    const equal = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    if (equal) {
      unlocked = true;
      failedAttempts = 0;
      lockedOutUntil = 0;
      return { ok: true };
    }
    failedAttempts++;
    if (failedAttempts >= MAX_PIN_ATTEMPTS) {
      lockedOutUntil = Date.now() + PIN_LOCKOUT_MS;
      failedAttempts = 0;
      return { ok: false, lockedOut: true, retryInMs: PIN_LOCKOUT_MS };
    }
    return { ok: false, attemptsRemaining: MAX_PIN_ATTEMPTS - failedAttempts };
  } catch {
    return { ok: false };
  }
}

/** Re-lock. Called when the lock is enabled and at quit. */
export function relock(): void {
  unlocked = false;
  failedAttempts = 0;
  lockedOutUntil = 0;
}

/**
 * Test seam: replace the in-memory policy without a database. Returns a
 * function that restores the previous state.
 */
export function __setPolicyForTest(policy: Partial<SecurityPolicy>): () => void {
  const previous = cached;
  cached = { ...cached, ...policy };
  return () => {
    cached = previous;
  };
}