/**
 * gatedChannel — the renderer half of the shell-confirmation gate.
 *
 * ## The defect this exists to close
 *
 * `SHELL_GATED_CHANNELS` in `electron/ipc/validation.ts` refuses every gated
 * invoke when `confirmShell` is on unless a one-shot grant covering the exact
 * payload has been armed. The grant was only ever armable through
 * `securityApproveChannel`, which had **no call sites in `src/`** — so on a
 * default install every gated call returned
 * `{ok:false, confirmationRequired:true}` forever. HQPanel swallowed it in a
 * `.catch(() => {})`, PrinterPanel logged a bare "Send failed.", and the failure
 * was invisible. A gate nobody can satisfy is not a gate.
 *
 * ## Why this file has no React in it
 *
 * The interesting part of this flow is not the dialog — it is the ordering and
 * the argument normalisation, both of which are security properties. Keeping
 * them here means they are testable without a DOM, and testable against the
 * REAL fingerprinting code from the main process rather than against a
 * hand-written imitation of it.
 *
 * ## The two fingerprints, and why they usually disagree
 *
 * The boundary fingerprints the arguments AFTER schema validation:
 *
 *     cleaned[i] = schema[i].parse(args[i])        // installIpcBoundary
 *     payloadFingerprint(cleaned)                   // → refuse unless armed
 *
 * The approve handler fingerprints the arguments AFTER baseline sanitisation
 * only:
 *
 *     normalised = args.map(sanitizePayload)       // main.ts security:approve-channel
 *     payloadFingerprint(normalised)
 *
 * Those are different transforms, so a raw renderer payload is not guaranteed to
 * produce the same fingerprint on both sides. Two concrete ways they diverge,
 * both confirmed against the installed zod (3.25):
 *
 *   1. `computer:runShell`'s schema is `z.object({ command: z.string().trim()…})`,
 *      so the boundary fingerprints `'ls'` for a payload of `' ls '` while the
 *      approve side fingerprints `' ls '`.
 *   2. zod KEEPS an explicitly-`undefined` optional key as an own property
 *      (`z.object({timeout: z.number().optional()}).parse({timeout: undefined})`
 *      has the key `timeout`), while `sanitizePayload` DROPS it. A payload of
 *      `{command:'ls', timeout: undefined}` therefore fingerprints differently
 *      on each side.
 *
 * Either mismatch produces an endless re-prompt: refused → approve → still
 * refused. Safe, but unusable, and it would look exactly like the bug this file
 * fixes. `normaliseGatedArgs` exists solely to produce a payload that is a fixed
 * point of BOTH transforms — and the tests assert that property directly
 * against the real `channelSchemas` and the real `sanitizePayload`.
 */

/** The refusal shape every gated channel returns when its approval is missing. */
export interface ConfirmationRequired {
  ok: false;
  confirmationRequired: true;
  channel: string;
  error: string;
}

/**
 * Mirrors `SHELL_GATED_CHANNELS`.
 *
 * Deliberately duplicated rather than imported: `validation.ts` imports
 * `electron`, and the renderer bundle must not. Drift is caught by
 * `gatedChannel.test.ts`, which asserts this list equals the real
 * `SHELL_GATED_CHANNELS`.
 */
export const GATED_CHANNELS: readonly string[] = [
  'computer:runShell',
  'computer:osascript',
  'terminal:exec',
  'printer:sendGcode',
  'printer:printGcode',
];


const GATED_CHANNEL_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(GATED_CHANNELS.map((channel) => [channel, true as const])),
);

export function isGatedChannel(channel: string): boolean {
  return GATED_CHANNEL_LOOKUP[channel] === true;
}

export function isConfirmationRequired(value: unknown): value is ConfirmationRequired {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { confirmationRequired?: unknown; channel?: unknown };
  return v.confirmationRequired === true && typeof v.channel === 'string';
}

// ── Argument normalisation ──────────────────────────────────────────────────

/** Keys that can poison Object.prototype if merged into a plain object. */
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deepest nesting we will walk. Matches MAX_DEPTH in electron/ipc/validation.ts. */
const MAX_DEPTH = 24;

/**
 * Channels whose schema trims the `command` field.
 *
 * Both schemas are `.passthrough()` objects with `command: nonEmpty(32_000)`,
 * and `nonEmpty` is `z.string().trim().min(1)`, so the boundary hands the
 * handler a trimmed command whether or not the renderer trimmed it.
 */

const TRIMMED_COMMAND_CHANNELS: Readonly<Record<string, true>> = {
  'computer:runShell': true,
  'terminal:exec': true,
};

/**
 * Channels whose entire first argument is a trimmed string.
 *
 * `computer:osascript` is `nonEmpty(32_000)`; the two printer channels are a
 * bare `z.string().max(…)` with NO transform, and G-code is whitespace-
 * significant — trimming it here would change what the printer is sent.
 */

const TRIMMED_STRING_ARG_CHANNELS: Readonly<Record<string, true>> = {
  'computer:osascript': true,
};

/**
 * Strip everything that cannot survive IPC, mirroring `sanitizePayload`.
 *
 * The point is not defence in depth — the main process does this anyway — it is
 * to make the renderer's payload a FIXED POINT of `sanitizePayload`, so that
 * approving exactly these arguments arms exactly the fingerprint the boundary
 * will compute.
 */
function prune(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'bigint') return Number(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const kept = prune(item, depth + 1);
      if (kept !== undefined) out.push(kept);
    }
    return out;
  }
  if (t === 'object') {
    // `sanitizePayload` stringifies dates; matching it keeps the fingerprint
    // identical for a payload that happens to carry one.
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (POISON_KEYS.has(key)) continue;
      const kept = prune(item, depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return undefined;
}

/**
 * The exact argument list to invoke with AND to approve.
 *
 * Return one result and use it for both calls. Computing them separately is
 * how the re-prompt loop is born.
 */
export function normaliseGatedArgs(channel: string, args: readonly unknown[]): unknown[] {
  const out = args.map((a) => prune(a, 0));
  const first = out[0];
  if (
    TRIMMED_COMMAND_CHANNELS[channel] === true &&
    typeof first === 'object' && first !== null && !Array.isArray(first) &&
    typeof (first as Record<string, unknown>).command === 'string'
  ) {
    (first as Record<string, unknown>).command = ((first as Record<string, unknown>).command as string).trim();
  }
  if (TRIMMED_STRING_ARG_CHANNELS[channel] === true && typeof out[0] === 'string') {
    out[0] = (out[0] as string).trim();
  }
  return out;
}

// ── Describing the call for the user ────────────────────────────────────────

/** Beyond this the dialog shows a truncated payload with an explicit marker. */
export const MAX_DISPLAY_CHARS = 4_000;

const CHANNEL_TITLES: Record<string, string> = {
  'computer:runShell': 'Run a shell command',
  'computer:osascript': 'Run an AppleScript',
  'terminal:exec': 'Run a terminal command',
  'printer:sendGcode': 'Send G-code to the printer',
  'printer:printGcode': 'Send a G-code print job',
};

export interface GatedDescription {
  /** Human label for the channel, e.g. "Run a shell command". */
  title: string;
  /** The thing that will actually run, shown verbatim and prominently. */
  summary: string;
  /** Any remaining arguments, rendered as JSON. */
  detail: string;
}

function truncate(text: string): string {
  return text.length <= MAX_DISPLAY_CHARS
    ? text
    : `${text.slice(0, MAX_DISPLAY_CHARS)}\n… (${text.length - MAX_DISPLAY_CHARS} more characters not shown)`;
}

/**
 * Build what the user is shown.
 *
 * A generic "are you sure?" is useless here: the whole point of the gate is
 * that the user reads the exact command before it runs. So the command or
 * payload text is the headline, not a footnote.
 */
export function describeGatedCall(
  channel: string,
  args: readonly unknown[],
  overrideSummary?: string,
): GatedDescription {
  const title = CHANNEL_TITLES[channel] ?? `Run ${channel}`;

  const firstArg = args[0];
  const isCommandObject =
    typeof firstArg === 'object' && firstArg !== null && !Array.isArray(firstArg) &&
    typeof (firstArg as Record<string, unknown>).command === 'string';

  let summary: string;
  if (typeof overrideSummary === 'string') {
    summary = overrideSummary;
  } else if (isCommandObject) {
    summary = (firstArg as Record<string, unknown>).command as string;
  } else if (typeof firstArg === 'string') {
    summary = firstArg;
  } else {
    summary = JSON.stringify(firstArg ?? null);
  }

  const rest: Array<[string, unknown]> =
    typeof firstArg === 'object' && firstArg !== null && !Array.isArray(firstArg)
      ? Object.entries(firstArg as Record<string, unknown>).filter(([k]) => k !== 'command')
      : [];
  const detailParts: string[] = [];
  for (const [key, value] of rest) detailParts.push(`${key}: ${truncate(JSON.stringify(value) ?? 'null')}`);
  if (args.length > 1) detailParts.push(`arguments: ${truncate(JSON.stringify(args.slice(1)) ?? 'null')}`);

  return {
    title,
    summary: truncate(summary),
    detail: detailParts.join('\n'),
  };
}

// ── The flow ────────────────────────────────────────────────────────────────

export interface GatedRequest {
  channel: string;
  /** Raw arguments, exactly as the caller would have invoked the channel. */
  args: readonly unknown[];
  /** Optional override for the headline text (e.g. "3 G-code commands"). */
  summary?: string;
}

/** Everything the flow touches, injected so it can be driven without Electron. */
export interface GatedDeps {
  /** Invoke the gated channel with the given argument list. */
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  /** `securityApproveChannel` — arms exactly one execution. */
  approve: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  /** Show the prompt; resolve `true` for approve, `false` for reject or cancel. */
  ask: (description: GatedDescription, channel: string) => Promise<boolean>;
}

export type GatedOutcome<T> =
  /** The call ran. `response` is whatever the channel returned. */
  | { status: 'ran'; response: T }
  /** The user said no. Nothing further was invoked or armed. */
  | { status: 'declined' }
  /** Something other than consent blocked it — most often the app lock. */
  | { status: 'blocked'; reason: string };

/**
 * Invoke a gated channel, asking the user for permission if it is refused.
 *
 * The order is fixed and each step is load-bearing:
 *
 *   invoke → refused → ask → approve(channel, THE SAME ARGS) → invoke once more
 *
 * - The retry happens at most once. A second refusal after an approval means
 *   something changed underneath us, so we stop and report it rather than
 *   re-arming — a loop that re-arms on every refusal can walk the user into
 *   approving an unbounded series of commands they never individually read.
 * - `approve` receives the same normalised array that was just refused, because
 *   the grant is bound to its fingerprint and a different array arms a grant
 *   that the retry cannot spend.
 * - If `approve` itself is refused — which is what happens when the app is
 *   locked, since `security:approve-channel` is not lock-exempt — nothing is
 *   retried. `security:approveChannel` is the one call this flow makes without
 *   having been told yes, and it is only ever a no-op without a grant behind it.
 */
export async function runGatedChannel<T>(
  deps: GatedDeps,
  request: GatedRequest,
): Promise<GatedOutcome<T>> {
  const { channel, args: rawArgs } = request;

  if (!isGatedChannel(channel)) {
    // Approving a channel outside the gate would arm nothing at best and, if
    // the list here has drifted from the main process's, the wrong thing at
    // worst. Refuse locally rather than guess.
    return { status: 'blocked', reason: `${channel} is not a confirmable channel.` };
  }

  const args = normaliseGatedArgs(channel, rawArgs);

  const first = await deps.invoke(channel, args);
  if (!isConfirmationRequired(first)) return { status: 'ran', response: first as T };

  const description = describeGatedCall(channel, args, request.summary);
  const approved = await deps.ask(description, channel);
  if (!approved) return { status: 'declined' };

  const armed = await deps.approve(channel, args);
  if (typeof armed !== 'object' || armed === null || (armed as { ok?: unknown }).ok !== true) {
    return {
      status: 'blocked',
      reason:
        'Your approval could not be registered, so nothing was run. This usually means ' +
        'another security rule is blocking it.',
    };
  }

  const second = await deps.invoke(channel, args);
  if (isConfirmationRequired(second)) {
    // Deliberately NOT re-armed. One prompt, one grant, one retry.
    return {
      status: 'blocked',
      reason:
        'Henry still refused this after you approved it, so it has not been run. ' +
        (typeof second.error === 'string' ? second.error : 'The security gate refused it again.')
    };
  }
  return { status: 'ran', response: second as T };
}
