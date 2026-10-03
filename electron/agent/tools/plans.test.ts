/**
 * Plan Mode tool tests.
 *
 * Two things are being defended here:
 *
 *  1. THE SAFETY INVARIANT — `plan_approve` must be `confirm` AND must carry a
 *     `confirmPrompt`. Either one missing means the model can approve its own
 *     plan: without the tier the runner never pauses, without the prompt the
 *     Approval Queue shows nothing to click. The tests also assert no bypass
 *     parameter (`force`/`skipConfirm`/…) has crept into the schema, because
 *     that is how a confirm gate gets quietly undone.
 *
 *  2. Input hygiene — plan steps are model-authored free text, so an empty or
 *     non-string step or an unbounded list must be refused at the door.
 *
 * The DB is `node:sqlite`: better-sqlite3 in node_modules is built for Electron's
 * ABI and won't load under plain Node. Same SQL engine, so the real migration
 * and state machine run underneath these tools.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import type { AgentContext, ToolDefinition } from "../types";
import { plansTools } from "./plans";
import { MAX_STEPS } from "../planning/planStore";

let db: Database.Database;
let ctx: AgentContext;
let tools: ToolDefinition[];

const byName = (name: string): ToolDefinition => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
};

beforeEach(() => {
  db = new DatabaseSync(":memory:") as unknown as Database.Database;
  ctx = { db, getWindow: () => null };
  tools = plansTools();
});

function run(name: string, params: Record<string, unknown>) {
  return byName(name).execute(params, ctx);
}

async function makePlan(overrides: Record<string, unknown> = {}) {
  const result = await run("plan_create", {
    title: "Ship the billing cron",
    objective: "Move the nightly invoice job off the local box.",
    steps: ["Snapshot the cron", "Write the workflow"],
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return result.data as { id: string; title: string; status: string; steps: string[] };
}

// ── Surface ────────────────────────────────────────────────────────────────

describe("plan tool surface", () => {
  it("registers exactly the five Plan Mode tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "plan_approve",
      "plan_create",
      "plan_get",
      "plan_list",
      "plan_reject",
    ]);
  });

  it("puts every plan tool in the automation category", () => {
    for (const tool of tools) expect(tool.category).toBe("automation");
  });

  // ── The safety invariant ────────────────────────────────────────────────
  it("plan_approve is confirm-tier AND names the plan for the Approval Queue", async () => {
    const approve = byName("plan_approve");
    expect(approve.safetyLevel).toBe("confirm");
    expect(typeof approve.confirmPrompt).toBe("function");

    // The prompt must name the plan, not just expose an id.
    const plan = await makePlan();
    const prompt = approve.confirmPrompt!({ id: plan.id });
    expect(prompt).toContain(plan.title);
  });

  it("plan_approve exposes no parameter that could bypass the gate", () => {
    const approve = byName("plan_approve");
    const props = Object.keys((approve.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(props).toEqual(["id"]);
    for (const bypass of ["force", "skipConfirm", "autoApprove", "assumeYes", "confirm"]) {
      expect(props).not.toContain(bypass);
    }
    // And no silent/notify sibling could re-do the same transition.
    expect(tools.filter((t) => /approve/i.test(t.name))).toHaveLength(1);
  });

  it("drafting and reading plans never block the user", () => {
    expect(byName("plan_create").safetyLevel).toBe("silent");
    expect(byName("plan_list").safetyLevel).toBe("silent");
    expect(byName("plan_get").safetyLevel).toBe("silent");
    expect(byName("plan_reject").safetyLevel).toBe("notify");
  });
});

// ── plan_create ────────────────────────────────────────────────────────────

describe("plan_create", () => {
  it("stores a draft with ordered steps and says nothing was executed", async () => {
    const plan = await makePlan();
    expect(plan.status).toBe("draft");
    expect(plan.steps).toEqual(["Snapshot the cron", "Write the workflow"]);
    expect(plan.title).toBe("Ship the billing cron");

    const listed = await run("plan_list", {});
    expect((listed.data as { plans: Array<{ id: string }> }).plans[0].id).toBe(plan.id);
  });

  it("requires title, objective, and steps", async () => {
    const base = { title: "t", objective: "o", steps: ["s"] };
    for (const missing of ["title", "objective", "steps"]) {
      const params: Record<string, unknown> = { ...base };
      delete params[missing];
      const r = await run("plan_create", params);
      expect(r.ok, `missing ${missing} should fail`).toBe(false);
    }
  });

  it("rejects a non-array, empty, or wholly missing steps argument", async () => {
    for (const steps of ["do it", 5, {}, []]) {
      const r = await run("plan_create", { title: "t", objective: "o", steps });
      expect(r.ok, JSON.stringify(steps)).toBe(false);
    }
    expect((await run("plan_create", { title: "t", objective: "o", steps: [7] })).error).toMatch(
      /steps\[0\] must be a string/,
    );
    expect(
      (await run("plan_create", { title: "t", objective: "o", steps: ["ok", "  "] })).error,
    ).toMatch(/steps\[1\] is required/);
  });

  it("caps the step count at the documented maximum", async () => {
    const steps = Array.from({ length: MAX_STEPS }, (_, i) => `step ${i + 1}`);
    expect((await run("plan_create", { title: "t", objective: "o", steps })).ok).toBe(true);

    const over = await run("plan_create", { title: "t", objective: "o", steps: [...steps, "x"] });
    expect(over.ok).toBe(false);
    expect(over.error).toContain(`limited to ${MAX_STEPS}`);
  });

  it("declares the same cap in the schema the model sees", () => {
    const steps = (byName("plan_create").inputSchema.properties as Record<string, Record<string, unknown>>)
      .steps;
    expect(steps.maxItems).toBe(MAX_STEPS);
    expect(steps.type).toBe("array");
  });
});

// ── plan_list / plan_get ───────────────────────────────────────────────────

describe("plan_list / plan_get", () => {
  it("filters by status and rejects an unknown status", async () => {
    const a = await makePlan({ title: "A" });
    await makePlan({ title: "B" });
    await run("plan_approve", { id: a.id });

    const approved = await run("plan_list", { status: "approved" });
    expect((approved.data as { count: number }).count).toBe(1);
    expect((await run("plan_list", { status: "draft" })).ok).toBe(true);
    expect((await run("plan_list", { status: "in-progress" })).ok).toBe(false);
  });

  it("returns parsed steps, not the raw JSON blob", async () => {
    const plan = await makePlan();
    const got = await run("plan_get", { id: plan.id });
    expect((got.data as { plan: { steps: string[] } }).plan.steps).toEqual([
      "Snapshot the cron",
      "Write the workflow",
    ]);
  });

  it("errors on an unknown or missing id", async () => {
    const missing = await run("plan_get", { id: "does-not-exist" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/No plan found/);

    expect((await run("plan_get", {})).ok).toBe(false);
    expect((await run("plan_approve", { id: "does-not-exist" })).ok).toBe(false);
    expect((await run("plan_reject", {})).ok).toBe(false);
  });
});

// ── plan_approve / plan_reject ─────────────────────────────────────────────

describe("plan review transitions", () => {
  it("approve moves draft → approved", async () => {
    const plan = await makePlan();
    const r = await run("plan_approve", { id: plan.id });
    expect(r.ok).toBe(true);
    expect((r.data as { status: string }).status).toBe("approved");

    // Second approval is an error, not a silent no-op.
    const again = await run("plan_approve", { id: plan.id });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/must be "draft"/);
  });

  it("reject records the reason and closes the plan for good", async () => {
    const plan = await makePlan();
    const r = await run("plan_reject", { id: plan.id, reason: "too risky right now" });
    expect(r.ok).toBe(true);
    expect((r.data as { status: string; result: string }).status).toBe("rejected");
    expect((r.data as { result: string }).result).toBe("too risky right now");

    const after = await run("plan_approve", { id: plan.id });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/cannot approve/i);
  });

  it("never throws out of execute, whatever the params", async () => {
    for (const name of ["plan_create", "plan_list", "plan_get", "plan_approve", "plan_reject"]) {
      const r = await run(name, { id: null, steps: undefined, limit: {} });
      expect(typeof r.ok, name).toBe("boolean");
      if (!r.ok) expect(typeof r.error).toBe("string");
    }
  });
});