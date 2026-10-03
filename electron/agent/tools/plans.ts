/**
 * Plan Mode tools (parity row 4.12) — the propose → review → execute loop.
 *
 * A plan is something the MODEL produces, the USER reviews, and only then is
 * executed. The model can write a draft without interruption; the moment it
 * tries to move that draft into `approved` it stops and asks the user.
 *
 * Safety tiers (design §5):
 *   - plan_create  silent  — drafts a proposal the user hasn't seen yet
 *   - plan_list    silent  — read
 *   - plan_get     silent  — read
 *   - plan_reject  notify  — records the user's "no"; toast so they see it stuck
 *   - plan_approve confirm — THE SAFETY INVARIANT. See below.
 *
 * ── Why plan_approve is the only confirm-gated tool here ───────────────────
 * Approval is the hinge of Plan Mode: it is the one action that turns
 * model-authored intent into work the user has agreed to. If Henry could call
 * this tool silently, he could approve his own plan and the user's review step
 * would be theatre. So `plan_approve` is `confirm`, which makes
 * `executeToolCall` (electron/agent/toolRunner.ts) park the call and emit an
 * Approval Queue entry; the row only moves once the user clicks OK.
 *
 * There is deliberately NO `force` / `skipConfirm` / `assumeYes` parameter, and
 * no silent sibling of this tool. A bypass flag on a confirm-tier tool is the
 * bug, not the feature — the gate lives in the runner and cannot be
 * parameterised away. The store's transition guard is the second line of
 * defence: even a bug that skipped the gate could not approve a plan that
 * isn't a draft.
 *
 * `confirmPrompt` only receives the tool params (no db handle), so it names the
 * plan via the store's display cache, falling back to the raw id. It never
 * invents a title: the authoritative row is read inside `execute`.
 *
 * Storage/state machine live in `../planning/planStore`, which owns its own
 * idempotent migration so it works on both fresh and existing installs.
 */

import type { ToolDefinition, ToolResult } from "../types";
import {
  approvePlan,
  cachedPlanTitle,
  createPlan,
  getPlan,
  listPlans,
  rejectPlan,
  MAX_STEPS,
  PLAN_STATUSES,
} from "../planning/planStore";

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

const STATUS_ENUM = [...PLAN_STATUSES] as unknown[];

export function plansTools(): ToolDefinition[] {
  return [
    // ── plan_create ──────────────────────────────────────────────────────
    {
      name: "plan_create",
      description:
        "Draft a plan for work that is too big for one step, BEFORE doing any " +
        "of it. Writes a 'draft' plan with an ordered step list so the user can " +
        "review the approach; nothing is executed and the user is not interrupted. " +
        "After creating a plan, call plan_approve to request their sign-off — that " +
        "call is what pauses for confirmation.",
      category: "automation",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short plan name, e.g. 'Migrate the billing cron to GitHub Actions'.",
          },
          objective: {
            type: "string",
            description: "What the plan achieves and how you will know it worked.",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_STEPS,
            description: `Ordered, concrete steps. At most ${MAX_STEPS}.`,
          },
        },
        required: ["title", "objective", "steps"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const plan = createPlan(db, {
            title: params.title as string,
            objective: params.objective as string,
            steps: params.steps as string[],
          });
          return ok({
            id: plan.id,
            title: plan.title,
            objective: plan.objective,
            steps: plan.steps,
            status: plan.status,
            message:
              "Plan drafted. Nothing has been executed — call plan_approve with this id " +
              "to ask the user to sign off before you start.",
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── plan_list ────────────────────────────────────────────────────────
    {
      name: "plan_list",
      description:
        "List plans with their status and steps. Use to find a plan id, or to " +
        "check whether something you proposed earlier is still waiting on the user.",
      category: "automation",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: STATUS_ENUM,
            description: "Filter to one state. Omit for all plans.",
          },
          limit: { type: "number", description: "Max plans to return (default 50)." },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const plans = listPlans(db, { status: params.status, limit: params.limit });
          return ok({ plans, count: plans.length });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── plan_get ─────────────────────────────────────────────────────────
    {
      name: "plan_get",
      description: "Fetch one plan by id: objective, steps, status, review decision.",
      category: "automation",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Plan id from plan_create or plan_list." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const plan = getPlan(db, params.id as string);
          if (!plan) return fail(`No plan found with id "${String(params.id ?? "")}"`);
          return ok({ plan });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── plan_approve ─────────────────────────────────────────────────────
    {
      name: "plan_approve",
      description:
        "Request the user's sign-off on a draft plan. This is the only step that " +
        "moves a plan to 'approved', and it always pauses for the user to confirm " +
        "in the Approval Queue — you cannot approve your own plan. Call it once, " +
        "then wait for the user's answer; if it fails, the plan was not approved.",
      category: "automation",
      safetyLevel: "confirm",
      confirmPrompt: (params) => {
        const id = String(params.id ?? "").trim();
        const title = cachedPlanTitle(id);
        return title
          ? `Approve your plan "${title}" and start executing it?`
          : `Approve plan ${id || "(no id)"} and start executing it?`;
      },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of the draft plan to approve." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const plan = approvePlan(db, params.id as string);
          return ok({
            id: plan.id,
            title: plan.title,
            status: plan.status,
            reviewed_at: plan.reviewed_at,
            message: `The user approved "${plan.title}". Work the steps in order.`,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── plan_reject ──────────────────────────────────────────────────────
    {
      name: "plan_reject",
      description:
        "Record that a draft plan was declined. Use this when the user says they " +
        "don't want a proposed plan. A rejected plan is final — it can never be " +
        "approved later; propose a new plan if the approach changes.",
      category: "automation",
      safetyLevel: "notify",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of the draft plan to reject." },
          reason: {
            type: "string",
            description: "Why it was rejected, in the user's terms (recorded on the plan).",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const reason = params.reason === undefined ? undefined : String(params.reason);
          const plan = rejectPlan(db, params.id as string, reason);
          return ok({
            id: plan.id,
            title: plan.title,
            status: plan.status,
            result: plan.result,
            message: `Plan "${plan.title}" was rejected and will not be executed.`,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}