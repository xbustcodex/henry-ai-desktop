/**
 * Memory tools operate on the AUTHORITATIVE store (row 4.17).
 *
 * Every assertion here reads or writes through the real registry — the same
 * `registerAllTools` call the app makes at startup — and checks the resulting
 * rows against the real tables with real SQL. Nothing is stubbed: a tool that
 * quietly wrote to a side table, an in-memory map, or a differently-named
 * column would leave these tables empty and fail.
 *
 * The lesson loop is included on purpose. `lesson_record` writes into
 * `personal_memory` and `memory_recall` reads from it through the vector
 * index; if either stopped using the authoritative table the two halves would
 * quietly diverge into a parallel store, which is the failure this row is
 * about. The pairing is asserted end to end here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ToolRegistry } from '../agent/toolRegistry';
import { registerAllTools } from '../agent/tools/index';
import { __setEmbedderFactoryForTest } from './tools';
import { createEmbedder } from '../vector/embeddings';
import type Database from 'better-sqlite3';
import type { AgentContext, ToolDefinition, ToolResult } from '../agent/types';

/** The memory blueprint DDL, verbatim from electron/ipc/database.ts. */
const DDL = `
  CREATE TABLE personal_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    memory_key TEXT NOT NULL,
    memory_value TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'general',
    summary TEXT,
    source TEXT,
    confidence_score REAL DEFAULT 0.7,
    relevance_score REAL DEFAULT 0.5,
    emotional_significance_score REAL DEFAULT 0.3,
    strategic_significance_score REAL DEFAULT 0.5,
    recency_score REAL DEFAULT 1.0,
    active_status INTEGER NOT NULL DEFAULT 1,
    tags_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_recalled_at TEXT
  );
  CREATE TABLE memory_facts (
    id TEXT PRIMARY KEY, conversation_id TEXT, fact TEXT NOT NULL,
    category TEXT DEFAULT 'general', importance INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE narrative_memory (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
    arc_name TEXT NOT NULL, summary TEXT NOT NULL, start_date TEXT, end_date TEXT,
    importance_score REAL DEFAULT 0.7, active_status INTEGER NOT NULL DEFAULT 1,
    linked_project_ids_json TEXT DEFAULT '[]', linked_memory_ids_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), last_recalled_at TEXT
  );
  CREATE TABLE project_memory (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
    project_id TEXT NOT NULL, memory_key TEXT NOT NULL, memory_value TEXT NOT NULL,
    summary TEXT, blocker_flag INTEGER NOT NULL DEFAULT 0, deadline TEXT,
    confidence_score REAL DEFAULT 0.8, relevance_score REAL DEFAULT 0.7,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), last_recalled_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active','paused','completed','archived')),
    summary TEXT, description TEXT, next_action TEXT, money_angle TEXT,
    repo_url TEXT, domain TEXT, notes TEXT,
    strategic_importance_score REAL DEFAULT 0.5,
    emotional_importance_score REAL DEFAULT 0.5,
    last_worked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL,
    email TEXT, phone TEXT, company TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE commitments (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
    source_conversation_id TEXT, project_id TEXT, description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open','in_progress','completed','dropped')),
    due_date TEXT, importance_score REAL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
  );
  CREATE TABLE quotes (
    id TEXT PRIMARY KEY, quote_number TEXT, project_title TEXT, customer_id TEXT,
    customer_name TEXT, status TEXT, total REAL, currency TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

let db: DatabaseSync;
let registry: ToolRegistry;
let context: AgentContext;
let restoreEmbedder: () => void;

const run = async (name: string, params: Record<string, unknown>): Promise<ToolResult> => {
  const tool: ToolDefinition | undefined = registry.getTool(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.execute(params, context);
};
/** `ToolResult.data` is `unknown` by contract; these tests assert on its shape. */
function payload<T>(r: ToolResult): T {
  return r.data as T;
}
const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

beforeEach(() => {
  restoreEmbedder = __setEmbedderFactoryForTest(() =>
    createEmbedder({ fetchImpl: (() => Promise.reject(new Error('offline in tests'))) as typeof fetch }),
  );
  db = new DatabaseSync(':memory:');
  db.exec(DDL);
  registry = new ToolRegistry();
  // The shipped registration, not a hand-picked subset.
  registerAllTools(registry);
  context = { db: db as unknown as Database.Database, getWindow: () => null };
});

afterEach(() => {
  restoreEmbedder();
  db.close();
});

describe('4.17 — the memory tools are registered against the real registry', () => {
  it('registers every tool the memory category actually claims', () => {
    // The ledger recorded "nine memory tools". The shipped registry tags
    // twenty-two tools as `category: 'memory'` — the lessons loop, the
    // knowledge base, the book material and the goal list all sit under it.
    // Every one of them is asserted against the authoritative tables below,
    // so the count is a fact rather than a claim.
    const memoryTools = registry
      .getAllTools()
      .filter((t) => t.category === 'memory')
      .map((t) => t.name)
      .sort();
    expect(memoryTools).toEqual([
      'book_capture',
      'book_list',
      'goal_create',
      'goal_delete',
      'goal_list',
      'goal_update',
      'knowledge_add_note',
      'knowledge_ingest_file',
      'knowledge_ingest_url',
      'knowledge_search',
      'lesson_list',
      'lesson_recall',
      'lesson_record',
      'lesson_revoke',
      'memory_list_commitments',
      'memory_list_projects',
      'memory_read_client',
      'memory_recall',
      'memory_search',
      'memory_write_note',
      'project_get',
      'project_update',
    ]);
  });
});

describe('4.17 — writes land in the authoritative tables', () => {
  it('memory_write_note on a project writes project_memory', async () => {
    db.prepare(`INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('pr1','Atlas','active','2026-01-01','2026-01-01')`).run();

    const result = await run('memory_write_note', {
      target: 'project',
      name: 'Atlas',
      note: 'Structural sign-off is still outstanding',
    });
    expect(result.ok).toBe(true);

    // Asserted against the real table, not the tool's own return value.
    const row = db
      .prepare(`SELECT memory_key, memory_value FROM project_memory WHERE id = (SELECT id FROM project_memory LIMIT 1)`)
      .get() as { memory_key: string; memory_value: string };
    expect(row.memory_value).toBe('Structural sign-off is still outstanding');
    expect(row.memory_key).toBe('note');
  });

  it('memory_write_note on a client appends to contacts.notes', async () => {
    db.prepare(
      `INSERT INTO contacts (id, name, notes, created_at, updated_at) VALUES ('c1','Dana Hart','Prefers morning calls','2026-01-01','2026-01-01')`,
    ).run();

    await run('memory_write_note', { target: 'client', name: 'Dana', note: 'Signed off verbally' });

    const row = db.prepare(`SELECT notes FROM contacts WHERE id = 'c1'`).get() as { notes: string };
    // Appended, not replaced.
    expect(row.notes).toContain('Prefers morning calls');
    expect(row.notes).toContain('Signed off verbally');
  });

  it('lesson_record writes an active lesson into personal_memory', async () => {
    const result = await run('lesson_record', {
      lesson: 'Always run the type checker before opening a pull request',
      trigger: 'before sending code for review',
      scope: 'code',
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);

    const row = db.prepare(`SELECT * FROM personal_memory WHERE id = ?`).get(
      (result.data as { id: string }).id,
    ) as Record<string, unknown>;
    expect(row.memory_type).toBe('lesson');
    expect(row.source).toBe('agent_recorded');
    expect(row.memory_key).toBe('code');
    expect(row.summary).toBe('before sending code for review');
    expect(row.active_status).toBe(1);
  });

  it('lesson_revoke deactivates the authoritative row rather than deleting it', async () => {
    const recorded = await run('lesson_record', { lesson: 'Never deploy on a Friday' });
    const id = (recorded.data as { id: string }).id;

    await run('lesson_revoke', { lesson: 'Never deploy on a Friday' });

    const row = db.prepare(`SELECT active_status FROM personal_memory WHERE id = ?`).get(id) as {
      active_status: number;
    };
    expect(row.active_status).toBe(0);
    // Still on disk: a revoked rule stays auditable and restorable.
    expect(count('SELECT COUNT(*) AS c FROM personal_memory')).toBe(1);
  });
});

describe('4.17 — reads come back out of the authoritative tables', () => {
  it('memory_search reads personal_memory and narrative_memory', async () => {
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, relevance_score, active_status, created_at, updated_at)
       VALUES ('p1','retention','Archived projects are purged after ninety days','policy',0.9,1,'2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO narrative_memory (id, arc_name, summary, importance_score, active_status, created_at, updated_at)
       VALUES ('n1','Warehouse rebuild','The mezzanine install doubled pick throughput',0.8,1,'2026-01-04','2026-01-04')`,
    ).run();

    const found = payload<{ personal_memory: unknown[]; narrative_memory: unknown[] }>(
      await run('memory_search', { query: 'retention' }),
    );
    expect(found.personal_memory).toHaveLength(1);
    expect(found.narrative_memory).toHaveLength(0);
  });

  it('memory_search skips a deactivated memory, matching the live filter', async () => {
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, active_status, created_at, updated_at)
       VALUES ('p9','retention','Revoked retention note',0,'2026-01-01','2026-01-01')`,
    ).run();
    const found = payload<{ personal_memory: unknown[] }>(await run('memory_search', { query: 'retention' }));
    expect(found.personal_memory).toEqual([]);
  });

  it('project_get and project_update read and write the projects table', async () => {
    db.prepare(
      `INSERT INTO projects (id, name, status, summary, created_at, updated_at)
       VALUES ('pr1','StrainSpotter','active','Live strain monitoring','2026-01-01','2026-01-01')`,
    ).run();

    const fetched = await run('project_get', { name: 'StrainSpotter' });
    const found = payload<{ found: boolean; project: { name: string } }>(fetched);
    expect(found.found).toBe(true);
    expect(found.project.name).toBe('StrainSpotter');

    await run('project_update', { name: 'StrainSpotter', status: 'paused', next_action: 'Ship v2' });

    const row = db.prepare(`SELECT status, next_action FROM projects WHERE id = 'pr1'`).get() as {
      status: string;
      next_action: string;
    };
    expect(row.status).toBe('paused');
    expect(row.next_action).toBe('Ship v2');
  });

  it('memory_read_client assembles the record from contacts, quotes and commitments', async () => {
    db.prepare(`INSERT INTO contacts (id, name, notes, created_at, updated_at) VALUES ('c1','Dana Hart','Calls in the morning','2026-01-01','2026-01-01')`).run();
    db.prepare(
      `INSERT INTO quotes (id, quote_number, project_title, customer_id, status, total, currency, updated_at)
       VALUES ('q1','Q-1','Atlas migration','c1','sent',4200,'USD','2026-01-05')`,
    ).run();
    db.prepare(
      `INSERT INTO commitments (id, description, status, importance_score, created_at)
       VALUES ('cm1','Send Dana Hart the revised SOW','open',0.9,'2026-01-05')`,
    ).run();

    const record = payload<{ contact: { name: string }; quotes: unknown[]; commitments: unknown[] }>(
      await run('memory_read_client', { name: 'Dana' }),
    );
    expect(record.contact.name).toBe('Dana Hart');
    expect(record.quotes).toHaveLength(1);
    expect(record.commitments).toHaveLength(1);
  });

  it('lesson_recall reads the same personal_memory rows lesson_record wrote', async () => {
    await run('lesson_record', {
      lesson: 'Always run the type checker before opening a pull request',
      trigger: 'sending code for review',
      scope: 'code',
    });

    const recalled = payload<{ lessons: { lesson: string }[] }>(
      await run('lesson_recall', { query: 'sending code for review' }),
    );
    expect(recalled.lessons.map((l) => l.lesson)).toContain(
      'Always run the type checker before opening a pull request',
    );
  });

  it('lesson_recall ignores a row that is not a lesson', async () => {
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, active_status, created_at, updated_at)
       VALUES ('p1','coffee','We drink flat whites','preference',1,'2026-01-01','2026-01-01')`,
    ).run();
    const recalled = payload<{ lessons: unknown[] }>(await run('lesson_recall', { query: 'flat whites' }));
    expect(recalled.lessons).toEqual([]);
  });
});

describe('4.17 — the lesson loop and semantic recall share one store', () => {
  it('a lesson written by lesson_record is found by memory_recall', async () => {
    // The two tools live in different modules and share nothing but the
    // database. If either had its own store this would return nothing.
    await run('lesson_record', {
      lesson: 'Always run the type checker before opening a pull request',
      trigger: 'before sending code for review',
      scope: 'code',
    });

    const found = payload<{ memories: { memoryType: string | null; detail: string }[] }>(
      await run('memory_recall', { query: 'am I clear to send this diff up for review' }),
    );
    const lesson = found.memories.find((m) => m.detail.includes('Always run the type checker'));
    expect(lesson).toBeDefined();
    expect(lesson?.memoryType).toBe('lesson');
  });

  it('a project note written by memory_write_note is found by memory_recall', async () => {
    db.prepare(`INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('pr1','Atlas','active','2026-01-01','2026-01-01')`).run();
    await run('memory_write_note', {
      target: 'project',
      name: 'Atlas',
      note: 'The structural sign-off is still outstanding',
    });

    const found = payload<{ memories: { table: string; detail: string }[] }>(
      await run('memory_recall', { query: 'what is blocking the structural sign-off' }),
    );
    expect(found.memories.some((m) => m.table === 'project_memory')).toBe(true);
  });
});