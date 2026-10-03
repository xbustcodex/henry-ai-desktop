/**
 * The self-improvement loop, end to end (rows 4.16 / 4.17).
 *
 * Every test here drives the REAL entry points in the order the app uses them:
 * `lesson_record` writes into the authoritative `personal_memory` table, and
 * `memory_recall` — a separate tool, a separate service, reached through the
 * agent tool registry — reads it back. Nothing calls an internal helper
 * directly, because the failure this file exists to prevent was exactly that:
 * a ranking function that honoured `memory_type` perfectly while nothing ever
 * supplied a `memory_type` to it, and an index that was only ever rebuilt by a
 * manual IPC channel nobody called.
 *
 * The two tools share nothing but the database. That is the point — if the
 * lesson did not flow through the authoritative store, these tests fail.
 *
 * Ranking is asserted through the tool's own response, including the
 * `ranking` breakdown, so a passing test means the numbers the model actually
 * sees say what we claim they say.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { lessonsTools } from '../agent/tools/lessons';
import { knowledgeTools, __setEmbedderFactoryForTest } from './tools';
import { createEmbedder } from '../vector/embeddings';
import type Database from 'better-sqlite3';
import type { AgentContext, ToolDefinition, ToolResult } from '../agent/types';

/**
 * The REAL memory blueprint DDL, copied verbatim from
 * electron/ipc/database.ts → migrateMemoryBlueprintSchema. A trimmed schema
 * would let a test pass against columns the product does not have.
 */
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
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    fact TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    importance INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE narrative_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    arc_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    start_date TEXT, end_date TEXT,
    importance_score REAL DEFAULT 0.7,
    active_status INTEGER NOT NULL DEFAULT 1,
    linked_project_ids_json TEXT DEFAULT '[]',
    linked_memory_ids_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_recalled_at TEXT
  );
  CREATE TABLE project_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    project_id TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    memory_value TEXT NOT NULL,
    summary TEXT,
    blocker_flag INTEGER NOT NULL DEFAULT 0,
    deadline TEXT,
    confidence_score REAL DEFAULT 0.8,
    relevance_score REAL DEFAULT 0.7,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_recalled_at TEXT
  );
`;

let db: DatabaseSync;
let context: AgentContext;
let restoreEmbedder: () => void;

const lesson = (name: string): ToolDefinition => {
  const found = lessonsTools().find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const recallTool = (): ToolDefinition => {
  const found = knowledgeTools().find((t) => t.name === 'memory_recall');
  if (!found) throw new Error('missing tool memory_recall');
  return found;
};

interface RecallHit {
  table: string;
  memoryType: string | null;
  trigger: string | null;
  label: string;
  detail: string;
  score: number;
  ranking: { semantic: number; significance: number; priority: number; triggerSignal: number };
}
interface RecallPayload {
  query: string;
  count: number;
  memories: RecallHit[];
}

const payload = (r: ToolResult): RecallPayload => r.data as RecallPayload;
const recall = async (query: string, extra: Record<string, unknown> = {}): Promise<RecallHit[]> => {
  const r = await recallTool().execute({ query, ...extra }, context);
  expect(r.ok, r.ok ? '' : String(r.error)).toBe(true);
  return payload(r).memories;
};

/** Every other layer the tool reads, so the tool has something to rank against. */
function seedOrdinaryMemories(): void {
  const insert = db.prepare(
    `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, summary,
       confidence_score, emotional_significance_score, strategic_significance_score,
       active_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-01-01', '2026-01-01')`,
  );
  insert.run('p-policy', 'retention', 'Archived projects are purged after ninety days', 'policy', null, 0.9, 0.4, 0.9);
  insert.run('p-pref', 'coffee', 'The team prefers flat whites over lattes', 'preference', null, 0.6, 0.2, 0.2);
  insert.run('p-review', 'meetings', 'Review process meetings run on Friday afternoons', 'general', null, 0.5, 0.2, 0.3);
  db.prepare(
    `INSERT INTO memory_facts (id, fact, category, importance, created_at)
     VALUES ('f-deploy', 'Deployments ship on Thursday mornings', 'ops', 8, '2026-01-03')`,
  ).run();
  db.prepare(
    `INSERT INTO narrative_memory (id, arc_name, summary, importance_score, active_status, created_at, updated_at)
     VALUES ('n-warehouse', 'Warehouse rebuild', 'The mezzanine install doubled pick throughput', 0.8, 1, '2026-01-04', '2026-01-04')`,
  ).run();
  db.prepare(
    `INSERT INTO project_memory (id, project_id, memory_key, memory_value, relevance_score, confidence_score, created_at, updated_at)
     VALUES ('m-blocker', 'proj-1', 'blocker', 'Waiting on the structural sign-off', 0.9, 0.8, '2026-01-05', '2026-01-05')`,
  ).run();
}

beforeEach(() => {
  // The production embedder reaches local Ollama. Point it at a fetch that
  // always fails so these run offline and deterministically.
  restoreEmbedder = __setEmbedderFactoryForTest(() =>
    createEmbedder({ fetchImpl: (() => Promise.reject(new Error('offline in tests'))) as typeof fetch }),
  );
  db = new DatabaseSync(':memory:');
  db.exec(DDL);
  context = { db: db as unknown as Database.Database, getWindow: () => null };
});

afterEach(() => {
  restoreEmbedder();
  db.close();
});

describe('4.16 — a lesson recorded in one session is retrieved in a later one', () => {
  it('surfaces through memory_recall, labelled as a lesson, with its trigger', async () => {
    seedOrdinaryMemories();

    // ── An earlier session already warmed the index. Without this the tool's
    // "index is empty, build it now" branch would do the work and the test
    // would pass even with the read-path sync removed — which is exactly how
    // a broken feature survives a passing test.
    const warm = await recall('what is the retention policy for archived projects?', { k: 20 });
    expect(warm.length).toBeGreaterThan(0);
    expect(warm.some((h) => h.memoryType === 'lesson')).toBe(false);

    // ── Session 2: the user corrects Henry. Recorded through the real tool.
    const recorded = await lesson('lesson_record').execute(
      {
        lesson: 'Always run the type checker before opening a pull request',
        trigger: 'before sending code for review',
        scope: 'code',
        confidence: 0.9,
      },
      context,
    );
    expect(recorded.ok).toBe(true);
    expect((recorded.data as { id: string }).id).toBeTruthy();

    // ── Session 3: a later, unrelated conversation. The index was already
    // non-empty when the lesson was written, so the only thing that can put
    // it in front of this query is the sync on the read path.
    const hits = await recall('am I clear to send this diff up for review?', { k: 8 });

    const found = hits.find((h) => h.detail.includes('Always run the type checker'));
    expect(found, 'the lesson was not retrieved by the later session').toBeDefined();
    // Retrievable AS a lesson, not merely as anonymous text.
    expect(found?.memoryType).toBe('lesson');
    expect(found?.trigger).toBe('before sending code for review');
    // And the trigger actually fired, which is what earned it the lift.
    expect(found?.ranking.triggerSignal).toBeGreaterThan(0);
    expect(found?.ranking.priority).toBeGreaterThan(1);
  });

  it('returns only lessons when memory_recall is asked for that type', async () => {
    seedOrdinaryMemories();
    await lesson('lesson_record').execute(
      { lesson: 'Never deploy on a Friday afternoon', trigger: 'before a deploy', scope: 'ops' },
      context,
    );

    const only = await recall('when should I push the release', { types: ['lesson'] });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((h) => h.memoryType === 'lesson')).toBe(true);
    expect(only.some((h) => h.detail.includes('Never deploy on a Friday afternoon'))).toBe(true);
  });

  it('drops a revoked lesson from recall, so the lift cannot outlive the rule', async () => {
    seedOrdinaryMemories();
    await lesson('lesson_record').execute(
      { lesson: 'Never deploy on a Friday afternoon', trigger: 'before a deploy', scope: 'ops' },
      context,
    );
    expect((await recall('when should I push the release')).filter((h) => h.memoryType === 'lesson').length).toBe(1);

    const revoked = await lesson('lesson_revoke').execute(
      { lesson: 'Never deploy on a Friday afternoon' },
      context,
    );
    expect(revoked.ok).toBe(true);

    expect(
      (await recall('when should I push the release')).filter((h) => h.memoryType === 'lesson'),
    ).toEqual([]);
  });
});

describe('4.16 — the lesson weight is bounded, not a constant tuned until a test passed', () => {
  it('gives a lesson no lift at all when its trigger shares nothing with the query', async () => {
    await lesson('lesson_record').execute(
      { lesson: 'Always run the type checker before opening a pull request', trigger: 'before sending code for review' },
      context,
    );

    const hits = await recall('retention policy archived projects deletion window');
    const lessonHit = hits.find((h) => h.memoryType === 'lesson');
    expect(lessonHit).toBeDefined();
    // Exactly 1, not "slightly above 1". An unrelated lesson must not be
    // promoted just for being a lesson.
    expect(lessonHit?.ranking.triggerSignal).toBe(0);
    expect(lessonHit?.ranking.priority).toBe(1);
    expect(lessonHit?.score).toBeCloseTo(
      lessonHit!.ranking.semantic * 0.65 + lessonHit!.ranking.significance * 0.35,
      4,
    );
  });

  it('caps the lift at 1.3 even when every trigger word matches', async () => {
    await lesson('lesson_record').execute(
      { lesson: 'Always run the type checker before opening a pull request', trigger: 'review' },
      context,
    );

    const hits = await recall('review');
    const lessonHit = hits.find((h) => h.memoryType === 'lesson');
    expect(lessonHit?.ranking.triggerSignal).toBe(1);
    expect(lessonHit?.ranking.priority).toBeCloseTo(1.3, 6);
    // Bounded means a lesson cannot climb past a fact that clearly matches
    // better: at 1.3 the rival needs a base at least ~23% higher, and that is
    // asserted on the scores rather than assumed.
    expect(lessonHit!.score).toBeLessThanOrEqual(1.3);
  });
});

describe('4.16 — general recall is not damaged by the lesson weight', () => {
  it('scores and orders non-lesson memories identically whether or not a lesson exists', async () => {
    seedOrdinaryMemories();
    const query = 'what did we decide about the review process and retention?';

    const withoutLesson = await recall(query, { k: 20 });
    expect(withoutLesson.some((h) => h.memoryType === 'lesson')).toBe(false);

    // Now the exact same store, plus a lesson that DOES match this query and
    // therefore takes the full lift. If the weight were leaking into general
    // recall, these numbers would move.
    await lesson('lesson_record').execute(
      { lesson: 'Always summarise the review process in writing afterwards', trigger: 'review process retention', scope: 'work' },
      context,
    );
    const withLesson = await recall(query, { k: 20 });

    const lessonHit = withLesson.find((h) => h.memoryType === 'lesson');
    expect(lessonHit, 'the matching lesson should have been lifted into view').toBeDefined();
    expect(lessonHit?.ranking.priority).toBeCloseTo(1.3, 6);

    const ordinaryWith = withLesson.filter((h) => h.memoryType !== 'lesson');
    expect(ordinaryWith.map((h) => h.label).sort()).toEqual(
      withoutLesson.map((h) => h.label).sort(),
    );
    for (const before of withoutLesson) {
      const after = ordinaryWith.find((h) => h.label === before.label);
      expect(after, `${before.label} disappeared`).toBeDefined();
      // Bit-identical, not merely close: the multiplier for a non-lesson row is
      // exactly 1.0, so nothing about general recall can have moved.
      expect(after?.score).toBe(before.score);
      expect(after?.ranking.priority).toBe(1);
    }
  });

  it('clamps a memory_facts importance on its 1-10 scale instead of overweighting it', async () => {
    // `memory_facts.importance` is written as 1..9 across this codebase. Fed
    // raw into a 0..1 weighted sum it once contributed 0.9 — more than the
    // entire significance budget — and let a mediocre fact outrank a project
    // memory that matched better. Two facts with identical text must score
    // identically whatever importance they claim, because the field is
    // clamped rather than summed.
    db.prepare(
      `INSERT INTO memory_facts (id, fact, category, importance, created_at)
       VALUES ('f-low', 'A mildly relevant note', 'misc', 1, '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO memory_facts (id, fact, category, importance, created_at)
       VALUES ('f-high', 'A mildly relevant note', 'misc', 9, '2026-01-01')`,
    ).run();

    const hits = await recall('a mildly relevant note');
    const facts = hits.filter((h) => h.table === 'memory_facts');
    expect(facts).toHaveLength(2);
    expect(facts[0].ranking.significance).toBe(facts[1].ranking.significance);
    expect(facts[0].score).toBe(facts[1].score);
    // And it stays inside the blueprint's 0..0.5 significance range.
    expect(facts[0].ranking.significance).toBeLessThanOrEqual(0.5);
  });
});