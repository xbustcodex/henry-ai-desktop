import type { MessagePart } from '../ipc/contentParts';
/**
 * ToolRunner — wraps a single-round model `complete` call in a tool-calling
 * loop and enforces the safety model (design §5, §7).
 *
 * The runner is provider-agnostic: `ai.ts` supplies a `complete` callback that
 * runs one model round (with the registry's tools attached) and returns the
 * assistant's text plus any tool calls. The runner then, per tool:
 *   - silent : execute immediately, log it, continue — UNLESS the security
 *              policy's `confirmSilentTools` flag is on, in which case it
 *              routes through the same approval gate as confirm-tier. That
 *              flag is a gate ABOVE the tier: no tool is reclassified.
 *   - notify : execute, fire a renderer toast, continue
 *   - confirm: emit `agent:confirm-required`, await `agent:confirm-response`,
 *              and only execute if approved (using edited args if provided)
 * Every call + result is written to the session store as a `tool` message.
 * Loops at most `maxRounds` (default 10) to prevent runaway tool use.
 */

import { randomUUID } from 'crypto';
import type { AgentContext, ModelTool, ToolResult } from './types';
import type { ToolRegistry } from './toolRegistry';
import { log } from '../lib/log';
import { policyFlag } from '../ipc/securityPolicy';

// ── Conversation shape passed to / from the model ──────────────────────────

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Pull image payloads out of a tool result.
 *
 * `file_load` returns `{kind:'image', mime, base64}`. Left inside the
 * JSON.stringify'd result the model received megabytes of base64 as prose: it
 * could not see the picture, and the context filled with noise. The image is
 * removed from the text and returned separately for the adapter to attach.
 */
export function liftImages(result: unknown): {
  text: string;
  images: Extract<MessagePart, { type: 'image' }>[];
} {
  const images: Extract<MessagePart, { type: 'image' }>[] = [];
  if (result && typeof result === 'object') {
    const data = (result as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const maybe = (data ?? (result as Record<string, unknown>)) as Record<string, unknown>;
    if (maybe && maybe.kind === 'image' && typeof maybe.base64 === 'string' && typeof maybe.mime === 'string') {
      images.push({
        type: 'image',
        mimeType: maybe.mime,
        data: maybe.base64,
        name: typeof maybe.path === 'string' ? maybe.path.split(/[\\/]/).pop() : undefined,
      });
      const trimmed: Record<string, unknown> = { ...(result as Record<string, unknown>) };
      if (trimmed.data && typeof trimmed.data === 'object') {
        const { base64: _drop, ...rest } = trimmed.data as Record<string, unknown>;
        (trimmed.data as Record<string, unknown>) = rest;
      }
      return { text: JSON.stringify(trimmed), images };
    }
  }
  return { text: JSON.stringify(result), images };
}

export interface RunnerMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Text, or text plus images. Images arrive from tools such as `file_load`,
   * which reads a picture off disk so the model can actually look at it.
   */
  content: string | MessagePart[];
  /** Images carried on this turn, kept out of `content` so persistence and
   *  every text-only consumer can ignore them. */
  images?: Extract<MessagePart, { type: 'image' }>[];
  /** Present on an assistant turn that requested tools. */
  toolCalls?: ModelToolCall[];
  /** Present on a tool-result turn. */
  toolCallId?: string;
  /** Tool name on a tool-result turn. */
  name?: string;
}

export interface ModelCompletion {
  content: string;
  toolCalls: ModelToolCall[];
  usage?: { input: number; output: number };
}

/**
 * Optional incremental channel for a model round.
 *
 * `onDelta` is PROVISIONAL. A provider that streams a tool-calling round emits
 * the raw tool call itself as text — measured live on both llama3.2:3b and
 * qwen2.5-coder:7b — so the user will briefly see `{"name":"get_weather"...}`
 * stream into the bubble before the round resolves and it is known to be a
 * call rather than prose. The runner therefore treats deltas as display-only
 * and always lets the round's final `content` win. Deltas are never persisted
 * and never logged as conversation content.
 *
 * A provider that does not stream simply never calls `onDelta`, which is why
 * it is optional and why behaviour is unchanged for every caller that omits it.
 */
export interface CompleteHandlers {
  onDelta?: (text: string) => void;
}

/**
 * Runs one model round with the given tools. Supplied by `ai.ts`.
 *
 * The third parameter is optional and additive: existing two-argument callers
 * (`ai.ts`, `scheduler.ts`) keep working with no change, and the provider
 * decides whether to call `onDelta` at all.
 */
export type CompleteFn = (
  messages: RunnerMessage[],
  modelTools: ModelTool[],
  handlers?: CompleteHandlers,
) => Promise<ModelCompletion>;

// ── Confirmation bus (confirm-tier tools) ──────────────────────────────────

interface PendingConfirm {
  resolve: (r: { approved: boolean; editedArgs?: Record<string, unknown> }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingConfirms = new Map<string, PendingConfirm>();
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Resolve a pending confirm-tier tool call. Called by the
 * `agent:confirm-response` IPC handler when the renderer replies. Returns true
 * if a matching pending request was found.
 */
export function resolveConfirmation(
  id: string,
  approved: boolean,
  editedArgs?: Record<string, unknown>,
): boolean {
  const pending = pendingConfirms.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingConfirms.delete(id);
  pending.resolve({ approved, editedArgs });
  // Persist the outcome so the Approval Queue has a durable record.
  void import('../ipc/approvals')
    .then((m) => m.recordApprovalDecision(id, approved ? 'approved' : 'rejected', editedArgs))
    .catch(() => {});
  return true;
}

function requestConfirmation(
  context: AgentContext,
  payload: { id: string; toolName: string; args: Record<string, unknown>; description: string },
): Promise<{ approved: boolean; editedArgs?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirms.delete(payload.id);
      // Record the timeout as an expired decision in the queue.
      void import('../ipc/approvals')
        .then((m) => m.recordApprovalDecision(payload.id, 'expired'))
        .catch(() => {});
      resolve({ approved: false }); // timeout → treat as rejection
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(payload.id, { resolve, timer });

    // Persist the pending request so the Approval Queue is reviewable (best-effort).
    void import('../ipc/approvals')
      .then((m) =>
        m.recordApprovalRequest({
          id: payload.id,
          toolName: payload.toolName,
          description: payload.description,
          args: payload.args,
          sessionId: context.sessionId,
        }),
      )
      .catch(() => {});

    const win = context.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:confirm-required', { ...payload, safetyLevel: 'confirm' });
    } else {
      // No renderer to confirm — fail safe.
      clearTimeout(timer);
      pendingConfirms.delete(payload.id);
      resolve({ approved: false });
    }
  });
}

// ── Renderer signalling ────────────────────────────────────────────────────

function send(context: AgentContext, channel: string, data: unknown): void {
  const win = context.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ── Session-store audit log ────────────────────────────────────────────────
// SessionStore lives at electron/ipc/sessionStore.ts (committed); we log each
// tool call there as a `tool` message via its exported helper. The import is
// resolved lazily so the runner stays usable even if the store is unavailable.
async function logToolCall(
  context: AgentContext,
  call: ModelToolCall,
  result: ToolResult,
): Promise<void> {
  if (!context.sessionId) return;
  try {
    const { recordSessionMessage, toolCallBlocks } = await import('../ipc/sessionStore');
    await recordSessionMessage({
      session_id: context.sessionId,
      role: 'tool',
      kind: 'tool_result',
      // Structured content (tool_use + tool_result blocks) instead of an opaque
      // JSON string, so the call is searchable and renderable as an action.
      content: toolCallBlocks(call.name, call.id, call.arguments, result, !result.ok),
      tool_name: call.name,
      tool_call_id: call.id,
    });
  } catch (e) {
    // Non-fatal: the tool ran fine — only its audit-log write failed.
    console.error('[agent:toolRunner] session log failed:', e instanceof Error ? e.message : e);
  }
}

// ── Retry/backoff (design §5 retry policy) ─────────────────────────────────
// Honours the `retryable` flag tools already set: network reads (web_search,
// web_fetch_page, weather, QBO transient 5xx) mark transient failures
// retryable. We retry those a couple of times with exponential backoff. We
// NEVER retry confirm-tier tools — senders/writes (messages_send, email_send,
// terminal_exec, invoice/event creation) must not fire twice from one approval.

const MAX_TOOL_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000]; // delays before attempts 2 and 3

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runToolWithRetry(
  tool: { execute: (a: Record<string, unknown>, c: AgentContext) => Promise<ToolResult>; safetyLevel: string; name: string },
  args: Record<string, unknown>,
  context: AgentContext,
): Promise<ToolResult> {
  // Side-effecting / gated tools execute exactly once.
  const allowRetry = tool.safetyLevel !== 'confirm';

  let result: ToolResult;
  for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt++) {
    try {
      result = await tool.execute(args, context);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const transient = !result.ok && result.retryable === true;
    if (!allowRetry || !transient || attempt === MAX_TOOL_ATTEMPTS) return result;
    const delay = RETRY_BACKOFF_MS[attempt - 1] ?? 2000;
    log.debug(`[agent:tool] ${tool.name} transient failure (attempt ${attempt}/${MAX_TOOL_ATTEMPTS}) — retrying in ${delay}ms`);
    await sleep(delay);
  }
  // Unreachable, but satisfies the type checker.
  return result!;
}

// ── Single tool call: gate → execute → signal ──────────────────────────────

async function executeToolCall(
  registry: ToolRegistry,
  context: AgentContext,
  call: ModelToolCall,
): Promise<ToolResult> {
  const tool = registry.getTool(call.name);
  if (!tool) return { ok: false, error: `Unknown tool: ${call.name}` };

  let args: Record<string, unknown> = call.arguments ?? {};
  const describe = tool.confirmPrompt ? tool.confirmPrompt(args) : `Run ${tool.name}`;

  // confirm tier, plus the security policy's silent-tier escalation.
  //
  // Security policy: when `confirmSilentTools` is on, the SILENT tier also
  // pauses for the user. This is a gate ABOVE the tier, not a reclassification
  // — no tool's declared `safetyLevel` changes, so the tier counts and the
  // safety-policy tests still describe reality. It routes through the SAME
  // `requestConfirmation` as confirm-tier, so there is exactly one gate and
  // one place where the no-renderer fail-safe lives.
  //
  // DEFAULT IS OFF — this gate is permissive by default, deliberately.
  // `DEFAULT_POLICY.confirmSilentTools` is `false`, and it is `false` in three
  // distinct cases: before the store has loaded (`cached` is seeded from
  // DEFAULT_POLICY), when the key is unset, and when a stored value is
  // unreadable (`resolvePolicy` builds on `{...DEFAULT_POLICY}` and `asBool`
  // falls back to `DEFAULT_POLICY[key]` per key). So an uninitialised or
  // corrupt policy PERMITS silent tools rather than blocking them.
  //
  // That is a considered decision, not an oversight: the silent tier is a
  // pre-existing, deliberately-designed classification that has always run
  // unattended, and defaulting this on would change every existing install's
  // behaviour on upgrade while collapsing the silent/confirm distinction the
  // tier system exists to carry. Do not "fix" this to fail-closed without
  // re-deciding that trade-off.
  //
  // Scope note, because it matters: this switch gates only the SILENT tier.
  // The confirm tier above is unconditional and unaffected by the policy — a
  // confirm-tier tool always requires approval, and still fails closed when
  // no renderer is present. So the security boundary around real-world side
  // effects does not depend on this flag.
  const needsApproval =
    tool.safetyLevel === 'confirm' ||
    (tool.safetyLevel === 'silent' && policyFlag('confirmSilentTools'));

  if (needsApproval) {
    const decision = await requestConfirmation(context, {
      id: randomUUID(),
      toolName: tool.name,
      args,
      description: describe,
    });
    if (!decision.approved) {
      // Deliberately the same error a confirm-tier denial produces: a caller
      // must not be able to tell the two apart and branch on it.
      return { ok: false, error: 'User declined the action.' };
    }
    if (decision.editedArgs) args = decision.editedArgs;
  }

  send(context, 'agent:tool-started', { tool: tool.name, args });

  const result = await runToolWithRetry(tool, args, context);

  send(context, 'agent:tool-completed', { tool: tool.name, result });

  // notify tier — non-blocking toast describing what just happened.
  if (tool.safetyLevel === 'notify') {
    send(context, 'agent:tool-notify', {
      tool: tool.name,
      message: describe,
      ok: result.ok,
    });
  }

  if (tool.safetyLevel === 'silent') {
    log.debug(`[agent:tool] ${tool.name} ok=${result.ok}`);
  }

  return result;
}

// ── Main loop ──────────────────────────────────────────────────────────────

export interface RunToolConversationOpts {
  registry: ToolRegistry;
  context: AgentContext;
  messages: RunnerMessage[];
  complete: CompleteFn;
  maxRounds?: number;
}

export interface RunToolConversationResult {
  content: string;
  rounds: number;
  usage: { input: number; output: number };
}

export async function runToolConversation(
  opts: RunToolConversationOpts,
): Promise<RunToolConversationResult> {
  const { registry, context, complete } = opts;
  const maxRounds = opts.maxRounds ?? 10;
  const messages: RunnerMessage[] = [...opts.messages];
  const modelTools = registry.toModelTools();
  const usage = { input: 0, output: 0 };

  let rounds = 0;
  while (rounds < maxRounds) {
    rounds++;
    const round = rounds;
    let streamed = false;
    const completion = await complete(messages, modelTools, {
      onDelta: (text: string) => {
        if (!text) return;
        streamed = true;
        // Provisional display only. Never persisted, never logged as content.
        send(context, 'agent:tool-stream-delta', { round, text });
      },
    });
    if (completion.usage) {
      usage.input += completion.usage.input;
      usage.output += completion.usage.output;
    }

    // If anything streamed, close the provisional bubble with the round's
    // authoritative text. For a tool-calling round this is what replaces the
    // raw tool-call JSON the user saw go by, so it must be sent on EVERY
    // round that streamed — not just the final one.
    if (streamed) {
      send(context, 'agent:tool-stream-final', { round, content: completion.content ?? '' });
    }

    // No tool calls → the model is done; return its answer.
    if (!completion.toolCalls || completion.toolCalls.length === 0) {
      return { content: completion.content ?? '', rounds, usage };
    }

    // Record the assistant's tool-call turn, then run each call.
    messages.push({
      role: 'assistant',
      content: completion.content ?? '',
      toolCalls: completion.toolCalls,
    });

    for (const call of completion.toolCalls) {
      const result = await executeToolCall(registry, context, call);
      // A tool that read a picture returns it as base64. Stringifying that into
      // the message text made the image inert AND billed every token of it, so
      // images are lifted out here and carried separately.
      const lifted = liftImages(result);
      messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: lifted.text,
        images: lifted.images,
      });
      await logToolCall(context, call, result);
    }
  }

  return {
    content: 'I reached my action limit for this task (10 tool calls).',
    rounds,
    usage,
  };
}
