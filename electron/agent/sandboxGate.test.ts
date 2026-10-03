/**
 * Sandbox gate — the DENIAL path of the confirm-tier approval boundary.
 *
 * `toolRunner.test.ts` proves the approve path. This file proves what happens
 * when approval does NOT arrive, because that is where the security value is:
 * an unattended scheduled run (a 7am briefing with no window up) must be unable
 * to send anything, a stale approval id must not unlock a fresh request, and a
 * confirm-tier tool must never be retried into a double-send.
 *
 * Every assertion here is a refusal or a non-escalation.
 *
 * Tools are the REAL shipped definitions, from `registerAllTools`, so the real
 * `name` / `safetyLevel` / `confirmPrompt` are what the gate reads — only
 * `execute` is swapped for a spy, so no real side effect can fire. `complete`
 * is scripted, so no model is ever contacted.
 *
 * On `confirmSilentTools`: `toolRunner` can also gate SILENT tools, but only
 * when the user has turned that on in Settings. It ships OFF. So "a silent
 * tool never escalates" is true by default, and this file pins both halves:
 * default/off → runs immediately, emits no `agent:confirm-required`; on → it
 * gates, and a refusal still executes nothing. The store-level behaviour
 * lives in `electron/ipc/securityPolicy.test.ts`; what is pinned here is the
 * runner's branch.
 *
 * The gate itself is NOT modified by this file. If a test fails, the gate is
 * the thing to fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The tool modules import Electron (`shell`, `safeStorage`, `ipcMain`) and the
// native better-sqlite3 addon at module top. Mock both so the REAL tool
// definitions can be imported under plain Node.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('better-sqlite3', () => ({ default: class FakeDb {} }));

// toolRunner lazily imports the Approval Queue (`../ipc/approvals`) to keep a
// durable record of every confirm decision. Rather than stub that module out —
// the lazy import resolves it through a different specifier than a local mock
// reliably intercepts — mock the DATABASE underneath it, so the REAL
// recordApprovalRequest/Decision code runs and its SQL is observable. That
// proves the decision actually reaches the queue instead of proving a stub was
// called.
const sqlLog: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('../ipc/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => { sqlLog.push({ sql, params }); return { changes: 1 }; },
    }),
  }),
  getDbFilePath: () => '/tmp/henry-test.db',
}));

// `confirmSilentTools` is read through `policyFlag` at module scope in
// toolRunner. Mocked HERE rather than driven through the real store's test seam:
// these tests are about the RUNNER's branch, and depending on the real
// DEFAULT_POLICY would couple this file to another agent's concurrent flip of
// that default. The default here is the shipped default (off) — the user opts
// in — and both halves are asserted below.
let confirmSilentTools = false;
vi.mock('../ipc/securityPolicy', () => ({
  policyFlag: (key: string) => {
    if (key !== 'confirmSilentTools') throw new Error(`unexpected policy key: ${key}`);
    return confirmSilentTools;
  },
}));

import { runToolConversation, resolveConfirmation } from './toolRunner';
import type { ModelCompletion, RunnerMessage } from './toolRunner';
import { ToolRegistry } from './toolRegistry';
import { registerAllTools } from './tools/index';
import type { AgentContext, ToolResult } from './types';

// ── Helpers (re-implemented here; toolRunner.test.ts is off-limits) ──────────

/** A `webContents.send` payload — asserted on whole, never field-read. */
type WirePayload = Record<string, unknown>;

/** The signature every tool's `execute` has. */
type Execute = (args: Record<string, unknown>, context: AgentContext) => Promise<ToolResult>;

/** A scripted `complete` that also keeps every round's message list. */
interface ScriptedComplete {
  (messages: RunnerMessage[]): Promise<ModelCompletion>;
  rounds: RunnerMessage[][];
}

/** A fake renderer window plus the wire log of what the runner sent it. */
interface FakeWin {
  context: AgentContext;
  sent: Array<{ channel: string; payload: WirePayload }>;
  /** Confirm ids seen on the wire, in order. */
  confirmIds: string[];
  /** Simulate the renderer going away mid-run. */
  destroy: () => void;
}

/** A registry holding every shipped tool, so tests can use REAL definitions. */
function realRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  registerAllTools(reg);
  return reg;
}

/**
 * Swap a real tool's `execute`, leaving its shipped `name`, `safetyLevel` and
 * `confirmPrompt` untouched — the gate reads exactly those fields, so the real
 * ones are what must be under test.
 */
function spyExecute(reg: ToolRegistry, name: string, execute: Execute): void {
  const real = reg.getTool(name);
  if (!real) throw new Error(`no such registered tool: ${name}`);
  reg.register({ ...real, execute });
}

/** An execute stub that always resolves to `result`. */
/**
 * A stub tool body that also records the args it was called with.
 *
 * `seenArgs` is a plain array the test owns, so assertions read the
 * observable call rather than the spy's `.mock` internals — the spy's type is
 * a bare function signature with no `.mock` member, and asserting through a
 * mock's internals tests the mock rather than the gate.
 */
function stub(result: ToolResult = { ok: true, data: 'stubbed' }): Execute & {
  seenArgs: Array<Record<string, unknown>>;
} {
  const seenArgs: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (args: Record<string, unknown>) => {
    seenArgs.push(args);
    return result;
  }) as unknown as Execute & { seenArgs: Array<Record<string, unknown>> };
  fn.seenArgs = seenArgs;
  return fn;
}

/**
 * A fake renderer. `answer` runs for each `agent:confirm-required`; return
 * nothing from it to leave the request pending. `window: false` models an
 * unattended scheduled run with no window up.
 */
function fakeContext(opts: { answer?: (id: string) => void; window?: boolean } = {}): FakeWin {
  const sent: Array<{ channel: string; payload: WirePayload }> = [];
  const confirmIds: string[] = [];
  let destroyed = false;
  const hasWindow = opts.window !== false;

  const win = {
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, payload: WirePayload) => {
        sent.push({ channel, payload });
        if (channel === 'agent:confirm-required') {
          confirmIds.push(String(payload.id));
          opts.answer?.(String(payload.id));
        }
      },
    },
  };

  const context = {
    db: {} as AgentContext['db'],
    getWindow: () => (hasWindow ? (win as unknown as ReturnType<AgentContext['getWindow']>) : null),
    // sessionId omitted so the runner skips the session-store audit import.
  } as AgentContext;

  return { context, sent, confirmIds, destroy: () => { destroyed = true; } };
}

/** One model turn calling a single tool. */
function callOnce(name: string, args: Record<string, unknown> = {}): ModelCompletion {
  return { content: '', toolCalls: [{ id: `call-${name}`, name, arguments: args }] };
}

/**
 * A scripted `complete` — no model is ever contacted. Each queued completion is
 * returned in turn, then a final no-tool answer. Every round's messages are
 * kept so a test can read the tool result the runner fed back.
 */
function scriptedComplete(queue: ModelCompletion[]): ScriptedComplete {
  const rounds: RunnerMessage[][] = [];
  let i = 0;
  const fn = vi.fn(async (messages: RunnerMessage[]): Promise<ModelCompletion> => {
    rounds.push(messages.map((m) => ({ ...m })));
    if (i < queue.length) return queue[i++];
    return { content: 'final answer', toolCalls: [] };
  });
  return Object.assign(fn, { rounds }) as ScriptedComplete;
}

/** The parsed tool result the runner handed back to the model. */
function toolResult(scripts: ScriptedComplete, index = -1): ToolResult {
  const msgs = scripts.rounds.at(index) ?? [];
  const msg = [...msgs].reverse().find((m) => m.role === 'tool');
  if (!msg) throw new Error('no tool message was fed back to the model');
  // A tool turn is text; the `MessagePart[]` arm is for image-bearing user
  // turns and cannot occur here, so narrow rather than cast.
  if (typeof msg.content !== 'string') {
    throw new Error('tool message content should be a string');
  }
  return JSON.parse(msg.content) as ToolResult;
}

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Drive a fake-timer run forward past the confirm deadline without waiting five
 * real minutes. The gate only arms its timer once the promise chain has settled,
 * so flush microtasks before jumping the clock.
 */
async function expireConfirm(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 1);
}

/**
 * The Approval Queue status recorded for `id`, read out of the SQL the real
 * `recordApprovalDecision` binds. That write sits behind a lazy dynamic
 * import, so it lands a macrotask or more after the decision — this waits for
 * the write rather than asserting against a race.
 */
async function queueStatus(id: string): Promise<string> {
  let status = '';
  await vi.waitFor(() => {
    const decision = sqlLog.find((q) => /UPDATE approvals/i.test(q.sql) && q.params[2] === id);
    if (!decision) throw new Error('no approval decision recorded yet');
    status = String(decision.params[0]);
  });
  return status;
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmSilentTools = false; // the shipped default: silent runs ungated
  sqlLog.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. Explicit denial ──────────────────────────────────────────────────────

describe('sandbox gate — explicit denial', () => {
  it('never runs a real confirm tool the user declined, and reports the decline', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const { context } = fakeContext({ answer: (id) => { resolveConfirmation(id, false); } });
    const scripts = scriptedComplete([callOnce('messages_send', { to: 'a@b.c', body: 'hi' })]);

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'text Henry' }],
      complete: scripts,
    });

    expect(exec).not.toHaveBeenCalled();
    const result = toolResult(scripts);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/declin/i);
  });

  it('records the decline in the approval queue as "rejected"', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'repo_edit', exec);
    const { context, confirmIds } = fakeContext({ answer: (id) => { resolveConfirmation(id, false); } });

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'edit it' }],
      complete: scriptedComplete([callOnce('repo_edit', { path: 'a.ts' })]),
    });

    expect(exec).not.toHaveBeenCalled();
    // The durable Approval Queue must show this as a rejection, not a pending row.
    expect(await queueStatus(confirmIds[0])).toBe('rejected');
  });

  it('refuses a real confirm tool the user declines mid-turn, then approves the next one', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const answers = [false, true];
    const { context } = fakeContext({ answer: (id) => { resolveConfirmation(id, answers.shift() ?? false); } });

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send two things' }],
      complete: scriptedComplete([
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'messages_send', arguments: { to: 'a@b.c' } },
            { id: 'c2', name: 'messages_send', arguments: { to: 'd@e.f' } },
          ],
        },
      ]),
    });

    // Only the approved second call may reach the body — one refusal must not
    // carry over and unlock the next request in the same turn.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.seenArgs[0]).toMatchObject({ to: 'd@e.f' });
  });
});

// ── 2. No renderer to confirm → fail CLOSED ────────────────────────────────

describe('sandbox gate — unattended runs fail closed', () => {
  it('refuses a confirm tool when getWindow() returns null (7am briefing, no window)', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const { context, sent } = fakeContext({ window: false });

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send the 7am briefing' }],
      complete: scriptedComplete([callOnce('messages_send', { to: 'a@b.c', body: 'briefing' })]),
    });

    expect(exec).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.channel === 'agent:confirm-required')).toHaveLength(0);
  });

  it('refuses a confirm tool when the window is destroyed', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'plan_approve', exec);
    const win = fakeContext();
    win.destroy();

    await runToolConversation({
      registry: reg,
      context: win.context,
      messages: [{ role: 'user', content: 'approve the plan' }],
      complete: scriptedComplete([callOnce('plan_approve', { id: 'p1' })]),
    });

    expect(exec).not.toHaveBeenCalled();
    expect(win.sent.filter((s) => s.channel === 'agent:confirm-required')).toHaveLength(0);
  });
});

// ── 3. Timeout fails closed ────────────────────────────────────────────────

describe('sandbox gate — an unanswered confirmation times out closed', () => {
  it('does not execute a real confirm tool nobody answered, and marks it expired', async () => {
    vi.useFakeTimers();
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    // `answer` omitted entirely: the prompt is emitted and then ignored.
    const { context, confirmIds } = fakeContext();

    const pending = runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send it' }],
      complete: scriptedComplete([callOnce('messages_send', { to: 'a@b.c', body: 'hi' })]),
    });

    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
    expect(confirmIds).toHaveLength(1);
    // Still pending, one tick short of the deadline — and still not run.
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 10);
    expect(exec).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(exec).not.toHaveBeenCalled();
    // An unanswered prompt is recorded as expired, never silently dropped.
    expect(await queueStatus(confirmIds[0])).toBe('expired');
  });

  it('drops the pending entry on timeout, so a late approval is a no-op', async () => {
    vi.useFakeTimers();
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const { context, confirmIds } = fakeContext();

    const pending = runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send it' }],
      complete: scriptedComplete([callOnce('messages_send')]),
    });
    await expireConfirm();
    await pending;

    expect(exec).not.toHaveBeenCalled();
    // The renderer finally clicks — far too late. Must not resurrect the call.
    expect(resolveConfirmation(confirmIds[0], true)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

// ── 4. silent never escalates (policy switch off) ───────────────────────────

describe('sandbox gate — silent tier does not escalate on its own', () => {
  it('runs a silent tool immediately with no confirm request and no window', async () => {
    confirmSilentTools = false;
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'book_list', exec);
    // No window at all: a silent read must not need one.
    const { context, sent } = fakeContext({ window: false });

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'list the book' }],
      complete: scriptedComplete([callOnce('book_list')]),
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(sent.filter((s) => s.channel === 'agent:confirm-required')).toHaveLength(0);
  });

  it('a declined silent escalation (policy on) runs nothing — the tier cannot self-widen', async () => {
    confirmSilentTools = true;
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'book_list', exec);
    const { context, sent } = fakeContext({ answer: (id) => { resolveConfirmation(id, false); } });
    const scripts = scriptedComplete([callOnce('book_list')]);

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'list the book' }],
      complete: scripts,
    });

    expect(exec).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.channel === 'agent:confirm-required')).toHaveLength(1);
    expect(toolResult(scripts).ok).toBe(false);
  });

  it('fails closed for a silent tool under the escalated policy when there is no renderer', async () => {
    confirmSilentTools = true;
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'book_list', exec);
    const { context } = fakeContext({ window: false });

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'list the book' }],
      complete: scriptedComplete([callOnce('book_list')]),
    });

    expect(exec).not.toHaveBeenCalled();
  });
});

// ── 5. Notify tier never escalates, under EITHER policy state ──────────────

describe('sandbox gate — notify tier never escalates', () => {
  it('runs and toasts without a confirm request (policy off)', async () => {
    confirmSilentTools = false;
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'book_capture', exec);
    const { context, sent } = fakeContext();

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'save this' }],
      complete: scriptedComplete([callOnce('book_capture', { title: 'a thing' })]),
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(sent.filter((s) => s.channel === 'agent:tool-notify')).toHaveLength(1);
    expect(sent.filter((s) => s.channel === 'agent:confirm-required')).toHaveLength(0);
  });

  it('still never escalates when confirmSilentTools is on — that switch gates silent only', async () => {
    confirmSilentTools = true;
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'book_capture', exec);
    const { context, sent } = fakeContext();

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'save this' }],
      complete: scriptedComplete([callOnce('book_capture', { title: 'a thing' })]),
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(sent.filter((s) => s.channel === 'agent:tool-notify')).toHaveLength(1);
    expect(sent.filter((s) => s.channel === 'agent:confirm-required')).toHaveLength(0);
  });
});

// ── 6/7. Unresolvable and stale confirmation ids are no-ops ─────────────────

describe('sandbox gate — confirmation ids must match a live request', () => {
  it('resolveConfirmation on an unknown id returns false and runs nothing', () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);

    expect(resolveConfirmation('does-not-exist', true)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('a stale id cannot approve a real pending call', async () => {
    vi.useFakeTimers();
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const seen: string[] = [];
    const { context } = fakeContext({
      // The renderer replays an id from a previous turn instead of this one.
      answer: (id) => {
        seen.push(id);
        resolveConfirmation('stale-id-from-a-previous-turn', true);
      },
    });
    const scripts = scriptedComplete([callOnce('messages_send', { to: 'a@b.c' })]);

    const pending = runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send it' }],
      complete: scripts,
    });
    await expireConfirm();
    await pending;

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('stale-id-from-a-previous-turn');
    expect(exec).not.toHaveBeenCalled();
    const result = toolResult(scripts);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/declin/i);
  });

  it('a stale id cannot unlock two different calls in the same turn', async () => {
    vi.useFakeTimers();
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const ids: string[] = [];
    const { context } = fakeContext({
      answer: (id) => {
        ids.push(id);
        resolveConfirmation('stale-id-from-a-previous-turn', true);
      },
    });

    const pending = runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send two things' }],
      complete: scriptedComplete([
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'messages_send', arguments: { to: 'a@b.c' } },
            { id: 'c2', name: 'messages_send', arguments: { to: 'd@e.f' } },
          ],
        },
      ]),
    });
    // Two requests, each expiring on its own clock, and the second is only
    // created after the first has been refused — so each armed timer needs its
    // own jump. Drain a few deadlines unconditionally rather than guessing how
    // many are outstanding; a round that arms nothing advances harmlessly.
    for (let round = 0; round < 4; round++) await expireConfirm();
    await pending;

    // Two distinct requests, two distinct ids — one stale id reaches neither.
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('an already-consumed answer is not replayable', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const { context, confirmIds } = fakeContext({ answer: (id) => { resolveConfirmation(id, false); } });

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send it' }],
      complete: scriptedComplete([callOnce('messages_send')]),
    });

    expect(exec).not.toHaveBeenCalled();
    // Replaying the same id with the opposite answer must not throw, and must
    // not execute.
    expect(resolveConfirmation(confirmIds[0], true)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

// ── 8. Unknown tools ────────────────────────────────────────────────────────

describe('sandbox gate — unknown tool names', () => {
  it('errors out and runs nothing, even with the full real tool set loaded', async () => {
    const reg = realRegistry();
    const exec = stub();
    spyExecute(reg, 'messages_send', exec);
    const { context } = fakeContext({ answer: (id) => { resolveConfirmation(id, true); } });

    const scripts = scriptedComplete([
      callOnce('definitely_not_a_tool'),
      callOnce('messages_send', { to: 'a@b.c' }),
    ]);

    await runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scripts,
    });

    // Round 1 fed back the unknown-tool error; round 2 the real approved send.
    const first = toolResult(scripts, 1);
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/unknown tool/i);
    // The unknown name never reached a body; only the approved real call ran.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.seenArgs[0]).toMatchObject({ to: 'a@b.c' });
  });

  it('an unknown tool name never reaches any registered tool body', async () => {
    const reg = realRegistry();
    const probes: Execute[] = [];
    // Spy on several real tools at once; none may fire for a bogus name.
    for (const name of ['messages_send', 'repo_edit', 'plan_approve', 'file_write']) {
      const probe = stub();
      probes.push(probe);
      spyExecute(reg, name, probe);
    }

    await runToolConversation({
      registry: reg,
      context: fakeContext().context,
      messages: [{ role: 'user', content: 'go' }],
      complete: scriptedComplete([
        callOnce('messages_sendd'),
        callOnce('../../etc/passwd'),
        callOnce('__proto__'),
      ]),
    });

    for (const probe of probes) expect(probe).not.toHaveBeenCalled();
  });
});

// ── 9. Confirm-tier tools are never retried ────────────────────────────────

describe('sandbox gate — retry policy', () => {
  it('runs an approved confirm tool exactly once even when it fails retryably', async () => {
    vi.useFakeTimers();
    const reg = realRegistry();
    // A double-fired send is the hazard: one approval, one attempt, ever.
    const exec = stub({ ok: false, error: 'carrier rejected the message', retryable: true });
    spyExecute(reg, 'messages_send', exec);
    const { context } = fakeContext({ answer: (id) => { resolveConfirmation(id, true); } });

    const pending = runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'send it' }],
      complete: scriptedComplete([callOnce('messages_send', { to: 'a@b.c' })]),
    });

    // Far more wall-clock than the 1s + 2s backoff schedule needs. Had it
    // retried, those timers would have fired and the count would exceed one.
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('still retries a notify-tier tool that fails retryably (the contrast)', async () => {
    vi.useFakeTimers();
    confirmSilentTools = false;
    const reg = realRegistry();
    const exec = stub({ ok: false, error: 'database busy', retryable: true });
    spyExecute(reg, 'book_capture', exec);
    const { context } = fakeContext();

    const pending = runToolConversation({
      registry: reg,
      context,
      messages: [{ role: 'user', content: 'save this' }],
      complete: scriptedComplete([callOnce('book_capture', { title: 'a thing' })]),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(exec).toHaveBeenCalledTimes(3);
  });
});

// ── The two gates are indistinguishable to a caller ────────────────────────

describe('sandbox gate — a refused call looks the same either way', () => {
  it('a confirm-tier denial and a declined silent escalation return identical errors', async () => {
    confirmSilentTools = true;

    const confirmRun = realRegistry();
    const confirmExec = stub();
    spyExecute(confirmRun, 'messages_send', confirmExec);
    const confirmScripts = scriptedComplete([callOnce('messages_send', { to: 'a@b.c' })]);
    await runToolConversation({
      registry: confirmRun,
      context: fakeContext({ answer: (id) => { resolveConfirmation(id, false); } }).context,
      messages: [{ role: 'user', content: 'go' }],
      complete: confirmScripts,
    });

    const silentRun = realRegistry();
    const silentExec = stub();
    spyExecute(silentRun, 'book_list', silentExec);
    const silentScripts = scriptedComplete([callOnce('book_list')]);
    await runToolConversation({
      registry: silentRun,
      context: fakeContext({ answer: (id) => { resolveConfirmation(id, false); } }).context,
      messages: [{ role: 'user', content: 'go' }],
      complete: silentScripts,
    });

    expect(confirmExec).not.toHaveBeenCalled();
    expect(silentExec).not.toHaveBeenCalled();
    // A caller must not be able to branch on which gate refused.
    expect(toolResult(silentScripts).error).toBe(toolResult(confirmScripts).error);
  });
});