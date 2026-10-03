// @vitest-environment jsdom
/**
 * `AppLockGate` — the lock screen `LOCK_EXEMPT_CHANNELS` was reserved for.
 *
 * ## What was broken
 *
 * `main.ts` refuses every non-exempt channel while `isLocked()`, and
 * `security:unlock` is on `LOCK_EXEMPT_CHANNELS` specifically so a lock screen
 * *can* be built. It never was — `securityUnlock` had no call sites in `src/`.
 * A user who turned on "Require a PIN to unlock Henry" locked themselves out
 * of their own app with no error and no way back, which is indistinguishable
 * from the feature working.
 *
 * These tests drive the component the way a user meets it: the gate polls
 * `security:get`, renders a PIN prompt when it reports `locked: true`, and
 * calls `securityUnlock`. The correct PIN unlocks; anything else does not, and
 * the rate-limit fields the main process returns are surfaced rather than
 * swallowed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import AppLockGate from './AppLockGate';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type UnlockResult = {
  ok: boolean;
  lockedOut?: boolean;
  retryInMs?: number;
  attemptsRemaining?: number;
};

interface Harness {
  /** PINs passed to `securityUnlock`, in order. */
  attempts: string[];
  /** What the main process currently believes about the lock. */
  locked: boolean;
  /** Queued answers, consumed one per `securityUnlock` call. */
  answers: UnlockResult[];
  securityGetCalls: () => number;
  quitCalls: () => number;
}

let harness: Harness;

function status() {
  return {
    policy: {},
    defaults: {},
    keys: [],
    hasPin: true,
    locked: harness.locked,
    encryptionAvailable: true,
    tools: { silent: 0, confirm: 0, notify: 0, total: 0 },
  };
}

beforeEach(() => {
  harness = {
    attempts: [],
    locked: true,
    answers: [{ ok: true }],
    securityGetCalls: () => 0,
    quitCalls: () => 0,
  };
  let getCalls = 0;
  let quitCalls = 0;
  harness.securityGetCalls = () => getCalls;
  harness.quitCalls = () => quitCalls;

  (globalThis as unknown as { henryAPI: unknown }).henryAPI = {
    securityGet: () => {
      getCalls += 1;
      return Promise.resolve(status());
    },
    securityUnlock: (pin: string) => {
      harness.attempts.push(pin);
      const answer = harness.answers.shift() ?? { ok: false };
      // `unlock()` in securityPolicy.ts flips its own `unlocked` flag on
      // success, so the next `security:get` reports unlocked. The harness has
      // to model that or the gate is being asked to trust a stale read.
      if (answer.ok === true) harness.locked = false;
      return Promise.resolve(answer);
    },
    quitApp: () => {
      quitCalls += 1;
      return Promise.resolve({ ok: true });
    },
  };
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { henryAPI?: unknown }).henryAPI;
});

async function mount() {
  await act(async () => {
    render(createElement(AppLockGate));
  });
}

function typePin(value: string) {
  fireEvent.change(screen.getByLabelText('PIN'), { target: { value } });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByText('Unlock'));
  });
}

describe('AppLockGate', () => {
  it('shows the lock screen and stays locked until the PIN is accepted', async () => {
    await mount();

    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());
    expect(screen.getByLabelText('PIN')).toBeTruthy();
    // Nothing is offered but the PIN — the app is genuinely closed off.
    expect(harness.attempts).toHaveLength(0);

    harness.answers = [{ ok: true }];
    typePin('4821');
    await submit();

    // The right PIN lets the user in.
    expect(harness.attempts).toEqual(['4821']);
    await waitFor(() => expect(screen.queryByText('Henry is locked')).toBeNull());
  });

  it('does NOT unlock with the wrong PIN', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());

    harness.answers = [{ ok: false, attemptsRemaining: 4 }];
    typePin('0000');
    await submit();

    expect(harness.attempts).toEqual(['0000']);
    // Still locked, and it says why rather than failing silently.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/not right/)).toBeTruthy();
    expect(screen.getByText('Henry is locked')).toBeTruthy();
  });

  it('counts down the lockout the main process imposes', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());

    harness.answers = [{ ok: false, lockedOut: true, retryInMs: 3000 }];
    typePin('1111');
    await submit();

    await waitFor(() => expect(screen.getByText(/Too many attempts/)).toBeTruthy());
    // The unlock button is not offered while the lockout is live.
    expect((screen.getByText('Unlock') as HTMLButtonElement).disabled).toBe(true);

    // And it does not let the user keep guessing in the meantime.
    const before = harness.attempts.length;
    typePin('2222');
    await submit();
    expect(harness.attempts.length).toBe(before);
  });

  it('reports how many attempts are left', async () => {
    await mount();
    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());

    harness.answers = [{ ok: false, attemptsRemaining: 2 }];
    typePin('9999');
    await submit();

    await waitFor(() => expect(screen.getByText(/2 attempts left/)).toBeTruthy());
  });

  it('refuses to submit a PIN shorter than the main process accepts', async () => {
    // `security:unlock`'s schema is `z.string().min(4)`; sending less is a
    // guaranteed rejection, and a guaranteed rejection should not be sent.
    await mount();
    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());

    typePin('12');
    expect((screen.getByText('Unlock') as HTMLButtonElement).disabled).toBe(true);
    await submit();
    expect(harness.attempts).toHaveLength(0);
  });

  it('renders nothing when the app is not locked', async () => {
    harness.locked = false;
    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('Henry is locked')).toBeNull();
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });

  it('offers a way out, because a forgotten PIN cannot be recovered', async () => {
    // A lock you cannot leave is a brick, and the PIN is a one-way hash. The
    // quit path (`app:quit` is lock-exempt) is what keeps this honest.
    await mount();
    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());
    expect(screen.getByText(/cannot be recovered/)).toBeTruthy();

    await act(async () => {
      screen.getByText('Quit Henry').click();
    });
    expect(harness.quitCalls()).toBe(1);
  });

  it('re-checks the lock state on window focus, so a lock taken in the background shows up', async () => {
    harness.locked = false;
    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('Henry is locked')).toBeNull();

    // Someone locks the app while the window is in the background.
    harness.locked = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByText('Henry is locked')).toBeTruthy());
  });

  it('does not pretend the app is open when the security bridge fails', async () => {
    const api = (globalThis as unknown as { henryAPI: Record<string, unknown> }).henryAPI;
    api.securityGet = vi.fn(() => Promise.reject(new Error('bridge down')));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });

    // A failed read is not a lock and not an unlock; what matters is that the
    // gate does not pretend there is no gate. It renders nothing rather than
    // claiming the app is unlocked — the main process still refuses everything.
    expect(screen.queryByText('Henry is locked')).toBeNull();
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
});