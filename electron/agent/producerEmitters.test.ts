/**
 * Real producers → the event bus → a real Routine.
 *
 * `scheduler.triggers.test.ts` drives the whole event path by calling
 * `emitTriggerEvent` itself — the test IS the emitter. That proves the consumer
 * side works and proves nothing about whether anything in the app ever emits.
 * It is exactly the shape that let `fireEvent` ship with zero production
 * callers while fourteen tests stayed green.
 *
 * This file closes the gap from the other end. Every test here drives a
 * genuine producer — the task broker finishing a run, the knowledge base
 * indexing a document — and asserts that a Routine watching the resulting
 * event actually runs. Delete an emitter from `taskBroker.ts` or
 * `knowledge/core.ts` and these fail.
 *
 * The storm cases are the ones the four-brake guard was written for and had
 * never seen a real producer for: a bulk ingest, and a producer that retries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callAI, callAIWithTools } from '../ipc/ai';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { HenryScheduler } from './scheduler';
import { eventBus, resetMigrationCache } from './triggers';
import { createKnowledgeBase } from '../knowledge/core';
import { registerTaskBrokerHandlers } from '../ipc/taskBroker';
import type Database from 'better-sqlite3';

vi.mock('../ipc/ai', () => ({
  callAIWithTools: vi.fn(async () => ({ content: 'done', toolCalls: [] })),
  // `executeAITask` reaches for `callAI`; the file_operation task type below
  // never does, but the module must still resolve the symbol at import time.
  callAI: vi.fn(async () => ({ content: '', usage: {}, cost: 0 })),
}));
vi.mock('../ipc/sessionStore', () => ({
  createSessionRecord: vi.fn(async () => 'sess-1'),
  recordSessionMessage: vi.fn(async () => undefined),
}));
vi.mock('../ipc/_keyStorage', () => ({ decryptKey: (s: string) => s }));
vi.mock('../lib/log', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * The broker reaches `electron` at module scope. `ipcMain.handle` is captured
 * so the test can invoke `task:submit` exactly as preload would, which is what
 * pulls the queued task through the real completion path.
 */
const ipcHandlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => ipcHandlers.set(channel, fn),
  },
  BrowserWindow: class {},
}));

// `callAI` is what `executeAITask` awaits, so mocking it keeps the broker's
// completion path entirely inside microtasks — fake timers never yield to the
// real event loop long enough for a genuine `fs` read to land.
const callAi = vi.mocked(callAI);

/** Wait for the broker's un-awaited `processNextTask` to reach a terminal row. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(0);
}

const aiCalls = vi.mocked(callAIWithTools);

/** `node:sqlite` lacks better-sqlite3's `.transaction()`; `seedDefaults` uses it. */
type DbLike = DatabaseSync & {
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
};

function withTransaction(db: DatabaseSync): DbLike {
  const wrapped = db as DbLike;
  wrapped.transaction = ((fn: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      db.exec('BEGIN');
      try {
        const out = fn(...args);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    }) as DbLike['transaction'];
  return wrapped;
}

function schedulerDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT,
      cronExpression TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      lastRunAt      TEXT,
      nextRunAt      TEXT,
      createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY, task_id TEXT, task_name TEXT, prompt TEXT,
      status TEXT, trigger TEXT, result TEXT, error TEXT, session_id TEXT,
      read_at TEXT, started_at TEXT, finished_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT DEFAULT '');
    INSERT INTO providers (id, name, api_key) VALUES ('test', 'Test', 'enc:v1:fake');
    INSERT INTO settings (key, value) VALUES ('worker_provider', 'test');
    INSERT INTO settings (key, value) VALUES ('worker_model', 'test-model');
  `);
  return withTransaction(db);
}

/** The broker's `tasks` table, plus the `workspace_root` it confines writes to. */
function brokerDb(): { db: DatabaseSync; workspace: string } {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, description TEXT, type TEXT, status TEXT,
      priority INTEGER DEFAULT 0, payload TEXT, result TEXT, error TEXT, cost REAL,
      source_engine TEXT, conversation_id TEXT, created_at TEXT, started_at TEXT,
      completed_at TEXT, created_from_mode TEXT, related_file_path TEXT,
      created_from_message_id TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT DEFAULT '');
    INSERT INTO providers (id, name, api_key) VALUES ('test', 'Test', 'enc:v1:fake');
    INSERT INTO settings (key, value) VALUES ('worker_provider', 'test');
    INSERT INTO settings (key, value) VALUES ('worker_model', 'test-model');
  `);
  const workspace = mkdtempSync(path.join(tmpdir(), 'henry-broker-'));
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('workspace_root', workspace);
  return { db, workspace };
}

const asSchedulerDb = (db: DatabaseSync) => db as unknown as ConstructorParameters<typeof HenryScheduler>[0];
const asBetterSqlite = (db: DatabaseSync) => db as unknown as Database.Database;

let db: DatabaseSync;
let sched: HenryScheduler;
let open: Array<{ db: DatabaseSync; dir?: string }> = [];

function track(database: DatabaseSync, dir?: string): DatabaseSync {
  open.push({ db: database, dir });
  return database;
}

beforeEach(() => {
  vi.useFakeTimers();
  aiCalls.mockClear();
  callAi.mockClear();
  callAi.mockResolvedValue({ content: 'ok', usage: {}, cost: 0 } as never);
  resetMigrationCache();
  eventBus.reset();
  db = track(schedulerDb());
  sched = new HenryScheduler(asSchedulerDb(db), () => null);
});

afterEach(() => {
  vi.useRealTimers();
  for (const entry of open) {
    try { entry.db.close(); } catch { /* already closed */ }
    if (entry.dir) rmSync(entry.dir, { recursive: true, force: true });
  }
  open = [];
});

/** An enabled Routine watching `event`, with a short debounce. */
function watchEvent(event: string, debounceMs = 500): string {
  sched.init();
  return sched.add({
    name: `On ${event}`,
    prompt: 'react',
    trigger: { type: 'event', event, debounceMs },
    enabled: true,
  }).id;
}

/** A real KnowledgeBase over an in-memory DB, offline embeddings only. */
function knowledgeBase() {
  const kdb = track(new DatabaseSync(':memory:'));
  const kb = createKnowledgeBase(kdb as never, {
    embedderConfig: { fetchImpl: (() => Promise.reject(new Error('offline'))) as typeof fetch },
    io: {
      readFile: async () => '',
      fetchUrl: async () => ({ text: '', contentType: 'text/plain' }),
    },
  });
  return kb;
}

// ─────────────────────────────────────────────────────────────────────────────
// task.completed — a real producer
// ─────────────────────────────────────────────────────────────────────────────

describe('task.completed — driven by the task broker', () => {
  it('fires a watching Routine when a queued task finishes', async () => {
    watchEvent('task.completed');
    const { db: broker, workspace } = brokerDb();
    track(broker, workspace);
    registerTaskBrokerHandlers(asBetterSqlite(broker), () => null, workspace);

    // `ai_generate` resolves through the mocked `callAI`, so the whole run is
    // microtasks — a `file_operation` would await real `fs` and never land
    // while fake timers hold the event loop.
    const submit = ipcHandlers.get('task:submit')!;
    await submit({}, { description: 'summarise the week', type: 'ai_generate', payload: { prompt: 'go' } });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(callAi).toHaveBeenCalledTimes(1);
    expect(aiCalls).toHaveBeenCalledTimes(1);
    const row = broker.prepare(`SELECT status FROM tasks`).get() as { status: string };
    expect(row.status).toBe('completed');
  });

  it('does not fire when the task fails instead of completing', async () => {
    watchEvent('task.completed');
    const { db: broker, workspace } = brokerDb();
    track(broker, workspace);
    registerTaskBrokerHandlers(asBetterSqlite(broker), () => null, workspace);
    callAi.mockRejectedValueOnce(new Error('the model refused'));

    const submit = ipcHandlers.get('task:submit')!;
    await submit({}, { description: 'do something impossible', type: 'ai_generate', payload: { prompt: 'go' } });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    // The emit lives in the success arm only, so a failure never announces
    // itself as a completion.
    expect(aiCalls).not.toHaveBeenCalled();
    const row = broker.prepare(`SELECT status FROM tasks`).get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('leaves a knowledge.ingested Routine alone — the two are not cross-wired', async () => {
    watchEvent('knowledge.ingested');
    const { db: broker, workspace } = brokerDb();
    track(broker, workspace);
    registerTaskBrokerHandlers(asBetterSqlite(broker), () => null, workspace);

    // A completed task must not wake a Routine watching knowledge ingestion.
    const submit = ipcHandlers.get('task:submit')!;
    await submit({}, { description: 'summarise the week', type: 'ai_generate', payload: { prompt: 'go' } });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(aiCalls).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// knowledge.ingested — a real producer
// ─────────────────────────────────────────────────────────────────────────────

describe('knowledge.ingested — driven by the knowledge base', () => {
  it('fires a watching Routine when a document is indexed', async () => {
    watchEvent('knowledge.ingested');
    const kb = knowledgeBase();

    await kb.ingestNote('The Acme retainer renews on the first of March.');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  it('leaves a task.completed Routine alone — the two are not cross-wired', async () => {
    watchEvent('task.completed');
    const kb = knowledgeBase();

    await kb.ingestNote('A note, indexed, that the broker never sees.');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(aiCalls).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The storm guard, against a real producer
// ─────────────────────────────────────────────────────────────────────────────

describe('storm guard — a real producer under load', () => {
  /**
   * The guard's own tests drive a synthetic loop from a test body. This drives
   * fifty distinct documents through the real indexer — a bulk import, the kind
   * of thing that actually happens — and asserts it collapses to one run.
   */
  it('collapses a fifty-document bulk ingest into one run', async () => {
    watchEvent('knowledge.ingested');
    const kb = knowledgeBase();

    for (let i = 0; i < 50; i++) {
      await kb.ingestNote(`Document number ${i} with distinct body text ${i * 7919}.`);
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  /**
   * The stronger property, and the one that does not depend on the guard at
   * all: re-ingesting identical content emits nothing, because the content hash
   * short-circuits before the bus is consulted. A producer that retries cannot
   * be turned into a storm by removing a brake.
   */
  it('emits nothing at all when identical content is re-ingested', async () => {
    watchEvent('knowledge.ingested', 250);
    const kb = knowledgeBase();

    const text = 'The same note, ingested over and over.';
    await kb.ingestNote(text);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 30; i++) {
      const again = await kb.ingestNote(text);
      expect(again.unchanged).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(5_000);

    // Thirty retries, still exactly one run. Not one per burst — one, ever.
    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  it('holds the cooldown across spaced-out ingests', async () => {
    watchEvent('knowledge.ingested', 250);
    const kb = knowledgeBase();

    for (let i = 0; i < 5; i++) {
      await kb.ingestNote(`Distinct document ${i}, body ${i * 104729}.`);
      // Well past the 250ms debounce, still inside the 60s cooldown.
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  /**
   * The hourly cap is the fourth brake and the only one the pure-module tests
   * cannot reach through a producer, because reaching it means outliving a
   * cooldown sixty times. Cheap here: each cycle is five seconds of fake time.
   */
  it('stops at the hourly cap even when the producer keeps going', async () => {
    watchEvent('knowledge.ingested', 250);
    const kb = knowledgeBase();

    // 12 distinct documents, each landing in a fresh cooldown window.
    for (let i = 0; i < 12; i++) {
      await kb.ingestNote(`Hourly-cap probe ${i}, body ${i * 15485863}.`);
      await vi.advanceTimersByTimeAsync(61_000);
    }

    // DEFAULT_MAX_FIRES_PER_HOUR is 10; the eleventh and twelfth are refused.
    expect(aiCalls).toHaveBeenCalledTimes(10);
  });
});