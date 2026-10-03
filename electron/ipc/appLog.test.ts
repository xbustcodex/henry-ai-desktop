/**
 * Redaction is the whole point of the log viewer, so these tests are mostly
 * about what must NOT survive into storage.
 *
 * The property being defended is stronger than "we scrub some patterns": a
 * secret must never reach the database at all. If redaction happened on read, a
 * single missed query, a future export endpoint, or a bug in this file would
 * put plaintext credentials on disk — recoverable by anyone with the file.
 * Capturing redacted is the only ordering where a mistake is survivable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { asDatabase, createFakeDb, type FakeDbHandle } from './_fakeDb';
import {
  initAppLog,
  capture,
  redactSecrets,
  registerSecret,
  clearRegisteredSecrets,
  queryLogs,
  exportLogs,
  clearLogs,
  logStats,
  setRetentionDays,
  getRetentionDays,
  __resetAppLogForTest,
  REDACTION_PLACEHOLDER,
} from './appLog';
import { __setPolicyForTest } from './securityPolicy';

beforeEach(() => {
  clearRegisteredSecrets();
  __resetAppLogForTest();
});

describe('redactSecrets — provider keys by shape', () => {
  it('removes an OpenAI-style key', () => {
    const out = redactSecrets('saving key sk-abcdefghijklmnopqrstuvwxyz012345 now');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it('removes a GitHub token', () => {
    const out = redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('removes a Google API key', () => {
    const out = redactSecrets('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(out).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuv');
  });

  it('removes safeStorage ciphertext, which is a secret at any length', () => {
    const out = redactSecrets('stored enc:v1:AbCdEf0123456789+/==');
    expect(out).not.toContain('enc:v1:');
  });

  it('removes a bearer token', () => {
    const out = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz.123');
  });

  it('removes a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(`token ${jwt}`)).not.toContain(jwt);
  });

  it('keeps the field name so the log stays diagnosable', () => {
    const out = redactSecrets('apiKey: mysecretvalue123');
    expect(out).toContain('apiKey');
    expect(out).not.toContain('mysecretvalue123');
  });

  it('redacts an api_key inside a JSON blob', () => {
    const out = redactSecrets('{"api_key":"sk-live-9988776655443322"}');
    expect(out).not.toContain('sk-live-9988776655443322');
  });

  it('redacts a password in a query string', () => {
    expect(redactSecrets('postgres://u:hunter2000@host/db')).not.toContain('hunter2000');
  });
});

describe('redactSecrets — literal registration catches unusual formats', () => {
  it('redacts a registered value no pattern would match', () => {
    registerSecret('ZZcustom-provider-key-xyz');
    expect(redactSecrets('using ZZcustom-provider-key-xyz now')).not.toContain(
      'ZZcustom-provider-key-xyz',
    );
  });

  it('ignores a registered value too short to be a credential', () => {
    registerSecret('abc');
    // Redacting a 3-char string would turn ordinary prose into asterisks.
    expect(redactSecrets('abc def')).toBe('abc def');
  });

  it('leaves ordinary log prose alone', () => {
    const line = '[SyncBridge] Server listening on 127.0.0.1:4242 (loopback-only)';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('capture redacts before the line is stored', () => {
  let db: FakeDbHandle;
  let restore: () => void;
  beforeEach(() => {
    db = createFakeDb();
    initAppLog(asDatabase(db));
    restore = __setPolicyForTest({ redactLogs: true });
  });
  afterEach(() => restore());

  it('never writes a provider key to the app_logs table', () => {
    registerSecret('sk-zzzzsecretkeyvalue123456');
    capture('info', 'providers:save', 'saved key sk-zzzzsecretkeyvalue123456');
    const stored = db.tables.app_logs.map((r) => String(r.message));
    for (const line of stored) expect(line).not.toContain('sk-zzzzsecretkeyvalue123456');
  });

  it('keeps the message useful after redaction', () => {
    capture('info', 'providers:save', 'saved provider openai with key sk-aaaaaaaaaaaaaaaaaaaa');
    expect(String(db.tables.app_logs[0].message)).toContain('saved provider openai');
  });

  it('records the level and scope so the viewer can filter', () => {
    capture('warn', 'syncBridge', 'port busy');
    expect(db.tables.app_logs[0]).toMatchObject({ level: 'warn', scope: 'syncBridge' });
  });

  it('leaves the stored line clean when redaction is switched off — and that ' +
     'is the only difference the switch makes', () => {
    restore();
    restore = __setPolicyForTest({ redactLogs: false });
    registerSecret('sk-plaintextkeyvalue12345');
    capture('info', 'test', 'key is sk-plaintextkeyvalue12345');
    expect(String(db.tables.app_logs[0].message)).toContain('sk-plaintextkeyvalue12345');
  });

  it('does not throw when the message is empty or a number', () => {
    expect(() => capture('info', 'x', '')).not.toThrow();
    expect(() => capture('info', 'x', 42 as unknown as string)).not.toThrow();
  });
});

describe('querying', () => {
  let db: FakeDbHandle;
  beforeEach(() => {
    db = createFakeDb();
    initAppLog(asDatabase(db));
    capture('info', 'alpha', 'first line');
    capture('error', 'beta', 'second line');
    capture('warn', 'alpha', 'third line');
  });

  it('returns everything newest-first by default', () => {
    const rows = queryLogs({});
    expect(rows).toHaveLength(3);
    expect(rows[0].message).toBe('third line');
  });

  it('filters by level', () => {
    const rows = queryLogs({ level: 'error' });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('second line');
  });

  it('filters by search text', () => {
    expect(queryLogs({ search: 'first' })).toHaveLength(1);
  });

  it('reports per-level counts for the header', () => {
    const stats = logStats();
    expect(stats.total).toBe(3);
    expect(stats.byLevel.info).toBe(1);
    expect(stats.byLevel.error).toBe(1);
  });
});

describe('export never reintroduces a secret', () => {
  let db: FakeDbHandle;
  let restore: () => void;
  beforeEach(() => {
    db = createFakeDb();
    initAppLog(asDatabase(db));
    restore = __setPolicyForTest({ redactLogs: true });
    registerSecret('exported-secret-key-abcdef');
    capture('info', 'scope', 'the key is exported-secret-key-abcdef');
  });
  afterEach(() => restore());

  it('emits redacted text', () => {
    const { text } = { text: exportLogs({}) };
    expect(text).not.toContain('exported-secret-key-abcdef');
  });

  it('includes the timestamp and level so the file is readable', () => {
    expect(exportLogs({})).toContain('[INFO]');
  });
});

describe('retention', () => {
  it('defaults to a bounded window rather than forever', () => {
    expect(getRetentionDays()).toBe(14);
  });

  it('clamps a request below the floor', () => {
    expect(setRetentionDays(0)).toBe(1);
  });

  it('clamps a request above the ceiling', () => {
    expect(setRetentionDays(10_000)).toBe(365);
  });

  it('accepts an in-range value', () => {
    expect(setRetentionDays(30)).toBe(30);
  });

  it('persists the choice so it survives a restart', () => {
    const db = createFakeDb();
    initAppLog(asDatabase(db));
    setRetentionDays(7);
    expect(db.rows.log_retention_days).toBe('7');
  });
});

describe('clearing', () => {
  it('reports how many rows it removed', () => {
    const db = createFakeDb();
    initAppLog(asDatabase(db));
    capture('info', 'a', 'one');
    capture('info', 'a', 'two');
    expect(clearLogs()).toBe(2);
  });

  it('leaves an empty log after clearing', () => {
    const db = createFakeDb();
    initAppLog(asDatabase(db));
    capture('info', 'a', 'one');
    clearLogs();
    expect(queryLogs({})).toHaveLength(0);
  });
});