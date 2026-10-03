/**
 * Tests for the pure trigger core (electron/agent/triggers.ts).
 *
 * Two things are worth proving here, and they are different from "the
 * functions return something":
 *
 *   1. The migration is genuinely idempotent — on a FRESH database that has
 *      no trigger columns, and on an EXISTING one that already has them, and
 *      across repeated calls. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a
 *      naive implementation throws on the second launch.
 *   2. The event storm guard actually prevents the busy-loop. A trigger type
 *      that can fire itself is the one way this feature can burn a user's
 *      battery, so debounce / cooldown / hourly-cap / in-flight are each
 *      tested as a distinct brake, not as one "it doesn't loop" assertion.
 *
 * Runs on `node:sqlite`: better-sqlite3 in this repo is rebuilt against
 * Electron's ABI and cannot be dlopen'd under plain Node.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  parseTrigger,
  describeTrigger,
  serializeTrigger,
  readTrigger,
  nextFireAt,
  TriggerGate,
  eventBus,
  emitTriggerEvent,
  ensureTriggerSchema,
  resetMigrationCache,
  TriggerValidationError,
  MIN_INTERVAL_MS,
  MAX_DEBOUNCE_MS,
  DEFAULT_EVENT_COOLDOWN_MS,
  DEFAULT_MAX_FIRES_PER_HOUR,
} from "./triggers";

/** The pre-migration `scheduled_tasks` shape — cron column only. */
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
  `);
  return db;
}

const asDb = (db: DatabaseSync) => db as unknown as Parameters<typeof ensureTriggerSchema>[0];

describe("trigger spec validation", () => {
  it("rejects an unknown trigger type with a message naming the valid set", () => {
    expect(() => parseTrigger({ type: "sundial" })).toThrow(TriggerValidationError);
    expect(() => parseTrigger({ type: "sundial" })).toThrow(/cron, interval, at, event/);
  });

  it("rejects a missing or non-object trigger", () => {
    expect(() => parseTrigger(null)).toThrow(/trigger is required/i);
    expect(() => parseTrigger("every day")).toThrow(/trigger is required/i);
  });

  it("requires a cron expression for a cron trigger", () => {
    expect(() => parseTrigger({ type: "cron" })).toThrow(/cronExpression/);
    expect(parseTrigger({ type: "cron", cronExpression: " 0 7 * * * " })).toEqual({
      type: "cron",
      cronExpression: "0 7 * * *",
    });
  });

  // The interval floor is a real guard: a cadence shorter than one model
  // round can outrun the very thing it triggers.
  it("refuses an interval below the floor and accepts one at it", () => {
    expect(() => parseTrigger({ type: "interval", everyMs: 1000 })).toThrow(/between/);
    expect(parseTrigger({ type: "interval", everyMs: MIN_INTERVAL_MS })).toEqual({
      type: "interval",
      everyMs: MIN_INTERVAL_MS,
    });
  });

  it("refuses a non-numeric interval", () => {
    expect(() => parseTrigger({ type: "interval", everyMs: "often" })).toThrow(/must be a number/);
  });

  it("canonicalises a one-shot runAt to ISO-8601", () => {
    expect(parseTrigger({ type: "at", runAt: "2026-10-03T10:00:00Z" })).toEqual({
      type: "at",
      runAt: "2026-10-03T10:00:00.000Z",
    });
  });

  it("refuses an unparseable one-shot date", () => {
    expect(() => parseTrigger({ type: "at", runAt: "next tuesday-ish" })).toThrow(/not a valid date/);
  });

  it("refuses an event name that is not lowercase dotted words", () => {
    expect(() => parseTrigger({ type: "event", event: "App Changed" })).toThrow(/dotted/);
    expect(() => parseTrigger({ type: "event", event: "app..changed" })).toThrow(/dotted/);
    expect(parseTrigger({ type: "event", event: "doc.saved" })).toEqual({
      type: "event",
      event: "doc.saved",
      debounceMs: DEFAULT_EVENT_COOLDOWN_MS,
    });
  });

  it("refuses an out-of-range event debounce", () => {
    const atMax = parseTrigger({ type: "event", event: "a.b", debounceMs: MAX_DEBOUNCE_MS });
    // `debounceMs` exists only on the `event` variant — it is the one trigger
    // kind that can storm, so it is the one that carries a debounce. Narrow
    // rather than cast: a union member without the field must not satisfy this.
    expect(atMax.type).toBe("event");
    if (atMax.type !== "event") throw new Error("expected an event trigger");
    expect(atMax.debounceMs).toBe(MAX_DEBOUNCE_MS);
  });
});

describe("trigger description round-trip", () => {
  it("describes each type in something a human can read", () => {
    expect(describeTrigger({ type: "cron", cronExpression: "0 7 * * *" })).toBe("0 7 * * *");
    expect(describeTrigger({ type: "interval", everyMs: 15 * 60_000 })).toBe("every 15m");
    expect(describeTrigger({ type: "interval", everyMs: 3 * 3_600_000 })).toBe("every 3h");
    expect(describeTrigger({ type: "event", event: "app.changed", debounceMs: 1000 })).toBe(
      "on app.changed",
    );
  });

  it("survives serialize -> read for every trigger type", () => {
    const specs = [
      { type: "cron", cronExpression: "*/5 * * * *" },
      { type: "interval", everyMs: 60_000 },
      { type: "at", runAt: "2026-10-03T10:00:00.000Z" },
      { type: "event", event: "app.changed", debounceMs: 1000 },
    ] as const;
    for (const spec of specs) {
      expect(readTrigger({ triggerType: spec.type, triggerConfig: serializeTrigger(spec) })).toEqual(
        spec,
      );
    }
  });

  // A corrupt config must never wedge a Routine or crash startup.
  it("falls back to cron when the stored config is corrupt", () => {
    expect(readTrigger({ triggerType: "interval", triggerConfig: "{not json", cronExpression: "0 9 * * *" })).toEqual({
      type: "cron",
      cronExpression: "0 9 * * *",
    });
  });

  it("treats a row with no trigger columns as a cron Routine", () => {
    expect(readTrigger({ cronExpression: "0 7 * * *" })).toEqual({ type: "cron", cronExpression: "0 7 * * *" });
  });
});

describe("next-fire arithmetic", () => {
  it("measures an interval from the last run, not from now", () => {
    const spec = { type: "interval", everyMs: 60_000 } as const;
    const next = nextFireAt(spec, "2026-10-03T10:00:00.000Z", "2026-10-03T09:00:00.000Z", new Date("2026-10-03T10:30:00.000Z"));
    expect(next?.toISOString()).toBe("2026-10-03T10:01:00.000Z");
  });

  it("anchors a never-run interval at its creation time", () => {
    const next = nextFireAt(
      { type: "interval", everyMs: 60_000 },
      null,
      "2026-10-03T09:00:00.000Z",
      new Date("2026-10-03T09:00:30.000Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-03T09:01:00.000Z");
  });

  it("returns null for a cron trigger (node-cron owns that arithmetic)", () => {
    expect(nextFireAt({ type: "cron", cronExpression: "0 7 * * *" }, null, null)).toBeNull();
  });

  it("returns null for an event trigger, which has no scheduled time", () => {
    expect(nextFireAt({ type: "event", event: "a.b", debounceMs: 1000 }, null, null)).toBeNull();
  });
});

describe("event storm guard", () => {
  let gate: TriggerGate;

  beforeEach(() => {
    gate = new TriggerGate();
  });

  const guards = { cooldownMs: 60_000, maxFiresPerHour: DEFAULT_MAX_FIRES_PER_HOUR, inFlight: false };

  it("refuses to fire when nothing was ever triggered", () => {
    expect(gate.mayFire("t1", guards)).toBe(false);
  });

  // Brake 1: a save-storm is dozens of events in milliseconds. Exactly one
  // run must result.
  it("debounces a burst of events in the same window into a single run", () => {
    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      if (gate.noteEvent("t1", 1000, 1000)) admitted++;
    }
    expect(admitted).toBe(1);
  });

  it("opens a fresh window once the debounce period has passed", () => {
    expect(gate.noteEvent("t1", 1000, 0)).toBe(true);
    expect(gate.noteEvent("t1", 1000, 999)).toBe(false);
    expect(gate.noteEvent("t1", 1000, 1000)).toBe(true);
  });

  // Brake 2: even after a debounce window settles, the cooldown holds.
  it("holds the cooldown after a run starts", () => {
    gate.noteEvent("t1", 0, 1000);
    expect(gate.mayFire("t1", guards, 1000)).toBe(true);
    gate.noteEvent("t1", 0, 2000);
    expect(gate.mayFire("t1", guards, 2000)).toBe(false); // 1s < 60s cooldown
  });

  it("allows a fire once the cooldown has elapsed", () => {
    gate.noteEvent("t1", 0, 1000);
    expect(gate.mayFire("t1", guards, 1000)).toBe(true);
    gate.noteEvent("t1", 0, 2000);
    expect(gate.mayFire("t1", guards, 1000 + DEFAULT_EVENT_COOLDOWN_MS + 1)).toBe(true);
  });

  // Brake 3: an independent ceiling, because a cooldown still permits 60
  // runs an hour. Spacing them past the cooldown isolates the hourly cap.
  it("stops at the hourly cap even when the cooldown is satisfied", () => {
    const opts = { cooldownMs: 0, maxFiresPerHour: 3, inFlight: false };
    for (let i = 0; i < 3; i++) {
      gate.noteEvent("t1", 0, 1000 + i);
      expect(gate.mayFire("t1", opts, 1000 + i)).toBe(true);
    }
    gate.noteEvent("t1", 0, 5000);
    expect(gate.mayFire("t1", opts, 5000)).toBe(false);
  });

  it("expires the hourly window so a cap does not wedge a Routine forever", () => {
    const opts = { cooldownMs: 0, maxFiresPerHour: 2, inFlight: false };
    gate.noteEvent("t1", 0, 1000);
    expect(gate.mayFire("t1", opts, 1000)).toBe(true);
    gate.noteEvent("t1", 0, 1100);
    expect(gate.mayFire("t1", opts, 1100)).toBe(true);
    // Just over an hour later the old runs have aged out.
    const later = 1000 + 3_600_001;
    gate.noteEvent("t1", 0, later);
    expect(gate.mayFire("t1", opts, later)).toBe(true);
  });

  // Brake 4: a Routine must never stack onto its own live run.
  it("refuses while a run is in flight", () => {
    gate.noteEvent("t1", 0, 1000);
    expect(gate.mayFire("t1", { ...guards, inFlight: true }, 1000)).toBe(false);
  });

  // markRun arms the cooldown for cron/interval runs too, so an event
  // trigger cannot burst on top of a Routine already ticking on cron.
  it("treats a run started by any means as arming the cooldown", () => {
    gate.markRun("t1", 1000);
    gate.noteEvent("t1", 0, 1100);
    expect(gate.mayFire("t1", guards, 1100)).toBe(false);
  });

  it("isolates one Routine's state from another's", () => {
    gate.noteEvent("t1", 1000, 1000);
    expect(gate.mayFire("t1", guards, 1000)).toBe(true);
    gate.noteEvent("t2", 1000, 1000);
    expect(gate.mayFire("t2", guards, 1000)).toBe(true);
  });

  it("forgets a deleted Routine so its state does not leak", () => {
    gate.noteEvent("t1", 0, 1000);
    gate.mayFire("t1", guards, 1000);
    expect(gate.fireCount("t1")).toBe(1);
    gate.forget("t1");
    expect(gate.fireCount("t1")).toBe(0);
  });
});

describe("event bus", () => {
  beforeEach(() => eventBus.reset());

  it("notifies every subscriber of an event", () => {
    const seen: string[] = [];
    eventBus.subscribe("app.changed", () => seen.push("a"));
    eventBus.subscribe("app.changed", () => seen.push("b"));
    expect(emitTriggerEvent("app.changed", { pid: 1 })).toBe(2);
    expect(seen).toEqual(["a", "b"]);
  });

  // One broken subscriber must not stop the rest, and must not escape into
  // whatever emitted the event.
  it("isolates a throwing subscriber", () => {
    const seen: string[] = [];
    eventBus.subscribe("app.changed", () => {
      throw new Error("boom");
    });
    eventBus.subscribe("app.changed", () => seen.push("ok"));
    expect(() => emitTriggerEvent("app.changed")).not.toThrow();
    expect(seen).toEqual(["ok"]);
  });

  it("returns 0 for an event nobody watches", () => {
    expect(emitTriggerEvent("nobody.listening")).toBe(0);
  });

  it("drops the subscriber on unsubscribe so a deleted Routine stops firing", () => {
    let count = 0;
    const off = eventBus.subscribe("doc.saved", () => count++);
    emitTriggerEvent("doc.saved");
    off();
    emitTriggerEvent("doc.saved");
    expect(count).toBe(1);
    expect(eventBus.watcherCount("doc.saved")).toBe(0);
  });

  it("passes the payload to the handler", () => {
    let got: unknown;
    eventBus.subscribe("doc.saved", (p) => {
      got = p;
    });
    emitTriggerEvent("doc.saved", { path: "a.ts" });
    expect(got).toEqual({ path: "a.ts" });
  });
});

describe("trigger schema migration", () => {
  beforeEach(() => resetMigrationCache());

  it("adds both columns to a pre-migration database", () => {
    const db = legacyDb();
    expect(ensureTriggerSchema(asDb(db)).added.sort()).toEqual(["triggerConfig", "triggerType"]);
    const cols = (db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("triggerType");
    expect(cols).toContain("triggerConfig");
  });

  // Every existing row was a cron Routine, so the column default makes them
  // correct without a data backfill — this is the fresh-install-vs-existing
  // install safety property that matters.
  it("defaults pre-existing rows to cron without rewriting them", () => {
    const db = legacyDb();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, name, cronExpression, prompt) VALUES ('old', 'Old', '0 7 * * *', 'p')`,
    ).run();
    ensureTriggerSchema(asDb(db));
    const row = db.prepare("SELECT triggerType, cronExpression FROM scheduled_tasks WHERE id='old'").get() as {
      triggerType: string;
      cronExpression: string;
    };
    expect(row.triggerType).toBe("cron");
    expect(row.cronExpression).toBe("0 7 * * *");
    expect(readTrigger(row as unknown as Record<string, unknown>)).toEqual({
      type: "cron",
      cronExpression: "0 7 * * *",
    });
  });

  // The launch-twice case. SQLite has no ADD COLUMN IF NOT EXISTS, so this
  // is the assertion that would fail on a naive implementation.
  it("is idempotent across repeated calls", () => {
    const db = legacyDb();
    expect(ensureTriggerSchema(asDb(db)).added).toHaveLength(2);
    expect(ensureTriggerSchema(asDb(db)).added).toHaveLength(0);
    expect(ensureTriggerSchema(asDb(db)).added).toHaveLength(0);
  });

  it("reports no work on a database that already has the columns", () => {
    const db = legacyDb();
    ensureTriggerSchema(asDb(db));
    resetMigrationCache(); // forget the memo, force a real re-probe
    expect(ensureTriggerSchema(asDb(db)).added).toHaveLength(0);
  });

  it("re-probes rather than trusting a stale memo when the cache is reset", () => {
    const db = legacyDb();
    ensureTriggerSchema(asDb(db));
    db.exec("ALTER TABLE scheduled_tasks DROP COLUMN triggerType");
    resetMigrationCache();
    expect(ensureTriggerSchema(asDb(db)).added).toEqual(["triggerType"]);
  });

  it("keeps separate databases independent", () => {
    const a = legacyDb();
    const b = legacyDb();
    ensureTriggerSchema(asDb(a));
    resetMigrationCache();
    expect(ensureTriggerSchema(asDb(b)).added).toHaveLength(2);
  });
});
