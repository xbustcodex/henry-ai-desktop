/**
 * Store tests — migration safety and the plan state machine.
 *
 * Runs against `node:sqlite` (Node's built-in SQLite) rather than
 * `better-sqlite3`: the copy of better-sqlite3 in node_modules is compiled for
 * Electron's ABI and throws `invalid ELF header` under plain Node, which is why
 * the sibling agent tests use hand-rolled fake DBs. `node:sqlite` speaks the
 * same SQL against the same engine, so these tests exercise the real migration
 * and the real CHECK/UPDATE guards instead of a mock's assumptions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import {
  approvePlan,
  createPlan,
  ensurePlanSchema,
  getPlan,
  listPlans,
  markPlanExecuted,
  MAX_STEPS,
  PlanStoreError,
  rejectPlan,
} from "./planStore";

function openDb(): Database.Database {
  const db = new DatabaseSync(":memory:");
  return db as unknown as Database.Database;
}

function columnsOf(db: Database.Database): string[] {
  const rows = db.prepare(`PRAGMA table_info(agent_plans)`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

let db: Database.Database;

beforeEach(() => {
  db = openDb();
});

function draft(overrides: Partial<Parameters<typeof createPlan>[1]> = {}) {
  return createPlan(db, {
    title: "Ship the billing cron",
    objective: "Move the nightly invoice job off the local box.",
    steps: ["Snapshot the current cron", "Write the GH Actions workflow", "Dry-run for 3 nights"],
    ...overrides,
  });
}

// ── Migration ──────────────────────────────────────────────────────────────

describe("agent_plans migration", () => {
  it("creates the table on a fresh install", () => {
    ensurePlanSchema(db);
    expect(columnsOf(db)).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "objective",
        "steps_json",
        "status",
        "created_at",
        "reviewed_at",
        "reviewed_by",
        "result",
      ]),
    );
  });

  it("is idempotent — repeated calls neither throw nor duplicate columns", () => {
    ensurePlanSchema(db);
    const first = columnsOf(db);
    ensurePlanSchema(db);
    ensurePlanSchema(db);
    expect(columnsOf(db)).toEqual(first);
  });

  it("leaves existing rows intact across a re-run (existing install)", () => {
    draft();
    const before = listPlans(db);
    ensurePlanSchema(db);
    ensurePlanSchema(db);
    expect(listPlans(db).map((p) => p.id)).toEqual(before.map((p) => p.id));
  });

  it("upgrades an older table that predates the later columns", () => {
    // Shape an older build would have left behind: id/title/objective only.
    db.exec(
      `CREATE TABLE agent_plans (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         objective TEXT NOT NULL,
         steps_json TEXT NOT NULL DEFAULT '[]'
       )`,
    );
    db.prepare(
      `INSERT INTO agent_plans (id, title, objective, steps_json) VALUES (?, ?, ?, ?)`,
    ).run("legacy-1", "Old plan", "From a previous build", '["still here"]');

    ensurePlanSchema(db);
    expect(columnsOf(db)).toEqual(expect.arrayContaining(["status", "reviewed_at", "result"]));

    // Pre-existing rows are readable and get usable defaults, not garbage.
    const legacy = getPlan(db, "legacy-1")!;
    expect(legacy.title).toBe("Old plan");
    expect(legacy.steps).toEqual(["still here"]);
    expect(legacy.status).toBe("draft");
  });

  it("rejects a status outside the four legal states (CHECK constraint)", () => {
    ensurePlanSchema(db);
    const plan = draft();
    expect(() =>
      db.prepare(`UPDATE agent_plans SET status = 'executed-lol' WHERE id = ?`).run(plan.id),
    ).toThrow();
  });

  it("swallows the duplicate-column race but surfaces real ALTER failures", () => {
    // Simulates two callers passing the PRAGMA guard for the same column: the
    // second ALTER reports "duplicate column name", which must not throw.
    const raced = {
      prepare: db.prepare.bind(db),
      exec: (sql: string) => {
        if (/ADD COLUMN/.test(sql)) {
          // Pretend a concurrent writer got there first.
          db.exec(sql);
          throw new Error("duplicate column name: objective");
        }
        db.exec(sql);
      },
    } as unknown as Database.Database;

    expect(() => ensurePlanSchema(raced)).not.toThrow();

    const broken = {
      prepare: db.prepare.bind(db),
      exec: (sql: string) => {
        if (/ADD COLUMN/.test(sql)) throw new Error("database disk image is malformed");
        db.exec(sql);
      },
    } as unknown as Database.Database;
    // Same, but starting from an old-shape table so the ALTERs are actually
    // attempted — a freshly created table needs no upgrades at all.
    db.exec(`DROP TABLE agent_plans`);
    db.exec(`CREATE TABLE agent_plans (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    expect(() => ensurePlanSchema(broken)).toThrow(PlanStoreError);
  });
});

// ── State machine ──────────────────────────────────────────────────────────

describe("plan state machine", () => {
  it("creates every plan as a draft, steps intact", () => {
    const plan = draft();
    expect(plan.status).toBe("draft");
    expect(plan.reviewed_at).toBeNull();
    expect(plan.steps[0]).toBe("Snapshot the current cron");
    expect(getPlan(db, plan.id)!.steps).toEqual(plan.steps);
  });

  it("allows draft → approved → executed", () => {
    const plan = draft();
    const approved = approvePlan(db, plan.id);
    expect(approved.status).toBe("approved");
    expect(approved.reviewed_at).not.toBeNull();
    expect(approved.reviewed_by).toBe("user");

    const executed = markPlanExecuted(db, plan.id, "3 clean nightly runs");
    expect(executed.status).toBe("executed");
    expect(executed.result).toBe("3 clean nightly runs");
  });

  it("refuses to approve twice — an error, not a silent no-op", () => {
    const plan = draft();
    approvePlan(db, plan.id);
    expect(() => approvePlan(db, plan.id)).toThrow(/is "approved" and must be "draft"/);
    expect(getPlan(db, plan.id)!.status).toBe("approved");
  });

  it("refuses to reject a rejected plan", () => {
    const plan = draft();
    rejectPlan(db, plan.id, "wrong approach");
    expect(() => rejectPlan(db, plan.id)).toThrow(/is "rejected" and must be "draft"/);
  });

  it("refuses to approve a rejected plan — rejected is terminal", () => {
    const plan = draft();
    const rejected = rejectPlan(db, plan.id, "user doesn't want this");
    expect(rejected.status).toBe("rejected");
    expect(rejected.result).toBe("user doesn't want this");
    expect(() => approvePlan(db, plan.id)).toThrow(/cannot approve plan/i);
    expect(getPlan(db, plan.id)!.status).toBe("rejected");
  });

  it("refuses to reject an approved plan", () => {
    const plan = draft();
    approvePlan(db, plan.id);
    expect(() => rejectPlan(db, plan.id, "changed my mind")).toThrow(PlanStoreError);
    expect(getPlan(db, plan.id)!.status).toBe("approved");
  });

  it("refuses to execute a plan that was never approved", () => {
    const plan = draft();
    expect(() => markPlanExecuted(db, plan.id)).toThrow(/must be "approved"/);
    rejectPlan(db, plan.id);
    expect(() => markPlanExecuted(db, plan.id)).toThrow(PlanStoreError);
  });

  it("errors on an unknown plan id instead of inventing one", () => {
    expect(() => approvePlan(db, "nope")).toThrow(/No plan found with id "nope"/);
    expect(() => rejectPlan(db, "")).toThrow(/plan id is required/i);
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("plan input validation", () => {
  it("requires a non-empty title and objective", () => {
    expect(() => draft({ title: "   " })).toThrow(/title is required/);
    expect(() => draft({ title: 42 as unknown as string })).toThrow(/title must be a string/);
    expect(() => draft({ objective: "" })).toThrow(/objective is required/);
  });

  it("rejects a non-array or empty steps list", () => {
    expect(() => draft({ steps: "do it" as unknown as string[] })).toThrow(
      /steps must be an array/,
    );
    expect(() => draft({ steps: [] })).toThrow(/at least one step/);
  });

  it("rejects a non-string, empty, or whitespace-only step and names the index", () => {
    expect(() => draft({ steps: ["ok", 7 as unknown as string] })).toThrow(
      /steps\[1\] must be a string/,
    );
    expect(() => draft({ steps: ["ok", "   "] })).toThrow(/steps\[1\] is required/);
  });

  it("accepts exactly the step cap and rejects one past it", () => {
    const atCap = Array.from({ length: MAX_STEPS }, (_, i) => `step ${i + 1}`);
    expect(draft({ steps: atCap }).steps).toHaveLength(MAX_STEPS);
    expect(() => draft({ steps: [...atCap, "one too many"] })).toThrow(
      new RegExp(`limited to ${MAX_STEPS} entries \\(got ${MAX_STEPS + 1}\\)`),
    );
  });

  it("bounds oversized text instead of storing it whole", () => {
    const plan = draft({ title: "T".repeat(5000), steps: ["S".repeat(4000)] });
    expect(plan.title.length).toBe(200);
    expect(plan.steps[0].length).toBe(1000);
  });
});

// ── Reads ──────────────────────────────────────────────────────────────────

describe("plan reads", () => {
  it("filters by status and honours the limit", () => {
    const a = draft({ title: "A" });
    draft({ title: "B" });
    approvePlan(db, a.id);

    expect(listPlans(db, { status: "approved" }).map((p) => p.title)).toEqual(["A"]);
    expect(listPlans(db, { status: "draft" })).toHaveLength(1);
    expect(listPlans(db).length).toBe(2);
    expect(listPlans(db, { limit: 1 })).toHaveLength(1);
  });

  it("caps the limit and rejects a nonsense one", () => {
    expect(listPlans(db, { limit: 100000 })).toHaveLength(0);
    expect(() => listPlans(db, { status: "pending" })).toThrow(/status must be one of/);
    expect(() => listPlans(db, { limit: -3 })).toThrow(/positive number/);
  });

  it("returns null for an unknown id", () => {
    expect(getPlan(db, "missing")).toBeNull();
  });
});