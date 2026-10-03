/**
 * appLog.ts — general application log capture, redacted at the write boundary.
 *
 * ## The problem this solves
 *
 * Henry's main process logs through `lib/log.ts` to stdout, which on a packaged
 * app lands in a console nobody can open. The only log surface the user could
 * reach was health-scoped (`health:logSave` and friends) — deliberate entries
 * about weight and water, written by a panel, not a record of what the app did.
 * There was no way to answer "what happened at 3pm" from inside the app.
 *
 * ## Redaction happens on the way IN, not on the way out
 *
 * This is the load-bearing decision. A viewer that filters secrets at read time
 * is one `SELECT` away from leaking them: the export path, a future endpoint,
 * a screenshot of the debug console. Redacting when the line is captured means
 * the secret never reaches storage, so every reader — including this one — only
 * ever sees the redacted form.
 *
 * ## What is redacted
 *
 * Anything that looks like a credential: provider keys (sk-, ghp_, xai-, AIza…),
 * bearer tokens, `enc:v1:` ciphertext from `_keyStorage`, long high-entropy
 * strings, and — most importantly — the value of ANY provider key currently in
 * the database, matched literally. The pattern rules catch keys Henry has never
 * seen; the literal set catches a key in an unusual format.
 */
import type Database from 'better-sqlite3';
import { policyFlag } from './securityPolicy';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
}

export interface LogQuery {
  level?: LogLevel | 'all';
  scope?: string;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** Cap what one line can occupy. A runaway loop must not fill the disk. */
const MAX_MESSAGE_CHARS = 4000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

/**
 * Values registered here are redacted verbatim wherever they appear. The main
 * process registers every provider key on boot, so a key that slips past the
 * pattern rules — an unusual prefix, a custom provider — is still caught.
 */
const literalSecrets = new Set<string>();

/**
 * Register a value that must never appear in the log. Short values are
 * ignored: redacting a 3-character string would turn ordinary words into
 * `***` and make the log useless.
 */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < 8) return;
  literalSecrets.add(v);
}

/**
 * Drop every registered secret. Exposed so a "clear my data" action can also
 * forget the in-memory copies, and so tests do not leak state between cases.
 */
export function clearRegisteredSecrets(): void {
  literalSecrets.clear();
}

/**
 * A pattern for credentials that were never explicitly registered, plus which
 * capture group holds the secret.
 *
 * Naming the group explicitly matters: the alternative — "assume the last
 * group is the secret" — silently redacts the wrong span as soon as a pattern
 * needs a trailing group, and that failure looks like a working redaction.
 * `secretGroup: -1` means the whole match is the secret.
 *
 * The generic high-entropy rule is deliberately conservative (40+ chars of
 * base62/hex) because a shorter rule turns ordinary log prose into redaction.
 */
interface SecretPattern {
  re: RegExp;
  /** Index of the capture group to replace; -1 replaces the entire match. */
  secretGroup: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // safeStorage ciphertext from _keyStorage — always secret, any length.
  { re: /enc:v1:[A-Za-z0-9+/=]{8,}/g, secretGroup: -1 },
  // Authorization headers in any casing, including inside a logged request.
  { re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, secretGroup: -1 },
  // `apiKey: <value>`, `"api_key":"<value>"`, `OPENCODE_API_KEY=<value>`, …
  // Group 2 is the value; groups 0 and 1 keep the field name for context.
  {
    re: /\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|pwd|authorization|auth[-_]?token|session[-_]?token|pin)\b(\s*[:=]\s*|"\s*:\s*")([^\s"',;)}\]]{6,})/gi,
    secretGroup: 2,
  },
  // Credentials embedded in a connection URL: scheme://user:password@host.
  // The scheme and host are the diagnostic value, so only the password goes.
  { re: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, secretGroup: 1 },
  // Well-known provider key shapes, standalone.
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, secretGroup: -1 },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, secretGroup: -1 },
  { re: /\bxai-[A-Za-z0-9]{20,}/g, secretGroup: -1 },
  { re: /\bAIza[A-Za-z0-9_-]{30,}/g, secretGroup: -1 },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, secretGroup: -1 },
  // JWTs.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, secretGroup: -1 },
  // Long opaque blobs — base64/hex tokens with no word characters.
  { re: /\b[A-Fa-f0-9]{40,}\b/g, secretGroup: -1 },
];

export const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Strip credentials from one string.
 *
 * Literal secrets are replaced first: they are known-good, whereas the pattern
 * rules are heuristics and a false positive there is merely unhelpful output
 * while a false negative is a leaked key.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const secret of literalSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTION_PLACEHOLDER);
  }
  for (const { re, secretGroup } of SECRET_PATTERNS) {
    // `lastIndex` on a /g regex survives reuse; reset so repeated calls are
    // deterministic rather than skipping matches.
    re.lastIndex = 0;
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      if (secretGroup < 0) return REDACTION_PLACEHOLDER;
      const secret = groups[secretGroup];
      if (typeof secret !== 'string' || !secret) return REDACTION_PLACEHOLDER;
      // Splice rather than reconstruct: keeping the surrounding text byte for
      // byte means the field name and separators survive intact.
      const at = match.indexOf(secret);
      if (at < 0) return REDACTION_PLACEHOLDER;
      return match.slice(0, at) + REDACTION_PLACEHOLDER + match.slice(at + secret.length);
    });
  }
  return out;
}

/** Redact then truncate, so a limit can never cut a secret in half. */
function prepare(message: string, enabled: boolean): string {
  const safe = enabled ? redactSecrets(message) : message;
  return safe.length > MAX_MESSAGE_CHARS ? safe.slice(0, MAX_MESSAGE_CHARS) + '…' : safe;
}

// ── Store ────────────────────────────────────────────────────────────────────

let db: Database.Database | null = null;
let tableReady = false;

/** Rows are capped so the log cannot grow without bound inside one session. */
const MAX_ROWS = 20_000;

/**
 * The retention floor. A user may raise this; they may not set it below one
 * day, because "keep nothing" is indistinguishable from "broken" when you are
 * trying to diagnose why.
 */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 14;

let retentionDays = DEFAULT_RETENTION_DAYS;

/**
 * Attach the log to a database, creating its table on first use.
 *
 * The CREATE is idempotent and runs once per process. It is deliberately here
 * rather than in `database.ts` so the log is self-contained: deleting this
 * feature cannot leave a schema migration behind.
 */
export function initAppLog(database: Database.Database): void {
  db = database;
  tableReady = false;
  ensureTable();
  loadRetention();
  applyRetention();
}

function ensureTable(): boolean {
  if (!db || tableReady) return tableReady;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT NOT NULL DEFAULT (datetime('now')),
        level   TEXT NOT NULL,
        scope   TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(ts);
    `);
    tableReady = true;
  } catch {
    // No table means no log. The app must still run, so this is swallowed and
    // `capture` becomes a no-op.
    tableReady = false;
  }
  return tableReady;
}

/** Record one line. Never throws — logging must not be able to break a caller. */
export function capture(level: LogLevel, scope: string, message: string): void {
  if (!ensureTable() || !db) return;
  const row: LogEntry = {
    id: 0,
    ts: new Date().toISOString(),
    level,
    scope: String(scope || '').slice(0, 120),
    message: prepare(String(message), policyFlag('redactLogs')),
  };
  try {
    db.prepare('INSERT INTO app_logs (ts, level, scope, message) VALUES (?, ?, ?, ?)').run(
      row.ts,
      row.level,
      row.scope,
      row.message,
    );
  } catch {
    /* a failed log write must never propagate into the operation being logged */
  }
}

/**
 * Trim to `MAX_ROWS`, oldest first.
 *
 * Deleting by rowid rather than by timestamp means a clock change cannot make
 * retention delete the newest rows instead of the oldest.
 */
function trimRowCount(): void {
  if (!db) return;
  try {
    db.prepare(
      `DELETE FROM app_logs WHERE id NOT IN (
         SELECT id FROM app_logs ORDER BY id DESC LIMIT ?
       )`,
    ).run(MAX_ROWS);
  } catch {
    /* best effort */
  }
}

function loadRetention(): void {
  if (!db) return;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='log_retention_days'").get() as
      | { value: string }
      | undefined;
    const n = Number(row?.value);
    if (Number.isFinite(n) && n >= MIN_RETENTION_DAYS && n <= MAX_RETENTION_DAYS) {
      retentionDays = Math.floor(n);
    }
  } catch {
    /* keep the default */
  }
}

/** Delete rows older than the retention window. */
export function applyRetention(): number {
  if (!ensureTable() || !db) return 0;
  let removed = 0;
  try {
    const info = db
      .prepare("DELETE FROM app_logs WHERE ts < datetime('now', ?)")
      .run(`-${retentionDays} days`);
    removed = info.changes;
  } catch {
    return 0;
  }
  trimRowCount();
  return removed;
}

export function getRetentionDays(): number {
  return retentionDays;
}

/**
 * Set retention. Values outside the allowed range are clamped rather than
 * rejected so the Settings UI can offer a slider without range-checking twice.
 */
export function setRetentionDays(days: number): number {
  const n = Number.isFinite(days) ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
  retentionDays = Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, n));
  if (db) {
    try {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('log_retention_days', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).run(String(retentionDays));
    } catch {
      /* keep the in-memory value; it still applies this session */
    }
  }
  applyRetention();
  return retentionDays;
}

/** Filtered, newest-first listing. Every filter is optional and bounded. */
export function queryLogs(q: LogQuery = {}): LogEntry[] {
  if (!ensureTable() || !db) return [];
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.level && q.level !== 'all') {
    where.push('level = ?');
    params.push(q.level);
  }
  if (q.scope) {
    where.push('scope LIKE ?');
    params.push(`%${String(q.scope).slice(0, 120)}%`);
  }
  if (q.search) {
    where.push('(message LIKE ? OR scope LIKE ?)');
    const like = `%${String(q.search).slice(0, 200)}%`;
    params.push(like, like);
  }
  if (q.since) {
    where.push('ts >= ?');
    params.push(String(q.since));
  }
  if (q.until) {
    where.push('ts <= ?');
    params.push(String(q.until));
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(Number(q.limit)) ? Number(q.limit) : DEFAULT_LIMIT),
  );
  const sql =
    `SELECT id, ts, level, scope, message FROM app_logs` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY id DESC LIMIT ?`;
  try {
    return db.prepare(sql).all(...params, limit) as LogEntry[];
  } catch {
    return [];
  }
}

/** Per-level counts plus the oldest/newest timestamps — for the viewer's header. */
export function logStats(): {
  total: number;
  byLevel: Record<string, number>;
  oldest: string | null;
  newest: string | null;
  retentionDays: number;
} {
  const empty = { total: 0, byLevel: {} as Record<string, number>, oldest: null, newest: null, retentionDays };
  if (!ensureTable() || !db) return empty;
  try {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM app_logs').get() as { n: number }).n;
    const rows = db
      .prepare('SELECT level, COUNT(*) AS n FROM app_logs GROUP BY level')
      .all() as Array<{ level: string; n: number }>;
    const span = db.prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM app_logs').get() as
      | { oldest: string | null; newest: string | null }
      | undefined;
    const byLevel: Record<string, number> = {};
    for (const r of rows) byLevel[r.level] = r.n;
    return {
      total,
      byLevel,
      oldest: span?.oldest ?? null,
      newest: span?.newest ?? null,
      retentionDays,
    };
  } catch {
    return empty;
  }
}

/**
 * Delete rows, either everything or everything before a cutoff.
 *
 * Returns the number removed so the UI can report what actually happened
 * instead of assuming success.
 */
export function clearLogs(before?: string): number {
  if (!ensureTable() || !db) return 0;
  try {
    const info = before
      ? db.prepare('DELETE FROM app_logs WHERE ts < ?').run(String(before))
      : db.prepare('DELETE FROM app_logs').run();
    return info.changes;
  } catch {
    return 0;
  }
}

/**
 * Render the filtered log as plain text for the export action.
 *
 * Goes through `redactSecrets` again even though capture already redacted. The
 * cost is trivial next to the guarantee: this is the one path that hands a user
 * a copy of their data to send to someone else, so it re-checks rather than
 * trusting that every writer went through the same function. The flag is
 * honoured, matching the capture-layer setting.
 */
export function exportLogs(q: LogQuery = {}): string {
  const rows = queryLogs({ ...q, limit: MAX_LIMIT });
  const redact = policyFlag('redactLogs');
  return rows
    .map((r) => {
      const line = `${r.ts} [${r.level.toUpperCase()}] ${r.scope ? r.scope + ': ' : ''}${r.message}`;
      return redact ? redactSecrets(line) : line;
    })
    .join('\n');
}

/** Test seam: forget the table cache so the next call re-runs the CREATE. */
export function __resetAppLogForTest(): void {
  tableReady = false;
}