/**
 * Daily / weekly rollups (row 8.7).
 *
 * The `memory_summaries` table, its IPC handlers and the companion
 * `GET /sync/companion/summaries` route were all already wired. Nothing ever
 * wrote a `daily_rollup` or `weekly_rollup` row, so the route served an empty
 * list forever. These tests build the rollup over the REAL tables the app
 * writes to — the same DDL, column for column — and assert the two properties
 * that make it a producer rather than a template: it reflects real rows, and it
 * is deterministic enough to check.
 *
 * Determinism is asserted by generating twice over an unchanged database and
 * comparing byte for byte. That is a stronger claim than "looks stable": a
 * clock read, an unordered query or a locale-formatted number would break it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { buildRollup, dailyWindow, weeklyWindow } from './rollup';
import type { SqlDatabase } from '../vector/sql';

/**
 * The real DDL. `personal_tasks`, `journal_entries`, `transactions`,
 * `focus_sessions` and `reminders` are created by inline statements inside
 * `registerMemoryHandlers`, so they are reproduced here exactly as that file
 * declares them — a trimmed version would let the rollup pass against columns
 * the product does not have.
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
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    status TEXT NOT NULL DEFAULT 'active',
    summary TEXT,
    strategic_importance_score REAL DEFAULT 0.5,
    emotional_importance_score REAL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE commitments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    source_conversation_id TEXT,
    project_id TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    due_date TEXT,
    importance_score REAL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE memory_summaries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    summary_type TEXT NOT NULL,
    period_label TEXT,
    summary TEXT NOT NULL,
    linked_memory_ids_json TEXT DEFAULT '[]',
    linked_project_ids_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE personal_tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
    priority INTEGER NOT NULL DEFAULT 2, due_at TEXT,
    created_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, amount REAL NOT NULL,
    category TEXT NOT NULL, description TEXT, date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE journal_entries (
    id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, title TEXT,
    content TEXT NOT NULL, mood TEXT, tags TEXT DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT,
    due_at TEXT NOT NULL, repeat TEXT DEFAULT 'none',
    done INTEGER DEFAULT 0, notified_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE focus_sessions (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, duration_mins INTEGER NOT NULL,
    completed_at TEXT NOT NULL, henry_checkin TEXT
  );
`;

let db: DatabaseSync;
let handle: SqlDatabase;
const handleOf = (d: DatabaseSync): SqlDatabase => d as unknown as SqlDatabase;

/** A fixed instant, so the window never depends on when the suite runs. */
const NOW = new Date(2026, 9, 3, 14, 30, 0);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(DDL);
  handle = handleOf(db);
});

afterEach(() => {
  db.close();
});

/** One fixed day of real activity, dated inside `NOW`'s window. */
function seedOneDay(): void {
  const at = (time: string): string => `2026-10-03T${time}:00.000Z`;
  db.prepare(
    `INSERT INTO personal_tasks (id, title, status, priority, due_at, created_at, completed_at)
     VALUES ('t1','Ship the migration','done',1,?,?,?)`,
  ).run(at('18:00'), at('09:00'), at('17:30'));
  db.prepare(
    `INSERT INTO personal_tasks (id, title, status, priority, due_at, created_at)
     VALUES ('t2','Write the retro','todo',2,?,?)`,
  ).run(at('20:00'), at('09:00'));
  db.prepare(
    `INSERT INTO commitments (id, description, status, due_date, importance_score, created_at, updated_at, completed_at)
     VALUES ('c1','Send the signed SOW','completed',?,0.9,?,?,?)`,
  ).run('2026-10-02', at('08:00'), at('16:00'), at('16:00'));
  db.prepare(
    `INSERT INTO commitments (id, description, status, due_date, importance_score, created_at, updated_at)
     VALUES ('c2','Chase the structural sign-off','open',?,0.8,?,?)`,
  ).run('2026-10-01', at('08:00'), at('08:00'));
  db.prepare(
    `INSERT INTO commitments (id, description, status, due_date, importance_score, created_at, updated_at)
     VALUES ('c3','Renew the domain','open',?,0.4,?,?)`,
  ).run('2026-11-01', at('08:00'), at('08:00'));
  db.prepare(
    `INSERT INTO focus_sessions (id, task, duration_mins, completed_at) VALUES ('f1','Ship the migration',95,?)`,
  ).run(at('13:00'));
  db.prepare(
    `INSERT INTO focus_sessions (id, task, duration_mins, completed_at) VALUES ('f2','Write the retro',25,?)`,
  ).run(at('19:00'));
  db.prepare(
    `INSERT INTO journal_entries (id, date, title, content, mood, created_at, updated_at)
     VALUES ('j1','2026-10-03','Migration day','Shipped it','good',?,?)`,
  ).run(at('21:00'), at('21:00'));
  db.prepare(
    `INSERT INTO transactions (id, type, amount, category, description, date, created_at)
     VALUES ('x1','income',2500,'client','Milestone one',?,?)`,
  ).run('2026-10-03', at('12:00'));
  db.prepare(
    `INSERT INTO transactions (id, type, amount, category, description, date, created_at)
     VALUES ('x2','expense',310.25,'tools','Hosting',?,?)`,
  ).run('2026-10-03', at('12:00'));
  db.prepare(
    `INSERT INTO memory_facts (id, fact, category, importance, created_at)
     VALUES ('mf1','The client signs off before the migration window opens','client',8,?)`,
  ).run(at('11:00'));
  db.prepare(
    `INSERT INTO personal_memory (id, memory_key, memory_value, memory_type, summary,
       confidence_score, created_at, updated_at)
     VALUES ('pm1','code','Always run the type checker before opening a pull request','lesson',
       'before sending code for review',0.9,?,?)`,
  ).run(at('15:00'), at('15:00'));
  db.prepare(
    `INSERT INTO projects (id, name, status, updated_at, last_active_at) VALUES ('pr1','Atlas','active',?,?)`,
  ).run(at('17:00'), at('17:00'));
}

describe('8.7 — window resolution', () => {
  it('labels a daily rollup with the date it covers', () => {
    expect(dailyWindow(NOW)).toEqual({ label: '2026-10-03', start: '2026-10-03', end: '2026-10-03' });
  });

  it('spans the trailing seven days for a weekly rollup', () => {
    expect(weeklyWindow(NOW)).toEqual({
      label: '2026-09-27 → 2026-10-03',
      start: '2026-09-27',
      end: '2026-10-03',
    });
  });
});

describe('8.7 — a real summary from real data', () => {
  it('reports what the tables actually hold', () => {
    seedOneDay();
    const rollup = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));

    expect(rollup.stats.tasksDone).toBe(1);
    // "Still open" is current state, not a windowed count — only t2 qualifies.
    expect(rollup.stats.tasksOpen).toBe(1);
    expect(rollup.stats.commitmentsClosed).toBe(1);
    expect(rollup.stats.commitmentsOpen).toBe(2);
    // One of the two open commitments was due before the window opened.
    expect(rollup.stats.commitmentsOverdue).toBe(1);
    expect(rollup.stats.focusMinutes).toBe(120);
    expect(rollup.stats.focusSessions).toBe(2);
    expect(rollup.stats.journalEntries).toBe(1);
    expect(rollup.stats.moneyIn).toBe(2500);
    expect(rollup.stats.moneyOut).toBeCloseTo(310.25, 2);
    expect(rollup.stats.factsLearned).toBe(1);
    expect(rollup.stats.lessonsRecorded).toBe(1);
    expect(rollup.stats.projectsTouched).toBe(1);
  });

  it('writes the figures and the rows into the markdown a person reads', () => {
    seedOneDay();
    const { markdown } = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));

    expect(markdown).toMatch(/^# Daily rollup — 2026-10-03/);
    expect(markdown).toContain('Period: 2026-10-03 to 2026-10-03');
    expect(markdown).toContain('Ship the migration');
    expect(markdown).toContain('Write the retro');
    expect(markdown).toContain('Chase the structural sign-off');
    expect(markdown).toContain('1 overdue — needs a decision');
    expect(markdown).toContain('2h 00m of focused work across 2 session(s)');
    expect(markdown).toContain('Net 2189.75');
    // A recorded lesson shows up as a lesson, not as an anonymous fact.
    expect(markdown).toContain('Lesson: Always run the type checker before opening a pull request');
    expect(markdown).toContain('The client signs off before the migration window opens');
    expect(markdown).toContain('Atlas');
  });

  it('links the memory and project rows the summary was built from', () => {
    seedOneDay();
    const rollup = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    expect(rollup.linkedMemoryIds).toEqual(expect.arrayContaining(['mf1', 'pm1']));
    expect(rollup.linkedProjectIds).toEqual(['pr1']);
  });

  it('excludes rows outside the window rather than widening the period', () => {
    seedOneDay();
    db.prepare(
      `INSERT INTO personal_tasks (id, title, status, priority, created_at, completed_at)
       VALUES ('t-old','Ancient history','done',1,'2026-01-01T09:00:00.000Z','2026-01-01T10:00:00.000Z')`,
    ).run();

    const rollup = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    expect(rollup.stats.tasksDone).toBe(1);
    expect(rollup.markdown).not.toContain('Ancient history');
  });

  it('rolls seven days up for a weekly period', () => {
    seedOneDay();
    const rollup = buildRollup(handle, 'weekly_rollup', weeklyWindow(NOW));
    expect(rollup.periodLabel).toBe('2026-09-27 → 2026-10-03');
    expect(rollup.markdown).toMatch(/^# Weekly rollup/);
    expect(rollup.stats.tasksDone).toBe(1);
  });

  it('produces a report rather than nothing when the optional tables are absent', () => {
    // A database where the inline-DDL tables were never created. The rollup
    // must still be true about what it can see.
    db.exec('DROP TABLE personal_tasks; DROP TABLE focus_sessions;');
    const rollup = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    expect(rollup.stats.tasksDone).toBe(0);
    expect(rollup.stats.focusMinutes).toBe(0);
    expect(rollup.markdown).toContain('# Daily rollup');
  });
});

describe('8.7 — the output is deterministic, so it can be checked', () => {
  it('produces byte-identical text for the same database and window', () => {
    seedOneDay();
    const first = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    const second = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    expect(second.markdown).toBe(first.markdown);
    expect(second.stats).toEqual(first.stats);
  });

  it('does not change between calls hours apart on the same day', () => {
    seedOneDay();
    const morning = buildRollup(handle, 'daily_rollup', dailyWindow(new Date(2026, 9, 3, 8, 0, 0)));
    const evening = buildRollup(handle, 'daily_rollup', dailyWindow(new Date(2026, 9, 3, 23, 59, 0)));
    expect(evening.markdown).toBe(morning.markdown);
  });

  it('orders equal-priority rows the same way every run', () => {
    // Two tasks with identical priority and due date — the tie-break must be
    // the row id, not whatever order SQLite happened to return.
    for (const [id, title] of [
      ['t-b', 'Beta write-up'],
      ['t-a', 'Alpha write-up'],
    ] as const) {
      db.prepare(
        `INSERT INTO personal_tasks (id, title, status, priority, due_at, created_at)
         VALUES (?,?,'todo',2,'2026-10-03T20:00:00.000Z','2026-10-03T09:00:00.000Z')`,
      ).run(id, title);
    }
    seedOneDay();
    const first = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    const second = buildRollup(handle, 'daily_rollup', dailyWindow(NOW));
    expect(second.markdown).toBe(first.markdown);
    expect(first.markdown.indexOf('Alpha write-up')).toBeLessThan(
      first.markdown.indexOf('Beta write-up'),
    );
  });
});