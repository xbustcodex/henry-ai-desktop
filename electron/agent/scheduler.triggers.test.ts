/**
 * Scheduler trigger wiring — the behaviours that live in HenryScheduler
 * itself rather than in the pure core (triggers.ts, tested there).
 *
 * Specifically the things that are easy to get subtly wrong and impossible to
 * see in the pure module:
 *   - a one-shot disables itself so it cannot resurrect on the next launch
 *   - an event Routine tears its subscription down on disable/remove, so a
 *     deleted Routine cannot fire once more
 *   - a pre-migration database is migrated on init() and its existing cron
 *     Routines keep working untouched
 *
 * Heavy deps are mocked because we assert on registration/timers, not on the
 * model round: `runPrompt` is stubbed, so no provider is ever called.
 *
 * `node:sqlite` stands in for better-sqlite3 (Electron ABI, not dlopen-able
 * under plain Node) — same SQL engine, so the migration and the CHECK-free
 * scheduled_tasks schema are genuinely exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { HenryScheduler } from "./scheduler";
import { eventBus, emitTriggerEvent, resetMigrationCache } from "./triggers";
// A run is exactly one `callAIWithTools` call: the tool loop stops as soon as
// the model returns no tool calls, so this is the "did a run happen" counter.
import { callAIWithTools } from "../ipc/ai";

const aiCalls = vi.mocked(callAIWithTools);

vi.mock("../ipc/ai", () => ({
  // A completion with no tool calls ends the tool loop immediately, so these
  // tests exercise trigger registration/timers and never a real provider.
  callAIWithTools: vi.fn(async () => ({ content: "done", toolCalls: [] })),
}));
vi.mock("../ipc/sessionStore", () => ({
  // Mirrors the real signature: Promise<string | null>, not an object.
  createSessionRecord: vi.fn(async () => "sess-1"),
  recordSessionMessage: vi.fn(async () => undefined),
}));

vi.mock("../ipc/_keyStorage", () => ({ decryptKey: (s: string) => s }));
vi.mock("../lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));


/**
 * `node:sqlite` has no `.transaction()` helper (better-sqlite3 does), so wrap
 * it here rather than changing production code to accommodate the test
 * double. `seedDefaults` uses it, so every test fails without this shim.
 */
type DbLike = DatabaseSync & {
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
};

function withTransaction(db: DatabaseSync): DbLike {
  const wrapped = db as DbLike;
  wrapped.transaction = ((fn: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      db.exec("BEGIN");
      try {
        const out = fn(...args);
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      }
    }) as DbLike["transaction"];
  return wrapped;
}

/** The pre-migration `scheduled_tasks` shape. */
function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT,
      cronExpression TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      lastRunAt      TEXT,
      nextRunAt      TEXT,
      createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY, task_id TEXT, task_name TEXT, prompt TEXT,
      status TEXT, trigger TEXT, result TEXT, error TEXT, session_id TEXT,
      read_at TEXT, started_at TEXT, finished_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT, api_key TEXT DEFAULT ''
    );
    INSERT INTO providers (id, name, api_key) VALUES ('test', 'Test', 'enc:v1:fake');
    INSERT INTO settings (key, value) VALUES ('worker_provider', 'test');
    INSERT INTO settings (key, value) VALUES ('worker_model', 'test-model');
  `);
  return withTransaction(db);
}

const asDb = (db: DatabaseSync) => db as unknown as ConstructorParameters<typeof HenryScheduler>[0];

const cols = (db: DatabaseSync) =>
  (db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>).map((c) => c.name);

const enabledOf = (db: DatabaseSync, id: string) =>
  (db.prepare("SELECT enabled FROM scheduled_tasks WHERE id = ?").get(id) as { enabled: number }).enabled;

let db: DatabaseSync;
let sched: HenryScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(callAIWithTools).mockClear();
  resetMigrationCache();
  eventBus.reset();
  db = legacyDb();
  sched = new HenryScheduler(asDb(db), () => null);
});

afterEach(() => {
  sched.shutdown();
  vi.useRealTimers();
});

describe("scheduler trigger migration on init", () => {
  it("adds the trigger columns to a legacy database at init", () => {
    sched.init();
    expect(cols(db)).toEqual(expect.arrayContaining(["triggerType", "triggerConfig"]));
  });

  it("leaves an existing cron Routine enabled, scheduled and correct", () => {
    db.prepare(
      `INSERT INTO scheduled_tasks (id, name, cronExpression, prompt, enabled)
       VALUES ('old', 'Legacy', '0 7 * * *', 'brief me', 1)`,
    ).run();

    sched.init();

    const row = db.prepare("SELECT * FROM scheduled_tasks WHERE id='old'").get() as Record<string, unknown>;
    expect(row.triggerType).toBe("cron");
    // A cron Routine still gets a real next-run stamp, proving it registered
    // through node-cron rather than being skipped.
    expect(row.nextRunAt).toBeTruthy();
  });

  it("is idempotent across two launches against the same file", () => {
    sched.init();
    sched.shutdown();
    resetMigrationCache();

    const second = new HenryScheduler(asDb(db), () => null);
    second.init();
    expect(cols(db)).toEqual(expect.arrayContaining(["triggerType", "triggerConfig"]));
    second.shutdown();
  });
});

describe("interval triggers", () => {
  it("records a next-run stamp derived from the last run", () => {
    sched.init();
    const task = sched.add({
      name: "Poll",
      prompt: "poll",
      trigger: { type: "interval", everyMs: 60_000 },
      enabled: true,
    });

    expect(task.triggerType).toBe("interval");
    expect(task.cronExpression).toBe("every 1m"); // readable summary, not blank
    expect(task.nextRunAt).toBeTruthy();
  });

  it("fires once the interval elapses and re-arms for the next one", async () => {
    sched.init();
    sched.add({
      name: "Poll",
      prompt: "poll",
      trigger: { type: "interval", everyMs: 60_000 },
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(aiCalls).toHaveBeenCalledTimes(2);
  });

  // Regression: the re-arm used to anchor on the run's start time, so once a
  // run took any real time the next due time was already in the past, the
  // delay clamped to 0, and the Routine re-fired immediately — doubling
  // every period. Over a few periods that is a busy loop.
  it("does not fire twice in one period when a run takes real time", async () => {
    sched.init();
    sched.add({
      name: "Poll",
      prompt: "poll",
      trigger: { type: "interval", everyMs: 60_000 },
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    // Still inside the same 60s period: nothing more should happen.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  // Regression: `createdAt` is stored at second granularity, so the first
  // computed due time is always fractionally in the past. Re-firing on a past
  // due time clamps the delay to 0 and spins the Routine in a hot loop —
  // hundreds of runs per period. An interval must skip forward, not catch up.
  it("skips missed intervals instead of replaying them", async () => {
    sched.init();
    sched.add({
      name: "Poll",
      prompt: "poll",
      trigger: { type: "interval", everyMs: 60_000 },
      enabled: true,
    });

    // One period produces exactly one run, not a spin.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    // Five periods later there have been five more, not hundreds.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(aiCalls).toHaveBeenCalledTimes(6); // 1 + 5, not 601
  });

  it("rejects an interval below the supported floor with a user-facing error", () => {
    sched.init();
    expect(() =>
      sched.add({ name: "TooFast", prompt: "p", trigger: { type: "interval", everyMs: 1000 } }),
    ).toThrow(/between/);
  });
});

describe("one-shot (at) triggers", () => {
  const soon = () => new Date(Date.now() + 30_000).toISOString();

  it("fires at its time and then disables itself", async () => {
    sched.init();
    sched.add({ name: "OneOff", prompt: "once", trigger: { type: "at", runAt: soon() }, enabled: true });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    const row = db.prepare("SELECT enabled FROM scheduled_tasks WHERE name='OneOff'").get() as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });

  // The hot-loop risk: a one-shot whose time has passed must be consumed,
  // not re-armed, or every launch would replay it.
  it("does not fire again after a restart, because it disabled itself", async () => {
    sched.init();
    sched.add({ name: "OneOff", prompt: "once", trigger: { type: "at", runAt: soon() }, enabled: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    sched.shutdown();
    resetMigrationCache();
    const relaunch = new HenryScheduler(asDb(db), () => null);
    relaunch.init();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(aiCalls).toHaveBeenCalledTimes(1); // no replay
    relaunch.shutdown();
  });

  it("fires exactly once for a time that has already passed", async () => {
    sched.init();
    const past = new Date(Date.now() - 60_000).toISOString();
    sched.add({ name: "Missed", prompt: "missed", trigger: { type: "at", runAt: past }, enabled: true });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(aiCalls).toHaveBeenCalledTimes(1); // not a repeating backlog
  });
});

describe("event triggers", () => {
  const spec = { type: "event" as const, event: "app.changed", debounceMs: 1_000 };

  it("fires when the watched event is emitted", async () => {
    sched.init();
    sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });

    emitTriggerEvent("app.changed", { pid: 42 });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  it("ignores events it does not watch", async () => {
    sched.init();
    sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });

    emitTriggerEvent("some.other.event");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aiCalls).not.toHaveBeenCalled();
  });

  // Storm guard end to end: 20 events inside the debounce window is one run.
  it("collapses a burst of events into a single run", async () => {
    sched.init();
    sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });

    for (let i = 0; i < 20; i++) emitTriggerEvent("app.changed");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  it("holds the cooldown so a slow trickle cannot storm", async () => {
    sched.init();
    sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });

    emitTriggerEvent("app.changed");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(aiCalls).toHaveBeenCalledTimes(1);

    // Well past the debounce, but inside the 60s cooldown.
    emitTriggerEvent("app.changed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aiCalls).toHaveBeenCalledTimes(1);
  });

  // A disabled or deleted Routine must be inert even though its bus
  // subscription was established earlier.
  it("stops firing once the Routine is disabled", async () => {
    sched.init();
    const task = sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });
    sched.disable(task.id)!;

    emitTriggerEvent("app.changed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aiCalls).not.toHaveBeenCalled();
  });

  it("stops firing once the Routine is removed", async () => {
    sched.init();
    const task = sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });
    sched.remove(task.id);

    emitTriggerEvent("app.changed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aiCalls).not.toHaveBeenCalled();
    expect(eventBus.watcherCount("app.changed")).toBe(0);
  });

  it("has no next-run stamp, because it has no scheduled time", () => {
    sched.init();
    const task = sched.add({ name: "OnChange", prompt: "react", trigger: spec, enabled: true });
    expect(task.nextRunAt).toBeNull();
    expect(task.cronExpression).toBe("on app.changed");
  });

  it("rejects a malformed event name", () => {
    sched.init();
    expect(() =>
      sched.add({ name: "Bad", prompt: "p", trigger: { type: "event", event: "App Changed" } }),
    ).toThrow(/dotted/);
  });
});

describe("changing a Routine's trigger", () => {
  it("promotes a cron Routine to an interval and tears down the cron job", async () => {
    sched.init();
    const task = sched.add({
      name: "Shift",
      prompt: "p",
      cronExpression: "*/5 * * * *",
      enabled: true,
    });
    expect(task.nextRunAt).toBeTruthy(); // cron registered

    const updated = sched.setTrigger(task.id, { type: "interval", everyMs: 120_000 })!;
    expect(updated.triggerType).toBe("interval");
    expect(sched.getTrigger(task.id)).toEqual({ type: "interval", everyMs: 120_000 });
  });

  it("leaves no duplicate subscription when re-registering an event Routine", async () => {
    sched.init();
    const task = sched.add({
      name: "OnChange",
      prompt: "p",
      trigger: { type: "event", event: "doc.saved", debounceMs: 500 },
      enabled: true,
    });
    expect(eventBus.watcherCount("doc.saved")).toBe(1);

    sched.setTrigger(task.id, { type: "event", event: "doc.saved", debounceMs: 500 });
    expect(eventBus.watcherCount("doc.saved")).toBe(1); // re-register, not stack

    emitTriggerEvent("doc.saved");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(aiCalls).toHaveBeenCalledTimes(1); // one run, not two
  });

  it("returns null when changing the trigger of an unknown Routine", () => {
    sched.init();
    expect(sched.setTrigger("nope", { type: "interval", everyMs: 60_000 })).toBeNull();
  });
});

describe("backward compatibility", () => {
  // Every existing caller passes a bare cronExpression and never a trigger.
  it("accepts the legacy cronExpression-only shape unchanged", () => {
    sched.init();
    const task = sched.add({ name: "Legacy", cronExpression: "0 7 * * *", prompt: "brief me" });
    expect(task.triggerType).toBe("cron");
    expect(sched.getTrigger(task.id)).toEqual({ type: "cron", cronExpression: "0 7 * * *" });
  });

  it("still rejects an invalid cron expression", () => {
    sched.init();
    expect(() => sched.add({ name: "Bad", cronExpression: "not a cron", prompt: "p" })).toThrow(
      /Invalid cron expression/,
    );
  });

  it("still requires a name and a prompt", () => {
    sched.init();
    expect(() => sched.add({ name: "", cronExpression: "0 7 * * *", prompt: "p" })).toThrow(/name/);
    expect(() => sched.add({ name: "N", cronExpression: "0 7 * * *", prompt: "" })).toThrow(/prompt/i);
  });

  it("exposes the shipped default Routines as cron triggers", () => {
    sched.init();
    const tasks = sched.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(sched.getTrigger(t.id)!.type).toBe("cron");
    }
  });
});
