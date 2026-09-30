/**
 * Linux session-type detection.
 *
 * `XDG_SESSION_TYPE` is frequently unset (it is absent on this machine, and on
 * WSLg / GNOME-on-Xwayland setups generally). Falling straight through to
 * "not Wayland" then picks X11 tools — which work here only because XWayland
 * happens to be present, and silently fail on a native Wayland session.
 *
 * Detection order: explicit XDG_SESSION_TYPE, then a real WAYLAND_DISPLAY,
 * then XDG_CURRENT_DESKTOP, then whether DISPLAY exists at all.
 */

export type LinuxSessionType = 'wayland' | 'x11' | 'unknown';

export function detectLinuxSession(env: NodeJS.ProcessEnv = process.env): LinuxSessionType {
  const declared = (env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  if (declared === 'wayland' || declared === 'x11') return declared;

  // A set WAYLAND_DISPLAY is the strongest available signal.
  if ((env.WAYLAND_DISPLAY || '').trim()) return 'wayland';

  const desktop = (env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (desktop.includes('wayland')) return 'wayland';

  if ((env.DISPLAY || '').trim()) return 'x11';
  return 'unknown';
}

/** True when this is a Wayland session we should not expect X11 tools to work on. */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectLinuxSession(env) === 'wayland';
}
