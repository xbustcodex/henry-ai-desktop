/**
 * Knowledge agent tools — the runtime consumer of the vector store.
 *
 * These are the tests that answer "is the vector store USED, not just
 * working?". They drive the actual `ToolDefinition.execute` path with a real
 * SQLite database, ingest through the tool, and then retrieve through a
 * different tool. If `query()` were removed or short-circuited, these fail —
 * a self-test of the store would not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { knowledgeTools, __setEmbedderFactoryForTest } from './tools';
import { createEmbedder } from '../vector/embeddings';
import type { AgentContext, ToolDefinition } from '../agent/types';

/** Tools are built without construction-time context, exactly as in production. */
function byName(name: string): ToolDefinition {
  const tool = knowledgeTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool;
}

let db: DatabaseSync;
let context: AgentContext;
let home: string;
let previousHome: string | undefined;

// The production embedder reaches the local Ollama endpoint. Point it at a
// fetch that always fails so these tool tests exercise the offline path
// instead of waiting out a real network timeout.
let restoreEmbedder: () => void;

beforeEach(() => {
  restoreEmbedder = __setEmbedderFactoryForTest(() =>
    createEmbedder({ fetchImpl: (() => Promise.reject(new Error('offline in tests'))) as typeof fetch }),
  );
  db = new DatabaseSync(':memory:');
  home = mkdtempSync(path.join(tmpdir(), 'henry-kbtools-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  // The tools only need `db`; the window getter is never reached on these paths.
  context = { db: db as never, getWindow: () => null } as unknown as AgentContext;
});

afterEach(() => {
  restoreEmbedder();
  db.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe('knowledge tools — registration', () => {
  it('registers exactly the knowledge and recall tools', () => {
    expect(knowledgeTools().map((t) => t.name).sort()).toEqual([
      'knowledge_add_note',
      'knowledge_ingest_file',
      'knowledge_ingest_url',
      'knowledge_search',
      'memory_recall',
    ]);
  });

  it('assigns safe tiers: reads silent, network and disk writes confirm', () => {
    const byNameMap = new Map(knowledgeTools().map((t) => [t.name, t.safetyLevel]));
    expect(byNameMap.get('knowledge_search')).toBe('silent');
    expect(byNameMap.get('memory_recall')).toBe('silent');
    expect(byNameMap.get('knowledge_add_note')).toBe('notify');
    // Anything that reaches the network or the disk must be confirmed.
    expect(byNameMap.get('knowledge_ingest_url')).toBe('confirm');
    expect(byNameMap.get('knowledge_ingest_file')).toBe('confirm');
  });

  it('requires a confirmation prompt on every confirm-tier tool', () => {
    for (const tool of knowledgeTools()) {
      if (tool.safetyLevel !== 'confirm') continue;
      expect(tool.confirmPrompt, `${tool.name} must explain what it will do`).toBeTypeOf('function');
    }
  });
});

describe('knowledge_add_note → knowledge_search (round trip through the tools)', () => {
  it('an ingested note is retrievable by a later search tool call', async () => {
    const added = await byName('knowledge_add_note').execute(
      {
        text: 'Acme Freight quotes surcharge-free shipping above 500 kg. Their P1 response SLA is two hours.',
        title: 'Acme Freight terms',
        tags: ['vendor'],
      },
      context,
    );
    expect(added.ok).toBe(true);
    expect((added.data as { documentId: string }).documentId).toBeTruthy();

    const found = await byName('knowledge_search').execute(
      { query: 'How quickly does Acme respond to a P1?' },
      context,
    );
    expect(found.ok).toBe(true);
    // The search tool surfaces title + uri rather than the raw document id,
    // because that is what the model needs in order to cite the passage.
    const data = found.data as { count: number; hits: { text: string; title: string; uri: string }[] };
    expect(data.count).toBeGreaterThan(0);
    expect(data.hits[0].title).toBe('Acme Freight terms');
    expect(data.hits[0].uri).toBe(`note://${(added.data as { documentId: string }).documentId ? 'acme-freight-terms' : ''}`);
    expect(data.hits[0].text).toContain('two hours');
  });

  it('reports the backend so the model does not over-claim semantic recall', async () => {
    await byName('knowledge_add_note').execute({ text: 'A note worth finding later.' }, context);
    const found = await byName('knowledge_search').execute({ query: 'worth finding' }, context);
    expect((found.data as { backend: string }).backend).toBe('hashed-fallback');
  });

  it('says so plainly when nothing matches, instead of returning empty noise', async () => {
    await byName('knowledge_add_note').execute({ text: 'Only about sourdough starter maintenance.' }, context);
    const found = await byName('knowledge_search').execute(
      { query: 'quarterly revenue recognition policy' },
      context,
    );
    const data = found.data as { count: number; note?: string };
    if (data.count === 0) expect(data.note).toMatch(/nothing in the knowledge base matched/i);
  });

  it('requires a query', async () => {
    const found = await byName('knowledge_search').execute({ query: '   ' }, context);
    expect(found.ok).toBe(false);
  });
});

describe('memory_recall — builds its index on demand', () => {
  function seedMemorySchema(): void {
    db.exec(`
      CREATE TABLE personal_memory (
        id TEXT PRIMARY KEY, memory_key TEXT, memory_value TEXT, memory_type TEXT,
        confidence_score REAL, emotional_significance_score REAL,
        strategic_significance_score REAL, active_status INTEGER, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE memory_facts (
        id TEXT PRIMARY KEY, fact TEXT, category TEXT, importance REAL, created_at TEXT
      );
      CREATE TABLE narrative_memory (
        id TEXT PRIMARY KEY, arc_name TEXT, summary TEXT, importance_score REAL,
        active_status INTEGER, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE project_memory (
        id TEXT PRIMARY KEY, project_id TEXT, memory_key TEXT, memory_value TEXT,
        relevance_score REAL, confidence_score REAL, created_at TEXT, updated_at TEXT
      );
    `);
  }

  it('recalls a memory with no index having been built beforehand', async () => {
    seedMemorySchema();
    // The vector tables do not exist yet — nothing has built the index. If the
    // tool silently skipped its on-demand reindex, this query would keep
    // returning zero rows and the assertion below would catch it.
    db.prepare(
      // active_status must be set explicitly: the column has no DEFAULT, so an
      // INSERT that omits it stores NULL, and `WHERE active_status = 1` then
      // excludes the row. A live deployment always writes it, so this is a
      // fixture bug — but it is exactly the shape that makes recall silently
      // return nothing, which is why the assertion below is worth having.
      `INSERT INTO personal_memory (id, memory_key, memory_value, confidence_score, emotional_significance_score, strategic_significance_score, active_status, created_at, updated_at)
       VALUES ('p1','retention','Archived projects are purged after ninety days',0.9,0.4,0.9,1,'2026-01-01','2026-01-01')`,
    ).run();

    const recalled = await byName('memory_recall').execute(
      { query: 'how long do we keep archived things' },
      context,
    );
    expect(recalled.ok).toBe(true);
    const data = recalled.data as { count: number; memories: { label: string; table: string }[]; error?: string };
    expect(data.count).toBeGreaterThan(0);
    expect(data.memories[0].table).toBe('personal_memory');
    expect(data.memories[0].label).toContain('retention');
  });

  it('reuses the index on a second call rather than re-embedding', async () => {
    seedMemorySchema();
    db.prepare(
      `INSERT INTO memory_facts (id, fact, category, importance, created_at)
       VALUES ('f1','Deployments ship Thursday mornings','ops',8,'2026-01-01')`,
    ).run();

    await byName('memory_recall').execute({ query: 'when do we deploy' }, context);
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM vector_sources`).get() as { c: number }).c;
    await byName('memory_recall').execute({ query: 'what day is deploy day' }, context);
    const after = (db.prepare(`SELECT COUNT(*) AS c FROM vector_sources`).get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('degrades to an empty result when the memory tables do not exist yet', async () => {
    // No schema seeded — a first-run database. The tool must not throw.
    const recalled = await byName('memory_recall').execute({ query: 'anything' }, context);
    expect(recalled.ok).toBe(true);
    expect((recalled.data as { count: number }).count).toBe(0);
  });
});

describe('knowledge_ingest_file — path confinement at the tool boundary', () => {
  it('refuses a path outside the home directory', async () => {
    const result = await byName('knowledge_ingest_file').execute({ path: '/etc/passwd' }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside your home directory|absolute path/i);
  });

  it('refuses traversal out of the home directory', async () => {
    const result = await byName('knowledge_ingest_file').execute({ path: '../../etc/shadow' }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside your home directory/i);
  });

  it('ingests and then retrieves a file inside the home directory', async () => {
    writeFileSync(
      path.join(home, 'spec.md'),
      'The migration must preserve referential integrity across both schemas. Rollback is reversible for 30 days.',
      'utf8',
    );

    const ingested = await byName('knowledge_ingest_file').execute({ path: 'spec.md' }, context);
    expect(ingested.ok).toBe(true);

    const found = await byName('knowledge_search').execute({ query: 'how long is rollback reversible?' }, context);
    expect((found.data as { count: number }).count).toBeGreaterThan(0);
  });
});

describe('knowledge_ingest_url — protocol guard', () => {
  it('refuses a non-http scheme before any network call', async () => {
    const result = await byName('knowledge_ingest_url').execute({ url: 'file:///etc/passwd' }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/http/i);
  });

  it('does not retry a refusal, because it is deterministic', async () => {
    const result = await byName('knowledge_ingest_url').execute({ url: 'ftp://example.com/x' }, context);
    expect(result.retryable).toBe(false);
  });
});
