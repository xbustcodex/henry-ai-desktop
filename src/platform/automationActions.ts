/**
 * The real action set behind Henry's "One-click Automations".
 *
 * Parity row 7.10. The HQ Automate tab advertises ten actions per platform —
 * Mute, Unmute, Sleep, Screenshot, Empty Trash, Clear Clipboard, Restart
 * Shell, Show IP, Lock Screen and Network info — and implemented every one of
 * them as a raw shell string assembled in the renderer and fired at
 * `computer:runShell`. That is three problems in one: the UI owned the command
 * (so the command could not be validated anywhere central), a scheduled task
 * ran the same strings with no classifier in front of them, and several of the
 * advertised commands were broken on Windows (`curl` is not present on a stock
 * install, and `bmp.Save('~/Desktop/…')` wrote a literal directory named `~`).
 *
 * This module is the single catalogue of those actions. Each one declares what
 * it does, whether it mutates the machine, and the exact argv it runs per
 * platform. `buildActionPlan` is pure, so the argv can be asserted in a test
 * without a desktop — and no action is ever a shell string.
 *
 * SAFETY
 * ------
 * `mutatesSystem` is the gate. Sleeping, locking, emptying the recycle bin,
 * restarting the shell and muting all change the user's machine, so they are
 * `confirm` tier: the caller must pass `confirmed: true`, which the IPC layer
 * only does after the user has actually agreed. Reads (Show IP, Network info)
 * and local, reversible actions are `silent`.
 *
 * WINDOWS
 * -------
 * No action pipes through a Unix tool. `ipconfig /all` is parsed in JavaScript,
 * `where` replaces `which`, and the recycle bin is emptied with the built-in
 * `Clear-RecycleBin` rather than a shell loop. The public-IP lookup uses Node's
 * `https` directly instead of `curl`, which does not exist on Windows.
 */

import os from 'os';

import type { FilePlatform } from './fileOps';

export type ActionTier = 'silent' | 'notify' | 'confirm';

/**
 * Actions whose work happens inside Electron rather than in a child process.
 * They are named here so the catalogue stays the single list.
 */
export type BuiltinAction = 'screenshot' | 'clearClipboard' | 'showIp' | 'muteAudio';

/** A runnable command. argv only — never a shell string. */
export interface ActionPlan {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * `silent` — nothing is printed.
   * `stdout` — stdout is the useful result.
   */
  capture: 'silent' | 'stdout';
}

export interface AutomationActionDef {
  id: string;
  label: string;
  description: string;
  tier: ActionTier;
  /** True when running this changes the user's machine. */
  mutatesSystem: boolean;
  /** True when the platform has no real implementation. */
  mutatesVolume?: boolean;
  builtin?: BuiltinAction;
  /** argv per platform. Absent platform = not available there. */
  plans: Partial<Record<FilePlatform, ActionPlan>>;
  /** Why a platform is unsupported, for the UI to show honestly. */
  unavailable?: Partial<Record<FilePlatform, string>>;
}

/**
 * Where a capture is written, resolved by the caller so it stays confined.
 *
 * Joined with the *target* platform's separator: on Windows `path.join`
 * would mix `C:\Users\b` with `/Pictures`.
 */
export function screenshotDirectory(home: string, platform: FilePlatform): string {
  const sep = platform === 'win32' ? '\\' : '/';
  if (platform === 'darwin') return `${home}${sep}Desktop`;
  if (platform === 'win32') return `${home}${sep}Pictures${sep}Screenshots`;
  return `${home}${sep}Pictures`;
}

/**
 * A timestamp safe in a filename on all three platforms. The Windows UI used
 * `$(date +%Y%m%d_%H%M%S)` inside a PowerShell string, where `$(...)` is not
 * command substitution at all — it typed a literal `~` and a literal `$`.
 */
export function timestampSlug(at: Date = new Date()): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

export const AUTOMATION_ACTIONS: readonly AutomationActionDef[] = [
  {
    id: 'mute',
    label: 'Mute audio',
    description: 'Mutes the default output device.',
    tier: 'confirm',
    mutatesSystem: true,
    builtin: 'muteAudio',
    plans: {
      darwin: { cmd: 'osascript', args: ['-e', 'set volume output muted true'], capture: 'silent' },
      linux: { cmd: 'pactl', args: ['set-sink-mute', '@DEFAULT_SINK@', '1'], capture: 'silent' },
    },
    unavailable: { win32: 'Windows has no scripting mute; use the volume key' },
  },
  {
    id: 'unmute',
    label: 'Unmute audio',
    description: 'Unmutes the default output device.',
    tier: 'confirm',
    mutatesSystem: true,
    builtin: 'muteAudio',
    plans: {
      darwin: { cmd: 'osascript', args: ['-e', 'set volume output muted false'], capture: 'silent' },
      linux: { cmd: 'pactl', args: ['set-sink-mute', '@DEFAULT_SINK@', '0'], capture: 'silent' },
    },
    unavailable: { win32: 'Windows has no scripting mute; use the volume key' },
  },
  {
    id: 'sleep',
    label: 'Sleep now',
    description: 'Suspends the machine. Everything open is kept.',
    tier: 'confirm',
    mutatesSystem: true,
    plans: {
      darwin: { cmd: 'pmset', args: ['sleepnow'], capture: 'silent' },
      linux: { cmd: 'systemctl', args: ['suspend'], capture: 'silent' },
      win32: { cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'], capture: 'silent' },
    },
  },
  {
    id: 'screenshot',
    label: 'Screenshot',
    description: 'Captures the screen into your pictures folder and reports where it went.',
    tier: 'silent',
    mutatesSystem: false,
    builtin: 'screenshot',
    plans: {},
  },
  {
    id: 'emptyTrash',
    label: 'Empty trash',
    description: 'Permanently removes everything in the trash or recycle bin.',
    tier: 'confirm',
    mutatesSystem: true,
    plans: {
      darwin: { cmd: 'osascript', args: ['-e', 'tell application "Finder" to empty trash'], capture: 'silent' },
      linux: { cmd: 'gio', args: ['trash', '--empty'], capture: 'silent' },
      // Clear-RecycleBin ships with Windows PowerShell 5. The previous version
      // walked Shell.Application's namespace and called InvokeVerb('Delete'),
      // which silently skips anything with a confirmation prompt.
      win32: {
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction Stop'],
        capture: 'silent',
      },
    },
    unavailable: { linux: 'gio (GLib) is not installed' },
  },
  {
    id: 'clearClipboard',
    label: 'Clear clipboard',
    description: 'Empties the clipboard.',
    tier: 'notify',
    mutatesSystem: false,
    builtin: 'clearClipboard',
    plans: {},
  },
  {
    id: 'restartShell',
    label: 'Restart desktop shell',
    description: 'Restarts the window manager. Open windows stay open; the shell flickers.',
    tier: 'confirm',
    mutatesSystem: true,
    plans: {
      darwin: { cmd: 'killall', args: ['Dock'], capture: 'silent' },
      linux: { cmd: 'systemctl', args: ['--user', 'restart', 'graphical-session.target'], capture: 'silent' },
      win32: { cmd: 'taskkill', args: ['/f', '/im', 'explorer.exe'], capture: 'silent' },
    },
  },
  {
    id: 'showIp',
    label: 'Show IP address',
    description: 'Reports this machine’s addresses. Local only unless a public lookup is requested.',
    tier: 'silent',
    mutatesSystem: false,
    builtin: 'showIp',
    plans: {},
  },
  {
    id: 'lockScreen',
    label: 'Lock screen',
    description: 'Locks the session. You will need your password to come back.',
    tier: 'confirm',
    mutatesSystem: true,
    plans: {
      darwin: {
        cmd: '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession',
        args: ['-suspend'],
        capture: 'silent',
      },
      linux: { cmd: 'loginctl', args: ['lock-session'], capture: 'silent' },
      win32: { cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'], capture: 'silent' },
    },
  },
  {
    id: 'networkInfo',
    label: 'Network info',
    description: 'Shows the configured network interfaces and their addresses.',
    tier: 'silent',
    mutatesSystem: false,
    plans: {
      darwin: { cmd: 'networksetup', args: ['-listallhardwareports'], capture: 'stdout' },
      linux: { cmd: 'ip', args: ['addr'], capture: 'stdout' },
      // `ipconfig /all` is parsed in JavaScript. Piping it through `head` or
      // `grep` is exactly the mistake that emptied the Windows process list.
      win32: { cmd: 'ipconfig', args: ['/all'], capture: 'stdout' },
    },
  },
];



export interface ActionAvailability {
  id: string;
  label: string;
  description: string;
  tier: ActionTier;
  mutatesSystem: boolean;
  available: boolean;
  /** Why it is unavailable on this platform. */
  reason?: string;
  /** True when the caller must pass `confirmed: true` after the user agrees. */
  needsConfirmation: boolean;
}

export function findAction(id: unknown): AutomationActionDef | null {
  if (typeof id !== 'string') return null;
  // Compare case-insensitively but keep the catalogue's camelCase spelling:
  // lower-casing the wanted value made `emptyTrash` and `showIp` unresolvable.
  const wanted = id.trim().toLowerCase();
  return AUTOMATION_ACTIONS.find((a) => a.id.toLowerCase() === wanted) ?? null;
}

/** What the UI should offer on this platform, and what each one needs. */
export function listActions(platform: FilePlatform): ActionAvailability[] {
  return AUTOMATION_ACTIONS.map((a) => {
    const available = Boolean(a.builtin) || Boolean(a.plans[platform]);
    const reason = available
      ? undefined
      : a.unavailable?.[platform] ?? `${platform} has no implementation for "${a.label}".`;
    return {
      id: a.id,
      label: a.label,
      description: a.description,
      tier: a.tier,
      mutatesSystem: a.mutatesSystem,
      available,
      reason,
      needsConfirmation: a.tier === 'confirm' && available,
    };
  });
}

export type PlanOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Resolve an action to the argv it runs, refusing anything that mutates the
 * machine until the caller confirms.
 *
 * `confirmed` is not a formality. It is the only thing standing between a
 * prompt-injected sentence and a machine that suspends itself at 3am, so the
 * check happens here — inside the catalogue — rather than at one call site.
 */
export function buildActionPlan(
  action: AutomationActionDef,
  platform: FilePlatform,
  opts: { confirmed?: boolean; timestamp?: string } = {},
): PlanOutcome<{ action: AutomationActionDef; plan: ActionPlan | null; builtin: BuiltinAction | null }> {
  if (action.mutatesSystem && !opts.confirmed) {
    return {
      ok: false,
      error: `"${action.label}" changes your machine, so it needs confirmation. Ask the user, then call again with confirmed: true.`,
    };
  }
  if (action.builtin) {
    return { ok: true, value: { action, plan: null, builtin: action.builtin } };
  }
  const plan = action.plans[platform];
  if (!plan) {
    return {
      ok: false,
      error: action.unavailable?.[platform] ?? `"${action.label}" is not available on ${platform}.`,
    };
  }
  return { ok: true, value: { action, plan, builtin: null } };
}

export interface NetworkInterface {
  name: string;
  family: string;
  address: string;
  internal: boolean;
  mac: string;
}

/**
 * Local interface addresses.
 *
 * The Show IP button used to shell out to `curl -s ifconfig.me`, which does not
 * exist on a stock Windows install and sends the machine's IP to a third party
 * every time someone pressed it. Local addresses answer the question for
 * offline use; the public lookup is opt-in.
 */
export function localInterfaces(): NetworkInterface[] {
  const out: NetworkInterface[] = [];
  const all = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    if (!addrs) continue;
    for (const a of addrs) {
      out.push({ name, family: a.family, address: a.address, internal: a.internal, mac: a.mac });
    }
  }
  return out;
}

/** Opt-in public address lookup, with a short timeout and no retries. */
export function lookupPublicIp(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    import('https').then(({ default: https }) => {
      const req = https.get(
        { host: 'api.ipify.org', path: '/?format=json', timeout: timeoutMs, headers: { accept: 'application/json' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
            if (body.length > 4096) req.destroy();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { ip?: string };
              if (parsed.ip) resolve(parsed.ip);
              else reject(new Error('The lookup returned no address.'));
            } catch {
              reject(new Error('The lookup returned something unexpected.'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('The lookup timed out.')));
      req.on('error', reject);
    }, reject);
  });
}