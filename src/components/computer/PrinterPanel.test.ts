// @vitest-environment jsdom
/**
 * PrinterPanel — the printer probes that `confirmShell` killed.
 *
 * ## The regression
 *
 * `printer:sendGcode` and `printer:printGcode` are in `SHELL_GATED_CHANNELS`.
 * `connectToPrinter` fires `M115` (firmware) and `M105` (temperatures) the
 * moment a connection succeeds, and `refreshTemps` fires `M105` on demand.
 * Before the confirmation gate had a consumer, every one of those was refused
 * by the boundary and logged as a bare "Send failed." — so the printer looked
 * broken for a reason that had nothing to do with the printer, and the user
 * could not fix it by doing anything.
 *
 * ## Why this renders the panel
 *
 * A test on the approval helper alone would pass whether or not PrinterPanel
 * ever used it — which is exactly how `securityApproveChannel` ended up with
 * zero call sites while its own unit test stayed green. This mounts the real
 * panel, performs a real connect, and clicks the real dialog buttons.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import PrinterPanel from './PrinterPanel';
import {
  channelSchemas,
  confirmationRequired,
  consumeChannelApproval,
  payloadFingerprint,
  revokeChannelApprovals,
  sanitizePayload,
  armChannelApproval,
} from '../../../electron/ipc/validation';
import { __resetConfirmationStoreForTest } from './confirmationStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every line the printer handler was actually allowed to receive. */
let sent: string[] = [];

beforeEach(() => {
  __resetConfirmationStoreForTest();
  revokeChannelApprovals();
  sent = [];

  (globalThis as unknown as { henryAPI: unknown }).henryAPI = {
    onPrinterData: () => () => {},
    printerCheckDeps: () => Promise.resolve({ available: true }),
    printerListPorts: () =>
      Promise.resolve({ success: true, ports: [{ device: '/dev/ttyUSB0', description: 'USB Serial' }] }),
    printerConnect: () => Promise.resolve({ success: true }),
    printerDisconnect: () => Promise.resolve({ success: true }),
    printerSendGcode: (command: string) => {
      // The real boundary: schema-validate, fingerprint, spend the grant.
      const cleaned = channelSchemas['printer:sendGcode'].parse(command);
      if (!consumeChannelApproval('printer:sendGcode', payloadFingerprint([cleaned]))) {
        return Promise.resolve(confirmationRequired('printer:sendGcode'));
      }
      sent.push(cleaned);
      return Promise.resolve({ success: true, sent: cleaned });
    },
    securityApproveChannel: (channel: string, args: unknown[] = []) => {
      // electron/main.ts:1200 — sanitise, fingerprint, arm.
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

async function connect() {
  await act(async () => {
    render(createElement(PrinterPanel));
  });
  await waitFor(() => expect(screen.getByText('/dev/ttyUSB0')).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByText('/dev/ttyUSB0'));
  });
  await act(async () => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const target = buttons.find((b) => /connect/i.test(b.textContent ?? ''));
    expect(target).toBeTruthy();
    target!.click();
  });
}

describe('PrinterPanel — connecting probes the printer', () => {
  it('asks before each of M115 and M105, then sends both', async () => {
    await connect();

    // The first probe prompts, showing the real G-code.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('M115')).toBeTruthy();
    expect(sent).toHaveLength(0);

    await act(async () => {
      screen.getByText('Run it once').click();
    });
    await waitFor(() => expect(sent).toEqual(['M115']));

    // The second probe gets its own prompt rather than being dropped.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('M105')).toBeTruthy();

    await act(async () => {
      screen.getByText('Run it once').click();
    });
    await waitFor(() => expect(sent).toEqual(['M115', 'M105']));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('sends nothing at all when the probes are declined', async () => {
    await connect();

    // Each G-code line is its own confirmation — declining `M115` must not
    // wave `M105` through, so the second prompt appears too.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await act(async () => {
      screen.getByText('Cancel').click();
    });
    await waitFor(() => expect(screen.getByText('M105')).toBeTruthy());
    await act(async () => {
      screen.getByText('Cancel').click();
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toHaveLength(0);

    // And the user is told, rather than seeing a silent "Send failed." The
    // declined lines land in the printer console, which is where every other
    // printer message goes.
    await act(async () => {
      fireEvent.click(screen.getByText('💻 Console'));
    });
    await waitFor(() => expect(document.body.textContent).toContain('you declined'));
  });
});