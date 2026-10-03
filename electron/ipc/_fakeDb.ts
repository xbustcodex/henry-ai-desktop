/**
 * A minimal in-memory stand-in for a better-sqlite3 handle.
 *
 * The real addon is compiled against Electron's ABI and cannot be loaded by a
 * plain-Node vitest run ("invalid ELF header"), so every existing main-process
 * test in this repo fakes the handle instead. This module does the same for the
 * security/privacy store, whose SQL is small and fixed: it only needs
 * `settings` key/value rows, so it implements exactly that surface and nothing
 * more — a fake that pretended to be a full SQL engine would be a test that
 * proves nothing.
 *
 * Only the statements the policy store actually issues are recognised. An
 * unrecognised statement throws rather than silently succeeding, so a future
 * change to the store's SQL fails loudly here instead of passing a vacuous
 * test.
 */
import type Database from 'better-sqlite3';

/**
 * Mirrors a better-sqlite3 PREPARED statement: the SQL is bound when the
 * statement is made, so the methods take only the bound parameters. That is
 * what lets the fake tell one statement shape from another.
 */
export interface FakeStatement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  exec: (sql: string) => unknown;
}

/**
 * What the fake holds. `rows` is a view of the `settings` table so a test can
 * assert that a specific key was written; `tables` exposes both tables for the
 * log tests; `closed` records whether the handle was closed, which is how the
 * graceful-quit test proves the database was flushed.
 */
export interface FakeDb {
  rows: Record<string, string>;
  tables: FakeDbTables;
  closed: boolean;
  pragmas: Record<string, unknown>;
}

/** The `settings` rows plus, when the app log is attached, its `app_logs` rows. */
export interface FakeDbTables {
  settings: Record<string, string>;
  app_logs: Array<Record<string, unknown>>;
}

export interface FakeDbHandle extends FakeDb {
  /** better-sqlite3 compiles statements; this fake returns a bound statement. */
  prepare: (sql: string) => FakeStatement;
  exec: (sql: string) => unknown;
  close: () => void;
  pragma: (name: string) => unknown[];
}

/**
 * Recognise the statement shapes the policy and app-log code actually issue.
 *
 * An unrecognised statement THROWS rather than returning an empty result: a
 * fake that quietly succeeded would make every assertion after it vacuous,
 * which is worse than no fake at all.
 */
export function createFakeDb(): FakeDbHandle {
  const tables: FakeDbTables = { settings: {}, app_logs: [] };
  const rows = tables.settings;
  const pragmas: Record<string, unknown> = {};
  const closed = { value: false };
  let logId = 0;

  const statement = (sql: string): FakeStatement => ({
    run(...params: unknown[]) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      const ignoreInsert = /^INSERT OR IGNORE INTO settings/i.test(text);
      if (/^INSERT (?:OR \w+ )?INTO settings/i.test(text)) {
        // The key may be a bound parameter OR a literal in the SQL
        // (`VALUES ('log_retention_days', ?, ...)`). Both forms occur.
        const literal = /VALUES \(\s*'([^']+)'/i.exec(text);
        const key = literal ? literal[1] : String(params[0]);
        const value = literal ? String(params[0]) : String(params[1]);
        const existed = key in rows;
        // `OR IGNORE` must leave an existing row alone. Getting this wrong
        // would make initSecurityPolicy() silently reset every switch on each
        // boot, which is exactly what the reload test exists to catch.
        if (existed && ignoreInsert) return { changes: 0 };
        rows[key] = value;
        return { changes: 1 };
      }
      if (/^DELETE FROM settings/i.test(text)) {
        // `WHERE key IN (?, ?)` binds the keys as parameters; only fall back to
        // literal parsing for the inline form the tests never use.
        const usesPlaceholders = /key IN \(\s*\?/i.test(text);
        const keys = usesPlaceholders
          ? params.map(String)
          : (/key IN \((.*?)\)/i.exec(text)?.[1] ?? '')
              .split(',')
              .map((s) => s.trim().replace(/^'|'$/g, ''));
        const list = usesPlaceholders ? keys : Object.keys(rows);
        let n = 0;
        for (const k of list) {
          if (k in rows) {
            delete rows[k];
            n++;
          }
        }
        return { changes: n };
      }
      if (/^INSERT INTO app_logs/i.test(text)) {
        const [ts, level, scope, message] = params;
        tables.app_logs.push({ id: ++logId, ts, level, scope, message });
        return { changes: 1 };
      }
      if (/^DELETE FROM app_logs/i.test(text)) {
        const before = tables.app_logs.length;
        const ts = /^DELETE FROM app_logs WHERE ts < \?/i.test(text) ? String(params[0]) : null;
        const idCut = /NOT IN \(\s*SELECT id/i.test(text) ? Number(params[0]) : null;
        // No predicate at all means "delete everything" — the Clear action.
        const wipeAll = ts === null && idCut === null;
        tables.app_logs = tables.app_logs.filter((r) => {
          if (wipeAll) return false;
          if (ts !== null && String(r.ts) < ts) return false;
          if (idCut !== null && Number(r.id) <= idCut) return false;
          return true;
        });
        return { changes: before - tables.app_logs.length };
      }
      throw new Error(`fakeDb: unrecognised statement: ${text}`);
    },
    get(...params: unknown[]) {
      if (/FROM settings WHERE key\s*=\s*\?/i.test(sql)) {
        const v = rows[String(params[0])];
        return v === undefined ? undefined : { value: v };
      }
      if (/FROM app_logs/i.test(sql)) {
        if (/COUNT\(\*\)/i.test(sql)) return { n: tables.app_logs.length };
        if (/MIN\(ts\)/i.test(sql)) {
          const ts = tables.app_logs.map((r) => String(r.ts));
          return { oldest: ts.length ? ts.reduce((a, b) => (a < b ? a : b)) : null, newest: ts.length ? ts.reduce((a, b) => (a > b ? a : b)) : null };
        }
        const level = /WHERE level = \?/i.test(sql) ? String(params[0]) : null;
        const limit = Number(params[params.length - 1]);
        const picked = tables.app_logs.filter((r) => level === null || r.level === level).slice(0, limit);
        return picked.length ? picked[picked.length - 1] : undefined;
      }
      throw new Error(`fakeDb: unrecognised query: ${sql}`);
    },
    all(...params: unknown[]) {
      if (/FROM app_logs/i.test(sql) && /GROUP BY/i.test(sql)) {
        const counts = new Map<string, number>();
        for (const r of tables.app_logs) {
          counts.set(String(r.level), (counts.get(String(r.level)) ?? 0) + 1);
        }
        return [...counts.entries()].map(([level, n]) => ({ level, n }));
      }
      if (/FROM app_logs/i.test(sql)) {
        const level = /WHERE level = \?/i.test(sql) ? String(params[0]) : null;
        const search = /message LIKE \?/i.test(sql) ? String(params[0]).replace(/^%|%$/g, '') : null;
        const since = /ts >= \?/i.test(sql) ? String(params[0]) : null;
        const limit = Number(params[params.length - 1]);
        return tables.app_logs
          .filter((r) => level === null || r.level === level)
          .filter((r) => search === null || String(r.message).includes(search))
          .filter((r) => since === null || String(r.ts) >= since)
          .slice(0, limit)
          .reverse();
      }
      if (/FROM settings/i.test(sql) && /LIKE/i.test(sql)) {
        const pattern = String(params[0] ?? '%');
        const re = new RegExp(
          '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$',
        );
        return Object.entries(rows)
          .filter(([k]) => re.test(k))
          .map(([key, value]) => ({ key, value }));
      }
      if (/FROM settings/i.test(sql)) {
        return Object.entries(rows).map(([key, value]) => ({ key, value }));
      }
      throw new Error(`fakeDb: unrecognised query: ${sql}`);
    },
    exec(inner: string) {
      void inner;
      return undefined;
    },
  });

  const fake: FakeDbHandle = {
    rows,
    tables,
    pragmas,
    get closed() {
      return closed.value;
    },
    set closed(v: boolean) {
      closed.value = v;
    },
    prepare: statement,
    exec: (sql: string) => {
      if (/wal_checkpoint/i.test(sql)) pragmas.checkpoint = true;
      return undefined;
    },
    close: () => {
      closed.value = true;
    },
    pragma: (name: string) => {
      pragmas[name] = true;
      return [];
    },
  };
  return fake;
}

/**
 * Present the fake as a `Database.Database` so it can be handed to the real
 * store functions, which only use the methods above.
 */
export function asDatabase(fake: FakeDb): Database.Database {
  return fake as unknown as Database.Database;
}