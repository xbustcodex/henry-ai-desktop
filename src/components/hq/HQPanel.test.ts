// @vitest-environment jsdom
/**
 * HQPanel — the shell auto-run whose refusal was swallowed.
 *
 * ## The regression
 *
 * `HQPanel` auto-executes the shell command Henry emits in a ```bash fence
 * through `computerRunShell(...).catch(() => {})`. `computer:runShell` is in
 * `SHELL_GATED_CHANNELS`, so with `confirmShell` on every one of those returned
 * `{ok:false, confirmationRequired:true}` — and the `.catch` turned a standing
 * safety refusal into silence. HQ looked like it had run the command.
 *
 * The same gate covers the manual Shell tab and the Automate buttons, both of
 * which discarded their results outright.
 *
 * ## Why this renders the panel
 *
 * A test on the approval helper would pass whether or not HQPanel ever called
 * it — which is precisely how `securityApproveChannel` came to have zero call
 * sites while the gate's own unit test stayed green. This mounts the panel,
 * types a command, and clicks the real dialog buttons.
 *
 * The chat auto-run path (`stream.onDone`) is not driven here: it needs the
 * full AI streaming stack, and it calls the same `runGatedShell` this file
 * exercises. What this file does assert is that a refusal is *visible*, which
 * is the half that was broken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import HQPanel from './HQPanel';
import {
  channelSchemas,
  confirmationRequired,
  consumeChannelApproval,
  payloadFingerprint,
  revokeChannelApprovals,
  sanitizePayload,
  armChannelApproval,
} from '../../../electron/ipc/validation';
import { __resetConfirmationStoreForTest } from '../computer/confirmationStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements neither of these, and HQPanel scrolls its chat and log panes.
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = () => {};

/** Commands the `computer:runShell` handler was actually allowed to receive. */
let ran: Array<{ command: string; timeout?: number }> = [];

beforeEach(() => {
  __resetConfirmationStoreForTest();
  revokeChannelApprovals();
  ran = [];

  (globalThis as unknown as { henryAPI: unknown }).henryAPI = {
    computerListApps: () => Promise.resolve([]),
    computerSystemStats: () => Promise.reject(new Error('unavailable in this harness')),
    computerSystemProcesses: () => Promise.resolve({ processes: [] }),
    computerListWindows: () => Promise.resolve([]),
    computerGetVolume: () => Promise.resolve({}),
    computerRunShell: (params: { command: string; timeout?: number }) => {
      const cleaned = channelSchemas['computer:runShell'].parse(params);
      if (!consumeChannelApproval('computer:runShell', payloadFingerprint([cleaned]))) {
        return Promise.resolve(confirmationRequired('computer:runShell'));
      }
      ran.push(cleaned);
      return Promise.resolve({ success: true, output: `ok:${cleaned.command}` });
    },
    securityApproveChannel: (channel: string, args: unknown[] = []) => {
      const normalised = args.map((a) => sanitizePayload(a));
      return Promise.resolve({ ok: armChannelApproval(channel, payloadFingerprint(normalised)), channel });
    },
  };
});

afterEach(() => {
  cleanup();
  __resetConfirmationStoreForTest();
  revokeChannelApprovals();
  delete (globalThis as unknown as { henryAPI?: unknown }).henryAPI;
});

async function openShellTab() {
  await act(async () => {
    render(createElement(HQPanel));
  });
  await act(async () => {
    fireEvent.click(screen.getByText('⌨ Shell'));
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText('Any shell command…'), {
      target: { value: 'rm -rf /tmp/x' },
    });
  });
  await act(async () => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const run = buttons.find((b) => /^\s*Run\s*$/i.test(b.textContent ?? ''));
    expect(run).toBeTruthy();
    run!.click();
  });
}

describe('HQPanel — the Shell tab is gated', () => {
  it('shows the exact command and refuses to run it until approved', async () => {
    await openShellTab();

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('rm -rf /tmp/x')).toBeTruthy();
    expect(ran).toHaveLength(0);

    await act(async () => {
      screen.getByText('Run it once').click();
    });
    await waitFor(() => expect(ran).toEqual([{ command: 'rm -rf /tmp/x', timeout: 30000 }]));
    await waitFor(() => expect(document.body.textContent).toContain('ok:rm -rf /tmp/x'));
  });

  it('reports a decline instead of swallowing it', async () => {
    // THE regression. The old code discarded the result entirely, so a standing
    // safety refusal produced no command, no output line and no message — HQ
    // looked like it had run something.
    await openShellTab();

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await act(async () => {
      screen.getByText('Cancel').click();
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(ran).toHaveLength(0);
    await waitFor(() => expect(document.body.textContent).toContain('Declined'));
  });
});