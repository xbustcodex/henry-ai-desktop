// @vitest-environment jsdom
/**
 * `GatedChannelHost` — the confirmation gate as a user actually meets it.
 *
 * ## Why this file exists at all
 *
 * The state this repo was in is the exact trap it has already fallen into once:
 * `consumeChannelApproval` was covered by a test that called
 * `armChannelApproval` directly and passed forever, while no user action in the
 * product could ever arm a grant. `securityApproveChannel` had ZERO call sites
 * in `src/`. HQ's shell auto-run and the printer's `M115`/`M105` probes were
 * silently dead, and one of them swallowed the refusal in `.catch(() => {})`.
 *
 * So nothing here touches `armChannelApproval`. Each test mounts the real
 * dialog, puts a small main-process stand-in behind `window.henryAPI`, and
 * clicks the buttons a user clicks:
 *
 *     panel → runGatedShell → computerRunShell → REFUSED
 *           → dialog appears showing the command
 *           → click "Run it once"
 *           → securityApproveChannel → computerRunShell → RUNS
 *
 * The stand-in is not a stub of the gate: it uses the real `channelSchemas`,
 * `sanitizePayload`, `payloadFingerprint`, `consumeChannelApproval`,
 * `armChannelApproval` and `confirmationRequired` from
 * `electron/ipc/validation.ts`, and `securityApproveChannel` sanitises and
 * fingerprints exactly as `electron/main.ts:1200` does. Change how the main
 * process fingerprints a payload and this file fails.
 *
 * See `gatedChannel.test.ts` for the argument-normalisation property itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import {
  channelSchemas,
  confirmationRequired,
  consumeChannelApproval,
  payloadFingerprint,
  revokeChannelApprovals,
  sanitizePayload,
  armChannelApproval,
} from '../../../electron/ipc/validation';
import GatedChannelHost, { runGatedShell } from './GatedChannelHost';
import { __resetConfirmationStoreForTest } from './confirmationStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Bridge {
  /** Commands the `computer:runShell` handler actually received. */
  ran: Array<{ command: string; timeout?: number }>;
  /** Argument lists handed to `securityApproveChannel`. */
  approvals: unknown[][];
  /** Refuse even when a matching grant exists — models a mid-flight change. */
  refuseEvenWhenArmed: boolean;
}

interface ShellResult {
  status: 'ran' | 'declined' | 'blocked';
  response?: { success: boolean; output: string };
  reason?: string;
}

let bridge: Bridge;

/** The exact cleanup `installIpcBoundary` performs before fingerprinting. */
function cleanArgs(channel: string, args: readonly unknown[]): unknown[] {
  const schema = channelSchemas[channel];
  if (Array.isArray(schema)) {
    return args.map((v, i) => (schema[i] ? schema[i].parse(v) : sanitizePayload(v)));
  }
  if (schema) return args.map((v, i) => (i === 0 ? schema.parse(v) : sanitizePayload(v)));
  return args.map((v) => sanitizePayload(v));
}

beforeEach(() => {
  __resetConfirmationStoreForTest();
  revokeChannelApprovals();
  bridge = { ran: [], approvals: [], refuseEvenWhenArmed: false };

  (globalThis as unknown as { henryAPI: unknown }).henryAPI = {
    computerRunShell: (params: { command: string; timeout?: number }) => {
      const fingerprint = payloadFingerprint(cleanArgs('computer:runShell', [params]));
      if (bridge.refuseEvenWhenArmed || !consumeChannelApproval('computer:runShell', fingerprint)) {
        return Promise.resolve(confirmationRequired('computer:runShell'));
      }
      bridge.ran.push(params);
      return Promise.resolve({ success: true, output: `ran: ${params.command}` });
    },
    // electron/main.ts:1200 — sanitise, fingerprint, arm.
    securityApproveChannel: (channel: string, args: unknown[] = []) => {
      const normalised = args.map((a) => sanitizePayload(a));
      bridge.approvals.push(args);
      return Promise.resolve({
        ok: armChannelApproval(channel, payloadFingerprint(normalised)),
        channel,
      });
    },
  };
});

afterEach(() => {
  cleanup();
  __resetConfirmationStoreForTest();
  revokeChannelApprovals();
  delete (globalThis as unknown as { henryAPI?: unknown }).henryAPI;
});

/**
 * Mount the dialog, fire a run, and wait for the refusal to put it on screen.
 *
 * Mounted per test rather than in `beforeEach`: a shared mount made each test
 * depend on the previous one's teardown, which is the kind of coupling that
 * turns a real regression into an unexplained failure.
 *
 * Returns the dialog's answer in a BOX. Returning the promise itself would make
 * this async function adopt it, so `await requestRun(...)` would block until
 * the user answered — which, in a test, means forever.
 */
async function requestRun(
  command: string,
  timeout?: number,
): Promise<{ pending: Promise<ShellResult> }> {
  // Any previous host goes first. Two live hosts both render the front of the
  // queue, so a second mount would duplicate the dialog rather than replace it.
  cleanup();
  await act(async () => {
    render(createElement(GatedChannelHost));
  });
  const pending = runGatedShell<{ success: boolean; output: string }>(
    timeout === undefined ? { command } : { command, timeout },
  ) as Promise<ShellResult>;
  await act(async () => {
    void pending;
  });
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  return { pending };
}

/** Click a dialog button and settle the answer it is holding. */
async function clickAndSettle(label: string, pending: Promise<ShellResult>): Promise<ShellResult> {
  let outcome!: ShellResult;
  await act(async () => {
    screen.getByText(label).click();
    outcome = await pending;
  });
  return outcome;
}

describe('the shell-confirmation gate, driven through the dialog', () => {
  it('refuses the command, shows it, and runs it only after the user approves', async () => {
    const { pending } = await requestRun('echo hello', 5000);

    expect(bridge.ran).toHaveLength(0);
    expect(bridge.approvals).toHaveLength(0);
    expect(screen.getByText('echo hello')).toBeTruthy();
    expect(screen.getByText(/Run a shell command/)).toBeTruthy();

    const outcome = await clickAndSettle('Run it once', pending);

    expect(outcome.status).toBe('ran');
    expect(bridge.ran).toHaveLength(1);
    expect(bridge.ran[0].command).toBe('echo hello');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs nothing at all when the user cancels', async () => {
    const { pending } = await requestRun('rm -rf /');

    expect((await clickAndSettle('Cancel', pending)).status).toBe('declined');
    expect(bridge.ran).toHaveLength(0);
    expect(bridge.approvals).toHaveLength(0);
  });

  it('leaves no armed grant behind when the dialog is unmounted mid-decision', async () => {
    const { pending } = await requestRun('rm -rf /');

    // Navigating away with the prompt open is a real user action. Unmounting
    // must resolve the prompt as a refusal, not strand it.
    let outcome!: ShellResult;
    await act(async () => {
      cleanup();
      outcome = await pending;
    });

    expect(outcome.status).toBe('declined');
    expect(bridge.approvals).toHaveLength(0);
    expect(bridge.ran).toHaveLength(0);

    // The decisive check: the same command on a fresh dialog is refused again,
    // so the abandoned prompt armed nothing.
    const later = (await requestRun('rm -rf /')).pending;
    expect((await clickAndSettle('Cancel', later)).status).toBe('declined');
    expect(bridge.ran).toHaveLength(0);
  });

  it('does not re-prompt after an approval the boundary refuses anyway', async () => {
    // One prompt, one grant, one retry. A second refusal is reported, not looped
    // on — otherwise a caller that keeps retrying can harvest approvals.
    bridge.refuseEvenWhenArmed = true;
    const { pending } = await requestRun('echo once');

    const outcome = await clickAndSettle('Run it once', pending);

    expect(outcome.status).toBe('blocked');
    expect(bridge.ran).toHaveLength(0);
    expect(bridge.approvals).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('binds an approval to one command and does not carry it to another', async () => {
    // Approve `ls -la`, then try `rm -rf /` on the same channel. A grant scoped
    // to the CHANNEL rather than the payload would run the second command with
    // no prompt at all — the exact failure `payloadFingerprint` exists to stop.
    const first = await clickAndSettle('Run it once', (await requestRun('ls -la')).pending);
    expect(first.status).toBe('ran');
    expect(bridge.ran.map((r) => r.command)).toEqual(['ls -la']);

    const { pending: second } = await requestRun('rm -rf /');
    expect(screen.getByText('rm -rf /')).toBeTruthy();

    expect((await clickAndSettle('Cancel', second)).status).toBe('declined');
    expect(bridge.ran).toHaveLength(1);
  });

  it('shows the command the boundary will actually run, not the raw request', async () => {
    // `computer:runShell`'s schema trims `command`, so the payload the boundary
    // fingerprints is trimmed. The dialog must show THAT — approving one string
    // and running a different one is consent for something nobody read.
    const { pending } = await requestRun('   sudo rm -rf /   ');
    expect(screen.getByText('sudo rm -rf /')).toBeTruthy();

    expect((await clickAndSettle('Run it once', pending)).status).toBe('ran');
    expect(bridge.ran[0].command).toBe('sudo rm -rf /');
  });

  it('still runs once when the caller passes a payload the boundary transforms', async () => {
    // `{command, timeout: undefined}` is the shape that produces an endless
    // re-prompt if the approved payload is not normalised: zod KEEPS the
    // explicitly-undefined key while `sanitizePayload` drops it.
    const { pending } = await requestRun('  echo trimmed  ', 5000);
    const outcome = await clickAndSettle('Run it once', pending);
    expect(outcome.status).toBe('ran');
    expect(bridge.ran).toHaveLength(1);
  });

  it('fails closed when the approval bridge is missing', async () => {
    // A renderer without `securityApproveChannel` must not read a refusal as
    // permission. Nothing runs, and the caller is told why.
    const api = (globalThis as unknown as { henryAPI: Record<string, unknown> }).henryAPI;
    delete api.securityApproveChannel;

    const outcome = await clickAndSettle('Run it once', (await requestRun('echo hi')).pending);

    expect(outcome.status).toBe('blocked');
    expect(bridge.ran).toHaveLength(0);
  });

  it('queues a second request instead of stranding it', async () => {
    // PrinterPanel sends a whole G-code file one line at a time. A single-slot
    // prompt would drop the second promise, hanging the panel forever.
    const first = (await requestRun('first')).pending;
    const second = runGatedShell<{ success: boolean; output: string }>({ command: 'second' }) as Promise<ShellResult>;

    expect((await clickAndSettle('Run it once', first)).status).toBe('ran');
    expect(bridge.ran.map((r) => r.command)).toEqual(['first']);

    // The second is on screen, not lost.
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    expect((await clickAndSettle('Run it once', second)).status).toBe('ran');
    expect(bridge.ran.map((r) => r.command)).toEqual(['first', 'second']);
  });
});

describe('the host with nothing pending', () => {
  it('renders nothing at all', async () => {
    await act(async () => {
      render(createElement(GatedChannelHost));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});