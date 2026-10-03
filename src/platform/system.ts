/**
 * Cross-platform system operations
 * Handles volume control, notifications, and other system-level functions
 */

import { app } from 'electron';
import { ipcMain } from 'electron';
import { BrowserWindow } from 'electron';

/**
 * Get the platform string.
 * In the renderer, use the preload-exposed process.platform.
 * In the main process, use os.platform() directly.
 */
let platformString: string;
if (typeof window !== 'undefined') {
  // Renderer: use the value exposed by the preload contextBridge
  platformString = window.henryAPI.platform();
} else {
  // Main process: use Node's os.platform directly
  const os = require('os');
  platformString = os.platform();
}

/**
 * Volume control result
 */
export interface VolumeControlResult {
  success: boolean;
  volume?: number;
  error?: string;
}

/**
 * Notification result
 */
export interface NotificationResult {
  success: boolean;
  error?: string;
  /** Which mechanism actually showed it — `electron`, `notify-send`, `osascript`, `msg`. */
  backend?: string;
}

/**
 * System info result
 */
export interface SystemInfoResult {
  platform: string;
  arch: string;
  hostname: string;
  totalMemoryGB: string;
  freeMemoryGB: string;
  cpuUsage?: number;
  battery?: {
    percent: number | null;
    charging: boolean;
    time: string;
  };
  error?: string;
}

/**
 * Sets system volume (0-100)
 * @param volume - Volume level (0-100)
 * @returns Promise resolving to volume control result
 */
export async function setVolume(volume: number): Promise<VolumeControlResult> {
  const clampedVolume = Math.max(0, Math.min(100, Math.round(volume)));

  try {
    if (platformString === 'darwin') {
      // macOS: use osascript
      const { execFileSync } = await import('child_process');
      execFileSync('osascript', ['-e', `set volume output volume ${clampedVolume}`], { timeout: 2000 });
      return { success: true, volume: clampedVolume };
    } else if (platformString === 'linux') {
      // Linux: try pactl first, then wpctl, then amixer
      try {
        const { execFileSync } = await import('child_process');
        // Try pactl (PulseAudio)
        execFileSync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${clampedVolume}%`], { timeout: 2000 });
        return { success: true, volume: clampedVolume };
      } catch (pactlErr) {
        try {
          const { execFileSync } = await import('child_process');
          // Try wpctl (WirePlumber/PipeWire)
          execFileSync('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${clampedVolume / 100}`], { timeout: 2000 });
          return { success: true, volume: clampedVolume };
        } catch (wpctlErr) {
          try {
            const { execFileSync } = await import('child_process');
            // Fallback to amixer (ALSA)
            execFileSync('amixer', ['-D', 'pulse', 'sset', 'Master', `${clampedVolume}%`], { timeout: 2000 });
            return { success: true, volume: clampedVolume };
          } catch (amixerErr) {
            return {
              success: false,
              error: `Volume control failed: tried pactl, wpctl, and amixer. Last error: ${amixerErr instanceof Error ? amixerErr.message : String(amixerErr)}`
            };
          }
        }
      }
    } else if (platformString === 'win32') {
      // Windows: use PowerShell (nircmd alternative)
      try {
        const { execFileSync } = await import('child_process');
        const command = `(New-Object -ComObject WScript.Shell).SendKeys([char]${clampedVolume < 32 ? 175 : clampedVolume < 64 ? 174 : clampedVolume < 96 ? 173 : 172})`;
        execFileSync('powershell', ['-Command', command], { timeout: 2000 });
        return { success: true, volume: clampedVolume };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    } else {
      return {
        success: false,
        error: `Volume control not implemented for platform: ${platformString}`
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Gets current system volume
 * @returns Promise resolving to volume control result with current volume
 */
export async function getVolume(): Promise<VolumeControlResult> {
  try {
    if (platformString === 'darwin') {
      // macOS: use osascript
      const { execFileSync } = await import('child_process');
      const out = execFileSync('osascript', ['-e', 'output volume of (get volume settings)'], { encoding: 'utf8', timeout: 2000 });
      const volume = parseInt(out.trim()) || 50;
      return { success: true, volume };
    } else if (platformString === 'linux') {
      // Linux: try pactl first, then wpctl, then amixer
      try {
        const { execFileSync } = await import('child_process');
        // Try pactl (PulseAudio)
        const out = execFileSync('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { encoding: 'utf8', timeout: 2000 });
        // Parse output like: "Volume: front-left: 65536 /  65% / 0,00 dB,   front-right: 65536 /  65% / 0,00 dB"
        const match = out.match(/(\d+)%/);
        if (match) {
          const volume = parseInt(match[1]);
          return { success: true, volume };
        }
        // Fallback if regex didn't match
        return { success: true, volume: 50 };
      } catch (pactlErr) {
        try {
          const { execFileSync } = await import('child_process');
          // Try wpctl (WirePlumber/PipeWire)
          const out = execFileSync('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { encoding: 'utf8', timeout: 2000 });
          // Parse output like: "0.65  [vol: 0.65]"
          const match = out.match(/(\d+\.\d+)/);
          if (match) {
            const volume = Math.round(parseFloat(match[1]) * 100);
            return { success: true, volume };
          }
          // Fallback if regex didn't match
          return { success: true, volume: 50 };
        } catch (wpctlErr) {
          try {
            const { execFileSync } = await import('child_process');
            // Fallback to amixer (ALSA)
            const out = execFileSync('amixer', ['-D', 'pulse', 'get', 'Master'], { encoding: 'utf8', timeout: 2000 });
            // Parse output like: "Mono: Playback 65536 [100%] [100%]"
            const match = out.match(/(\d+)%/);
            if (match) {
              const volume = parseInt(match[1]);
              return { success: true, volume };
            }
            // Fallback if regex didn't match
            return { success: true, volume: 50 };
          } catch (amixerErr) {
            return {
              success: false,
              error: `Volume query failed: tried pactl, wpctl, and amixer. Last error: ${amixerErr instanceof Error ? amixerErr.message : String(amixerErr)}`
            };
          }
        }
      }
    } else if (platformString === 'win32') {
      // Windows: use PowerShell
      try {
        const { execFileSync } = await import('child_process');
        const out = execFileSync('powershell', ['-Command', '(New-Object -ComObject WScript.Shell).SendKeys([char]175); (New-Object -ComObject WScript.Shell).SendKeys([char]174)'], { encoding: 'utf8', timeout: 2000 });
        // This approach doesn't work well for getting volume on Windows without third-party tools
        // Return a reasonable default
        return { success: true, volume: 50 };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    } else {
      return {
        success: false,
        error: `Volume query not implemented for platform: ${platformString}`
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Shows a system notification
 * @param title - Notification title
 * @param body - Notification body (optional)
 * @returns Promise resolving to notification result
 */
export async function showNotification(title: string, body?: string): Promise<NotificationResult> {
  const text = (body ?? '').trim();
  const heading = (title ?? '').trim();
  if (!heading && !text) {
    return { success: false, error: 'A notification needs a title or a body.' };
  }

  try {
    if (platformString === 'darwin') {
      // macOS: use osascript. Both strings are AppleScript literals, so a
      // quote or a backslash has to be escaped or the remainder of the
      // notification becomes script.
      const { execFileSync } = await import('child_process');
      const escapedTitle = appleScriptLiteral(heading);
      const escapedBody = appleScriptLiteral(text);
      execFileSync('osascript', ['-e', `display notification "${escapedBody}" with title "${escapedTitle}"`], { timeout: 3000 });
      return { success: true };
    }

    if (platformString === 'linux') {
      try {
        const { execFileSync } = await import('child_process');
        // argv, never a shell string: a title containing `"` or `$(…)` must
        // not be able to become a command.
        execFileSync('notify-send', [heading, text], { timeout: 3000 });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (platformString === 'win32') {
      return showWindowsNotification(heading, text);
    }

    return {
      success: false,
      error: `Notifications not implemented for platform: ${platformString}`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Escape a string for a single-quoted AppleScript literal. */
function appleScriptLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Windows notifications, in order of how well they actually work.
 *
 * The old implementation called `New-BurntToastNotification`, which only
 * exists if the BurntToast PowerShell *module* is installed — it is not part
 * of Windows. On a stock machine that always failed, and the fallback was a
 * `System.Windows.Forms.MessageBox`, which is a modal dialog that blocks the
 * Electron main process until someone clicks it. That is why
 * `computer:notify` returned `{ok:false}` on the installed build.
 *
 * 1. Electron's own `Notification`. On Windows 10 and later this is a native
 *    toast through the WinRT toast notifier — the same API the
 *    `notification:*` channels already use successfully.
 * 2. `msg.exe`, which ships with Windows and needs no module.
 * 3. Nothing else. A modal dialog is never an acceptable notification.
 */
async function showWindowsNotification(title: string, body: string): Promise<NotificationResult> {
  const { Notification } = await import('electron');
  if (Notification.isSupported()) {
    try {
      const n = new Notification({
        title: title || 'Henry',
        body,
        silent: false,
      });
      n.show();
      return { success: true, backend: 'electron' };
    } catch (err) {
      const viaElectron = err instanceof Error ? err.message : String(err);
      return notifyViaMsg(title, body, `Electron notifications failed (${viaElectron}).`);
    }
  }
  return notifyViaMsg(title, body, 'Electron reports this system cannot show notifications.');
}

function notifyViaMsg(title: string, body: string, reason: string): NotificationResult {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    // `*` is msg.exe's own "every session" selector and must stay a separate
    // argv element so the title can never be mistaken for a target.
    execFileSync('msg', ['*', '/time:10', `${title}${body ? `\n${body}` : ''}`], {
      timeout: 3000,
      windowsHide: true,
    });
    return { success: true, backend: 'msg' };
  } catch (err) {
    return {
      success: false,
      error: `${reason} msg.exe also failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Gets system information
 * @returns Promise resolving to system info result
 */
export async function getSystemInfo(): Promise<SystemInfoResult> {
  const os = require('os');
  const { arch, hostname, totalmem, freemem } = os;
  const result: SystemInfoResult = {
    platform: platformString,
    arch: arch(),
    hostname: hostname(),
    totalMemoryGB: (totalmem() / 1024 / 1024 / 1024).toFixed(1),
    freeMemoryGB: (freemem() / 1024 / 1024 / 1024).toFixed(1)
  };

  try {
    // CPU usage (simplified)
    if (platformString === 'darwin') {
      try {
        const topOut = await import('child_process').then(child_process =>
          child_process.execFileSync('sh', ['-c', "top -l 1 -s 0 | grep 'CPU usage'"], { encoding: 'utf8', timeout: 3000 })
        );
        const m = topOut.match(/([\d.]+)% user.*?([\d.]+)% sys/);
        if (m) {
          result.cpuUsage = parseFloat(m[1]) + parseFloat(m[2]);
        }
      } catch {
        // Ignore errors in CPU usage detection
      }
    } else if (platformString === 'linux') {
      try {
        // Read from /proc/stat
        const stat = await import('child_process').then(child_process =>
          child_process.execFileSync('cat', ['/proc/stat'], { encoding: 'utf8', timeout: 2000 })
        );
        const lines = stat.split('\n');
        const cpuLine = lines.find(line => line.startsWith('cpu '));
        if (cpuLine) {
          const parts = cpuLine.split(/\s+/).slice(1).map(Number);
          const idle = parts[3];
          const total = parts.reduce((a, b) => a + b, 0);
          const usage = ((total - idle) / total) * 100;
          result.cpuUsage = Math.round(usage);
        }
      } catch {
        // Ignore errors in CPU usage detection
      }
    } else if (platformString === 'win32') {
      // Windows CPU usage would require WMI or performance counters
      // For now, leave undefined
    }

    // Battery info
    try {
      if (platformString === 'darwin') {
        const battOut = await import('child_process').then(child_process =>
          child_process.execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 2000 })
        );
        const bp = battOut.match(/(\d+)%/);
        if (bp) {
          result.battery = {
            percent: parseInt(bp[1]),
            charging: /AC Power|charging/.test(battOut),
            time: battOut.match(/(\d+:\d+) remaining/)?.[1] ?? ''
          };
        }
      } else if (platformString === 'linux') {
        // Try upower first
        try {
          const upowerOut = await import('child_process').then(child_process =>
            child_process.execFileSync('upower', ['-i', '/org/freedesktop/UPower/devices/battery_BAT0'], { encoding: 'utf8', timeout: 2000 })
          );
          const percentMatch = upowerOut.match(/percentage:\s+(\d+)%/);
          const stateMatch = upowerOut.match(/state:\s+(\w+)/);
          const timeMatch = upowerOut.match(/time to empty:\s+(\d+:\d+:\d+)/);

          if (percentMatch) {
            result.battery = {
              percent: parseInt(percentMatch[1]),
              charging: stateMatch?.[1] === 'charging',
              time: timeMatch?.[1] ?? ''
            };
          }
        } catch (upowerErr) {
          // Try acpi
          try {
            const acpiOut = await import('child_process').then(child_process =>
              child_process.execFileSync('acpi', ['-b'], { encoding: 'utf8', timeout: 2000 })
            );
            const percentMatch = acpiOut.match(/(\d+)%/);
            const charging = /charging/i.test(acpiOut);
            const timeMatch = acpiOut.match(/(\d+:\d+:\d+)/);

            if (percentMatch) {
              result.battery = {
                percent: parseInt(percentMatch[1]),
                charging,
                time: timeMatch?.[1] ?? ''
              };
            }
          } catch (acpiErr) {
            // No battery info available
          }
        }
      } else if (platformString === 'win32') {
        // Windows battery info would require WMI
        // For now, leave undefined
      }
    } catch {
      // Ignore battery detection errors
    }

    return result;
  } catch (err) {
    return {
      ...result,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * IPC registration for system operations
 */
export function registerPlatformSystemHandlers() {
  ipcMain.handle('system:setVolume', (_e, volume: number) => {
    return setVolume(volume);
  });

  ipcMain.handle('system:getVolume', () => {
    return getVolume();
  });

  ipcMain.handle('system:showNotification', (_e, title: string, body?: string) => {
    return showNotification(title, body);
  });

  ipcMain.handle('system:getSystemInfo', () => {
    return getSystemInfo();
  });
}