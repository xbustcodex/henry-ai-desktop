/**
 * Plan store — persistence + state machine for "Plan Mode" (parity row 4.12).
 *
 * A plan is something the MODEL produces, the USER reviews, and only then is
 * executed. That ordering is the whole point of this file: the store owns the
 * transitions so no caller (tool, renderer, future scheduler) can talk a plan
 * into being approved without a human decision. The legal moves are
 *
 *     draft ──approve──▶ approved ──markExecuted──▶ executed
 *       │
 *       └──reject──▶ rejected   (terminal — a rejected plan can never be approved)
 *
 * Every illegal move throws a `PlanStoreError` with a message a model can relay
 * ("already approved", "cannot approve a rejected plan"). Nothing is a silent
 * no-op: double-approving is a bug the caller must see.
 *
 * ── Why this owns its own migration ────────────────────────────────────────
 * `electron/ipc/database.ts` is the app-wide schema owner, but it is owned and
 * changed by another workstream, so this module must not touch it. Instead
 * `ensurePlanSchema()` runs its own migration on first use of every entry point.
 * That is safe on both install shapes and on every call after:
 *
 *   - Fresh install: `CREATE TABLE IF NOT EXISTS` creates the table with all
 *     columns, then the guarded ALTERs find every column present and no-op.
 *   - Existing install (an older `agent_plans` from a previous build, possibly
 *     missing later columns): `CREATE TABLE IF NOT EXISTS` leaves the table
 *     alone, then each missing column is added by `ALTER TABLE ADD COLUMN`.
 *   - Repeated calls: idempotent — the table is only created once and a column
 *     is only added when `PRAGMA table_info` says it is absent.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the PRAGMA guard. Two callers
 * can pass that guard concurrently in the same tick (two tool calls racing), so
 * the ALTER is additionally wrapped: SQLite's "duplicate column name" error is
 * swallowed, because in that race the other writer already did the work.
 *
 * Kept deliberately Electron-free and synchronous (better-sqlite3) so it can be
 * unit-tested without the app runtime.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────────────────────

export const PLAN_STATUSES = ["draft", "approved", "rejected", "executed"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface Plan {
  id: string;
  title: string;
  objective: string;
  /** Ordered, non-empty step strings. Stored as a JSON array. */
  steps: string[];
  status: PlanStatus;
  /** ISO-8601. */
  created_at: string;
  /** ISO-8601, null while the plan is still a draft. */
  reviewed_at: string | null;
  /** Who made the review decision (`user` in practice), or null. */
  reviewed_by: string | null;
  /** Reject reason or execution outcome, or null. */
  result: string | null;
}

export interface NewPlanInput {
  title: string;
  objective: string;
  steps: string[];
  /** Overrides the reviewer label recorded on review transitions. */
  reviewedBy?: string;
}

/** Any illegal transition, or malformed input. Message is user-relayable. */
export class PlanStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanStoreError";
  }
}

// ── Bounds ─────────────────────────────────────────────────────────────────
// Plans are model-authored text; keep a row small and a prompt-safe size.
export const MAX_STEPS = 50;
const MAX_TITLE = 200;
const MAX_OBJECTIVE = 2000;
const MAX_STEP = 1000;
const MAX_RESULT = 4000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** How many plan titles the display cache keeps (see cachedPlanTitle). */
const TITLE_CACHE_MAX = 500;

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ── Migration ──────────────────────────────────────────────────────────────

/** Column definitions applied after the table exists, in order. */
const ADDED_COLUMNS: Array<[string, string]> = [
  ["objective", "TEXT NOT NULL DEFAULT ''"],
  ["steps_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["status", "TEXT NOT NULL DEFAULT 'draft'"],
  ["created_at", "TEXT NOT NULL DEFAULT ''"],
  ["reviewed_at", "TEXT"],
  ["reviewed_by", "TEXT"],
  ["result", "TEXT"],
];

function tableColumns(db: Database.Database): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(agent_plans)`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * Create/upgrade `agent_plans`. Idempotent — safe on a fresh install, on an
 * existing install, and on repeated/concurrent calls. Called by every entry
 * point below, so callers never need to remember to migrate.
 */
export function ensurePlanSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','approved','rejected','executed')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      result TEXT
    )
  `);

  const present = tableColumns(db);
  for (const [name, definition] of ADDED_COLUMNS) {
    if (present.has(name)) continue;
    try {
      db.exec(`ALTER TABLE agent_plans ADD COLUMN ${name} ${definition}`);
    } catch (e) {
      // Lost the race against a concurrent writer that added the same column:
      // the end state we wanted is already true, so this is not an error.
      const message = e instanceof Error ? e.message : String(e);
      if (!/duplicate column name/i.test(message)) {
        throw new PlanStoreError(`agent_plans migration failed on column "${name}": ${message}`);
      }
    }
  }
}

// ── Row mapping ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function parseSteps(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

function isStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

function toPlan(row: Row): Plan {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    objective: String(row.objective ?? ""),
    steps: parseSteps(row.steps_json),
    status: isStatus(row.status) ? row.status : "draft",
    created_at: String(row.created_at ?? ""),
    reviewed_at: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
    result: row.result ? String(row.result) : null,
  };
}

function insertRow(db: Database.Database, plan: Plan): void {
  db.prepare(
    `INSERT INTO agent_plans
       (id, title, objective, steps_json, status, created_at, reviewed_at, reviewed_by, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id,
    plan.title,
    plan.objective,
    JSON.stringify(plan.steps),
    plan.status,
    plan.created_at,
    plan.reviewed_at,
    plan.reviewed_by,
    plan.result,
  );
}

// ── Title cache (display only) ─────────────────────────────────────────────
//
// `confirmPrompt(params)` receives only the tool params — no database handle —
// so it cannot look a plan up on its own. Every store call that touches a plan
// therefore remembers its id → title here, purely so approval prompts can name
// the plan instead of showing a bare id. It is a display hint only: it can never
// substitute for the authoritative row read inside the transition, and lookups
// miss cleanly (bounded map, eviction on overflow).

const titleCache = new Map<string, string>();

function rememberTitle(plan: Plan): Plan {
  if (!plan.id) return plan;
  // Re-insert so the most recently touched plan is last (evicted first).
  titleCache.delete(plan.id);
  titleCache.set(plan.id, plan.title);
  while (titleCache.size > TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next();
    if (oldest.done) break;
    titleCache.delete(oldest.value);
  }
  return plan;
}

/** Best-effort title for an id previously seen by this process, else null. */
export function cachedPlanTitle(id: string): string | null {
  return titleCache.get(id) ?? null;
}

// ── Input validation ───────────────────────────────────────────────────────

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new PlanStoreError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new PlanStoreError(`${field} is required`);
  return clamp(trimmed, max);
}

function requireSteps(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PlanStoreError("steps must be an array of strings");
  }
  if (value.length === 0) {
    throw new PlanStoreError("steps must contain at least one step");
  }
  if (value.length > MAX_STEPS) {
    throw new PlanStoreError(`steps is limited to ${MAX_STEPS} entries (got ${value.length})`);
  }
  return value.map((step, i) => requireText(step, `steps[${i}]`, MAX_STEP));
}

// ── Reads ──────────────────────────────────────────────────────────────────

export function getPlan(db: Database.Database, id: unknown): Plan | null {
  ensurePlanSchema(db);
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) throw new PlanStoreError("plan id is required");
  const row = db.prepare(`SELECT * FROM agent_plans WHERE id = ?`).get(key) as Row | undefined;
  return row ? rememberTitle(toPlan(row)) : null;
}

export interface ListPlansOptions {
  status?: unknown;
  limit?: unknown;
}

export function listPlans(db: Database.Database, opts: ListPlansOptions = {}): Plan[] {
  ensurePlanSchema(db);
  const { status, limit } = opts;

  if (status !== undefined && status !== null && !isStatus(status)) {
    throw new PlanStoreError(
      `status must be one of ${PLAN_STATUSES.join(", ")} (got ${JSON.stringify(status)})`,
    );
  }

  let max = DEFAULT_LIST_LIMIT;
  if (limit !== undefined && limit !== null) {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new PlanStoreError("limit must be a positive number");
    }
    max = Math.min(Math.floor(parsed), MAX_LIST_LIMIT);
  }

  const rows = (
    isStatus(status)
      ? db
          .prepare(
            `SELECT * FROM agent_plans WHERE status = ?
             ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?`,
          )
          .all(status, max)
      : db
          .prepare(
            `SELECT * FROM agent_plans
             ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?`,
          )
          .all(max)
  ) as Row[];

  return rows.map((row) => rememberTitle(toPlan(row)));
}

// ── Writes ─────────────────────────────────────────────────────────────────

/** Create a new plan. Always starts in `draft` — nothing else is legal here. */
export function createPlan(db: Database.Database, input: NewPlanInput): Plan {
  ensurePlanSchema(db);
  if (!input || typeof input !== "object") {
    throw new PlanStoreError("plan input is required");
  }
  const plan: Plan = {
    id: randomUUID(),
    title: requireText(input.title, "title", MAX_TITLE),
    objective: requireText(input.objective, "objective", MAX_OBJECTIVE),
    steps: requireSteps(input.steps),
    status: "draft",
    created_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    result: null,
  };
  insertRow(db, plan);
  return rememberTitle(plan);
}

function transition(
  db: Database.Database,
  id: unknown,
  to: PlanStatus,
  opts: { reviewedBy?: string; result?: string; requireFrom: PlanStatus; verb: string },
): Plan {
  ensurePlanSchema(db);
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) throw new PlanStoreError("plan id is required");

  const current = getPlan(db, key);
  if (!current) throw new PlanStoreError(`No plan found with id "${key}"`);

  if (current.status !== opts.requireFrom) {
    throw new PlanStoreError(
      `Cannot ${opts.verb} plan "${current.title || key}" — it is ` +
        `"${current.status}" and must be "${opts.requireFrom}".`,
    );
  }

  const reviewer =
    typeof opts.reviewedBy === "string" && opts.reviewedBy.trim()
      ? clamp(opts.reviewedBy.trim(), 100)
      : "user";
  const result = opts.result ? clamp(opts.result.trim(), MAX_RESULT) : null;

  const changed = db
    .prepare(
      `UPDATE agent_plans
       SET status = ?, reviewed_at = ?, reviewed_by = ?, result = ?
       WHERE id = ? AND status = ?`,
    )
    .run(to, new Date().toISOString(), reviewer, result, key, opts.requireFrom).changes;

  if (changed !== 1) {
    // Lost a race: someone else moved the plan out of `requireFrom` between the
    // read and the write. The guarded UPDATE caught it — surface it, don't
    // silently claim success.
    const latest = getPlan(db, key);
    throw new PlanStoreError(
      `Cannot ${opts.verb} plan "${current.title || key}" — it changed to ` +
        `"${latest?.status ?? "unknown"}" while the review was in progress.`,
    );
  }

  return rememberTitle(getPlan(db, key) as Plan);
}

/** draft → approved. Any other starting state is an error. */
export function approvePlan(
  db: Database.Database,
  id: unknown,
  reviewedBy?: string,
): Plan {
  return transition(db, id, "approved", {
    reviewedBy,
    requireFrom: "draft",
    verb: "approve",
  });
}

/** draft → rejected. A rejected plan is terminal. */
export function rejectPlan(
  db: Database.Database,
  id: unknown,
  reason?: string,
  reviewedBy?: string,
): Plan {
  return transition(db, id, "rejected", {
    reviewedBy,
    result: typeof reason === "string" ? reason : undefined,
    requireFrom: "draft",
    verb: "reject",
  });
}

/** approved → executed, optionally recording the outcome. */
export function markPlanExecuted(
  db: Database.Database,
  id: unknown,
  result?: string,
): Plan {
  return transition(db, id, "executed", {
    result: typeof result === "string" ? result : undefined,
    requireFrom: "approved",
    verb: "mark executed",
  });
}