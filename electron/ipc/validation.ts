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
import { ipcMain } from 'electron';

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
 *
 * Precise schemas, written from the REAL handler signatures and real callers.
 *
 * Every channel name here was read off the handler registration and the
 * preload bridge — the first draft of this file guessed names like
 * "filesystem:read" for channels that are actually "fs:readFile", and would
 * have silently guarded nothing.
 *
 * Deliberately NOT `.strict()` where a caller sends fields the handler ignores:
 *   - `computer:desktopMode` — HQPanel sends `fullscreen`, the handler never
 *     reads it. Rejecting it would break a live call. The handler is the bug,
 *     not the caller, and it is recorded rather than papered over.
 *   - `google:*` — the preload substitutes empty-string credentials when the
 *     renderer omits them, so `{clientId: '', clientSecret: ''}` must remain
 *     valid or every existing call site breaks.
 */

/** Coordinates and the rest of the numeric geometry actually reach a shell
 *  command on macOS (osascript interpolates them), so they must be numbers. */
const finiteNumber = z.number().finite();

/** A required, non-blank, length-bounded string. */
const nonEmpty = (max = 4096) => z.string().trim().min(1).max(max);

/**
 * Any value that survives `JSON.parse` — the boundary of what can cross IPC.
 *
 * Declared before `jsonObject` because the two are mutually recursive: an
 * object may contain an array, which may contain another object. `z.lazy` is
 * what makes that expressible without an unbounded type.
 */
const jsonValue: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string().max(1024 * 1024),
    z.number().finite(),
    z.boolean(),
    z.null(),
    jsonObject,
    z.array(jsonValue).max(10_000),
  ]),
);

/**
 * A free-form JSON object — the shape preload actually sends for the ~60
 * record-style channels (`saveFact(record)`, `addRoutine(task)`, …).
 *
 * This is deliberately NOT `.strict()`. Those handlers read named fields and
 * ignore the rest, and a strict object schema would reject any caller that
 * sends one extra key — a regression, not a protection. Its job is to refuse a
 * non-object where an object is required (which would otherwise reach the
 * handler as `undefined` and fail confusingly deep inside it) and to bound the
 * nesting.
 */
const jsonObject = z.record(z.string(), jsonValue);

/** A channel preload invokes with no arguments at all. */
const noArg = z.undefined().optional();

/** Coordinates and other geometry reach a shell command on macOS, so they must
 *  be finite numbers rather than whatever the renderer sent. */

export const channelSchemas: Record<string, ChannelSchema> = {
  // ── Shell / process execution ──────────────────────────────────────────
  'computer:runShell': z
    .object({
      command: nonEmpty(32_000),
      timeout: z.number().int().min(100).max(600_000).optional(),
    })
    .passthrough(),

  // ── Computer control ───────────────────────────────────────────────────
  // Was an injection: x/y interpolate straight into an AppleScript string and
  // preload typed them as Record<string, unknown>, so a crafted renderer could
  // smuggle arbitrary AppleScript. Numbers only now.
  'computer:click': z
    .object({
      x: finiteNumber,
      y: finiteNumber,
      button: z.enum(['primary', 'right', 'left', 'middle']).optional(),
    })
    .strict(),

  // preload and the handler both take a BARE STRING here. An earlier version of
  // this schema demanded `{ appName }` and rejected every real call.
  'computer:openApp': nonEmpty(512),
  'computer:screenshot': z
    .object({
      region: z
        .object({
          x: finiteNumber, y: finiteNumber,
          w: z.number().int().positive().max(20_000),
          h: z.number().int().positive().max(20_000),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  // Not strict: HQPanel sends `fullscreen`, which the handler ignores.
  'computer:desktopMode': z.object({ enable: z.boolean().optional(), fullscreen: z.boolean().optional() }).passthrough(),

  // ── Filesystem (real channel names) ────────────────────────────────────
  // These three are bridged as BARE STRINGS (preload: readDirectory: (dirPath?) =>
  // invoke('fs:readDirectory', dirPath)). The object schemas added here would have
  // rejected all of them.
  'fs:readDirectory': z.string().max(4096).optional(),
  'fs:readFile': z.string().max(4096).optional(),
  'fs:pathExists': nonEmpty(4096),
  'fs:writeFile': z
    .object({ path: nonEmpty(4096), content: z.string().max(64 * 1024 * 1024) })
    .passthrough(),

  // ── Provider configuration / credentials ───────────────────────────────
  'providers:save': z
    .object({
      id: nonEmpty(64),
      name: z.string().max(200),
      apiKey: z.string().max(4096).optional(),
      api_key: z.string().max(4096).optional(),
      enabled: z.union([z.boolean(), z.number()]),
      models: z.string().max(1_000_000).optional(),
    })
    .passthrough(),

  // ── Settings ───────────────────────────────────────────────────────────
  // Values are strings today, including JSON-encoded settings. The type is not
  // narrowed to a scalar — that would silently reject existing callers.
  'settings:save': z
    .object({ key: nonEmpty(128), value: z.string().max(8 * 1024 * 1024) })
    .passthrough(),

  // ── Google OAuth ───────────────────────────────────────────────────────
  // Empty strings are valid: preload sends them when the renderer omits creds.
  'google:startAuth': z
    .object({
      clientId: z.string().max(2048),
      clientSecret: z.string().max(2048),
      scopes: z.array(z.string().max(512)).max(64).optional(),
    })
    .passthrough(),
  'google:getToken': z.object({ clientId: z.string().max(2048).optional(), clientSecret: z.string().max(2048).optional() }).passthrough(),
  'google:refreshToken': z.object({ clientId: z.string().max(2048).optional(), clientSecret: z.string().max(2048).optional() }).passthrough(),

  // ── Creator demo / orb ─────────────────────────────────────────────────
  'creators:importMedia': z
    .object({
      paths: z.array(nonEmpty(4096)).max(64),
      kind: z.enum(['audio', 'image', 'file']),
    })
    .strict(),
  'creators:deleteMedia': z.object({ fileName: nonEmpty(256) }).strict(),
  'creators:openMedia': z.object({ fileName: nonEmpty(256) }).strict(),
  'creators:launchStage': z.object({ mode: z.enum(['voice', 'chat']) }).strict(),

  // ── Automation notifications ───────────────────────────────────────────
  'notification:notifyRun': z
    .object({
      runId: z.number().int().nonnegative(),
      title: z.string().max(300),
      success: z.boolean(),
      detail: z.string().max(2000).optional(),
      mode: z.enum(['all', 'failures', 'none']).optional(),
    })
    // Strict: both ends are ours, and nothing legitimate sends extra fields.
    .strict(),
  // ── Conversations / messages / cost ───────────────────────────────────
  // Bare strings, per preload: createConversation(title) →
  // invoke('conversations:create', title).
  'conversations:create': nonEmpty(1000),
  'conversations:update': z.object({ id: nonEmpty(128), title: z.string().max(1000) }).passthrough(),
  'conversations:delete': nonEmpty(128),
  'messages:getAll': nonEmpty(128),
  'messages:save': z
    .object({
      id: nonEmpty(128),
      conversation_id: nonEmpty(128),
      role: z.string().max(32),
      content: z.string().max(16 * 1024 * 1024),
      model: z.string().max(200).optional(),
      provider: z.string().max(200).optional(),
      tokens_used: finiteNumber.optional(),
      cost: finiteNumber.optional(),
      engine: z.string().max(64).optional(),
    })
    .passthrough(),
  'cost:getAll': z.enum(['7d', '30d']).optional(),

  // ── Memory ────────────────────────────────────────────────────────────
  // preload passes a bare string for every id-taking memory channel and a bare
  // number for the limit variant — an object schema would reject all of them.
  'memory:getAllFacts': z.number().int().min(1).max(10_000).optional(),
  'memory:getSummary': nonEmpty(128),
  'memory:getSessionMemory': nonEmpty(128),
  'memory:getWorkingMemory': z.string().max(128).optional(),
  'memory:getProjectMemory': nonEmpty(128),
  'memory:saveWhereWeLeftOff': z.string().max(100_000),
  'memory:searchWorkspace': z.string().max(4096),
  // Positional: preload's updatePersonalMemory(id, updates).
  'memory:updatePersonalMemory': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'memory:updateProject': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'memory:updateGoal': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'memory:updateCommitment': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'memory:deletePersonalMemory': nonEmpty(128),
  'memory:recallPersonalMemory': nonEmpty(128),
  'memory:deleteGoal': nonEmpty(128),
  'memory:resolveCommitment': nonEmpty(128),

  // ── Memory: options objects ────────────────────────────────────────────
  'memory:getPersonalMemory': z
    .object({ limit: z.number().int().min(1).max(1000).optional(), category: z.string().max(64).optional() })
    .passthrough()
    .optional(),
  'memory:getProjects': z
    .object({ status: z.string().max(32).optional(), limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getGoals': z
    .object({ status: z.string().max(32).optional(), limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getCommitments': z
    .object({ status: z.string().max(32).optional(), limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getMilestones': z
    .object({ projectId: z.string().max(128).optional(), limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getRelationshipMemory': z
    .object({ limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getNarrativeMemory': z
    .object({ activeOnly: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getMemorySummaries': z
    .object({ conversationId: z.string().max(128).optional(), limit: z.number().int().min(1).max(1000).optional() })
    .passthrough()
    .optional(),
  'memory:getGraphEdges': z
    .object({ kind: z.string().max(64).optional(), limit: z.number().int().min(1).max(5000).optional() })
    .passthrough()
    .optional(),

  // ── Tasks / contacts / finance / journal / lists (all bare-string ids) ──
  'tasks:list': z.object({ status: z.string().max(32).optional() }).passthrough().optional(),
  'tasks:update': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'tasks:delete': nonEmpty(128),
  'contacts:list': z.string().max(4096).optional(),
  'contacts:get': nonEmpty(128),
  'contacts:update': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'contacts:delete': nonEmpty(128),
  'finance:list': z.string().max(32).optional(),
  'finance:delete': nonEmpty(128),
  'finance:summary': z.string().max(32),
  'finance:recurring:delete': nonEmpty(128),
  'journal:list': z.string().max(4096).optional(),
  'journal:get': nonEmpty(128),
  'journal:delete': nonEmpty(128),
  'reminders:delete': nonEmpty(128),
  'lists:delete': nonEmpty(128),
  // Positional: preload's listsAddItem(listId, item).
  'lists:add-item': [nonEmpty(128), z.record(z.string(), z.unknown())],
  'lists:toggle-item': nonEmpty(128),
  'lists:delete-item': nonEmpty(128),
  'lists:clear-done': nonEmpty(128),
  'focus:list': z.number().int().min(1).max(1000).optional(),
  'capture:list': z.number().int().min(1).max(1000).optional(),

  // ── Health (analytics rows — gated by persistAnalytics at the call site) ─
  'health:logsForDate': z.string().max(32),
  'health:logDelete': nonEmpty(128),
  'health:habitDelete': nonEmpty(128),
  'health:habitLog': z
    .object({ habit_id: nonEmpty(128), date: z.string().max(32), count: z.number().int().min(0).max(10_000).optional() })
    .strict(),
  'health:habitUnlog': z.object({ habit_id: nonEmpty(128), date: z.string().max(32) }).strict(),
  // Positional: preload's healthLogsRange(from, to) and habitLogsRange.
  'health:logsRange': [z.string().max(32), z.string().max(32)],
  'health:habitLogsForDate': z.string().max(32),
  'health:habitLogsRange': [z.string().max(32), z.string().max(32)],

  // ── Maker Studio ──────────────────────────────────────────────────────
  'maker:machines:delete': nonEmpty(128),
  'maker:materials:delete': nonEmpty(128),
  'maker:runs:delete': nonEmpty(128),
  'maker:waste:delete': nonEmpty(128),
  'maker:maintenance:delete': nonEmpty(128),
  'maker:bom:delete': nonEmpty(128),
  'maker:waste:list': z.number().int().min(1).max(1000).optional(),
  'maker:maintenance:list': z.string().max(128).optional(),
  'maker:bom:list': z.string().max(256).optional(),

  // ── Quoting ───────────────────────────────────────────────────────────
  'quote:get': nonEmpty(128),
  'quote:delete': nonEmpty(128),
  'quote:duplicate': nonEmpty(128),
  'quote:lineItem:delete': nonEmpty(128),
  'quote:exportMarkdown': nonEmpty(128),
  // Positional: preload's quoteSetStatus(id, status).
  'quote:setStatus': [nonEmpty(128), z.string().max(32)],
  // Positional: preload's quoteLineItemsReorder(quoteId, ids).
  'quote:lineItems:reorder': [nonEmpty(128), z.array(nonEmpty(128)).max(1000)],

  // ── Sync bridge (companion pairing / LAN surface) ──────────────────────
  'henry:sync:start': z.number().int().min(1).max(65_535).optional(),
  'henry:sync:unlink-device': nonEmpty(128),
  'henry:sync:generate-pair-token': z.number().int().min(1000).max(86_400_000).optional(),

  // ── Terminal / printer ────────────────────────────────────────────────
  'terminal:exec': z
    .object({
      command: nonEmpty(32_000),
      cwd: z.string().max(4096).optional(),
      timeout: z.number().int().min(100).max(600_000).optional(),
      channelId: z.string().max(128).optional(),
    })
    .passthrough(),
  'terminal:kill': nonEmpty(128),
  'printer:sendGcode': z.string().max(1_000_000),
  'printer:printGcode': z.string().max(64 * 1024 * 1024),

  // ── Computer control: bare-string app names ────────────────────────────
  'computer:closeApp': nonEmpty(512),
  'computer:activateApplication': nonEmpty(512),
  'computer:focusAiInput': nonEmpty(512),
  'computer:osascript': nonEmpty(32_000),
  'computer:typeText': z.string().max(100_000),
  'computer:pressKey': nonEmpty(64),
  'computer:openUrl': z.string().max(4096),
  'computer:killProcess': z.number().int().positive().max(2 ** 31),
  'computer:setVolume': z.number().min(0).max(1),
  'computer:clipboard:write': z.string().max(16 * 1024 * 1024),

  // ── Sessions ──────────────────────────────────────────────────────────
  'session:delete': z.record(z.string(), z.unknown()),

  // ── Attachments / media / recordings (bare-string ids) ─────────────────
  'attachments:list': nonEmpty(128),
  'attachments:listForMessage': nonEmpty(128),
  'attachments:get': nonEmpty(128),
  'attachments:delete': nonEmpty(128),
  'attachments:open': nonEmpty(128),
  // Positional: preload's linkAttachmentsToMessage(ids, messageId, conversationId).
  'attachments:linkToMessage': [z.array(nonEmpty(128)).max(1000), nonEmpty(128), z.string().max(128).optional()],
  'media:get': nonEmpty(128),
  'media:open': nonEmpty(128),
  'media:reveal': nonEmpty(128),
  'media:delete': nonEmpty(128),
  'recordings:get': nonEmpty(128),
  'recordings:delete': nonEmpty(128),

  // ── Marketplace ───────────────────────────────────────────────────────
  'marketplace:fetch': nonEmpty(128),
  'marketplace:openEntry': nonEmpty(128),
  'marketplace:reveal': nonEmpty(4096),
  'marketplace:remove': nonEmpty(128),

  // ── Ollama ────────────────────────────────────────────────────────────
  'ollama:status': z.string().max(2048).optional(),
  'ollama:models': z.string().max(2048).optional(),
  'ollama:launch': z.string().max(4096).optional(),
  // Positional: preload's ollamaPull(model, baseUrl) and ollamaDelete.
  'ollama:pull': [nonEmpty(512), z.string().max(2048).optional()],
  'ollama:delete': [nonEmpty(512), z.string().max(2048).optional()],

  // ── Lessons ───────────────────────────────────────────────────────────
  'lessons:courses:get': nonEmpty(128),
  'lessons:courses:delete': nonEmpty(128),
  'lessons:lessons:get': nonEmpty(128),
  'lessons:reviews:listForCourse': nonEmpty(128),

  // ── Security / privacy / logs / quit (see securityPolicy.ts) ───────────
  'security:set': z.object({ key: z.string().max(64), value: z.boolean() }).strict(),
  'security:unlock': z.object({ pin: z.string().min(4).max(128) }).strict(),
  'security:setPin': z.object({ pin: z.string().min(4).max(128) }).strict(),
  'privacy:clear': z
    .object({
      what: z
        .array(z.enum(['conversations', 'messages', 'memory', 'analytics', 'attachments', 'media', 'logs']))
        .min(1),
    })
    .strict(),
  'logs:query': z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error', 'all']).optional(),
      scope: z.string().max(120).optional(),
      search: z.string().max(200).optional(),
      since: z.string().max(64).optional(),
      until: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  'logs:clear': z.object({ before: z.string().max(64).optional() }).strict(),
  'logs:retention': z.object({ days: z.number().int().min(1).max(365) }).strict(),
  'app:quit': z.object({ force: z.boolean().optional(), confirm: z.boolean().optional() }).strict(),

  // ── Session store ─────────────────────────────────────────────────────
  // Every `session:*` handler is `handler(command)`, which takes ONE object
  // payload. preload sends an object for all of them, including the two that
  // look argument-less — `sessionStats: () => invoke('session:stats', {})` and
  // `clearToolCalls: () => invoke('session:clear-tool-calls', {})` send `{}`.
  // Requiring an object here is therefore safe and catches a bare-string call.
  'session:checkDeps': noArg,
  'session:create': jsonObject,
  'session:end': jsonObject,
  'session:resume': jsonObject,
  'session:branch': jsonObject,
  'session:list': jsonObject,
  'session:search': jsonObject,
  'session:addMessage': jsonObject,
  'session:getMessages': jsonObject,
  'session:list-tool-calls': jsonObject,
  'session:clear-tool-calls': jsonObject,
  'session:get': jsonObject,
  'session:setTitle': jsonObject,
  'session:archive': jsonObject,
  'session:updateTokens': jsonObject,
  'session:export': jsonObject,
  'session:stats': jsonObject,

  // ── Creators ─────────────────────────────────────────────────────────
  'creators:getDemo': noArg,
  'creators:saveDemo': jsonObject,
  'creators:getOrb': noArg,
  'creators:saveOrb': jsonObject,
  'creators:listMedia': noArg,
  'creators:closeStage': noArg,

  // ── Memory: record payloads (preload sends a Record for each) ──────────
  'memory:saveFact': jsonObject,
  'memory:searchFacts': jsonObject,
  'memory:saveSummary': jsonObject,
  'memory:savePersonalMemory': jsonObject,
  'memory:saveProject': jsonObject,
  'memory:saveProjectMemory': jsonObject,
  'memory:saveSessionMemory': jsonObject,
  'memory:updateWorkingMemory': jsonObject,
  'memory:saveGoal': jsonObject,
  'memory:saveCommitment': jsonObject,
  'memory:saveMilestone': jsonObject,
  'memory:saveRelationshipMemory': jsonObject,
  'memory:saveNarrativeMemory': jsonObject,
  'memory:saveMemorySummary': jsonObject,
  'memory:saveGraphEdge': jsonObject,
  'memory:buildContext': jsonObject,
  'memory:buildDeepContext': jsonObject,
  'memory:compressSession': jsonObject,

  // ── Personal apps that live in memory.ts ──────────────────────────────
  'reminders:list': noArg,
  'reminders:due': noArg,
  'reminders:save': jsonObject,
  'focus:stats': noArg,
  'weekly:data': noArg,
  'finance:create': jsonObject,
  'finance:add': jsonObject,
  'journal:save': jsonObject,
  'lists:all': noArg,
  'lists:save': jsonObject,
  'focus:save': jsonObject,
  'capture:save': jsonObject,
  'recordings:list': noArg,
  'recordings:save': jsonObject,
  'contacts:create': jsonObject,
  'tasks:create': jsonObject,
  'finance:recurring:list': noArg,
  'finance:recurring:autopost': noArg,
  'finance:recurring:save': jsonObject,
  'health:habitList': noArg,
  // Required fields the handler reads directly — a missing `date` would
  // otherwise write a row keyed on NULL.
  'health:logSave': z
    .object({
      id: z.string().max(128).optional(),
      date: nonEmpty(32),
      category: nonEmpty(64),
      label: z.string().max(200).optional(),
      value: finiteNumber.optional(),
      unit: z.string().max(32).optional(),
      note: z.string().max(2000).optional(),
    })
    .passthrough(),
  'health:habitSave': z
    .object({
      id: z.string().max(128).optional(),
      name: nonEmpty(200),
      icon: z.string().max(32).optional(),
      color: z.string().max(32).optional(),
      target_per_day: z.number().int().min(0).max(1000).optional(),
    })
    .passthrough(),
};

/** Channels whose payload must never be a bare string. */
export function validateRequest(channel: string, payload: unknown): unknown {
  const schema = channelSchemas[channel];
  const cleaned = sanitizePayload(payload);
  assertPayloadSize(channel, cleaned);
  // A positional (array) schema describes a multi-argument channel, which
  // `validateRequest` — a single-payload helper used by the `guarded*`
  // wrappers — cannot express. Such channels are enforced by the global
  // boundary instead, so here they take the baseline only.
  if (!schema || Array.isArray(schema)) return cleaned;
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
 * Same, for handlers written as `(event, payload)` — which is every
 * `ipcMain.handle` signature. The event is passed through untouched; only the
 * payload is validated.
 */
export function guardedEvent<Req, Res>(
  channel: string,
  handler: (event: unknown, payload: Req) => Promise<Res> | Res,
): (event: unknown, payload: unknown) => Promise<Res | ValidationFailure> {
  return async (event: unknown, payload: unknown) => {
    let clean: unknown;
    try {
      clean = validateRequest(channel, payload);
    } catch (e) {
      if (e instanceof ValidationError) {
        console.warn(
          `[ipc:${channel}] rejected payload:`,
          e.issues.map((i) => `${i.path} ${i.message}`).join('; '),
        );
        return validationFailure(e);
      }
      throw e;
    }
    return handler(event, clean as Req);
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

// ── The global boundary ─────────────────────────────────────────────────────

/**
 * ## Why one interception point instead of 367 edits
 *
 * Hand-writing a call to `guarded()` into every `ipcMain.handle` site was the
 * previous approach and it does not scale: it was applied to 2 of 367
 * channels, and every future handler is another chance to forget. Worse, it
 * spreads a security-relevant decision across dozens of files, so "is channel
 * X validated?" is only answerable by reading all of them.
 *
 * Instead we wrap `ipcMain.handle` itself, once, before any handler is
 * registered. From that point on every channel — present or future — passes
 * through the baseline and through its schema if it has one. A new handler is
 * covered by construction rather than by discipline.
 *
 * ## What it does and does not change
 *
 * It does not alter handler signatures, return shapes, or the set of arguments
 * a handler receives (all arguments are forwarded, in order, after
 * sanitisation). A channel with no schema still works exactly as before; it
 * simply gets the baseline. This is the property that kept the earlier
 * migrations from breaking working calls.
 */

/**
 * A schema for a channel that takes several arguments. The array is positional
 * and matches the renderer's `invoke(channel, a, b, c)` call exactly — see
 * `contacts:update(id, patch)` and `attachments:linkToMessage(ids, id, convId)`.
 */
export type ChannelSchema = z.ZodTypeAny | z.ZodTypeAny[];

/**
 * Channels whose execution the security policy can require confirmation for.
 *
 * Membership is decided by what the channel DOES, not by what module it lives
 * in: every entry can reach a shell, and none of them is reachable without a
 * renderer-side approval grant when `confirmShell` is on.
 */
export const SHELL_GATED_CHANNELS: ReadonlySet<string> = new Set([
  'computer:runShell',
  'computer:osascript',
  'terminal:exec',
  'printer:sendGcode',
  'printer:printGcode',
]);

/**
 * One-shot approval grants, keyed by channel.
 *
 * Each grant stores the fingerprint of the EXACT payload the user approved, not
 * just the channel name. A grant scoped only to the channel means consent for
 * `ls` also authorises `rm -rf` on the same channel — the call is refused,
 * armed, and re-invoked, and anything that changes the payload in between
 * inherits the consent. Consent that does not describe what actually runs is
 * not consent, so the fingerprint must match or the grant is destroyed.
 */
interface Grant {
  expiresAt: number;
  fingerprint: string;
}

const approvals = new Map<string, Grant>();

/** Grants are short-lived so a forgotten approval cannot be revived later. */
const APPROVAL_TTL_MS = 60_000;

/**
 * Stable JSON serialisation, so key order cannot change the fingerprint.
 *
 * `JSON.stringify` preserves insertion order, which means `{a:1,b:2}` and
 * `{b:2,a:1}` would fingerprint differently for identical content — and two
 * logically equal payloads failing to match would silently re-prompt the user.
 * Sorting keys makes the digest a function of VALUE, not of serialisation.
 */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']';
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalise((value as Record<string, unknown>)[k])}`);
  return '{' + entries.join(',') + '}';
}

/**
 * A digest of the exact arguments a gated call will carry.
 *
 * Hashed rather than stored raw so the grant map never holds the command text:
 * a debug dump of the approval table must not become a shell history.
 */
export function payloadFingerprint(args: readonly unknown[]): string {
  // Lazily required so this module still loads under a plain-Node test where
  // the `electron` import is already stubbed.
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(canonicalise(args)).digest('hex');
}

/**
 * Record that the user approved running `channel` with exactly `fingerprint`.
 *
 * Called from the preload bridge only after the renderer has actually shown a
 * confirmation. Returns false for a non-gated channel so a typo cannot create a
 * grant that some later channel happens to match.
 */
export function armChannelApproval(
  channel: string,
  fingerprint: string,
  getWindow?: () => { isDestroyed(): boolean } | null,
): boolean {
  if (!SHELL_GATED_CHANNELS.has(channel)) return false;
  const win = getWindow?.();
  if (win && win.isDestroyed()) return false;
  approvals.set(channel, { expiresAt: Date.now() + APPROVAL_TTL_MS, fingerprint });
  return true;
}

/**
 * Spend the approval for `channel`, requiring it to cover exactly `fingerprint`.
 *
 * A mismatch DESTROYS the grant rather than leaving it for a later matching
 * call. That is the conservative choice on purpose: if the payload changed
 * once, we have no reason to believe the renderer still intends what the user
 * saw, so the safest assumption is that this is a new, unapproved action.
 */
export function consumeChannelApproval(channel: string, fingerprint: string): boolean {
  const grant = approvals.get(channel);
  if (grant === undefined) return false;
  approvals.delete(channel);
  if (Date.now() >= grant.expiresAt) return false;
  return grant.fingerprint === fingerprint;
}

/** Drop every outstanding grant. Used on policy change and by tests. */
export function revokeChannelApprovals(): void {
  approvals.clear();
}

/**
 * The refusal every gated channel returns when its approval is missing.
 *
 * Distinct from a validation failure on purpose: `validationError: true` means
 * the payload was malformed and retrying will not help, whereas this means the
 * call was well-formed and is waiting on a decision the user has not made. The
 * renderer keys its confirm dialog off `confirmationRequired`.
 */
export interface ConfirmationRequired {
  ok: false;
  confirmationRequired: true;
  channel: string;
  error: string;
}

export function confirmationRequired(channel: string): ConfirmationRequired {
  return {
    ok: false,
    confirmationRequired: true,
    channel,
    error: 'This action needs your confirmation before it can run.',
  };
}

/**
 * How the boundary consults the security policy.
 *
 * Injected rather than imported so this module stays testable without a
 * database, and so `electron/ipc/securityPolicy.ts` is the only owner of the
 * defaults. `main.ts` wires the real implementation at install time.
 */
export interface BoundaryHooks {
 /** Whether `channel` may run right now, given the policy and any approval. */
  isExecutionAllowed?: (channel: string) => boolean;
}

/**
 * Install the boundary. Idempotent — a second call is a no-op rather than a
 * double wrap, so a hot reload cannot stack two validators on one channel.
 *
 * Must be called before any `register*Handlers()` runs.
 */
export function installIpcBoundary(hooks: BoundaryHooks = {}): void {
  // Outside Electron (a plain-Node vitest run) the `electron` package resolves
  // to a binary path, so `ipcMain` is undefined. That is a legitimate
  // "nothing to install" — every channel in that environment is a test double.
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  if ((ipcMain as unknown as { __henryGuarded?: boolean }).__henryGuarded) return;

  const rawHandle = ipcMain.handle;
  const original = rawHandle.bind(ipcMain);
  // The wrapper accepts the same `(channel, listener)` pair but types its
  // listener loosely; Electron's own signature narrows `event` to
  // IpcMainInvokeEvent, which the wrapper forwards untouched.
  const registrar = ipcMain as unknown as {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
  };

  registrar.handle = (channel: string, listener: (...args: unknown[]) => unknown) =>
    original(channel, async (ev: unknown, ...payloadArgs: unknown[]) => {
      try {
        const schema = channelSchemas[channel];
        let cleaned: unknown[];

        if (Array.isArray(schema)) {
          // Positional: every declared position is validated in place. A short
          // call is left short rather than padded, so the handler sees exactly
          // the arguments the renderer sent.
          cleaned = payloadArgs.map((value, i) => {
            const s = schema[i] as z.ZodTypeAny | undefined;
            return s ? s.parse(value) : sanitizePayload(value);
          });
        } else if (schema) {
          // A single-schema channel describes the FIRST payload argument; the
          // rest still take the baseline.
          cleaned = payloadArgs.map((value, i) =>
            i === 0 ? (schema as z.ZodTypeAny).parse(value) : sanitizePayload(value),
          );
        } else {
          cleaned = payloadArgs.map((value) => sanitizePayload(value));
        }

        for (const value of cleaned) assertPayloadSize(channel, value);

        if (hooks.isExecutionAllowed && !hooks.isExecutionAllowed(channel)) {
          return confirmationRequired(channel);
        }

        return listener(ev, ...cleaned);
      } catch (e) {
        if (e instanceof ValidationError || e instanceof z.ZodError) {
          console.warn(`[ipc:${channel}] rejected payload:`, describeIssues(e));
          return e instanceof ValidationError ? validationFailure(e) : zodFailure(channel, e);
        }
        throw e;
      }
    });

  (ipcMain as unknown as { __henryGuarded?: boolean }).__henryGuarded = true;
  (ipcMain as unknown as { __henryOriginalHandle?: unknown }).__henryOriginalHandle = rawHandle;
}

/**
 * Uninstall the boundary and restore the original `ipcMain.handle`.
 *
 * A test seam: the install flag makes re-installation a deliberate no-op, which
 * is correct in production (a hot reload must not stack validators) but means a
 * test cannot swap hooks without it.
 */
export function __resetIpcBoundaryForTest(): void {
  const marked = ipcMain as unknown as {
    __henryGuarded?: boolean;
    __henryOriginalHandle?: typeof ipcMain.handle;
  };
  if (marked.__henryOriginalHandle) ipcMain.handle = marked.__henryOriginalHandle;
  delete marked.__henryOriginalHandle;
  delete marked.__henryGuarded;
}

/** Shape a zod error into the same structured failure as a ValidationError. */
function zodFailure(channel: string, e: z.ZodError): ValidationFailure {
  return {
    ok: false,
    validationError: true,
    error: `Rejected: ${e.issues
      .slice(0, 12)
      .map((i) => `${i.path.join('.') || 'payload'} ${i.message}`)
      .join('; ')
      .slice(0, 300)}`,
    channel,
    issues: e.issues.slice(0, 12).map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  };
}

/** One-line issue summary used by both failure shapes. */
function describeIssues(e: ValidationError | z.ZodError): string {
  if (e instanceof ValidationError) {
    return e.issues.map((i) => `${i.path} ${i.message}`).join('; ');
  }
  return e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
}