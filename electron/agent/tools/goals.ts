/**
 * Goal tools — Henry's read/write access to the goals the user already tracks
 * in the Goals panel.
 *
 * Single source of truth: every tool below reads and writes the SAME SQLite
 * `goals` table created in `electron/ipc/database.ts` and driven by the
 * `memory:getGoals` / `memory:saveGoal` / `memory:updateGoal` /
 * `memory:deleteGoal` handlers in `electron/ipc/memory.ts`. There is no second
 * table, no second database and no agent-owned cache of goal state — so a goal
 * Henry writes here shows up in the panel, and a goal the panel edits is
 * visible to Henry on the next `goal_list`.
 *
 * Safety tiers follow design §5 and mirror `memory.ts`:
 *   silent — goal_list (a read; logged, never interrupts).
 *   notify — goal_create / goal_update (applied immediately, then a toast).
 *   confirm — goal_delete (irreversible, so the user is asked first).
 *
 * Because `confirmPrompt` is synchronous and receives only the raw params (it
 * has no `AgentContext`), `goal_delete` cannot re-read the row when it builds
 * the prompt. It renders the title from a small, NON-authoritative lookup
 * cache that the read/write tools in this module fill in as the agent sees
 * goals; when the id is unknown it falls back to the id. `goal_delete`'s
 * `execute` is what actually verifies the row exists, so an unknown id is
 * refused with an error and nothing is deleted.
 */

import { randomUUID } from "crypto";
import type { AgentContext, ToolDefinition, ToolResult } from "../types";

type Row = Record<string, unknown>;

type UpdatableColumn =
  | "title"
  | "summary"
  | "status"
  | "priority_score"
  | "emotional_significance_score"
  | "strategic_significance_score";

type Field = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * The update allow-list, in the exact order and spelling of
 * `memory:updateGoal`'s `allowed` array: title, summary, status,
 * priority_score, emotional_significance_score, strategic_significance_score.
 * `goal_update` iterates THIS table and never the incoming params, so a name
 * like `user_id` or `created_at` has nowhere to enter the SET clause.
 */
const COERCE_BY_COLUMN: Record<UpdatableColumn, (raw: unknown) => Field> = {
  title: (raw) => {
    const t = String(raw ?? "").trim();
    return t ? { ok: true, value: t } : { ok: false, error: "title cannot be empty" };
  },
  summary: (raw) => ({ ok: true, value: String(raw ?? "").trim() || null }),
  status: (raw) =>
    isStatus(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `status must be one of: ${STATUSES.join(", ")}` },
  priority_score: (raw) => ({ ok: true, value: score(raw, DEFAULT_SCORE) }),
  emotional_significance_score: (raw) => ({ ok: true, value: score(raw, DEFAULT_SCORE) }),
  strategic_significance_score: (raw) => ({ ok: true, value: score(raw, DEFAULT_SCORE) }),
};

const UPDATABLE = Object.keys(COERCE_BY_COLUMN) as UpdatableColumn[];

const STATUSES = ["active", "paused", "completed", "abandoned"] as const;
type Status = (typeof STATUSES)[number];

const DEFAULT_STATUS: Status = "active";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SCORE = 0.5;

/** id → title, for the goal_delete confirm prompt only. Never the store. */
const titleCache = new Map<string, string>();
const TITLE_CACHE_MAX = 200;

function rememberTitle(id: unknown, title: unknown): void {
  if (typeof id !== "string" || !id) return;
  const t = typeof title === "string" ? title : "";
  titleCache.set(id, t);
  // Bounded: oldest insertion first, so a long session cannot grow this
  // without limit. Dropping an entry only degrades the prompt wording.
  if (titleCache.size > TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next().value;
    if (oldest !== undefined) titleCache.delete(oldest);
  }
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/** Bounds a long free-text column before it reaches the model. */
function clip(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Normalizes a 0..1 score. Out-of-range numbers are CLAMPED, not rejected:
 * models routinely answer "0.85" as "85" or "8.5", and failing the whole call
 * would strand the goal they were trying to record. Values that are not
 * finite numbers at all fall back to the schema default.
 */
function score(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function limit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function isStatus(raw: unknown): raw is Status {
  return typeof raw === "string" && (STATUSES as readonly string[]).includes(raw);
}

/** Goal rows as handed to the model: bounded text, numeric scores. */
function presentGoal(row: Row): Row {
  rememberTitle(row.id, row.title);
  return {
    id: String(row.id),
    title: clip(row.title, 200),
    summary: clip(row.summary, 600),
    status: String(row.status),
    priority_score: Number(row.priority_score),
    emotional_significance_score: Number(row.emotional_significance_score),
    strategic_significance_score: Number(row.strategic_significance_score),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_active_at: String(row.last_active_at),
  };
}

function fetchGoal(db: AgentContext["db"], id: string): Row | undefined {
  return db
    .prepare(
      `SELECT id, title, summary, status, priority_score,
              emotional_significance_score, strategic_significance_score,
              created_at, updated_at, last_active_at
       FROM goals WHERE id = ? LIMIT 1`,
    )
    .get(id) as Row | undefined;
}

export function goalsTools(): ToolDefinition[] {
  return [
    // ── goal_list ────────────────────────────────────────────────────────
    {
      name: "goal_list",
      description:
        "List the user's goals, highest priority first. Defaults to the " +
        "active goals — pass status 'paused', 'completed' or 'abandoned' to " +
        "see the rest. Use this before promising to do something, or when " +
        "the user asks what they are working toward.",
      category: "memory",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...STATUSES],
            description: "Filter by status (default 'active').",
          },
          limit: {
            type: "number",
            description: `Max goals to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const status = params.status === undefined || params.status === ""
            ? DEFAULT_STATUS
            : params.status;
          if (!isStatus(status)) {
            return fail(`status must be one of: ${STATUSES.join(", ")}`);
          }
          const max = limit(params.limit);

          const rows = db
            .prepare(
              `SELECT id, title, summary, status, priority_score,
                      emotional_significance_score, strategic_significance_score,
                      created_at, updated_at, last_active_at
               FROM goals
               WHERE status = ?
               ORDER BY priority_score DESC, strategic_significance_score DESC
               LIMIT ?`,
            )
            .all(status, max) as Row[];

          const goals = rows.map(presentGoal);
          return ok({ goals, count: goals.length, status, limit: max });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── goal_create ──────────────────────────────────────────────────────
    {
      name: "goal_create",
      description:
        "Record a new goal for the user. This writes to the same Goals list " +
        "the user sees in the app, so use it when they state a goal or agree " +
        "to one — don't invent goals they did not ask for.",
      category: "memory",
      safetyLevel: "notify",
      confirmPrompt: (p) => `Add the goal "${String(p.title ?? "").slice(0, 80)}"`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name of the goal." },
          summary: { type: "string", description: "What it means, in a sentence or two." },
          priorityScore: {
            type: "number",
            description: `How urgent, 0..1 (default ${DEFAULT_SCORE}). Out-of-range values are clamped.`,
          },
          emotionalSignificanceScore: {
            type: "number",
            description: `How much this matters to them emotionally, 0..1 (default ${DEFAULT_SCORE}). Clamped.`,
          },
          strategicSignificanceScore: {
            type: "number",
            description: `How much it moves the long game, 0..1 (default ${DEFAULT_SCORE}). Clamped.`,
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const title = String(params.title ?? "").trim();
          if (!title) return fail("title is required");
          const summary = String(params.summary ?? "").trim();

          const id = randomUUID();
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO goals (
               id, title, summary,
               priority_score, emotional_significance_score, strategic_significance_score,
               created_at, updated_at, last_active_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            title,
            summary || null,
            score(params.priorityScore, DEFAULT_SCORE),
            score(params.emotionalSignificanceScore, DEFAULT_SCORE),
            score(params.strategicSignificanceScore, DEFAULT_SCORE),
            now,
            now,
            now,
          );

          rememberTitle(id, title);
          const created = fetchGoal(db, id);
          return ok({
            created: true,
            id,
            goal: created ? presentGoal(created) : { id, title, status: DEFAULT_STATUS },
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── goal_update ──────────────────────────────────────────────────────
    {
      name: "goal_update",
      description:
        "Change an existing goal by id: rename it, rewrite the summary, move " +
        "it between active / paused / completed / abandoned, or rescore it. " +
        "Only the fields you pass are changed. Use when the user finishes or " +
        "drops a goal, or revises what it was.",
      category: "memory",
      safetyLevel: "notify",
      confirmPrompt: (p) =>
        `Update the goal "${titleCache.get(String(p.id ?? "")) ?? String(p.id ?? "")}"`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Goal id (from goal_list / goal_create)." },
          title: { type: "string", description: "New title." },
          summary: { type: "string", description: "New summary." },
          status: { type: "string", enum: [...STATUSES], description: "New status." },
          priority_score: { type: "number", description: "Urgency, 0..1. Clamped." },
          emotional_significance_score: {
            type: "number",
            description: "Emotional significance, 0..1. Clamped.",
          },
          strategic_significance_score: {
            type: "number",
            description: "Strategic significance, 0..1. Clamped.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const id = String(params.id ?? "").trim();
          if (!id) return fail("id is required");

          // Walk the allow-list, not the params: an injected key such as
          // `user_id` is simply never looked at.
          const sets: string[] = [];
          const vals: unknown[] = [];
          for (const col of UPDATABLE) {
            if (!(col in params)) continue;
            const field = COERCE_BY_COLUMN[col](params[col]);
            if (!field.ok) return fail(field.error);
            sets.push(`${col} = ?`);
            vals.push(field.value);
          }

          if (sets.length === 0) {
            return ok({ updated: false, id, reason: "No updatable field was supplied." });
          }

          const now = new Date().toISOString();
          sets.push("updated_at = ?", "last_active_at = ?");
          vals.push(now, now, id);

          const info = db
            .prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`)
            .run(...vals);
          if (info.changes === 0) return fail(`No goal found with id "${id}".`);

          const goal = fetchGoal(db, id);
          return ok({ updated: true, id, goal: goal ? presentGoal(goal) : undefined });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── goal_delete ──────────────────────────────────────────────────────
    {
      name: "goal_delete",
      description:
        "Permanently delete a goal by id. This cannot be undone — prefer " +
        "goal_update with status 'abandoned' or 'completed' unless the user " +
        "explicitly asks for the goal to be removed.",
      category: "memory",
      safetyLevel: "confirm",
      confirmPrompt: (p) => {
        const id = String(p.id ?? "");
        const title = titleCache.get(id);
        return `Delete the goal "${title ?? id}" permanently — this cannot be undone`;
      },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Goal id (from goal_list / goal_create)." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const id = String(params.id ?? "").trim();
          if (!id) return fail("id is required");

          const goal = fetchGoal(db, id);
          if (!goal) return fail(`No goal found with id "${id}".`);

          const title = String(goal.title ?? "");
          const info = db.prepare("DELETE FROM goals WHERE id = ?").run(id);
          titleCache.delete(id);
          return ok({ deleted: info.changes > 0, id, title });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}