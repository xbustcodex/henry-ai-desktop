/**
 * Integration tests for the SessionStore Python CLI — exercised exactly the way
 * the Electron bridge (electron/ipc/sessionStore.ts) drives it: spawn
 * `session_store.py <command> --db <db>`, pipe a JSON payload on stdin, parse
 * the JSON result on stdout.
 *
 * Skips cleanly when Python 3 (or FTS5) isn't available, so CI without Python
 * stays green while still covering the store wherever Python is present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session_store.py');

/** Find a working python3 (mirrors the bridge's candidate list, abbreviated). */
function findPython(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['python', 'python3']
      : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-c', 'print("ok")'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return cmd;
  }
  return null;
}

const PYTHON = findPython();

// A throwaway DB per run.
let dbDir: string;
let dbPath: string;

/** Run one CLI command and return its `result` (throws on { ok: false }). */
function call(python: string, command: string, payload: Record<string, unknown>): any {
  const r = spawnSync(python, [SCRIPT, command, '--db', dbPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  let parsed: { ok?: boolean; result?: unknown; error?: string };
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Non-JSON output (status ${r.status}): ${r.stderr || r.stdout}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || 'command failed');
  return parsed.result;
}

// Probe FTS availability once (the store reports it in `stats`).
let ftsEnabled = false;
beforeAll(() => {
  if (!PYTHON) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-sessionstore-'));
  dbPath = path.join(dbDir, 'sessions.db');
  try {
    const stats = call(PYTHON, 'stats', {});
    ftsEnabled = !!stats.fts_enabled;
  } catch {
    ftsEnabled = false;
  }
});

afterAll(() => {
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const run = PYTHON ? describe : describe.skip;

run('SessionStore CLI (Python integration)', () => {
  const c = (command: string, payload: Record<string, unknown> = {}) => call(PYTHON!, command, payload);

  it('reports a working store (WAL + FTS where available)', () => {
    const stats = c('stats');
    expect(['wal', 'delete']).toContain(stats.journal_mode);
    expect(typeof stats.fts_enabled).toBe('boolean');
  });

  it('creates a session with an origin and reads it back', () => {
    const { session } = c('create', { id: 'sess1', title: 'Docker chat', origin: 'chat' });
    expect(session.id).toBe('sess1');
    expect(session.origin).toBe('chat');
    expect(session.message_count).toBe(0);
  });

  it('appends messages and round-trips structured + scalar content', () => {
    c('add-message', { session_id: 'sess1', role: 'user', kind: 'chat', content: 'How do I deploy with docker?' });
    c('add-message', {
      session_id: 'sess1', role: 'assistant', kind: 'chat',
      content: 'Use docker compose up -d.', token_count: 9,
    });
    // Structured block content (multimodal / tool style)
    c('add-message', {
      session_id: 'sess1', role: 'user', kind: 'chat',
      content: [{ type: 'text', text: 'and kubernetes?' }],
    });

    const { messages } = c('get-messages', { session_id: 'sess1' });
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('How do I deploy with docker?');
    expect(Array.isArray(messages[2].content)).toBe(true); // structured content preserved
    expect(messages[2].content[0]).toEqual({ type: 'text', text: 'and kubernetes?' });
    expect(messages[1].kind).toBe('chat');
  });

  it('increments the session message_count', () => {
    const session = c('get', { session_id: 'sess1' });
    expect(session.message_count).toBe(3);
  });

  it('full-text searches message content', () => {
    if (!ftsEnabled) return; // store reports FTS disabled — skip the FTS assertion
    const { results } = c('search', { query: 'docker' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].snippet).toMatch(/docker/i);
  });

  it('searches the flattened text of structured/tool blocks', () => {
    if (!ftsEnabled) return;
    c('add-message', {
      session_id: 'sess1', role: 'tool', kind: 'tool_result', tool_name: 'open_app', tool_call_id: 'tc1',
      content: [
        { type: 'tool_use', id: 'tc1', name: 'open_app', input: { name: 'Safari' } },
        { type: 'tool_result', tool_use_id: 'tc1', content: 'Safari launched', is_error: false },
      ],
    });
    const { results } = c('search', { query: 'Safari' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns nothing for a non-matching search', () => {
    if (!ftsEnabled) return;
    const { results } = c('search', { query: 'zzzzznotpresent' });
    expect(results).toHaveLength(0);
  });

  it('accumulates token + cost accounting', () => {
    c('update-tokens', { session_id: 'sess1', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.0021, model: 'test-model' });
    c('update-tokens', { session_id: 'sess1', input_tokens: 10, output_tokens: 5 });
    const s = c('get', { session_id: 'sess1' });
    expect(s.input_tokens).toBe(110);
    expect(s.output_tokens).toBe(55);
    expect(s.actual_cost_usd).toBeCloseTo(0.0021, 6);
  });

  it('ends then resumes a session (clears ended_at, returns history)', () => {
    c('end', { session_id: 'sess1', end_reason: 'done' });
    const ended = c('get', { session_id: 'sess1' });
    expect(ended.ended_at).not.toBeNull();

    const resumed = c('resume', { session_id: 'sess1' });
    expect(resumed.ended_at).toBeNull();
    expect(resumed.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('branches a session, copying history under a new parent', () => {
    const { id, session } = c('branch', { session_id: 'sess1', title: 'forked' });
    expect(id).toBeTruthy();
    expect(session.parent_session_id).toBe('sess1');
    expect(session.message_count).toBeGreaterThanOrEqual(3);
  });

  it('auto-creates a session on first add-message and lists it', () => {
    c('add-message', { session_id: 'fresh-sess', role: 'user', content: 'hello there' });
    const { sessions } = c('list', {});
    const ids = sessions.map((s: any) => s.id);
    expect(ids).toContain('fresh-sess');
  });

  it('deletes a session and its messages', () => {
    c('delete', { session_id: 'fresh-sess' });
    const gone = c('get', { session_id: 'fresh-sess' });
    expect(gone).toBeNull();
  });
});

// Hand-build a v1-schema DB, then open it with the current code and confirm the
// migration (adds origin/kind/content_text, backfills content_text, rebuilds
// FTS to index the flattened text) without losing data.
const V1_BUILDER = `
import sqlite3, sys, time
db = sys.argv[1]
c = sqlite3.connect(db)
c.executescript("""
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, model_config TEXT,
  system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
  end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
  api_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, pricing_version TEXT,
  cwd TEXT, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
  timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE VIRTUAL TABLE messages_fts USING fts5(content);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content,'')||' '||COALESCE(new.tool_name,'')||' '||COALESCE(new.tool_calls,''));
END;
INSERT INTO schema_version VALUES (1);
""")
c.execute("INSERT INTO sessions (id,title,started_at,message_count) VALUES ('old1','Legacy',?,1)", (time.time(),))
c.execute("INSERT INTO messages (session_id,role,content,timestamp) VALUES ('old1','user','legacy needle message',?)", (time.time(),))
c.commit(); c.close()
print("built")
`;

run('SessionStore v1 → v2 migration', () => {
  it('migrates a legacy DB: adds columns, backfills content_text, keeps search working', () => {
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-migrate-'));
    const mdb = path.join(mdir, 'sessions.db');
    try {
      const build = spawnSync(PYTHON!, ['-c', V1_BUILDER, mdb], { encoding: 'utf8' });
      expect(build.status, build.stderr).toBe(0);

      // Opening via any command triggers _init_schema → migration.
      const r = spawnSync(PYTHON!, [SCRIPT, 'search', '--db', mdb], {
        input: JSON.stringify({ query: 'needle' }),
        encoding: 'utf8',
      });
      const parsed = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
      expect(parsed.ok).toBe(true);

      // Legacy data survived and is searchable (only assert hits when FTS is on).
      const statsR = spawnSync(PYTHON!, [SCRIPT, 'stats', '--db', mdb], { input: '{}', encoding: 'utf8' });
      const stats = JSON.parse((statsR.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}').result;
      if (stats?.fts_enabled) {
        expect(parsed.result.results.length).toBeGreaterThanOrEqual(1);
      }

      // The session itself is intact.
      const getR = spawnSync(PYTHON!, [SCRIPT, 'get', '--db', mdb], {
        input: JSON.stringify({ session_id: 'old1' }),
        encoding: 'utf8',
      });
      const session = JSON.parse((getR.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}').result;
      expect(session.title).toBe('Legacy');
    } finally {
      fs.rmSync(mdir, { recursive: true, force: true });
    }
    // Spawns Python twice (build the legacy schema, then migrate it) and does a
    // full-text search over the result. Measured at ~7s, so the 5s default
    // times out on an otherwise-correct test.
  }, 30_000);
});
