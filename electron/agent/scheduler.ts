/**
 * HenryScheduler — Henry's autonomous Routines (design §3).
 *
 * A Routine is a `scheduled_tasks` row: a cron expression + a prompt. On
 * startup the scheduler loads every enabled Routine and registers it with
 * node-cron. When a Routine fires, the scheduler runs its prompt through the
 * full tool suite (the same `runToolConversation` loop the chat path uses),
 * opens a fresh session in the SessionStore for the run, and writes the result
 * back as an assistant message — so the output lands in conversation history
 * with the audit trail of every tool the run called.
 *
 * Renderer signalling:
 *   - `scheduler:task-started`   { id, name }            when a run begins
 *   - `scheduler:task-completed` { id, name, ok, ... }   when a run finishes
 *
 * Safety note: confirm-tier tools (send a message, create an event) still pause
 * for the user via the ToolRunner's confirmation gate. An unattended 7am
 * briefing therefore reads freely but cannot send anything without approval —
 * if no window is present to confirm, the gate fails the action closed.
 */

import cron, { type ScheduledTask as CronJob } from "node-cron";
import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import { randomUUID } from "crypto";

import { registry } from "./toolRegistry";
import { runToolConversation, type RunnerMessage, type ModelCompletion } from "./toolRunner";
import type { ModelTool } from "./types";
import { callAIWithTools } from "../ipc/ai";
import { createSessionRecord, recordSessionMessage } from "../ipc/sessionStore";
import { decryptKey } from "../ipc/_keyStorage";
import { log } from '../lib/log';
import {
  ensureTriggerSchema,
  readTrigger,
  describeTrigger,
  parseTrigger,
  serializeTrigger,
  nextFireAt,
  eventBus,
  emitTriggerEvent,
  TriggerGate,
  DEFAULT_EVENT_COOLDOWN_MS,
  DEFAULT_MAX_FIRES_PER_HOUR,
  type TriggerSpec,
  type TriggerType,
} from "./triggers";

type WindowGetter = () => BrowserWindow | null;

/** One Routine, mirroring the `scheduled_tasks` columns exactly. */
export interface ScheduledTask {
  id: string;
  name: string;
  description: string | null;
  /**
   * Human-readable schedule summary. For a cron Routine this is the cron
   * expression; for every other trigger type it is a summary produced by
   * `describeTrigger` ("every 15m", "on app.changed"). The authoritative
   * spec lives in `triggerType` + `triggerConfig` — see triggers.ts.
   */
  cronExpression: string;
  triggerType?: TriggerType;
  triggerConfig?: string | null;
  prompt: string;
  enabled: number; // SQLite boolean: 1 | 0
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

/** Input shape for `add()` — id/timestamps are filled in by the scheduler. */
export interface NewScheduledTask {
  name: string;
  description?: string;
  /**
   * The trigger spec. Defaults to `{type:'cron'}` with `cronExpression`,
   * which is how every pre-existing Routine and the four shipped defaults
   * keep working untouched.
   */
  trigger?: TriggerSpec | { type: TriggerType } & Record<string, unknown>;
  /** Shorthand for a cron trigger; ignored when `trigger` is supplied. */
  cronExpression?: string;
  prompt: string;
  enabled?: boolean;
}

/**
 * The four Routines Henry ships with (design §3). All disabled by default —
 * the user opts in from the Routines panel. Seeded only when the table is
 * empty, so user edits/deletes are never clobbered on a later launch.
 */
const DEFAULT_ROUTINES: Array<Omit<NewScheduledTask, "enabled">> = [
  {
    name: "Morning Briefing",
    description: "A 7am rundown of the day ahead.",
    cronExpression: "0 7 * * *",
    prompt:
      "Give me a morning briefing: list today's calendar events, any overdue " +
      "commitments, and open quotes that need follow-up.",
  },
  {
    name: "Evening Wrap",
    description: "End-of-day summary, weekdays at 6pm.",
    cronExpression: "0 18 * * 1-5",
    prompt:
      "End of day summary: what got done today, any commitments due tomorrow, " +
      "anything I should prep tonight.",
  },
  {
    name: "Client Message Watch",
    description: "Checks for new client iMessages every 15 minutes.",
    cronExpression: "*/15 * * * *",
    prompt:
      "Check for any new iMessages from known clients in the last 15 minutes. " +
      "If there are any, summarize them and flag if any need a reply.",
  },
  {
    name: "Pre-appointment Reminder",
    description: "Pulls client context before upcoming appointments (business hours).",
    cronExpression: "*/30 8-17 * * *",
    prompt:
      "Check if any calendar events start in the next 30 minutes. If so, pull " +
      "up the client record and relevant quote/job details.",
  },
];

const SCHEDULED_RUN_SYSTEM_PROMPT =
  "You are Henry, running an autonomous scheduled Routine for your owner — a " +
  "contractor. No one is necessarily watching, so be concise and useful. Use " +
  "your tools to gather what you need (calendar, messages, quotes, memory), " +
  "then write a short, skimmable summary. If nothing is noteworthy, say so " +
  "plainly rather than padding. Outbound actions (sending a message, creating " +
  "an event) will pause for the owner's approval, so it is fine to draft them.";

export class HenryScheduler {
  private jobs = new Map<string, CronJob>();
  private firing = new Set<string>(); // guards against overlapping runs
  /** In-flight run controllers, so a running Routine can be aborted. */
  private controllers = new Map<string, AbortController>();
  /**
   * One-shot (`at`) and `interval` timers, keyed by Routine id. Kept apart
   * from `jobs` because these are plain timers, not cron jobs — but they are
   * registered, untracked and torn down by the same lifecycle, so a Routine
   * still has exactly one answer to "is this scheduled and when does it run".
   */
  private timers = new Map<string, NodeJS.Timeout>();
  /**
   * Event-trigger debounce timers, keyed by `${taskId} ${event}`. A burst of
   * events collapses into one pending run rather than one run per event.
   */
  private eventDebounce = new Map<string, NodeJS.Timeout>();
  /** Unsubscribers returned by the event bus, so re-register is leak-free. */
  private eventUnsubs = new Map<string, () => void>();
  /** Debounce/cooldown/hourly-cap guard for event-triggered Routines. */
  private gate = new TriggerGate();


  constructor(
    private db: Database.Database,
    private getWindow: WindowGetter,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Seed defaults (first run only), then register every enabled Routine.
   *
   * The trigger columns are migrated here, lazily, rather than in
   * `database.ts` — that file is owned elsewhere, and a lazy idempotent
   * migration keeps this slice independently reviewable. It is safe on a
   * fresh install and on an existing database, because every pre-existing row
   * is a cron Routine and gets `triggerType` defaulted to 'cron' with no data
   * backfill.
   */
  init(): void {
    try {
      const { added } = ensureTriggerSchema(this.db);
      if (added.length > 0) {
        log.info(`[scheduler] migrated trigger columns: ${added.join(", ")}`);
      }
    } catch (e) {
      // A migration failure must not stop the scheduler booting: cron still
      // works via the legacy column, and `readTrigger` falls back to it.
      log.warn("[scheduler] trigger schema migration failed:", e);
    }
    this.seedDefaults();
    this.reconcileOrphanedRuns();
    const tasks = this.db
      .prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1")
      .all() as ScheduledTask[];
    for (const task of tasks) this.register(task);
    log.debug(
      `[scheduler] initialized — ${this.jobs.size} cron, ${this.timers.size} timer, ` +
        `${this.eventUnsubs.size} event Routine(s)`,
    );
  }

  /**
   * Stop every cron job, timer and event subscription. Called on app quit.
   */
  shutdown(): void {
    for (const [, job] of this.jobs) {
      try {
        void job.stop();
      } catch {
        /* best effort */
      }
    }
    this.jobs.clear();
    for (const [, timer] of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const [, timer] of this.eventDebounce) clearTimeout(timer);
    this.eventDebounce.clear();
    for (const [, unsub] of this.eventUnsubs) {
      try { unsub(); } catch { /* best effort */ }
    }
    this.eventUnsubs.clear();
    this.gate.reset();
    for (const ctrl of this.controllers.values()) {
      try { ctrl.abort(); } catch { /* best effort */ }
    }
    this.controllers.clear();
    // `firing` must be cleared too, or a shutdown mid-run leaves the Routine
    // permanently wedged for the rest of the process.
    this.firing.clear();
  }

  /**
   * A run that was in flight when Henry quit or crashed is still marked
   * 'running' in the database forever. On startup, close those out so the Runs
   * list and the unread badge reflect reality.
   */
  private reconcileOrphanedRuns(): void {
    try {
      const info = this.db
        .prepare(
          `UPDATE automation_runs
             SET status = 'aborted',
                 error = 'Interrupted — Henry closed while this run was in progress',
                 finished_at = ?
           WHERE status = 'running'`,
        )
        .run(new Date().toISOString());
      if (info.changes > 0) {
        log.warn(`[scheduler] reconciled ${info.changes} orphaned run(s) from a previous session`);
      }
    } catch (e) {
      log.warn('[scheduler] could not reconcile orphaned runs:', e);
    }
  }

  private seedDefaults(): void {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM scheduled_tasks")
      .get() as { n: number };
    if (row.n > 0) return;

    const insert = this.db.prepare(
      `INSERT INTO scheduled_tasks (id, name, description, cronExpression, prompt, enabled, createdAt)
       VALUES (?, ?, ?, ?, ?, 0, datetime('now'))`,
    );
    const seed = this.db.transaction(() => {
      for (const r of DEFAULT_ROUTINES) {
        insert.run(randomUUID(), r.name, r.description ?? null, r.cronExpression, r.prompt);
      }
    });
    seed();
    log.debug(`[scheduler] seeded ${DEFAULT_ROUTINES.length} default Routines (disabled)`);
  }

  // ── Registration: one dispatch over every trigger type ──────────────────

  /**
   * Register (or re-register) a task according to its trigger type, and stamp
   * its next run. Always tears down whatever was registered before, so a type
   * change leaves no orphaned timer or event subscription behind.
   */
  private register(task: ScheduledTask): void {
    this.unregister(task.id);

    const spec = readTrigger(task as unknown as Record<string, unknown>);
    switch (spec.type) {
      case "cron":
        this.registerCron(task, spec.cronExpression);
        return;
      case "interval":
        this.registerInterval(task, spec.everyMs);
        return;
      case "at":
        this.registerOneShot(task, spec.runAt);
        return;
      case "event":
        this.registerEvent(task, spec);
        return;
    }
  }

  private registerCron(task: ScheduledTask, expression: string): void {
    if (!cron.validate(expression)) {
      console.error(
        `[scheduler] invalid cron "${expression}" for Routine ${task.id} (${task.name}) — skipping`,
      );
      return;
    }

    const job = cron.schedule(
      expression,
      () => {
        this.gate.markRun(task.id);
        void this.fire(task.id);
      },
      { name: `henry-routine-${task.id}` },
    );
    this.jobs.set(task.id, job);

    // Persist the computed next-run time for the panel to display.
    const next = this.nextRunOf(job);
    this.db
      .prepare("UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?")
      .run(next, task.id);
  }

  /**
   * `interval` fires every `everyMs`. The next due time is derived from the
   * previous due time, not from when the run happened, so the cadence does
   * not drift and a slow run cannot cause a catch-up burst.
   */
  private registerInterval(
    task: ScheduledTask,
    everyMs: number,
    anchor?: number,
  ): void {
    // The anchor is the timestamp this interval was *scheduled* for, not the
    // moment the run started. Anchoring on the run start looks equivalent but
    // is not: once a run takes any non-zero time, `start + everyMs` is
    // already in the past by the time it is computed, the delay clamps to 0,
    // and the Routine re-fires immediately — doubling every period and
    // turning an interval into a busy loop. Deriving the next due time from
    // the previous due time keeps the cadence exact and self-correcting.
    const due = anchor
      ? new Date(anchor + everyMs)
      : nextFireAt({ type: "interval", everyMs }, task.lastRunAt, task.createdAt);
    if (!due) return;

    const now = Date.now();
    // An interval never catches up. `createdAt` is stored at second
    // granularity, so the first computed due time is always fractionally in
    // the past, and a re-arm chained from a due time the clock has already
    // passed lands in the past too. Firing on a past due time clamps the
    // delay to 0 and the Routine re-fires immediately, forever — so skip
    // forward to the first future occurrence instead.
    let dueMs = due.getTime();
    if (dueMs <= now) dueMs += (Math.floor((now - dueMs) / everyMs) + 1) * everyMs;
    const delay = dueMs - now;
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      this.gate.markRun(task.id);
      void this.fire(task.id).finally(() => {
        const fresh = this.getRow(task.id);
        if (fresh && fresh.enabled === 1) {
          this.registerInterval(fresh, everyMs, dueMs);
        }
      });
    }, delay);
    // A Routine must not hold the process open on quit.
    timer.unref?.();
    this.timers.set(task.id, timer);
    this.db
      .prepare("UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?")
      .run(new Date(dueMs).toISOString(), task.id);
  }

  /**
   * `at` is genuinely one-shot: after it fires, the Routine disables itself.
   * Re-arming a one-shot whose timestamp is already in the past is how a
   * backlogged date becomes a startup hot loop, so a past `at` is consumed
   * once and then cleared rather than rescheduled.
   */
  private registerOneShot(task: ScheduledTask, runAt: string): void {
    const due = nextFireAt({ type: "at", runAt }, task.lastRunAt, task.createdAt);
    if (!due) return;

    const delay = due.getTime() - Date.now();
    if (delay < 0) {
      // Missed while Henry was closed: fire once on the next tick, then let
      // fire() disable it.
      const timer = setTimeout(() => {
        this.timers.delete(task.id);
        this.gate.markRun(task.id);
        void this.fire(task.id);
      }, 1000);
      timer.unref?.();
      this.timers.set(task.id, timer);
    } else {
      const timer = setTimeout(() => {
        this.timers.delete(task.id);
        this.gate.markRun(task.id);
        void this.fire(task.id);
      }, delay);
      timer.unref?.();
      this.timers.set(task.id, timer);
    }

    this.db
      .prepare("UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?")
      .run(due.toISOString(), task.id);
  }

  /**
   * `event` subscribes to a name on the shared bus and routes it through the
   * storm guard. The subscription is the only registration: an event Routine
   * holds no timer, so an event that never fires costs one map entry and
   * never wakes anything.
   */
  private registerEvent(task: ScheduledTask, spec: Extract<TriggerSpec, { type: "event" }>): void {
    const unsub = eventBus.subscribe(spec.event, () => {
      this.onEvent(task.id, spec);
    });
    this.eventUnsubs.set(task.id, unsub);

    // An event Routine has no scheduled time of its own.
    this.db.prepare("UPDATE scheduled_tasks SET nextRunAt = NULL WHERE id = ?").run(task.id);
  }

  /**
   * An event arrived. Debounce the burst, then re-check every guard before
   * starting a run — the window can stay open for the whole debounce period,
   * during which a run may have started for some other reason.
   */
  private onEvent(taskId: string, spec: Extract<TriggerSpec, { type: "event" }>): void {
    const row = this.getRow(taskId);
    if (!row || row.enabled !== 1) return; // disabled or deleted since subscribe

    const debounceKey = `${taskId} ${spec.event}`;
    // Record the event against the storm guard before arming the timer.
    // `mayFire` only permits a run for an event that was actually noted, so
    // skipping this would make every event trigger silently inert.
    this.gate.noteEvent(taskId, spec.debounceMs);

    const pending = this.eventDebounce.get(debounceKey);
    if (pending) clearTimeout(pending);

    // Trailing-edge debounce: a burst keeps pushing the run out until the
    // events stop, so a save-storm produces exactly one run when it settles.
    const timer = setTimeout(() => {
      this.eventDebounce.delete(debounceKey);
      const allowed = this.gate.mayFire(taskId, {
        cooldownMs: DEFAULT_EVENT_COOLDOWN_MS,
        maxFiresPerHour: DEFAULT_MAX_FIRES_PER_HOUR,
        inFlight: this.firing.has(taskId),
      });
      if (!allowed) return;
      void this.fire(taskId);
    }, spec.debounceMs);
    timer.unref?.();
    this.eventDebounce.set(debounceKey, timer);
  }

  /** Tear down every kind of registration for one Routine. */
  private unregister(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      try {
        void job.stop();
      } catch {
        /* best effort */
      }
      this.jobs.delete(id);
    }

    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    const unsub = this.eventUnsubs.get(id);
    if (unsub) {
      try { unsub(); } catch { /* best effort */ }
      this.eventUnsubs.delete(id);
    }

    // Any debounce window still open for this Routine must not outlive its
    // registration, or a deleted Routine would fire once more.
    for (const [key, pending] of this.eventDebounce) {
      if (key.startsWith(`${id} `)) {
        clearTimeout(pending);
        this.eventDebounce.delete(key);
      }
    }

    this.gate.forget(id);

    // Clear the stale next-run stamp when a Routine is no longer scheduled.
    this.db.prepare("UPDATE scheduled_tasks SET nextRunAt = NULL WHERE id = ?").run(id);
  }

  private nextRunOf(job: CronJob): string | null {
    try {
      const next = job.getNextRun();
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }

  // ── Public API (backs the IPC handlers) ─────────────────────────────────

  listTasks(): ScheduledTask[] {
    return this.db
      .prepare("SELECT * FROM scheduled_tasks ORDER BY createdAt ASC")
      .all() as ScheduledTask[];
  }

  /**
   * Create a Routine. Accepts any trigger type via `trigger`; a bare
   * `cronExpression` (what every existing caller sends) is still valid and
   * produces a cron trigger, so no caller had to change.
   */
  add(task: NewScheduledTask): ScheduledTask {
    if (!task.name?.trim()) throw new Error("Routine name is required.");
    if (!task.prompt?.trim()) throw new Error("Prompt is required.");

    // The migration is idempotent and owned by this module, so a caller can
    // create a non-cron Routine without the scheduler having been init'd.
    ensureTriggerSchema(this.db);

    const raw = task.trigger ?? { type: "cron" as TriggerType, cronExpression: task.cronExpression };
    // parseTrigger throws a TriggerValidationError whose message is written
    // for the user — let it propagate rather than flattening it.
    const spec = parseTrigger(raw);
    if (spec.type === "cron" && !cron.validate(spec.cronExpression)) {
      throw new Error(`Invalid cron expression: "${spec.cronExpression}"`);
    }

    const id = randomUUID();
    const enabled = task.enabled ? 1 : 0;
    // `cronExpression` is NOT NULL and predates the trigger columns, so it
    // always gets a value: the real expression for cron, a readable summary
    // otherwise. The authoritative spec is triggerType + triggerConfig.
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks
           (id, name, description, cronExpression, triggerType, triggerConfig, prompt, enabled, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        id,
        task.name.trim(),
        task.description?.trim() || null,
        describeTrigger(spec),
        spec.type,
        serializeTrigger(spec),
        task.prompt.trim(),
        enabled,
      );

    const row = this.getRow(id)!;
    if (enabled) this.register(row);
    return this.getRow(id)!;
  }

  /**
   * Change a Routine's trigger (e.g. promote a cron Routine to an interval
   * one). Re-registers from the new spec and unregisters the old one, so
   * no stale timer or event subscription survives the change.
   */
  setTrigger(id: string, raw: unknown): ScheduledTask | null {
    const row = this.getRow(id);
    if (!row) return null;

    const spec = parseTrigger(raw);
    if (spec.type === "cron" && !cron.validate(spec.cronExpression)) {
      throw new Error(`Invalid cron expression: "${spec.cronExpression}"`);
    }

    const wasEnabled = row.enabled === 1;
    // Tear down the previous registration before the row changes, so nothing
    // keeps firing under the old spec.
    this.unregister(id);
    this.db
      .prepare(
        `UPDATE scheduled_tasks
            SET cronExpression = ?, triggerType = ?, triggerConfig = ?
          WHERE id = ?`,
      )
      .run(describeTrigger(spec), spec.type, serializeTrigger(spec), id);

    if (wasEnabled) this.register(this.getRow(id)!);
    return this.getRow(id);
  }

  /** The trigger spec for a Routine, as the authoritative typed value. */
  getTrigger(id: string): TriggerSpec | null {
    const row = this.getRow(id);
    if (!row) return null;
    return readTrigger(row as unknown as Record<string, unknown>);
  }

  /**
   * Fire every enabled Routine watching `event`, through the storm guard.
   * This is the app-facing entry point (re-exported from triggers.ts as
   * `emitTriggerEvent`); the scheduler exposes it too so callers holding a
   * scheduler instance do not need a second import.
   */
  fireEvent(event: string, payload?: unknown): number {
    return emitTriggerEvent(event, payload);
  }

  remove(id: string): boolean {
    this.unregister(id);
    const info = this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    return info.changes > 0;
  }

  enable(id: string): ScheduledTask | null {
    const row = this.getRow(id);
    if (!row) return null;
    this.db.prepare("UPDATE scheduled_tasks SET enabled = 1 WHERE id = ?").run(id);
    this.register(this.getRow(id)!);
    return this.getRow(id);
  }

  disable(id: string): ScheduledTask | null {
    const row = this.getRow(id);
    if (!row) return null;
    this.db.prepare("UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?").run(id);
    this.unregister(id);
    return this.getRow(id);
  }

  /** Fire a Routine immediately, regardless of its schedule or enabled state. */
  async runNow(id: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const row = this.getRow(id);
    if (!row) return { ok: false, error: `No Routine found for id "${id}"` };
    return this.fire(id, "manual");
  }

  private getRow(id: string): ScheduledTask | null {
    return (
      (this.db
        .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
        .get(id) as ScheduledTask | undefined) ?? null
    );
  }

  // ── Firing a Routine ─────────────────────────────────────────────────────

  private async fire(
    id: string,
    trigger: 'schedule' | 'manual' = 'schedule',
  ): Promise<{ ok: boolean; content?: string; error?: string }> {
    const task = this.getRow(id);
    if (!task) return { ok: false, error: "Routine not found" };

    // Skip if a previous run of this Routine is still in flight (e.g. a long
    // model turn overrunning a */15 cadence).
    if (this.firing.has(id)) {
      console.warn(`[scheduler] Routine ${task.name} still running — skipping this tick`);
      return { ok: false, error: "Previous run still in progress" };
    }
    this.firing.add(id);

    // A one-shot (`at`) Routine is spent the moment it fires: disable it and
    // tear down its registration so it cannot come back on the next app
    // launch and fire again with a timestamp still in the past. Done before
    // the run so a crash mid-run cannot resurrect it.
    const spec = readTrigger(task as unknown as Record<string, unknown>);
    const oneShot = spec.type === "at";
    if (oneShot) {
      this.db.prepare("UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?").run(id);
      this.unregister(id);
    }


    const controller = new AbortController();
    this.controllers.set(id, controller);
    // Everything from here must be inside the try, or a throw would skip the
    // finally and leave `firing` set for the life of the process — which wedges
    // the Routine (every later tick short-circuits, isRunning() stays true and
    // abort() reports nothing to abort).
    const startedAt = new Date().toISOString();
    let runId: string | null = null;
    let sessionId: string | null = null;
    try {
      this.send("scheduler:task-started", { id: task.id, name: task.name });

      // ── Run history ────────────────────────────────────────────────────
      // Scheduled tasks only remembered lastRunAt, so there was no record of
      // what a Routine actually did, whether it failed, or what was unread.
      runId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO automation_runs (id, task_id, task_name, prompt, status, trigger, started_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(runId, task.id, task.name, task.prompt, trigger, startedAt);
      this.send("automation:run-changed", { id: runId, taskId: task.id, status: "running" });

      // Open a session so the run's output + tool-call audit trail are recorded.
      sessionId =
        (await createSessionRecord({
          title: `Routine: ${task.name}`,
          origin: "schedule",
          system_prompt: SCHEDULED_RUN_SYSTEM_PROMPT,
        }).catch(() => null)) ?? randomUUID();

      await recordSessionMessage({
        session_id: sessionId,
        role: "user",
        kind: "chat",
        content: task.prompt,
      }).catch(() => {});

      const content = await this.runPrompt(task.prompt, sessionId, controller.signal);

      await recordSessionMessage({
        session_id: sessionId,
        role: "assistant",
        kind: "chat",
        content,
      }).catch(() => {});

      // Stamp last/next run.
      const job = this.jobs.get(id);
      const next = job ? this.nextRunOf(job) : null;
      this.db
        .prepare("UPDATE scheduled_tasks SET lastRunAt = ?, nextRunAt = ? WHERE id = ?")
        .run(startedAt, next, id);

      if (runId) {
        this.db
          .prepare(
            `UPDATE automation_runs SET status = 'succeeded', result = ?, session_id = ?, finished_at = ?
             WHERE id = ?`,
          )
          .run(content, sessionId, new Date().toISOString(), runId);
      }
      this.send("automation:run-changed", { id: runId, taskId: task.id, status: "succeeded" });
      this.notifyFinished(runId, task.name, true);
      this.send("scheduler:task-completed", {
        id: task.id,
        name: task.name,
        ok: true,
        sessionId,
        content,
      });
      return { ok: true, content };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const aborted = controller.signal.aborted;
      console.error(`[scheduler] Routine ${task.name} failed:`, error);
      this.db
        .prepare("UPDATE scheduled_tasks SET lastRunAt = ? WHERE id = ?")
        .run(startedAt, id);
      if (runId) {
        this.db
          .prepare(
            `UPDATE automation_runs SET status = ?, error = ?, session_id = ?, finished_at = ? WHERE id = ?`,
          )
          .run(aborted ? 'aborted' : 'failed', error, sessionId, new Date().toISOString(), runId);
      }
      this.send("automation:run-changed", { id: runId, taskId: task.id, status: aborted ? "aborted" : "failed" });
      this.notifyFinished(runId, task.name, false);
      this.send("scheduler:task-completed", {
        id: task.id,
        name: task.name,
        ok: false,
        sessionId,
        error,
      });
      return { ok: false, error };
    } finally {
      this.firing.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }

  /**
   * Abort the in-flight run of a Routine, if any. Returns true when a run was
   * actually cancelled.
   */
  abort(id: string): boolean {
    const ctrl = this.controllers.get(id);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** Whether a Routine currently has a run in flight. */
  isRunning(id: string): boolean {
    return this.firing.has(id);
  }

  /**
   * Run a single prompt through the full tool suite. Resolves the worker engine
   * config (provider/model/key) the same way the task broker does, builds the
   * `complete` callback over `callAIWithTools`, and drives the tool-call loop.
   */
  private async runPrompt(prompt: string, sessionId: string, external?: AbortSignal): Promise<string> {
    const { provider, model, apiKey } = this.resolveEngine();

    const messages: RunnerMessage[] = [
      { role: "system", content: SCHEDULED_RUN_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    // Hard timeout per model round so a stalled provider can't hang a Routine.
    const complete = (msgs: RunnerMessage[], modelTools: ModelTool[]): Promise<ModelCompletion> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      // An abort request (or a shutdown) must also cancel the in-flight fetch.
      // The signal may ALREADY be aborted by the time a later round starts (an
      // abort can land during a tool call or during session setup) — and a
      // listener added to an aborted signal never fires, which silently dropped
      // the abort and let the run finish as 'succeeded'.
      const onExternalAbort = () => ctrl.abort();
      if (external?.aborted) ctrl.abort();
      else external?.addEventListener('abort', onExternalAbort);
      return callAIWithTools({ provider, model, apiKey, messages: msgs, modelTools, signal: ctrl.signal })
        .finally(() => {
          clearTimeout(timer);
          external?.removeEventListener('abort', onExternalAbort);
        });
    };

    const context = {
      db: this.db,
      getWindow: this.getWindow,
      sessionId,
    };

    const result = await runToolConversation({ registry, context, messages, complete });
    return result.content;
  }

  /**
   * Resolve the engine a Routine runs on. Routines use the Worker engine
   * (same as background tasks) so they don't depend on the chat UI's current
   * model selection. Mirrors `getWorkerEngineConfig` in taskBroker.ts.
   */
  private resolveEngine(): { provider: string; model: string; apiKey: string } {
    const get = (key: string): string =>
      (
        (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
          | { value?: string }
          | undefined)?.value ?? ""
      ).trim();

    const providerId = get("worker_provider");
    const model = get("worker_model");
    if (!providerId || !model) {
      throw new Error(
        "Worker engine is not configured. Open Settings and choose a Worker provider/model so Routines can run.",
      );
    }

    const provider = this.db
      .prepare("SELECT * FROM providers WHERE id = ?")
      .get(providerId) as { id: string; name: string; api_key?: string } | undefined;
    if (!provider) {
      throw new Error("Worker provider not found. Reconfigure the Worker engine in Settings.");
    }

    const isOllama =
      (provider.id || "").toLowerCase() === "ollama" ||
      (provider.name || "").toLowerCase() === "ollama";
    if (!isOllama && !provider.api_key) {
      throw new Error(`Worker provider "${provider.name}" is missing an API key.`);
    }

    return { provider: providerId, model, apiKey: decryptKey(provider.api_key ?? "") };
  }

  // ── Renderer signalling ─────────────────────────────────────────────────

  private send(channel: string, data: unknown): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }

  /**
   * Native notification for a finished run, clickable back into the run.
   * Never let a notification failure escape into the scheduler — a run that
   * succeeded must still be recorded as succeeded.
   */
  private notifyFinished(runId: number | string | null | undefined, name: string, success: boolean): void {
    try {
      // Loaded lazily so the scheduler stays usable in contexts without a
      // window, and so the module is only pulled in when a run actually ends.
      const { notifyRunFinished } = require("../ipc/automationNotifications") as typeof import("../ipc/automationNotifications");
      // The scheduler holds the run id as a string (it comes from lastInsertRowid).
      if (runId == null) return;
      const id = Number(runId);
      if (!Number.isFinite(id)) return;
      notifyRunFinished({ runId: id, title: name || "Routine finished", success });
    } catch (e) {
      console.warn("[scheduler] run notification failed:", e instanceof Error ? e.message : e);
    }
  }
}
