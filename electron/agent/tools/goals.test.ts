/**
 * Goal tools — the agent's view of the user's Goals list.
 *
 * These run against the REAL `goals` DDL (copied verbatim from
 * electron/ipc/database.ts → migrateMemoryBlueprintSchema) on an in-memory
 * node:sqlite handle, NOT a hand-rolled fake db. Two reasons: (1) `goals.ts`
 * writes dynamic SQL — the goal_update SET clause is assembled from the
 * allow-list — and a fake that records SQL strings would only prove the tool
 * formatted a string, not that SQLite accepts it; (2) the table carries
 * `CHECK(status IN (...))` and NOT NULL defaults, so the real engine is what
 * proves a bad status can never be persisted. node:sqlite speaks the same
 * `prepare()/run()/get()/all()` surface as better-sqlite3, so the tools are
 * driven through their normal `AgentContext.db`.
 *
 * better-sqlite3 itself is a native Electron-rebuilt addon that cannot be
 * loaded from plain Node (invalid ELF header), hence node:sqlite here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import type { AgentContext, ToolResult } from '../types';
import { goalsTools } from './goals';

const DDL = `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'paused', 'completed', 'abandoned')),
    priority_score REAL DEFAULT 0.5,
    emotional_significance_score REAL DEFAULT 0.5,
    strategic_significance_score REAL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

interface GoalRow {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  status: string;
  priority_score: number;
  emotional_significance_score: number;
  strategic_significance_score: number;
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

interface GoalView {
  id: string;
  title: string | null;
  summary: string | null;
  status: string;
  priority_score: number;
  emotional_significance_score: number;
  strategic_significance_score: number;
}

let db: DatabaseSync;
let ctx: AgentContext;
const tools = goalsTools();

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const run = (name: string, params: Record<string, unknown>): Promise<ToolResult> =>
  tool(name).execute(params, ctx);
/** ToolResult.data is `unknown` by contract; these tests assert on its shape. */
const payload = <T>(r: ToolResult): T => r.data as T;
const goalsOf = (r: ToolResult): GoalView[] => payload<{ goals: GoalView[] }>(r).goals;
const raw = (id: string): GoalRow | undefined =>
  db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as unknown as GoalRow;
const countAll = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM goals').get() as unknown as { n: number }).n;

const insert = (over: Partial<GoalRow> & { id: string; title: string }): string => {
  db.prepare(
    `INSERT INTO goals (id, title, summary, status, priority_score,
                        emotional_significance_score, strategic_significance_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    over.id,
    over.title,
    over.summary ?? null,
    over.status ?? 'active',
    over.priority_score ?? 0.5,
    over.emotional_significance_score ?? 0.5,
    over.strategic_significance_score ?? 0.5,
  );
  return over.id;
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(DDL);
  ctx = { db: db as unknown as Database.Database, getWindow: () => null };
});

describe('goals tools — surface', () => {
  it('exposes the goal loop with the documented safety tiers', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'goal_create',
      'goal_delete',
      'goal_list',
      'goal_update',
    ]);
    expect(tool('goal_list').safetyLevel).toBe('silent');
    expect(tool('goal_create').safetyLevel).toBe('notify');
    expect(tool('goal_update').safetyLevel).toBe('notify');
    expect(tool('goal_delete').safetyLevel).toBe('confirm');
    for (const t of tools) expect(t.category).toBe('memory');
    // goal_list must not interrupt; goal_delete must ask, and must say which goal.
    expect(tool('goal_list').confirmPrompt).toBeUndefined();
    expect(typeof tool('goal_delete').confirmPrompt).toBe('function');
  });
});

describe('goal_create', () => {
  it('persists a row the Goals panel can read back, with ISO timestamps', async () => {
    const r = await run('goal_create', { title: 'Ship the deck', summary: 'Friday.' });
    expect(r.ok).toBe(true);
    const { id, created } = payload<{ id: string; created: boolean }>(r);
    expect(created).toBe(true);

    const row = raw(id)!;
    expect(row.title).toBe('Ship the deck');
    expect(row.summary).toBe('Friday.');
    // Defaults come from the schema, not from the tool.
    expect(row.status).toBe('active');
    expect(row.priority_score).toBe(0.5);
    expect(row.user_id).toBe('default');
    // memory:saveGoal stamps new Date().toISOString(); created/updated/last_active agree.
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(row.updated_at).toBe(row.created_at);
    expect(row.last_active_at).toBe(row.created_at);
  });

  it('rejects a blank title rather than storing an empty goal', async () => {
    const r = await run('goal_create', { title: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/title/i);
    expect(countAll()).toBe(0);
  });

  it('stores a missing summary as NULL, not an empty string', async () => {
    const { id } = payload<{ id: string }>(await run('goal_create', { title: 'No summary' }));
    expect(raw(id)!.summary).toBeNull();
  });

  it('clamps out-of-range scores into 0..1 instead of failing the call', async () => {
    const { id } = payload<{ id: string }>(
      await run('goal_create', {
        title: 'Clamped',
        priorityScore: 85,
        emotionalSignificanceScore: -3,
        strategicSignificanceScore: 0.42,
      }),
    );
    const row = raw(id)!;
    expect(row.priority_score).toBe(1);
    expect(row.emotional_significance_score).toBe(0);
    expect(row.strategic_significance_score).toBe(0.42);
  });
});

describe('goal_list', () => {
  beforeEach(() => {
    insert({ id: 'a', title: 'Active low', priority_score: 0.1 });
    insert({ id: 'b', title: 'Active high', priority_score: 0.9 });
    insert({ id: 'c', title: 'Paused', status: 'paused', priority_score: 0.99 });
    insert({ id: 'd', title: 'Done', status: 'completed', priority_score: 1 });
  });

  it('defaults to active goals only, matching memory:getGoals', async () => {
    const r = await run('goal_list', {});
    expect(goalsOf(r).map((g) => g.id)).toEqual(['b', 'a']);
    expect(payload<{ status: string }>(r).status).toBe('active');
  });

  it('filters on the status enum', async () => {
    expect(goalsOf(await run('goal_list', { status: 'paused' })).map((g) => g.id)).toEqual(['c']);
    expect(goalsOf(await run('goal_list', { status: 'completed' })).map((g) => g.id)).toEqual(['d']);
    expect(goalsOf(await run('goal_list', { status: 'abandoned' }))).toEqual([]);
  });

  it('refuses a status outside the enum', async () => {
    const r = await run('goal_list', { status: 'archived' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status must be one of/);
  });

  it('clamps limit to 100 and defaults to 20', async () => {
    const clamped = await run('goal_list', { limit: 5000 });
    expect(payload<{ limit: number }>(clamped).limit).toBe(100);
    // Only two active goals exist, so a 100-row cap must not truncate them.
    expect(goalsOf(clamped)).toHaveLength(2);
    expect(payload<{ limit: number }>(await run('goal_list', {})).limit).toBe(20);
    // A real limit still truncates, highest priority first.
    expect(goalsOf(await run('goal_list', { limit: 1 })).map((g) => g.id)).toEqual(['b']);
  });

  it('ignores a nonsensical limit rather than returning nothing', async () => {
    expect(payload<{ limit: number }>(await run('goal_list', { limit: 0 })).limit).toBe(20);
    expect(payload<{ limit: number }>(await run('goal_list', { limit: -5 })).limit).toBe(20);
  });

  it('returns an empty list rather than failing when there are no goals', async () => {
    db.exec('DELETE FROM goals');
    const r = await run('goal_list', {});
    expect(r.ok).toBe(true);
    expect(goalsOf(r)).toEqual([]);
  });

  it('sees a goal the panel inserted directly — one table, one source of truth', async () => {
    insert({ id: 'panel', title: 'Written by the panel', priority_score: 0.95 });
    expect(goalsOf(await run('goal_list', {})).map((g) => g.id)).toContain('panel');
  });
});

describe('goal_update', () => {
  it('applies the allow-listed fields and bumps updated_at', async () => {
    const id = insert({ id: 'g1', title: 'Old', summary: 'old summary' });
    // Backdate the stamps so "bumped" means moved forward, not merely rewritten.
    db.prepare("UPDATE goals SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);

    const r = await run('goal_update', {
      id,
      title: '  New title  ',
      summary: 'new summary',
      status: 'completed',
      priority_score: 0.8,
    });
    expect(r.ok).toBe(true);

    const row = raw(id)!;
    expect(row.title).toBe('New title');
    expect(row.summary).toBe('new summary');
    expect(row.status).toBe('completed');
    expect(row.priority_score).toBe(0.8);
    // memory:updateGoal stamps ISO here, where the schema default was SQLite's
    // datetime('now') — and it must have moved forward from the backdated value.
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(row.updated_at > '2000-01-01T00:00:00.000Z').toBe(true);
    expect(row.last_active_at).toBe(row.updated_at);
  });

  it('cannot reach user_id or created_at through an injected column', async () => {
    const id = insert({ id: 'g1', title: 'Keep me' });
    const created = raw(id)!.created_at;

    const r = await run('goal_update', {
      id,
      title: 'Renamed',
      user_id: 'attacker',
      created_at: '1999-01-01T00:00:00.000Z',
      id_injected: 'nope',
    } as Record<string, unknown>);

    // The allow-listed change still lands...
    expect(raw(id)!.title).toBe('Renamed');
    // ...but nothing outside the allow-list moved.
    expect(raw(id)!.user_id).toBe('default');
    expect(raw(id)!.created_at).toBe(created);
    expect(payload<{ updated: boolean }>(r).updated).toBe(true);
  });

  it('returns updated:false when only non-allow-listed fields are supplied', async () => {
    const id = insert({ id: 'g1', title: 'Untouched' });
    const r = await run('goal_update', { id, user_id: 'attacker' } as Record<string, unknown>);
    expect(r.ok).toBe(true);
    expect(payload<{ updated: boolean }>(r).updated).toBe(false);
    expect(raw(id)!.user_id).toBe('default');
    expect(raw(id)!.title).toBe('Untouched');
  });

  it('refuses an invalid status rather than letting SQLite reject it', async () => {
    const id = insert({ id: 'g1', title: 'Valid so far', status: 'active' });
    const r = await run('goal_update', { id, status: 'archived' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status must be one of/);
    // The failed call must not have half-applied.
    expect(raw(id)!.status).toBe('active');
  });

  it('refuses a blank title', async () => {
    const id = insert({ id: 'g1', title: 'Has a title' });
    expect((await run('goal_update', { id, title: '  ' })).ok).toBe(false);
    expect(raw(id)!.title).toBe('Has a title');
  });

  it('errors on an id that matches nothing', async () => {
    const r = await run('goal_update', { id: 'does-not-exist', status: 'paused' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No goal found/);
    expect(countAll()).toBe(0);
  });

  it('requires an id', async () => {
    expect((await run('goal_update', { title: 'orphan' })).ok).toBe(false);
  });

  it('clears the summary when given an empty one', async () => {
    const id = insert({ id: 'g1', title: 't', summary: 'something' });
    await run('goal_update', { id, summary: '   ' });
    expect(raw(id)!.summary).toBeNull();
  });
});

describe('goal_delete', () => {
  it('removes only the named goal', async () => {
    const a = insert({ id: 'a', title: 'Delete me' });
    insert({ id: 'b', title: 'Keep me' });

    const r = await run('goal_delete', { id: a });
    expect(payload<{ deleted: boolean; title: string }>(r)).toMatchObject({
      deleted: true,
      title: 'Delete me',
    });
    expect(raw(a)).toBeUndefined();
    expect(raw('b')).toBeDefined();
  });

  it('errors on an unknown id instead of silently reporting success', async () => {
    const r = await run('goal_delete', { id: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No goal found/);
  });

  it('requires an id', async () => {
    expect((await run('goal_delete', {})).ok).toBe(false);
  });

  it('names the goal title in the confirm prompt', async () => {
    const id = insert({ id: 'a', title: 'Quit the gym' });
    // The prompt is built from params alone, so the title comes from what the
    // agent has already seen this session.
    await run('goal_list', {});
    const prompt = tool('goal_delete').confirmPrompt!({ id });
    expect(prompt).toContain('Quit the gym');
    expect(prompt).toMatch(/cannot be undone/);
  });

  it('falls back to the id when the title was never seen', () => {
    const prompt = tool('goal_delete').confirmPrompt!({ id: 'never-seen' });
    expect(prompt).toContain('never-seen');
  });

  it('confirms the newly created goal by its title too', async () => {
    const { id } = payload<{ id: string }>(
      await run('goal_create', { title: 'Learn Portuguese' }),
    );
    expect(tool('goal_delete').confirmPrompt!({ id })).toContain('Learn Portuguese');
  });
});