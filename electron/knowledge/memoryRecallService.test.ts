/**
 * Memory recall over the vector store.
 *
 * The point of these tests is that recall reads the AUTHORITATIVE memory
 * tables — `personal_memory`, `memory_facts`, `narrative_memory`,
 * `project_memory` — and indexes them into the vector store rather than into a
 * parallel store of its own. So the schema here is the real one, and the
 * assertions are about memories that exist in those tables being recalled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeBase, type KnowledgeIo } from './core';
import { createMemoryRecallService } from './memoryRecallService';
import { createEmbedder } from '../vector/embeddings';
import type { SqlDatabase } from '../vector/sql';

const offlineEmbedder = () =>
  createEmbedder({ fetchImpl: (() => Promise.reject(new Error('offline in tests'))) as typeof fetch });

const io: KnowledgeIo = {
  readFile: async () => '',
  fetchUrl: async () => ({ text: '', contentType: 'text/plain' }),
};

let db: DatabaseSync;
let kb: KnowledgeBase;
let recall: ReturnType<typeof createMemoryRecallService>;

/** The real memory blueprint schema, trimmed to what recall reads. */
function createMemorySchema(handle: DatabaseSync): void {
  handle.exec(`
    CREATE TABLE personal_memory (
      id TEXT PRIMARY KEY,
      memory_key TEXT NOT NULL,
      memory_value TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'general',
      confidence_score REAL DEFAULT 0.7,
      emotional_significance_score REAL DEFAULT 0.3,
      strategic_significance_score REAL DEFAULT 0.5,
      active_status INTEGER NOT NULL DEFAULT 1,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE memory_facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT,
      importance REAL,
      created_at TEXT
    );
    CREATE TABLE narrative_memory (
      id TEXT PRIMARY KEY,
      arc_name TEXT NOT NULL,
      summary TEXT,
      importance_score REAL DEFAULT 0.7,
      active_status INTEGER NOT NULL DEFAULT 1,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE project_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      memory_key TEXT NOT NULL,
      memory_value TEXT NOT NULL,
      relevance_score REAL DEFAULT 0.7,
      confidence_score REAL DEFAULT 0.8,
      created_at TEXT, updated_at TEXT
    );
  `);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  createMemorySchema(db);
  const embedder = offlineEmbedder();
  kb = new KnowledgeBase(db as unknown as SqlDatabase, embedder, io);
  kb.migrate();
  recall = createMemoryRecallService(db as never, kb.store, embedder);
});

afterEach(() => {
  db.close();
});

function seedMemories(): void {
  db.prepare(
    `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, confidence_score, emotional_significance_score, strategic_significance_score, created_at, updated_at)
     VALUES ('p1','retention','Archived projects are purged after ninety days','policy',0.9,0.4,0.9,'2026-01-01','2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, confidence_score, emotional_significance_score, strategic_significance_score, created_at, updated_at)
     VALUES ('p2','coffee','The team prefers flat whites over lattes','preference',0.6,0.2,0.2,'2026-01-02','2026-01-02')`,
  ).run();
  db.prepare(`INSERT INTO memory_facts (id, fact, category, importance, created_at) VALUES ('f1','Deployments ship on Thursday mornings','ops',8,'2026-01-03')`).run();
  db.prepare(`INSERT INTO narrative_memory (id, arc_name, summary, importance_score, active_status, created_at, updated_at) VALUES ('n1','Warehouse rebuild','The mezzanine install doubled pick throughput',0.8,1,'2026-01-04','2026-01-04')`).run();
  db.prepare(`INSERT INTO project_memory (id, project_id, memory_key, memory_value, relevance_score, confidence_score, created_at, updated_at) VALUES ('m1','proj1','blocker','Waiting on the structural sign-off',0.9,0.8,'2026-01-05','2026-01-05')`).run();
}

describe('MemoryRecallService — indexes the authoritative tables', () => {
  it('reports one indexed memory per live authoritative row', async () => {
    seedMemories();
    const result = await recall.reindexAllMemory();
    expect(result.indexed).toBe(5);
  });

  it('excludes soft-deleted personal memories', async () => {
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, active_status, created_at, updated_at)
       VALUES ('p9','archived','An old deactivated memory',0,'2025-01-01','2025-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, active_status, created_at, updated_at)
       VALUES ('p1','live','A live memory',1,'2026-01-01','2026-01-01')`,
    ).run();

    const result = await recall.reindexAllMemory();
    expect(result.indexed).toBe(1);
    const found = await recall.recall('live memory');
    expect(found.memories.every((m) => m.id !== 'p9')).toBe(true);
  });

  it('reports the layer a memory came from', async () => {
    seedMemories();
    await recall.reindexAllMemory();
    const found = await recall.recall('mezzanine install pick throughput');
    expect(found.memories.length).toBeGreaterThan(0);
    expect(found.memories.map((m) => m.table)).toContain('narrative_memory');
  });

  it('treats a NULL active_status as active, matching the schema default', async () => {
    // personal_memory is declared NOT NULL DEFAULT 1, so a live row always has
    // a value. A NULL means the writer omitted the column; excluding it would
    // make recall silently return nothing for that row, which looks like a
    // quality problem rather than a data problem.
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, created_at, updated_at)
       VALUES ('pnull','omitted','A memory whose active_status was never written','2026-01-01','2026-01-01')`,
    ).run();

    const result = await recall.reindexAllMemory();
    expect(result.indexed).toBe(1);
    const found = await recall.recall('active_status was never written');
    expect(found.memories.some((m) => m.id === 'pnull')).toBe(true);
  });

  it('does not collide when two layers share an id', async () => {
    db.prepare(`INSERT INTO memory_facts (id, fact, category, importance, created_at) VALUES ('shared','A fact about espresso','drinks',5,'2026-01-01')`).run();
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, created_at, updated_at)
       VALUES ('shared','espresso','A preference for espresso','2026-01-01','2026-01-01')`,
    ).run();

    await recall.reindexAllMemory();
    const found = await recall.recall('espresso');
    const tables = new Set(found.memories.map((m) => m.table));
    expect(tables.size).toBe(2);
  });
});

describe('MemoryRecallService — retrieval', () => {
  it('recalls a memory by meaning, not by matching words', async () => {
    seedMemories();
    await recall.reindexAllMemory();

    // Shares almost no vocabulary with the stored memory, which is exactly
    // what a keyword search cannot do.
    const found = await recall.recall('how long do we keep things before deleting them');
    expect(found.memories.length).toBeGreaterThan(0);
    expect(found.memories[0].label).toContain('retention');
  });

  it('reports the offline backend instead of claiming semantic recall', async () => {
    seedMemories();
    await recall.reindexAllMemory();
    const found = await recall.recall('anything');
    expect(found.backend).toBe('hashed-fallback');
    expect(found.note).toMatch(/lexical/i);
  });

  it('returns nothing for an empty query', async () => {
    seedMemories();
    await recall.reindexAllMemory();
    expect((await recall.recall('  ')).memories).toEqual([]);
  });

  it('carries the significance scores through', async () => {
    seedMemories();
    await recall.reindexAllMemory();
    const found = await recall.recall('archived projects purged');
    const retention = found.memories.find((m) => m.id === 'p1');
    expect(retention?.significance?.strategic).toBeCloseTo(0.9, 5);
  });
});

describe('MemoryRecallService — forgetting', () => {
  it('drops a memory from recall without touching the authoritative row', async () => {
    seedMemories();
    await recall.reindexAllMemory();
    expect(recall.forgetMemory('personal_memory', 'p1')).toEqual({ deleted: true });

    const found = await recall.recall('archived projects purged ninety days');
    expect(found.memories.every((m) => m.id !== 'p1')).toBe(true);

    // The authoritative memory is still there — recall indexes it, it does
    // not own it.
    const row = db.prepare(`SELECT memory_value FROM personal_memory WHERE id = 'p1'`).get() as
      | { memory_value: string }
      | undefined;
    expect(row?.memory_value).toContain('ninety days');
  });

  it('refuses a table name outside the known layers', () => {
    expect(recall.forgetMemory('sqlite_master' as never, 'x')).toEqual({ deleted: false });
  });
});
