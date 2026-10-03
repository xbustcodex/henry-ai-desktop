/**
 * Scheduler IPC — the renderer's boundary to Henry's Routines (design §6).
 *
 *   - `scheduler:list`         → every Routine with its status/next-run
 *   - `scheduler:add`          → create a new Routine (any trigger type)
 *   - `scheduler:set-trigger`  → change an existing Routine's trigger type
 *   - `scheduler:toggle`       → enable/disable a Routine by id
 *   - `scheduler:run-now`      → fire a Routine immediately
 *   - `scheduler:delete`       → remove a Routine
 *
 * The `HenryScheduler` instance is owned by main.ts and handed in here so the
 * cron jobs and the IPC surface share one source of truth.
 */

import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import type { HenryScheduler, NewScheduledTask } from "../agent/scheduler";

/** Wrap a handler so the renderer always gets `{ ok, result }` | `{ ok, error }`. */
function safe<T>(fn: () => T | Promise<T>) {
  return async () => {
    try {
      return { ok: true, result: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export function registerSchedulerHandlers(scheduler: HenryScheduler, db: Database.Database): void {
  ipcMain.handle("scheduler:list", () => {
    try {
      return { ok: true, result: scheduler.listTasks() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("scheduler:add", (_e, task: NewScheduledTask) =>
    safe(() => scheduler.add(task))(),
  );

  /**
   * Change a Routine's trigger type after it exists. Without this the renderer
   * can only ever create cron Routines — `scheduler:add` accepted any spec, but
   * nothing could ever move an existing Routine onto one, so a Routine created
   * from the wrong type was permanently wrong.
   *
   * `scheduler.setTrigger` re-parses through `parseTrigger`, so an invalid spec
   * comes back as `{ ok: false, error }` with a message written for the user
   * and the row is left untouched.
   */
  ipcMain.handle(
    "scheduler:set-trigger",
    (_e, payload: { id: string; trigger: unknown }) =>
      safe(() => {
        if (!payload?.id) throw new Error("A Routine id is required.");
        const updated = scheduler.setTrigger(String(payload.id), payload.trigger);
        if (!updated) throw new Error(`No Routine found for id "${payload.id}".`);
        return updated;
      })(),
  );

  ipcMain.handle(
    "scheduler:toggle",
    (_e, payload: { id: string; enabled: boolean }) =>
      safe(() =>
        payload.enabled ? scheduler.enable(payload.id) : scheduler.disable(payload.id),
      )(),
  );

  ipcMain.handle("scheduler:run-now", (_e, payload: { id: string }) =>
    safe(() => scheduler.runNow(payload.id))(),
  );

  ipcMain.handle("scheduler:delete", (_e, payload: { id: string }) =>
    safe(() => scheduler.remove(payload.id))(),
  );

  // ── Run history ──────────────────────────────────────────────────────────
  // Every automation:* handler is wrapped: a DB error must surface as
  // {ok:false} rather than rejecting the invoke, which the renderer's single
  // bare catch would swallow and silently disable the whole Runs feature.
  const runSafe = <T>(fn: () => T): { ok: true; result: T; error?: undefined } | { ok: false; result: T; error: string } => {
    const empty = undefined as T;
    try {
      return { ok: true, result: fn() };
    } catch (e: unknown) {
      console.error("[automation] query failed", e);
      return { ok: false, result: empty, error: e instanceof Error ? e.message : String(e) };
    }
  };

  ipcMain.handle("automation:runs", (_e, opts: { taskId?: string; limit?: number; unreadOnly?: boolean } = {}) => {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    // unreadOnly must compose with taskId — it used to be dropped whenever a
    // taskId was supplied, so a per-routine unread filter silently showed all.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.taskId) { where.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.unreadOnly) { where.push("read_at IS NULL"); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const res = runSafe(() =>
      db.prepare(`SELECT * FROM automation_runs ${clause} ORDER BY started_at DESC LIMIT ?`).all(...params, limit),
    );
    // Return the ARRAY the renderer expects. Returning `{ok, rows}` here made
    // every caller do `.map` on an object — "v.map is not a function" — and the
    // Runs list broke. Fail soft to an empty list instead.
    if (!res.ok) {
      console.error('[automation:runs]', res.error);
      return [];
    }
    return res.result;
  });

  ipcMain.handle("automation:unread-count", () => {
    const res = runSafe(() =>
      db.prepare(`SELECT COUNT(*) AS n FROM automation_runs WHERE read_at IS NULL AND status != 'running'`).get() as { n: number } | undefined,
    );
    return { count: res.result?.n ?? 0, error: res.error };
  });

  ipcMain.handle("automation:mark-read", (_e, id: string) => {
    try {
      db.prepare(`UPDATE automation_runs SET read_at = datetime('now') WHERE id = ?`).run(id);
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("automation:mark-all-read", () => {
    try {
      const info = db
        .prepare(`UPDATE automation_runs SET read_at = datetime('now') WHERE read_at IS NULL`)
        .run();
      return { ok: true, count: info.changes };
    } catch (e: unknown) {
      return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("automation:clear-runs", (_e, taskId?: string) => {
    try {
      // In-flight runs are excluded on BOTH branches — deleting one mid-run
      // meant the completion UPDATE matched no rows and the outcome was lost.
      if (taskId) {
        db.prepare(`DELETE FROM automation_runs WHERE task_id = ? AND status != 'running'`).run(taskId);
      } else {
        db.prepare(`DELETE FROM automation_runs WHERE status != 'running'`).run();
      }
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Abort a Routine that is running right now. */
  ipcMain.handle("automation:abort", (_e, taskId: string) => {
    const aborted = scheduler.abort(taskId);
    if (!aborted) {
      return { ok: false, error: "That Routine is not running right now." };
    }
    return { ok: true };
  });

  ipcMain.handle("automation:is-running", (_e, taskId: string) => {
    return { running: scheduler.isRunning(taskId) };
  });
}
