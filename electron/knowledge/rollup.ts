/**
 * Daily and weekly rollups (row 8.7).
 *
 * The `memory_summaries` table, its IPC handlers and the companion
 * `GET /sync/companion/summaries` route all existed and had no producer:
 * nothing in the app ever wrote a `daily_rollup` or `weekly_rollup` row, so
 * the route served an empty list forever. This module is that producer.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   1. **Deterministic.** No model call, no clock read, no locale formatting.
 *      Every value comes from a SQL aggregate over a caller-supplied window,
 *      and every query has an explicit `ORDER BY` including the row id, so the
 *      same database with the same window produces byte-identical markdown.
 *      That is what makes the output checkable in a test instead of merely
 *      plausible — and what makes it safe to regenerate.
 *
 *   2. **Read-only.** It reads the authoritative tables and returns text. The
 *      caller decides whether to persist, which is what keeps the privacy
 *      switch (`persistMemory`) enforceable at the one place that writes.
 *
 * A rollup is a rollup of what Henry actually recorded, so it reads the same
 * tables the rest of the app reads rather than a private staging area.
 */

import type { SqlDatabase } from '../vector/sql';

/** The `memory_summaries.summary_type` values this module produces. */
export type RollupPeriod = 'daily_rollup' | 'weekly_rollup';

export interface RollupWindow {
  /** What `period_label` is stored as, e.g. `2026-10-03` or `2026-09-27 → 2026-10-03`. */
  label: string;
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  end: string;
}

export interface RollupStats {
  tasksDone: number;
  tasksOpen: number;
  commitmentsClosed: number;
  commitmentsOpen: number;
  commitmentsOverdue: number;
  focusMinutes: number;
  focusSessions: number;
  journalEntries: number;
  moneyIn: number;
  moneyOut: number;
  factsLearned: number;
  lessonsRecorded: number;
  memoriesUpdated: number;
  projectsTouched: number;
}

export interface Rollup {
  summaryType: RollupPeriod;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  /** The rollup body. Deterministic given the window and the database. */
  markdown: string;
  stats: RollupStats;
  linkedMemoryIds: string[];
  linkedProjectIds: string[];
}

const EMPTY_STATS: RollupStats = {
  tasksDone: 0,
  tasksOpen: 0,
  commitmentsClosed: 0,
  commitmentsOpen: 0,
  commitmentsOverdue: 0,
  focusMinutes: 0,
  focusSessions: 0,
  journalEntries: 0,
  moneyIn: 0,
  moneyOut: 0,
  factsLearned: 0,
  lessonsRecorded: 0,
  memoriesUpdated: 0,
  projectsTouched: 0,
};

/** `YYYY-MM-DD` in local time, which is the "day" a person means. */
function dayStamp(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Today, in local time. */
export function dailyWindow(now: Date): RollupWindow {
  const end = dayStamp(now);
  return { label: end, start: end, end };
}

/**
 * The trailing seven days ending today — the same window `weekly:data` uses,
 * so the rollup and the Weekly panel cannot disagree about what "this week"
 * meant.
 */
export function weeklyWindow(now: Date): RollupWindow {
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(endDate.getTime() - 6 * 86400000);
  const start = dayStamp(startDate);
  const end = dayStamp(endDate);
  return { label: `${start} → ${end}`, start, end };
}

export function windowFor(period: RollupPeriod, now: Date): RollupWindow {
  return period === 'daily_rollup' ? dailyWindow(now) : weeklyWindow(now);
}

/**
 * Run a query, returning `[]` when the table is absent.
 *
 * `personal_tasks`, `journal_entries`, `transactions`, `focus_sessions` and
 * `reminders` are created by inline DDL inside `registerMemoryHandlers`, not by
 * the migration file, so a table genuinely can be missing — a rollup over the
 * layers that do exist is far more useful than no rollup at all.
 */
function rows(db: SqlDatabase, sql: string, params: string[] = []): Record<string, unknown>[] {
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/** Run a single-value aggregate, defaulting when the table is absent. */
function scalar(db: SqlDatabase, sql: string, fallback: number, params: string[] = []): number {
  const row = rows(db, sql, params)[0];
  if (!row) return fallback;
  const value = Object.values(row)[0];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Money to two decimals, with a stable sign convention. */
function money(n: number): string {
  return n.toFixed(2);
}

/** Minutes as `2h 05m` / `45m`, which is how a person reads a time budget. */
function duration(mins: number): string {
  if (mins <= 0) return '0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * Build the rollup for one window. Pure with respect to everything except the
 * database handle — the same handle and window always give the same string.
 */
export function buildRollup(
  db: SqlDatabase,
  period: RollupPeriod,
  window: RollupWindow,
): Rollup {
  const { start, end } = window;
  // Timestamps in these tables are stored in several shapes — ISO with a `T`,
  // ISO with a space, and bare `YYYY-MM-DD`. Comparing the first ten
  // characters makes one range filter correct for all three.
  const from = `${start}T00:00:00`;
  const to = `${end}T23:59:59`;

  const doneTasks = rows(
    db,
    `SELECT id, title FROM personal_tasks
     WHERE status = 'done' AND IFNULL(completed_at, created_at) >= ? AND IFNULL(completed_at, created_at) <= ?
     ORDER BY completed_at DESC, id ASC LIMIT 10`,
    [from, to],
  );
  const openTasks = rows(
    db,
    `SELECT id, title, priority FROM personal_tasks
     WHERE status IN ('todo','doing') AND IFNULL(due_at, '9999') <= ?
     ORDER BY priority ASC, due_at ASC, id ASC LIMIT 10`,
    [to],
  );
  const openCommitments = rows(
    db,
    `SELECT id, description, due_date FROM commitments
     WHERE status IN ('open','in_progress')
     ORDER BY IFNULL(due_date, '9999-12-31') ASC, importance_score DESC, id ASC
     LIMIT 10`,
  );
  const overdueCommitments = rows(
    db,
    `SELECT id FROM commitments WHERE status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date ASC, id ASC`,
    [start],
  );
  const focusMinutes = scalar(
    db,
    `SELECT SUM(duration_mins) FROM focus_sessions WHERE completed_at >= ? AND completed_at <= ?`,
    0,
    [from, to],
  );
  const focusSessions = rows(
    db,
    `SELECT id FROM focus_sessions WHERE completed_at >= ? AND completed_at <= ?`,
    [from, to],
  ).length;
  const journal = rows(
    db,
    `SELECT date, title, mood FROM journal_entries
     WHERE date >= ? AND date <= ? ORDER BY date ASC, id ASC`,
    [start, end],
  );
  const moneyRows = rows(
    db,
    `SELECT type, SUM(amount) AS total FROM transactions
     WHERE date >= ? AND date <= ?
     GROUP BY type ORDER BY type ASC`,
    [start, end],
  );
  const facts = rows(
    db,
    `SELECT id, fact, importance FROM memory_facts
     WHERE created_at >= ? AND created_at <= ?
     ORDER BY importance DESC, id ASC LIMIT 8`,
    [from, to],
  );
  const lessons = rows(
    db,
    `SELECT id, memory_value FROM personal_memory
     WHERE memory_type = 'lesson' AND created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC, id ASC LIMIT 8`,
    [from, to],
  );
  const memoriesUpdated = rows(
    db,
    `SELECT id FROM personal_memory WHERE updated_at >= ? AND updated_at <= ? ORDER BY id ASC`,
    [from, to],
  ).length;
  const projectsTouched = rows(
    db,
    `SELECT id, name FROM projects
     WHERE (last_active_at >= ? AND last_active_at <= ?) OR (updated_at >= ? AND updated_at <= ?)
     ORDER BY id ASC`,
    [from, to, from, to],
  );

  let moneyIn = 0;
  let moneyOut = 0;
  for (const row of moneyRows) {
    const total = Number(row.total ?? 0);
    if (!Number.isFinite(total)) continue;
    if (String(row.type).toLowerCase() === 'expense') moneyOut += total;
    else moneyIn += total;
  }

  const stats: RollupStats = {
    tasksDone: scalar(db, `SELECT COUNT(*) FROM personal_tasks WHERE status = 'done' AND IFNULL(completed_at, created_at) >= ? AND IFNULL(completed_at, created_at) <= ?`, 0, [from, to]),
    tasksOpen: scalar(db, `SELECT COUNT(*) FROM personal_tasks WHERE status IN ('todo','doing')`, 0),
    commitmentsClosed: scalar(db, `SELECT COUNT(*) FROM commitments WHERE status = 'completed' AND IFNULL(completed_at, updated_at) >= ? AND IFNULL(completed_at, updated_at) <= ?`, 0, [from, to]),
    commitmentsOpen: openCommitments.length,
    commitmentsOverdue: overdueCommitments.length,
    focusMinutes,
    focusSessions,
    journalEntries: journal.length,
    moneyIn,
    moneyOut,
    factsLearned: scalar(db, `SELECT COUNT(*) FROM memory_facts WHERE created_at >= ? AND created_at <= ?`, 0, [from, to]),
    lessonsRecorded: scalar(db, `SELECT COUNT(*) FROM personal_memory WHERE memory_type = 'lesson' AND created_at >= ? AND created_at <= ?`, 0, [from, to]),
    memoriesUpdated,
    projectsTouched: projectsTouched.length,
  };

  const heading = period === 'daily_rollup' ? 'Daily rollup' : 'Weekly rollup';
  const bullet = (s: string): string => `- ${s}`;
  const section = (title: string, lines: string[]): string[] =>
    lines.length ? [`## ${title}`, '', ...lines, ''] : [];

  const lines: string[] = [
    `# ${heading} — ${window.label}`,
    '',
    `Period: ${start} to ${end}. Generated from Henry's own records.`,
    '',
  ];

  lines.push(
    ...section('Headline', [
      bullet(
        `${stats.tasksDone} task${stats.tasksDone === 1 ? '' : 's'} done, ${stats.tasksOpen} still open`,
      ),
      bullet(`${stats.commitmentsClosed} commitment(s) closed, ${stats.commitmentsOpen} open`),
      bullet(`${duration(stats.focusMinutes)} of focused work across ${stats.focusSessions} session(s)`),
    ]),
  );

  lines.push(
    ...section(
      'Completed',
      doneTasks.map((t) => bullet(String(t.title ?? ''))),
    ),
  );
  lines.push(
    ...section(
      'Still open',
      openTasks.map((t) => bullet(`${String(t.title ?? '')} (priority ${String(t.priority ?? '?')})`)),
    ),
  );
  lines.push(
    ...section(
      'Commitments',
      [
        ...openCommitments.map((c) =>
          bullet(
            `${String(c.description ?? '')}${c.due_date ? ` — due ${String(c.due_date)}` : ''}`,
          ),
        ),
        ...(stats.commitmentsOverdue
          ? [bullet(`${stats.commitmentsOverdue} overdue — needs a decision`)]
          : []),
      ],
    ),
  );

  lines.push(
    ...section(
      'Journal',
      journal.map((j) => bullet(`${String(j.date)} — ${String(j.title ?? '(untitled)')}${j.mood ? ` (${String(j.mood)})` : ''}`)),
    ),
  );
  lines.push(
    ...section('Money', [
      bullet(`In ${money(stats.moneyIn)}`),
      bullet(`Out ${money(stats.moneyOut)}`),
      bullet(`Net ${money(stats.moneyIn - stats.moneyOut)}`),
    ]),
  );
  lines.push(
    ...section(
      'Learned',
      [
        ...facts.map((f) => bullet(`${String(f.fact ?? '')} (${String(f.category ?? 'general')})`)),
        ...lessons.map((l) => bullet(`Lesson: ${String(l.memory_value ?? '')}`)),
        bullet(`${stats.memoriesUpdated} memory row(s) updated`),
      ],
    ),
  );
  if (projectsTouched.length) {
    lines.push(
      ...section(
        'Projects touched',
        projectsTouched.map((p) => bullet(String(p.name ?? p.id ?? ''))),
      ),
    );
  }

  return {
    summaryType: period,
    periodLabel: window.label,
    periodStart: start,
    periodEnd: end,
    markdown: `${lines.join('\n').replace(/\n{3,}$/, '')}\n`,
    stats,
    linkedMemoryIds: [...facts.map((f) => String(f.id)), ...lessons.map((l) => String(l.id))].filter(Boolean),
    linkedProjectIds: projectsTouched.map((p) => String(p.id ?? '')).filter(Boolean),
  };
}