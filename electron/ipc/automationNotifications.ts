/**
 * Automation notifications with a working deep-link.
 *
 * Paid 1.7.0 (automation-notifications.ts) shows a native notification when a
 * run reaches a terminal state, decides whether to notify at all (all runs /
 * only failures / never), and routes a click on the notification into the exact
 * run. It also reads the OS notification permission into a 6-value enum so the
 * UI can tell "you turned them off in Henry" apart from "Windows is blocking
 * them", which are very different problems.
 *
 * Ours showed a notification and discarded the click. This adds the click
 * routing, the permission state, and the per-job notify mode.
 */
import { Notification, systemPreferences } from 'electron';
import type { BrowserWindow } from 'electron';

/** Mirrors the OS's own vocabulary so "denied by the OS" is distinguishable. */
export type NotifyPermission =
  | 'granted'
  | 'denied'
  | 'default'
  | 'provisional'
  | 'unknown'
  | 'unsupported';

export type NotifyMode = 'all' | 'failures' | 'none';

export interface OpenRequest {
  kind: 'automation-run';
  runId: number;
  title: string;
  at: number;
}

/**
 * Clicks that arrive while no window is listening yet. A notification can be
 * clicked before the renderer has finished booting, and losing the request
 * there is exactly the bug this replaces.
 */
const pending: OpenRequest[] = [];
let mainWindowGetter: (() => BrowserWindow | null) | null = null;

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  mainWindowGetter = fn;
}

export function notifyPermission(): NotifyPermission {
  if (!Notification.isSupported()) return 'unsupported';
  try {
    // getNotificationSettings exists at runtime but is missing from the
    // bundled types, so it is reached defensively rather than assumed.
    const getSettings = (systemPreferences as unknown as {
      getNotificationSettings?: () => { authStatus?: string };
    }).getNotificationSettings;
    const status = getSettings?.call(systemPreferences)?.authStatus;
    if (status === 'granted' || status === 'denied' || status === 'default' || status === 'provisional') {
      return status;
    }
  } catch {
    /* older Electron without getNotificationSettings */
  }
  return Notification.isSupported() ? 'default' : 'unsupported';
}

/**
 * Ask the OS for permission. Must be triggered by a user gesture on macOS, so
 * callers invoke it from a click handler.
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!Notification.isSupported()) return 'unsupported';
  try {
    const request = (Notification as unknown as {
      requestPermission?: () => Promise<string>;
    }).requestPermission;
    if (typeof request !== 'function') return notifyPermission();
    const result = await request.call(Notification);
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
  } catch {
    return notifyPermission();
  }
}

/** Take the oldest queued open request, if any. */
export function consumeOpenRequest(): OpenRequest | null {
  return pending.shift() ?? null;
}

export function peekOpenRequests(): OpenRequest[] {
  return [...pending];
}

function deliver(req: OpenRequest): void {
  const win = mainWindowGetter?.();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('notification:open-request', req);
    return;
  }
  // No window yet — hold it so the renderer can collect it on boot.
  pending.push(req);
}

/**
 * Show a native notification for a finished automation run.
 *
 * Returns false when nothing was shown, and why — a silent no-op here is how
 * users end up believing they have notifications turned on.
 */
export function notifyRunFinished(opts: {
  runId: number;
  title: string;
  success: boolean;
  detail?: string;
  mode?: NotifyMode;
}): { shown: boolean; reason?: string } {
  const mode = opts.mode ?? 'all';
  if (mode === 'none') return { shown: false, reason: 'notifications are off for this job' };
  if (mode === 'failures' && opts.success) return { shown: false, reason: 'this run succeeded' };

  if (!Notification.isSupported()) return { shown: false, reason: 'this system cannot show notifications' };
  const permission = notifyPermission();
  if (permission === 'denied') {
    return { shown: false, reason: 'the operating system is blocking notifications' };
  }

  const req: OpenRequest = {
    kind: 'automation-run',
    runId: opts.runId,
    title: opts.title,
    at: Date.now(),
  };

  try {
    const n = new Notification({
      title: opts.title,
      body: opts.detail ?? (opts.success ? 'Finished' : 'Failed'),
      silent: false,
    });
    // The whole point: a click has to land somewhere useful.
    n.on('click', () => deliver(req));
    n.show();
    return { shown: true };
  } catch (e) {
    return { shown: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Test seam: lets the click path be exercised without a real notification. */
export function simulateNotificationClick(req: OpenRequest): void {
  deliver(req);
}