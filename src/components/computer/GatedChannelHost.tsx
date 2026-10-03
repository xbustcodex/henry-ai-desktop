/**
 * GatedChannelHost — the dialog the shell-confirmation gate was missing, plus
 * the one function panels call instead of invoking a gated channel directly.
 *
 * ## What this fixes
 *
 * Before this existed, `securityApproveChannel` had zero call sites in `src/`.
 * With `confirmShell` on (the shipped default for the printer probes and for
 * HQ's auto-run), every gated invoke returned
 * `{ok:false, confirmationRequired:true}` and the callers had no way to grant
 * it: HQPanel swallowed it in `.catch(() => {})`, PrinterPanel logged a bare
 * "Send failed." The gate was closed with no key in anyone's hand.
 *
 * ## The shape
 *
 * `runGated` is the entry point. It refuses to do anything for a channel that
 * is not in the gate list, so a caller cannot arm a grant by accident, and it
 * performs exactly one prompt and at most one retry. The security reasoning —
 * why the arguments must be normalised, and why a second refusal must not
 * re-arm — lives in `./gatedChannel.ts`, which has no React in it and is
 * tested without a DOM.
 */
import { useEffect, useState } from 'react';
import {
  isGatedChannel,
  runGatedChannel,
  type GatedDescription,
  type GatedOutcome,
  type GatedRequest,
} from './gatedChannel';
import {
  answerConfirmation,
  currentConfirmation,
  enqueueConfirmation,
  retainHost,
  subscribeToConfirmations,
} from './confirmationStore';

/**
 * Ask the user, showing exactly what will run.
 *
 * `description.summary` is the command or payload itself, not a paraphrase —
 * consent that does not describe what actually executes is not consent.
 */
async function ask(description: GatedDescription, channel: string): Promise<boolean> {
  return enqueueConfirmation({
    channel,
    title: description.title,
    summary: description.summary,
    detail: description.detail,
  });
}

/**
 * Returns a discriminated outcome rather than the channel's raw response so a
 * caller cannot mistake "the user said no" for "the command returned no
 * output". Callers that ignore the outcome still run the command exactly once.
 */
export async function runGated<T>(request: GatedRequest): Promise<GatedOutcome<T>> {
  const api = window.henryAPI;
  const invokeBridge: BridgeInvoker | undefined = BRIDGE_INVOKERS[request.channel];

  if (!invokeBridge) {
    return { status: 'blocked', reason: `${request.channel} has no renderer bridge.` };
  }
  const bridge: unknown = api[invokeBridge.key];
  if (typeof bridge !== 'function') {
    return { status: 'blocked', reason: `The ${request.channel} bridge is not available.` };
  }

  return runGatedChannel<T>(
    {
      // `pass` re-shapes the normalised argument list into exactly what the
      // preload method forwards to `ipcRenderer.invoke`. The normalised array
      // is the single source of truth — `runGatedChannel` passes the very same
      // one to `securityApproveChannel` — so the approved payload and the
      // invoked payload cannot drift apart.
      invoke: (channel, args) => invokeBridge.pass(api, args),
      approve: async (channel, args) => {
        if (typeof api.securityApproveChannel !== 'function') {
          // No approval surface means no approval. Failing closed here is the
          // whole point: a missing bridge must not read as consent.
          return { ok: false, error: 'unavailable' };
        }
        return api.securityApproveChannel(channel, [...args]);
      },
      ask,
    },
    request,
  );
}

type HenryBridge = NonNullable<Window['henryAPI']>;

interface BridgeInvoker {
  key: keyof HenryBridge;
  pass: (api: HenryBridge, args: readonly unknown[]) => Promise<unknown>;
}

/**
 * Which preload method carries each gated channel, and how it re-shapes the
 * argument list on the way to `ipcRenderer.invoke`.
 *
 * The preload exposes typed methods (`computerRunShell`, `printerSendGcode`)
 * rather than a generic `invoke`, so the mapping has to be written down
 * somewhere. Putting it here — one table, beside the flow that depends on it —
 * means a channel added to `SHELL_GATED_CHANNELS` without a bridge entry fails
 * closed with a readable reason instead of silently doing nothing.
 */
const BRIDGE_INVOKERS: Readonly<Record<string, BridgeInvoker>> = {
  'computer:runShell': {
    key: 'computerRunShell',
    pass: (api, args) => api.computerRunShell(args[0] as { command: string; timeout?: number }),
  },
  'computer:osascript': {
    key: 'computerOsascript',
    pass: (api, args) => api.computerOsascript(args[0] as string),
  },
  'terminal:exec': {
    key: 'execTerminal',
    pass: (api, args) => api.execTerminal(args[0] as Parameters<HenryBridge['execTerminal']>[0]),
  },
  'printer:sendGcode': {
    key: 'printerSendGcode',
    pass: (api, args) => api.printerSendGcode(args[0] as string),
  },
  'printer:printGcode': {
    key: 'printerPrintGcode',
    pass: (api, args) => api.printerPrintGcode(args[0] as string),
  },
};

/** Convenience wrappers so call sites read as what they do. */
export async function runGatedShell<T>(
  params: { command: string; timeout?: number },
  summary?: string,
): Promise<GatedOutcome<T>> {
  return runGated<T>({ channel: 'computer:runShell', args: [{ ...params }], summary });
}

export async function runGatedGcode<T>(command: string): Promise<GatedOutcome<T>> {
  return runGated<T>({ channel: 'printer:sendGcode', args: [command] });
}

export async function runGatedPrint<T>(gcode: string): Promise<GatedOutcome<T>> {
  return runGated<T>({ channel: 'printer:printGcode', args: [gcode] });
}

/** Exported for the dialog's own guard and for tests. */
export { isGatedChannel };

/**
 * Renders one pending confirmation at a time.
 *
 * Mount it once per panel that can raise a request. Mounting it more than once
 * is safe — duplicate hosts show the same dialog — but the store reference-
 * counts them so an unmount only cancels the queue when the last one goes.
 */
export default function GatedChannelHost() {
  const [current, setCurrent] = useState(currentConfirmation());

  useEffect(() => {
    setCurrent(currentConfirmation());
    const unsubscribe = subscribeToConfirmations(() => setCurrent(currentConfirmation()));
    const release = retainHost();
    return () => {
      unsubscribe();
      release();
    };
  }, []);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gated-confirm-title"
    >
      <div className="w-full max-w-xl rounded-xl border border-henry-border/40 bg-henry-bg shadow-2xl p-5 text-henry-text">
        <div className="flex items-center gap-2 mb-1">
          <span aria-hidden="true">🔐</span>
          <h2 id="gated-confirm-title" className="text-sm font-semibold">
            {current.title}
          </h2>
        </div>
        <p className="text-xs text-henry-text-muted leading-relaxed mb-3">
          Your security settings ask Henry to check with you before this runs. This is the exact
          thing that will happen if you allow it — once.
        </p>

        <pre className="mb-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-henry-border/40 bg-black/40 px-3 py-2 text-[12px] leading-relaxed font-mono">
          {current.summary}
        </pre>

        {current.detail && (
          <div className="mb-3 rounded-lg border border-henry-border/30 bg-henry-surface/30 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-henry-text-muted mb-1">
              Other arguments
            </div>
            <pre className="whitespace-pre-wrap break-words text-[11px] text-henry-text-dim font-mono">
              {current.detail}
            </pre>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => answerConfirmation(current.id, false)}
            className="px-4 py-1.5 text-xs rounded-lg border border-henry-border/50 text-henry-text-muted hover:text-henry-text hover:border-henry-border transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => answerConfirmation(current.id, true)}
            className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 transition-colors"
          >
            Run it once
          </button>
        </div>
      </div>
    </div>
  );
}