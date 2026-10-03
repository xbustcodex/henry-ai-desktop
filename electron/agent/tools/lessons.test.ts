/**
 * Lessons tool — behaviour of the self-improvement loop.
 *
 * Backed by the REAL `personal_memory` DDL (copied verbatim from
 * electron/ipc/database.ts → migrateMemoryBlueprintSchema) on an in-memory
 * node:sqlite handle, so the SQL the tools actually emit is exercised —
 * including the soft-delete (`active_status = 0`) that revocation relies on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import type { AgentContext, ToolResult } from '../types';
import { lessonsTools } from './lessons';

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
`;

/** A `personal_memory` row as the lessons tools read and write it. */
interface MemoryRow {
  id: string;
  memory_key: string;
  memory_value: string;
  memory_type: string;
  summary: string | null;
  source: string | null;
  confidence_score: number;
  relevance_score: number;
  active_status: number;
  created_at: string;
  last_recalled_at: string | null;
}

interface LessonView {
  id: string;
  lesson: string;
  trigger: string | null;
  scope: string;
  confidence: number;
  active: boolean;
  last_recalled_at: string | null;
  score?: number;
}

let db: DatabaseSync;
let ctx: AgentContext;
const tools = lessonsTools();

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const run = (name: string, params: Record<string, unknown>): Promise<ToolResult> =>
  tool(name).execute(params, ctx);
/** ToolResult.data is `unknown` by contract; these tests assert on its shape. */
const payload = <T>(r: ToolResult): T => r.data as T;
const row = (id: string): MemoryRow =>
  // node:sqlite hands back a plain record; the DDL above pins the column types.
  db.prepare('SELECT * FROM personal_memory WHERE id = ?').get(id) as unknown as MemoryRow;
const lessonsOf = (r: ToolResult): LessonView[] =>
  payload<{ lessons: LessonView[] }>(r).lessons;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(DDL);
  ctx = { db: db as unknown as Database.Database, getWindow: () => null };
});

describe('lessons tools — surface', () => {
  it('exposes the record/recall/list/revoke loop with the documented tiers', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'lesson_list',
      'lesson_recall',
      'lesson_record',
      'lesson_revoke',
    ]);
    expect(tool('lesson_record').safetyLevel).toBe('notify');
    expect(tool('lesson_recall').safetyLevel).toBe('silent');
    expect(tool('lesson_list').safetyLevel).toBe('silent');
    expect(tool('lesson_revoke').safetyLevel).toBe('confirm');
    for (const t of tools) expect(t.category).toBe('memory');
  });

  it('revoke is confirm-gated and its prompt quotes the lesson text', () => {
    const revoke = tool('lesson_revoke');
    expect(typeof revoke.confirmPrompt).toBe('function');
    const prompt = revoke.confirmPrompt!({
      lesson: 'Always run the linter before committing',
    });
    expect(prompt).toContain('Always run the linter before committing');
    expect(prompt).toMatch(/forget/i);
  });
});

describe('lesson_record', () => {
  it('persists a lesson into personal_memory as an agent-recorded rule', async () => {
    const r = await run('lesson_record', {
      lesson: 'Always run the linter before committing',
      trigger: 'committing',
      scope: 'code',
      confidence: 0.8,
    });
    expect(r.ok).toBe(true);
    const saved = payload<{ id: string }>(r);
    expect(typeof saved.id).toBe('string');

    const rec = row(saved.id);
    expect(rec.memory_type).toBe('lesson');
    expect(rec.memory_value).toBe('Always run the linter before committing');
    expect(rec.summary).toBe('committing');
    expect(rec.memory_key).toBe('code');
    expect(rec.source).toBe('agent_recorded');
    expect(rec.confidence_score).toBeCloseTo(0.8);
    expect(rec.active_status).toBe(1);
  });

  it('defaults scope to general and confidence to 0.9 for a stated correction', async () => {
    const r = await run('lesson_record', { lesson: 'Stop asking, just do it' });
    const rec = row(payload<{ id: string }>(r).id);
    expect(rec.memory_key).toBe('general');
    expect(rec.confidence_score).toBeCloseTo(0.9);
    expect(rec.summary).toBeNull();
  });

  it('refuses an empty rule and an unbounded one rather than storing junk', async () => {
    expect((await run('lesson_record', { lesson: '   ' })).ok).toBe(false);
    const tooLong = await run('lesson_record', { lesson: 'x'.repeat(2001) });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toMatch(/too long/i);
    const { c } = db
      .prepare('SELECT COUNT(*) AS c FROM personal_memory')
      .get() as unknown as { c: number };
    expect(c).toBe(0);
  });

  it('clamps an out-of-range confidence into 0..1', async () => {
    const hi = await run('lesson_record', { lesson: 'always lint', confidence: 4 });
    const lo = await run('lesson_record', { lesson: 'always test', confidence: -2 });
    expect(payload<{ confidence: number }>(hi).confidence).toBe(1);
    expect(payload<{ confidence: number }>(lo).confidence).toBe(0);
  });
});

describe('lesson_recall', () => {
  it('returns a formatted injection block and stamps last_recalled_at', async () => {
    const rec = await run('lesson_record', {
      lesson: 'Never commit directly to main',
      trigger: 'committing',
    });
    const id = payload<{ id: string }>(rec).id;
    expect(row(id).last_recalled_at).toBeNull();

    const r = await run('lesson_recall', { query: 'committing to main' });
    expect(r.ok).toBe(true);
    const d = payload<{ count: number; block: string; lessons: LessonView[] }>(r);
    expect(d.count).toBe(1);
    expect(d.block).toContain('Remembered preferences:');
    expect(d.block).toContain('- committing: Never commit directly to main');

    const stamped = row(id).last_recalled_at;
    expect(stamped).not.toBeNull();
    expect(d.lessons[0].last_recalled_at).toBe(stamped);
  });

  it('ranks an exact keyword above a near-miss substring match', async () => {
    await run('lesson_record', {
      lesson: 'Prefer staging deployments over production deploys',
      confidence: 0.9,
    });
    await run('lesson_record', {
      lesson: 'Deploy from the release branch only',
      trigger: 'deploy',
      confidence: 0.9,
    });

    const d = payload<{ count: number; lessons: LessonView[] }>(
      await run('lesson_recall', { query: 'deploy' }),
    );
    // Both are recalled — the near miss is not dropped, only outranked.
    expect(d.count).toBe(2);
    expect(d.lessons[0].lesson).toBe('Deploy from the release branch only');
    expect(d.lessons[1].lesson).toBe('Prefer staging deployments over production deploys');
    expect(d.lessons[0].score).toBeGreaterThan(d.lessons[1].score as number);

    // With a tight limit the winner is the exact match, not insertion order.
    const top = lessonsOf(await run('lesson_recall', { query: 'deploy', limit: 1 }));
    expect(top).toHaveLength(1);
    expect(top[0].lesson).toBe('Deploy from the release branch only');
  });

  it('returns nothing for an unrelated query without inventing a lesson', async () => {
    await run('lesson_record', { lesson: 'Never commit directly to main' });
    const r = await run('lesson_recall', { query: 'kubernetes' });
    const d = payload<{ count: number; block: string; lessons: LessonView[] }>(r);
    expect(d.count).toBe(0);
    expect(d.block).toBe('');
    expect(d.lessons).toEqual([]);
  });

  it('falls back to the scope when a lesson has no trigger', async () => {
    await run('lesson_record', { lesson: 'Use metric units', scope: 'recipes' });
    const d = payload<{ block: string }>(await run('lesson_recall', { query: 'metric units' }));
    expect(d.block).toContain('- recipes: Use metric units');
  });

  it('rejects a blank query and a query with no searchable terms', async () => {
    expect((await run('lesson_recall', { query: '  ' })).ok).toBe(false);
    expect((await run('lesson_recall', { query: 'a !' })).ok).toBe(false);
  });
});

describe('lesson_revoke + lesson_list', () => {
  it('soft-deletes: gone from recall and the default list, visible on request', async () => {
    const rec = await run('lesson_record', {
      lesson: 'Never commit directly to main',
      trigger: 'committing',
    });
    const id = payload<{ id: string }>(rec).id;

    const rv = await run('lesson_revoke', { id });
    expect(rv.ok).toBe(true);
    expect(payload<{ id: string; revoked: boolean }>(rv)).toMatchObject({
      id,
      revoked: true,
    });

    // Soft delete, never a DELETE — the row survives for audit.
    const after = row(id);
    expect(after.active_status).toBe(0);
    expect(after.memory_value).toBe('Never commit directly to main');

    expect(payload<{ count: number }>(await run('lesson_recall', { query: 'commit' })).count).toBe(0);
    expect(lessonsOf(await run('lesson_list', {}))).toHaveLength(0);

    const withRevoked = lessonsOf(await run('lesson_list', { include_revoked: true }));
    expect(withRevoked).toHaveLength(1);
    expect(withRevoked[0].active).toBe(false);
  });

  it('revokes by lesson text when the id is unknown', async () => {
    await run('lesson_record', { lesson: 'Never commit directly to main' });
    const r = await run('lesson_revoke', { lesson: 'commit directly' });
    expect(r.ok).toBe(true);
    expect(payload<{ lesson: string }>(r).lesson).toBe('Never commit directly to main');
    expect(lessonsOf(await run('lesson_list', {}))).toHaveLength(0);
  });

  it('refuses to revoke twice, and reports a miss instead of silently no-oping', async () => {
    await run('lesson_record', { lesson: 'Always run the linter' });
    expect((await run('lesson_revoke', { lesson: 'Always run the linter' })).ok).toBe(true);
    const again = await run('lesson_revoke', { lesson: 'Always run the linter' });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already revoked/i);

    const miss = await run('lesson_revoke', { id: 'nope' });
    expect(miss.ok).toBe(false);
    expect(miss.error).toMatch(/no stored lesson/i);

    expect((await run('lesson_revoke', {})).ok).toBe(false);
  });

  it('lists only lessons, never unrelated personal memory', async () => {
    db.prepare(
      `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, created_at, updated_at)
       VALUES ('other', 'general', 'Name: Topher', 'general', '2026-01-01', '2026-01-01')`,
    ).run();
    await run('lesson_record', { lesson: 'Always run the linter' });

    const listed = lessonsOf(await run('lesson_list', { include_revoked: true }));
    expect(listed).toHaveLength(1);
    expect(listed[0].lesson).toBe('Always run the linter');
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) await run('lesson_record', { lesson: `rule number ${i}` });
    expect(lessonsOf(await run('lesson_list', {}))).toHaveLength(5);
    expect(lessonsOf(await run('lesson_list', { limit: 2 }))).toHaveLength(2);
  });
});
