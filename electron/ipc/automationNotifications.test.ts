/**
 * The click has to land somewhere. Before this, a finished routine produced a
 * notification that could not be clicked into anything, so "show me the run"
 * did not exist.
 *
 * Tested here because it is pure routing logic and the failure mode was
 * silent: a notification that shows and then goes nowhere looks exactly like a
 * working one until you click it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// electron is not available in the unit environment; the module reaches it
// defensively for exactly this reason, so a minimal stand-in is enough.
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return true; }
    static requestPermission() { return Promise.resolve('granted'); }
    on(_e: string, _cb: () => void) { /* click wiring exercised via simulateNotificationClick */ }
    show() { /* no-op */ }
  },
  systemPreferences: {
    getNotificationSettings: () => ({ authStatus: 'granted' }),
  },
}));

import {
  notifyPermission,
  requestNotifyPermission,
  consumeOpenRequest,
  peekOpenRequests,
  notifyRunFinished,
  simulateNotificationClick,
  setMainWindowGetter,
  type OpenRequest,
} from './automationNotifications';

let sent: OpenRequest[] = [];
let focused = 0;

beforeEach(() => {
  sent = [];
  focused = 0;
  setMainWindowGetter(() => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => { focused++; },
    show: () => { focused++; },
    focus: () => { focused++; },
    webContents: { send: (_ch: string, req: OpenRequest) => sent.push(req) },
  } as never));
  // Drain anything a previous test left queued.
  while (consumeOpenRequest()) { /* drain */ }
});

describe('notification permission', () => {
  it('reports the OS auth status rather than a bare boolean', () => {
    expect(notifyPermission()).toBe('granted');
  });

  it('can ask for permission', async () => {
    expect(await requestNotifyPermission()).toBe('granted');
  });
});

describe('automation run notification', () => {
  it('shows for a successful run by default', () => {
    const r = notifyRunFinished({ runId: 7, title: 'Daily digest', success: true });
    expect(r.shown).toBe(true);
  });

  it('suppresses successes in failures-only mode, with a reason', () => {
    const r = notifyRunFinished({ runId: 7, title: 'Daily digest', success: true, mode: 'failures' });
    expect(r.shown).toBe(false);
    expect(r.reason).toContain('succeeded');
  });

  it('still notifies failures in failures-only mode', () => {
    expect(notifyRunFinished({ runId: 7, title: 'x', success: false, mode: 'failures' }).shown).toBe(true);
  });

  it('says why it stayed quiet when set to none', () => {
    const r = notifyRunFinished({ runId: 7, title: 'x', success: false, mode: 'none' });
    expect(r.shown).toBe(false);
    expect(r.reason).toContain('off for this job');
  });
});

describe('click routing — the part that did not exist before', () => {
  it('routes a click to the exact run', () => {
    simulateNotificationClick({ kind: 'automation-run', runId: 42, title: 'Nightly build', at: Date.now() });
    expect(sent).toHaveLength(1);
    expect(sent[0].runId).toBe(42);
    expect(sent[0].kind).toBe('automation-run');
  });

  it('brings the window forward', () => {
    simulateNotificationClick({ kind: 'automation-run', runId: 1, title: 't', at: Date.now() });
    expect(focused).toBeGreaterThan(0);
  });

  it('queues the request when no window exists yet, instead of losing it', () => {
    setMainWindowGetter(() => null);
    simulateNotificationClick({ kind: 'automation-run', runId: 99, title: 'early click', at: Date.now() });
    expect(peekOpenRequests()).toHaveLength(1);

    // …and the renderer can collect it on boot
    setMainWindowGetter(() => ({
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      show: () => {},
      focus: () => {},
      webContents: { send: () => {} },
    } as never));
    const got = consumeOpenRequest();
    expect(got?.runId).toBe(99);
    expect(peekOpenRequests()).toHaveLength(0);
  });

  it('consume returns null when there is nothing pending', () => {
    expect(consumeOpenRequest()).toBeNull();
  });

  it('preserves order across several clicks', () => {
    setMainWindowGetter(() => null);
    for (const id of [1, 2, 3]) {
      simulateNotificationClick({ kind: 'automation-run', runId: id, title: `r${id}`, at: Date.now() });
    }
    expect(consumeOpenRequest()?.runId).toBe(1);
    expect(consumeOpenRequest()?.runId).toBe(2);
    expect(consumeOpenRequest()?.runId).toBe(3);
    expect(consumeOpenRequest()).toBeNull();
  });
});