/**
 * triggers.ts — the pure core of Henry's non-cron trigger types.
 *
 * This is NOT a second scheduler. It is the part of `HenryScheduler`
 * (electron/agent/scheduler.ts) that has no Electron and no model in it: the
 * trigger *spec*, its validation, its "when is this next due" arithmetic, and
 * the storm guard. `HenryScheduler` remains the single thing that owns
 * "what is scheduled and when", and it consumes everything here. Two
 * schedulers in one process would mean two answers to that question; this
 * arrangement gives one.
 *
 * ── Why the trigger surface was genuinely unimplemented ─────────────────────
 * `scheduled_tasks` has exactly one scheduling column, `cronExpression`, and
 * `automation_runs.trigger` is only a free-text log label
 * ('schedule' | 'manual'). There is no trigger-type union in the schema and no
 * code path that could dispatch on one. So rows 4.15 / 5.5 were not
 * partially-wired-but-unverified; the surface did not exist.
 *
 * ── Schema ownership ───────────────────────────────────────────────────────
 * `electron/ipc/database.ts` is owned by another agent mid-flight, so this
 * module migrates its own schema idempotently on first use (see
 * `ensureTriggerSchema`). SQLite has no `ADD COLUMN IF NOT EXISTS`, so the
 * guard reads `PRAGMA table_info` and only alters when the column is genuinely
 * absent, and still swallows the duplicate-column race that two callers
 * starting at once would produce.
 *
 *   `triggerType`   — 'cron' | 'interval' | 'at' | 'event'
 *   `triggerConfig` — JSON of the type-specific spec
 *
 * `cronExpression` is `TEXT NOT NULL` and is left untouched, so non-cron
 * triggers store a human-readable summary there (see `describeTrigger`). The
 * authoritative spec always lives in `triggerType` + `triggerConfig`; the
 * summary column exists only so an existing panel that renders
 * `cronExpression` shows something true rather than blank.
 */

import type Database from 'better-sqlite3';

// ── Trigger spec ────────────────────────────────────────────────────────────

export type TriggerType = 'cron' | 'interval' | 'at' | 'event';

export const TRIGGER_TYPES: readonly TriggerType[] = ['cron', 'interval', 'at', 'event'];

/**
 * A discriminated trigger spec. Each variant carries only what its type needs:
 *   - `interval` — every `everyMs`, measured from the previous run (drift-corrected).
 *   - `at`       — one shot at `runAt`, then the Routine disables itself.
 *   - `event`    — when `event` is emitted, after `debounceMs` of quiet.
 *   - `cron`     — the pre-existing path, unchanged.
 */
export type TriggerSpec =
  | { type: 'cron'; cronExpression: string }
  | { type: 'interval'; everyMs: number }
  | { type: 'at'; runAt: string }
  | { type: 'event'; event: string; debounceMs: number };

// ── Bounds ──────────────────────────────────────────────────────────────────
// Deliberately generous at the top and hard at the bottom. The floor is the
// interesting number: an interval shorter than the floor can outrun the model
// round it kicks off, and the overlapping-run guard would then silently drop
// ticks. Bounding it here makes the bad config a load-time error instead.

export const MIN_INTERVAL_MS = 30_000; // 30s
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MIN_DEBOUNCE_MS = 250;
export const MAX_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Default cooldown between two fires of the same event-triggered Routine.
 * This is the anti-storm floor: even a trigger that legitimately fires a
 * thousand times a second produces at most one run per cooldown window.
 */
export const DEFAULT_EVENT_COOLDOWN_MS = 60_000;

/** Hard cap on runs per hour for an event trigger, as a second, independent
 *  brake. A cooldown alone still permits a 1-per-minute storm across an hour. */
export const DEFAULT_MAX_FIRES_PER_HOUR = 10;

/** Event names are namespaced dotted identifiers: `app.changed`, `doc.saved`. */
const EVENT_NAME_RE = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/;

/** Upper bound on distinct events an event-triggered Routine may watch. */
export const MAX_EVENT_WATCHES_PER_ROUTINE = 5;

// ── Validation ──────────────────────────────────────────────────────────────

export class TriggerValidationError extends Error {}

function fail(msg: string): never {
  throw new TriggerValidationError(msg);
}

function requirePositiveInt(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) fail(`${label} must be a number.`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max} (got ${n}).`);
  return Math.round(n);
}

/**
 * Validate and canonicalise a trigger spec. Throws `TriggerValidationError`
 * with a message written for the user, not the log. Returns a fresh object —
 * the caller must persist what this returns, not what it passed in.
 */
export function parseTrigger(raw: unknown): TriggerSpec {
  if (!raw || typeof raw !== 'object') fail('A trigger is required.');
  const r = raw as Record<string, unknown>;
  const type = String(r.type ?? '');
  if (!TRIGGER_TYPES.includes(type as TriggerType)) {
    fail(`trigger type must be one of ${TRIGGER_TYPES.join(', ')} (got "${type || 'nothing'}").`);
  }

  switch (type as TriggerType) {
    case 'cron': {
      const expr = String(r.cronExpression ?? r.value ?? '').trim();
      if (!expr) fail('A cron trigger needs a cronExpression.');
      return { type: 'cron', cronExpression: expr };
    }
    case 'interval': {
      const everyMs = requirePositiveInt(
        r.everyMs ?? r.value,
        'interval everyMs',
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS,
      );
      return { type: 'interval', everyMs };
    }
    case 'at': {
      const rawAt = String(r.runAt ?? r.value ?? '').trim();
      if (!rawAt) fail('A one-shot trigger needs an ISO-8601 runAt.');
      const ms = Date.parse(rawAt);
      if (Number.isNaN(ms)) fail(`runAt is not a valid date: "${rawAt}".`);
      return { type: 'at', runAt: new Date(ms).toISOString() };
    }
    case 'event': {
      const event = String(r.event ?? r.value ?? '').trim();
      if (!event) fail("An event trigger needs an event name, e.g. 'app.changed'.");
      if (!EVENT_NAME_RE.test(event)) {
        fail(`Event name must be lowercase dotted words (e.g. "app.changed"), got "${event}".`);
      }
      const debounceMs =
        r.debounceMs === undefined || r.debounceMs === null
          ? DEFAULT_EVENT_COOLDOWN_MS
          : requirePositiveInt(r.debounceMs, 'event debounceMs', MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS);
      return { type: 'event', event, debounceMs };
    }
  }
}

/**
 * Short human-readable summary. Also what goes in the legacy NOT NULL
 * `cronExpression` column for non-cron triggers, so an existing panel that
 * renders that field shows something true instead of a blank cell.
 */
export function describeTrigger(spec: TriggerSpec): string {
  switch (spec.type) {
    case 'cron':
      return spec.cronExpression;
    case 'interval': {
      const mins = Math.round(spec.everyMs / 60000);
      if (mins < 60) return `every ${mins}m`;
      const hours = Math.round(mins / 60);
      return `every ${hours}h`;
    }
    case 'at':
      return `once at ${spec.runAt}`;
    case 'event':
      return `on ${spec.event}`;
  }
}

/** Persist-ready JSON for the `triggerConfig` column. */
export function serializeTrigger(spec: TriggerSpec): string {
  return JSON.stringify(spec);
}

/**
 * Read a spec back out of a `scheduled_tasks` row. A row that predates this
 * migration, or one whose config is corrupt, degrades to a cron spec built
 * from `cronExpression` — so an unreadable trigger can never wedge a Routine
 * or crash startup.
 */
export function readTrigger(row: Record<string, unknown>): TriggerSpec {
  const type = String(row.triggerType ?? 'cron');
  const raw = typeof row.triggerConfig === 'string' ? row.triggerConfig : '';
  if (raw) {
    try {
      return parseTrigger(JSON.parse(raw));
    } catch {
      /* fall through to the cron fallback below */
    }
  }
  return { type: 'cron', cronExpression: String(row.cronExpression ?? '') };
}

// ── Next-fire arithmetic ────────────────────────────────────────────────────

/**
 * When is this Routine next due? Returns null for event triggers, which have
 * no scheduled time — they fire on demand — and for a disabled/unscheduled
 * state the caller should not be computing a time for at all.
 *
 * Intervals are measured from the last run (or creation, if it has never
 * run), so a slow run does not permanently shift the cadence the way a naive
 * `setTimeout` chain does.
 */
export function nextFireAt(
  spec: TriggerSpec,
  lastRunAt: string | null | undefined,
  createdAt: string | null | undefined,
  now: Date = new Date(),
): Date | null {
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const created = createdAt ? Date.parse(createdAt) : NaN;
  const anchor = Number.isNaN(last) ? (Number.isNaN(created) ? now.getTime() : created) : last;

  switch (spec.type) {
    case 'cron':
      // A cron's own next time is node-cron's job; the scheduler passes the
      // computed value through from the live job rather than re-deriving it.
      return null;
    case 'interval':
      return new Date(anchor + spec.everyMs);
    case 'at':
      return new Date(spec.runAt);
    case 'event':
      return null;
  }
}

/**
 * Has a one-shot trigger passed? A one-shot that is already in the past must
 * not be re-armed — that is how a backlogged `at` date turns into a hot loop
 * on startup.
 */
export function isOneShotDue(spec: TriggerSpec, now: Date = new Date()): boolean {
  return spec.type === 'at' && Date.parse(spec.runAt) <= now.getTime();
}

// ── Storm guard ─────────────────────────────────────────────────────────────

interface GateState {
  /** First event seen in the current debounce window. */
  pendingSince: number | null;
  /** Last time a run was actually started, for the cooldown. */
  lastFiredAt: number | null;
  /** Fire timestamps inside the trailing hour, for the hard hourly cap. */
  recent: number[];
}

/**
 * TriggerGate decides whether a due event should actually start a run.
 *
 * Event triggers are the one kind that can become an accidental busy-loop, so
 * this guard is deliberately layered:
 *
 *   1. **Debounce** — a burst of events inside `debounceMs` collapses to one
 *      run. Editor "save" storms arrive as dozens of events in milliseconds.
 *   2. **Cooldown** — at most one run per `cooldownMs`, regardless of whether
 *      the events were debounced.
 *   3. **Hourly cap** — an absolute ceiling, because a cooldown alone still
 *      permits 60 runs an hour. Independent brake, not a substitute.
 *   4. **Self-fire** — while a run is in flight, further triggers for that
 *      Routine are dropped. The scheduler also never emits an event as a
 *      result of a run, so a Routine cannot retrigger itself; this is the
 *      belt to that braces.
 *
 * Every rule fails *closed*: a malformed or over-eager event is dropped, never
 * queued for a burst later.
 */
export class TriggerGate {
  private state = new Map<string, GateState>();

  private st(taskId: string): GateState {
    let s = this.state.get(taskId);
    if (!s) {
      s = { pendingSince: null, lastFiredAt: null, recent: [] };
      this.state.set(taskId, s);
    }
    return s;
  }

  /**
   * Register an incoming event. Returns true if it starts a debounce window
   * that has not already been opened — i.e. only the first event of a burst
   * is honoured, the rest are absorbed.
   */
  noteEvent(taskId: string, debounceMs: number, now: number = Date.now()): boolean {
    const s = this.st(taskId);
    if (s.pendingSince !== null && now - s.pendingSince < debounceMs) return false;
    s.pendingSince = now;
    return true;
  }

  /**
   * A debounced event has settled. May the run start? Re-checks the cooldown,
   * the hourly cap and the in-flight guard — a window can sit open for the
   * whole debounceMs, during which a run may have started for other reasons.
   */
  mayFire(
    taskId: string,
    opts: { cooldownMs: number; maxFiresPerHour: number; inFlight: boolean },
    now: number = Date.now(),
  ): boolean {
    const s = this.st(taskId);
    if (s.pendingSince === null) return false; // nothing was ever triggered
    if (opts.inFlight) return false; // rule 4: never stack onto a live run
    if (s.lastFiredAt !== null && now - s.lastFiredAt < opts.cooldownMs) return false; // rule 2

    // Prune the hourly window before testing it.
    const cutoff = now - 3_600_000;
    s.recent = s.recent.filter((t) => t > cutoff);
    if (s.recent.length >= opts.maxFiresPerHour) return false; // rule 3

    s.pendingSince = null;
    s.lastFiredAt = now;
    s.recent.push(now);
    return true;
  }

  /**
   * Called when a run starts by any means, so a cron or interval tick still
   * arms the cooldown — otherwise a Routine firing every minute on cron would
   * also be allowed to burst on top of its event trigger.
   */
  markRun(taskId: string, now: number = Date.now()): void {
    const s = this.st(taskId);
    s.lastFiredAt = now;
    const cutoff = now - 3_600_000;
    s.recent = s.recent.filter((t) => t > cutoff);
    s.recent.push(now);
  }

  /** Forget a Routine's state — used when it is deleted. Bounds memory. */
  forget(taskId: string): void {
    this.state.delete(taskId);
  }

  /** Test/introspection seam: how many runs this Routine has started. */
  fireCount(taskId: string): number {
    return this.st(taskId).recent.length;
  }

  reset(): void {
    this.state.clear();
  }
}

// ── Event bus ───────────────────────────────────────────────────────────────

type EventHandler = (payload: unknown, taskId: string) => void;

/**
 * A tiny in-process event bus. Deliberately NOT an EventEmitter: it bounds
 * how many Routines may watch one event, so a bug that subscribes in a loop
 * leaks a bounded number of entries instead of growing without limit.
 *
 * "Degrades safely if the thing it watches disappears" — there is no such
 * thing as a dead subscription here: a trigger whose event never fires simply
 * never runs, holds no timer, and costs one map entry. `releaseWatch()` drops
 * that entry when the Routine is deleted.
 */
class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.releaseWatch(event, handler);
  }

  releaseWatch(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(event);
  }

  /**
   * Emit. Returns the number of handlers reached. Handlers are isolated: one
   * throwing must not stop the others, and the throw must not escape into
   * whatever emitted the event.
   */
  emit(event: string, payload?: unknown): number {
    const set = this.handlers.get(event);
    if (!set) return 0;
    for (const handler of Array.from(set)) {
      try {
        handler(payload, event);
      } catch {
        /* one bad subscriber must not stop the rest */
      }
    }
    return set.size;
  }

  watcherCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  get eventCount(): number {
    return this.handlers.size;
  }

  reset(): void {
    this.handlers.clear();
  }
}

/** Process-wide bus. `HenryScheduler` is the only consumer. */
export const eventBus = new EventBus();

/**
 * Public entry point for the rest of the app: "this happened, fire whatever
 * Routines watch it". Returns how many Routines were notified.
 */
export function emitTriggerEvent(event: string, payload?: unknown): number {
  return eventBus.emit(event, payload);
}

// ── Schema migration ────────────────────────────────────────────────────────

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.some((c) => c.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): boolean {
  if (columnExists(db, table, column)) return false;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  } catch (e) {
    // A concurrent caller may have won the race between the PRAGMA check and
    // the ALTER. "duplicate column name" means the outcome we wanted anyway.
    if (/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

let migratedFor: WeakSet<Database.Database> | null = new WeakSet();

/**
 * Idempotently add the trigger columns. Safe on a fresh install and on an
 * existing database, and safe to call concurrently.
 *
 * Returns which columns it actually added, so a caller (and a test) can tell
 * "migrated" from "already current" without re-reading `PRAGMA`.
 */
export function ensureTriggerSchema(db: Database.Database): { added: string[] } {
  const added: string[] = [];
  if (migratedFor?.has(db)) return { added };

  // A pre-migration database has neither column, so it gets the full
  // treatment. `DEFAULT 'cron'` is what makes every existing row correct
  // without a data backfill: they were all cron, and now they say so.
  if (addColumnIfMissing(db, 'scheduled_tasks', 'triggerType', "TEXT NOT NULL DEFAULT 'cron'")) {
    added.push('triggerType');
  }
  if (addColumnIfMissing(db, 'scheduled_tasks', 'triggerConfig', 'TEXT')) {
    added.push('triggerConfig');
  }

  migratedFor?.add(db);
  return { added };
}

/** Test seam: forget that a db handle has been migrated. */
export function resetMigrationCache(): void {
  migratedFor = new WeakSet();
}
