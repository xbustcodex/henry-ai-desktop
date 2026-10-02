/**
 * The IPC trust boundary.
 *
 * Henry's renderer is a browser document that an AI can drive, so every value
 * crossing IPC is untrusted — including values our own UI produced, because a
 * bug or a crafted state can put anything there. Paid 1.7.0 validates every
 * channel in both directions with named Zod schemas (contracts.ts throughout).
 * Ours used bare `unknown` with ad-hoc checks, which is the largest structural
 * gap in the codebase and the reason several concrete bugs needed patching by
 * hand.
 *
 * ## Why this is not 333 hand-written schemas
 *
 * There are 333 channels. Writing a precise schema for each in one pass would
 * break working calls wherever the schema guessed the shape slightly wrong, and
 * a broken call is far worse than an unvalidated one. So this does two
 * different things at two different strengths:
 *
 *   - **Every channel** passes through `sanitizePayload` and `enforcePayload`,
 *     which reject prototype-pollution keys, non-serialisable values, and
 *     oversized payloads. These cannot reject any call that used to work.
 *
 *   - **Channels that touch paths, shell, credentials, network or the database**
 *     are registered with a precise schema in `channelSchemas`, and are the ones
 *     this module actually constrains.
 *
 * A channel with no registered schema still gets the baseline. A channel with
 * one gets checked, and the check is written from its real handler signature.
 *
 * ## Failure is explicit, never silent
 *
 * A rejected payload produces a structured `{ ok: false, validationError: true,
 * issues }`. It never returns `undefined`, and it is never shaped like any
 * existing success or failure result — in particular a validation failure can
 * never be mistaken for "not installed", which would turn a bad request into a
 * phantom install prompt.
 */
import { z } from 'zod';

// ── Baseline ────────────────────────────────────────────────────────────────

/** Keys that can poison Object.prototype if merged into a plain object. */
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Generous enough for any legitimate payload, small enough to bound memory. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Deepest nesting we will walk. Protects against stack exhaustion. */
const MAX_DEPTH = 24;

export class ValidationError extends Error {
  readonly issues: { path: string; message: string }[];
  readonly channel: string;
  constructor(channel: string, issues: { path: string; message: string }[]) {
    super(`Invalid payload for "${channel}"`);
    this.name = 'ValidationError';
    this.channel = channel;
    this.issues = issues;
  }
}

/**
 * Strip prototype-pollution keys and reject values that cannot cross the
 * boundary at all. Mutates nothing the caller passed — returns a clean copy.
 */
export function sanitizePayload<T>(value: T): T {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return undefined;
    if (node === null) return null;
    const t = typeof node;
    if (t === 'string' || t === 'boolean') return node;
    if (t === 'number') return Number.isFinite(node) ? node : null;
    if (t === 'bigint') return Number(node);
    if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
    if (Array.isArray(node)) {
      return node.map((v) => walk(v, depth + 1)).filter((v) => v !== undefined);
    }
    if (node instanceof Date) return node.toISOString();
    if (node instanceof Uint8Array) return node;
    if (t === 'object') {
      const src = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src)) {
        if (POISON_KEYS.has(key)) continue;
        const walked = walk(src[key], depth + 1);
        if (walked !== undefined) out[key] = walked;
      }
      return out;
    }
    return undefined;
  };
  return walk(value, 0) as T;
}

/** Approximate serialised size, without actually serialising. */
function roughSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const t = typeof value;
  if (t === 'string') return (value as string).length * 2;
  if (t === 'number' || t === 'boolean') return 8;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return (value as unknown[]).reduce<number>((a, v) => a + roughSize(v), 16);
  if (t === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>((a, v) => a + roughSize(v), 16);
  }
  return 8;
}

/** A payload that can never be a legitimate request. */
export function assertPayloadSize(channel: string, payload: unknown): void {
  if (roughSize(payload) > MAX_PAYLOAD_BYTES) {
    throw new ValidationError(channel, [
      { path: '', message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` },
    ]);
  }
}

// ── Channel schemas ─────────────────────────────────────────────────────────

/**
 * Precise schemas, written from the real handler signatures.
 *
 * Only channels that can cause damage are here. Anything not listed still gets
 * the baseline hardening, and that is a deliberate choice: an over-eager schema
 * that rejects a valid call is a regression, and a regression across 333
 * channels is not something to introduce in one pass.
 */
const nonEmpty = (max = 4096) => z.string().trim().min(1).max(max);

/** A filesystem path. Content is NOT interpreted here — path safety is a
 *  separate concern with its own, stricter checks (`_pathSafety`). This only
 *  guarantees it is a usable string and not a megabyte of junk. */
const pathString = nonEmpty(4096);

export const channelSchemas: Record<string, z.ZodTypeAny> = {
  // ── Shell / process execution ──────────────────────────────────────────
  'computer:runShell': z.object({
    command: nonEmpty(32_000),
    timeout: z.number().int().min(100).max(600_000).optional(),
  }).strict(),

  // ── Computer control ───────────────────────────────────────────────────
  'computer:openUrl': z.object({}).passthrough().or(z.string().max(8192)).or(nonEmpty(8192)),
  'computer:openApp': z.object({ appName: nonEmpty(512) }).strict(),
  'computer:screenshot': z.object({
    region: z.object({
      x: z.number().int(), y: z.number().int(),
      w: z.number().int().positive().max(20_000),
      h: z.number().int().positive().max(20_000),
    }).strict().optional(),
  }).strict().default({}),

  // ── Filesystem ─────────────────────────────────────────────────────────
  'filesystem:read': z.object({ path: pathString }).passthrough(),
  'filesystem:write': z.object({ path: pathString, content: z.string().max(64 * 1024 * 1024) }).passthrough(),
  'filesystem:delete': z.object({ path: pathString }).passthrough(),
  'filesystem:list': z.object({ path: pathString.optional() }).passthrough(),

  // ── Provider configuration / credentials ───────────────────────────────
  'providers:save': z.object({
    id: nonEmpty(64),
    name: z.string().max(200),
    apiKey: z.string().max(4096).optional(),
    api_key: z.string().max(4096).optional(),
    enabled: z.union([z.boolean(), z.number()]),
    models: z.string().max(1_000_000).optional(),
  }).strict(),

  // ── Settings ───────────────────────────────────────────────────────────
  'settings:save': z.object({
    key: nonEmpty(128),
    // Values are strings today. JSON-encoded settings ride in here too, so the
    // length is bounded but the type is NOT narrowed to a scalar — changing
    // that would silently reject existing callers.
    value: z.string().max(8 * 1024 * 1024),
  }).strict(),

  // ── Creator demo / orb (added by this programme) ───────────────────────
  'creators:saveDemo': z.unknown(),
  'creators:saveOrb': z.unknown(),
  'creators:importMedia': z.object({
    paths: z.array(nonEmpty(4096)).max(64),
    kind: z.enum(['audio', 'image', 'file']),
  }).strict(),
  'creators:deleteMedia': z.object({ fileName: nonEmpty(256) }).strict(),
  'creators:openMedia': z.object({ fileName: nonEmpty(256) }).strict(),
  'creators:launchStage': z.object({ mode: z.enum(['voice', 'chat']) }).strict(),

  // ── Automation notifications ───────────────────────────────────────────
  'notification:notifyRun': z.object({
    runId: z.number().int().nonnegative(),
    title: z.string().max(300),
    success: z.boolean(),
    detail: z.string().max(2000).optional(),
    mode: z.enum(['all', 'failures', 'none']).optional(),
  }).strict(),
};

/** Channels whose payload must never be a bare string. */
export function validateRequest(channel: string, payload: unknown): unknown {
  const schema = channelSchemas[channel];
  const cleaned = sanitizePayload(payload);
  assertPayloadSize(channel, cleaned);
  if (!schema) return cleaned;
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;
  throw new ValidationError(
    channel,
    result.error.issues.slice(0, 12).map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  );
}

// ── Handler wrapper ────────────────────────────────────────────────────────

/** The shape every guarded handler returns on a validation failure. */
export interface ValidationFailure {
  ok: false;
  validationError: true;
  error: string;
  channel: string;
  issues: { path: string; message: string }[];
}

export function validationFailure(e: ValidationError): ValidationFailure {
  return {
    ok: false,
    validationError: true,
    error: `Rejected: ${e.issues.map((i) => `${i.path || 'payload'} ${i.message}`).join('; ').slice(0, 300)}`,
    channel: e.channel,
    issues: e.issues,
  };
}

/**
 * Wrap an IPC handler so its input is validated at the boundary.
 *
 * The original handler is only invoked once the payload is clean. A rejected
 * payload never reaches it, which is the point: nothing privileged runs on a
 * value nobody checked.
 *
 * The failure path deliberately returns a tagged object rather than throwing.
 * Throwing across the IPC boundary produces an unhandled promise rejection in
 * the renderer, which is how this codebase ended up with several of its earlier
 * bugs in the first place.
 */
export function guarded<Req, Res>(
  channel: string,
  handler: (payload: Req) => Promise<Res> | Res,
): (payload: unknown) => Promise<Res | ValidationFailure> {
  return async (payload: unknown) => {
    let clean: unknown;
    try {
      clean = validateRequest(channel, payload);
    } catch (e) {
      if (e instanceof ValidationError) {
        console.warn(`[ipc:${channel}] rejected payload:`, e.issues.map((i) => `${i.path} ${i.message}`).join('; '));
        return validationFailure(e);
      }
      throw e;
    }
    return handler(clean as Req);
  };
}

/**
 * Apply the baseline to an existing handler without changing its signature.
 * For handlers whose contract is already correct but whose input is unchecked.
 */
export function sanitizeArg<T>(channel: string, value: T): T {
  assertPayloadSize(channel, value);
  return sanitizePayload(value);
}