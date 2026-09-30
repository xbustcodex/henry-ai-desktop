/**
 * Computer Control — Henry's ability to operate macOS and Windows.
 *
 * Built on top of the existing terminal executor. Uses AppleScript on Mac
 * and PowerShell/WSH on Windows. No additional npm packages needed.
 *
 * Mac permissions required:
 *   - Accessibility: System Settings → Privacy & Security → Accessibility → Henry AI
 *   - Screen Recording: System Settings → Privacy & Security → Screen Recording → Henry AI
 */

import { ipcMain, BrowserWindow, app, systemPreferences } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { classifyCommand } from './_commandSafety';
import { detectLinuxSession, isWaylandSession } from './sessionDetect';
import { launchApplication, openUrl } from '../../src/platform/launcher';
import { discoverInstalledApps, InstalledApp } from '../../src/platform/installedApps';

type WindowGetter = () => BrowserWindow | null;

/** Escape a string for safe embedding inside an AppleScript "..." literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Current CPU utilisation on Linux, measured from two /proc/stat samples.
 * Returns 0 when it cannot be measured — never a fabricated number.
 */
async function linuxCpuPercent(): Promise<number> {
  const fs = await import('fs');
  const read = (): number[] | null => {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
      const idle = parts[3] + (parts[4] ?? 0);
      const total = parts.reduce((a, b) => a + b, 0);
      return [total, idle];
    } catch { return null; }
  };
  const first = read();
  if (!first) return 0;
  await new Promise((r) => setTimeout(r, 250));
  const second = read();
  if (!second) return 0;
  const totalDelta = second[0] - first[0];
  const idleDelta = second[1] - first[1];
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

export function registerComputerHandlers(winGetter: WindowGetter) {
  const platform = process.platform;

  // ── Helper: run a shell command and capture output ───────────────────
  function runCmd(command: string, timeout = 600000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const shell = platform === 'win32' ? ['cmd', ['/c', command]] : ['sh', ['-c', command]];
      const child = spawn(shell[0] as string, shell[1] as string[], { timeout });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
      child.on('error', (e: Error) => resolve({ stdout: '', stderr: e.message, exitCode: -1 }));
    });
  }

  /**
   * Run a binary with an argv array — no shell, so renderer/AI supplied text
   * can never be interpreted as shell syntax. Use this instead of runCmd for
   * anything that embeds user or model text.
   */
  function runBin(cmd: string, args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Promise.withResolvers is unavailable at this tsconfig lib target, so the
    // executor form is used deliberately here.
    const { promise, resolve } = (() => {
      let r!: (v: { stdout: string; stderr: string; exitCode: number }) => void;
      const p = new Promise<{ stdout: string; stderr: string; exitCode: number }>((res) => { r = res; });
      return { promise: p, resolve: r };
    })();
    const child = spawn(cmd, args, { timeout });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.on('error', (e: Error) => resolve({ stdout: '', stderr: e.message, exitCode: -1 }));
    return promise;
  }

  // ── Screenshot ────────────────────────────────────────────────────────
  // Delegates to the shared capture implementation so this handler and the
  // capability probe use the SAME backend ladder. It used to shell out to
  // `scrot || import` while the probe advertised a four-backend list, so a
  // "ready" capability could describe a backend this handler never ran.
  ipcMain.handle('computer:screenshot', async (_event, params: { region?: { x: number; y: number; w: number; h: number } } = {}) => {
    try {
      const { captureScreenshot } = await import('../../src/platform/screenshot');
      const result = await captureScreenshot(params.region);
      if (!result.success) {
        return {
          success: false,
          base64: null,
          error: result.error
            || (platform === 'darwin'
              ? 'Screenshot failed. Check Screen Recording permission in System Settings.'
              : 'No screenshot backend could capture the screen.'),
        };
      }
      return { success: true, base64: result.base64 ?? null, mimeType: result.mimeType };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[computer:screenshot]', message);
      return { success: false, base64: null, error: message };
    }
  });

  // ── Close a window by title ────────────────────────────────────────────
  // HQPanel used to build `pkill -f "<title>"` in the renderer and POST it to
  // /computer/shell. Titles come from wmctrl, i.e. from arbitrary window
  // content, so a title containing a quote or `$(...)` became shell input.
  // `wmctrl -c` takes the title as a plain argument — no shell involved.
  ipcMain.handle('computer:closeApp', async (_event, appName: string) => {
    const name = (appName ?? '').trim();
    if (!name) return { success: false, error: 'No window title supplied.' };
    try {
      if (platform === 'darwin') {
        const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const r = await runBin('osascript', ['-e', `tell application "${escaped}" to quit`], 5000);
        return { success: r.exitCode === 0, error: r.exitCode !== 0 ? r.stderr : undefined };
      }
      if (platform === 'win32') {
        const r = await runBin('taskkill', ['/f', '/im', `${name}.exe`], 5000);
        return { success: r.exitCode === 0, error: r.exitCode !== 0 ? r.stderr : undefined };
      }
      // Linux: close the window itself rather than killing a matching process.
      const r = await runBin('wmctrl', ['-c', name], 5000);
      if (r.exitCode === 0) return { success: true };
      return { success: false, error: r.stderr || `Could not close "${name}".` };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Open App ──────────────────────────────────────────────────────────
  ipcMain.handle('computer:openApp', async (_event, appName: string) => {
    try {
      const result = await launchApplication(appName);
      return {
        success: result.success,
        output: result.output,
        error: result.error
      };
    } catch (e: unknown) {
      console.error('[computer:openApp]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Open URL in default browser ───────────────────────────────────────
  ipcMain.handle('computer:openUrl', async (_event, url: string) => {
    try {
      const result = await openUrl(url);
      return { success: result.success, output: result.output, error: result.error };
    } catch (e: unknown) {
      console.error('[computer:openUrl]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── AppleScript ───────────────────────────────────────────────────────
  ipcMain.handle('computer:osascript', async (_event, script: string) => {
    try {
      if (platform !== 'darwin') {
        return { success: false, error: 'AppleScript only supported on macOS', output: '' };
      }
      const result = await runCmd(`osascript -e '${script.replace(/'/g, "'\\''")}'`, 30000);
      return {
        success: result.exitCode === 0,
        output: result.stdout.trim(),
        error: result.exitCode !== 0 ? result.stderr.trim() : undefined,
      };    } catch (e: unknown) {
      console.error('[computer:osascript]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Run shell command (with allowlist safety) ─────────────────────────
  ipcMain.handle('computer:runShell', async (_event, params: { command: string; timeout?: number }) => {
    try {
      const verdict = classifyCommand(params.command);
      if (verdict.blocked) {
        return { success: false, error: `Command blocked for safety: ${verdict.reason}.`, output: '' };
      }
      const result = await runCmd(params.command, params.timeout || 30000);
      return {
        success: result.exitCode === 0,
        output: result.stdout,
        error: result.stderr || undefined,
        exitCode: result.exitCode,
      };    } catch (e: unknown) {
      console.error('[computer:runShell]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Get installed apps ──────────────────────────────────────────────────
  ipcMain.handle('computer:listApps', async () => {
    try {
      const apps = await discoverInstalledApps();
      return { apps: apps.map(a => ({ 
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        executable: a.executable,
        icon: a.icon,
        categories: a.categories,
        isTerminal: a.isTerminal,
        isFileManager: a.isFileManager,
        isBrowser: a.isBrowser,
      })), platform: process.platform };
    } catch (e: unknown) {
      console.error('[computer:listApps]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Get default file manager ─────────────────────────────────────────────
  ipcMain.handle('computer:getDefaultFileManager', async () => {
    try {
      const apps = await discoverInstalledApps();
      const fileManager = apps.find(a => a.isFileManager);
      if (fileManager) {
        return { success: true, name: fileManager.displayName, executable: fileManager.executable, icon: fileManager.icon };
      }
      return { success: false, error: 'No file manager found' };
    } catch (e: unknown) {
      console.error('[computer:getDefaultFileManager]', e instanceof Error ? e.message : String(e));
      return { success: false, error: String(e) };
    }
  });

  // ── Get default terminal ──────────────────────────────────────────────────
  ipcMain.handle('computer:getDefaultTerminal', async () => {
    try {
      const apps = await discoverInstalledApps();
      const terminal = apps.find(a => a.isTerminal);
      if (terminal) {
        return { success: true, name: terminal.displayName, executable: terminal.executable, icon: terminal.icon };
      }
      return { success: false, error: 'No terminal found' };
    } catch (e: unknown) {
      console.error('[computer:getDefaultTerminal]', e instanceof Error ? e.message : String(e));
      return { success: false, error: String(e) };
    }
  });

  // ── Get default browser ───────────────────────────────────────────────────
  ipcMain.handle('computer:getDefaultBrowser', async () => {
    try {
      const apps = await discoverInstalledApps();
      const browser = apps.find(a => a.isBrowser);
      if (browser) {
        return { success: true, name: browser.displayName, executable: browser.executable, icon: browser.icon };
      }
      return { success: false, error: 'No browser found' };
    } catch (e: unknown) {
      console.error('[computer:getDefaultBrowser]', e instanceof Error ? e.message : String(e));
      return { success: false, error: String(e) };
    }
  });

  // ── Get running processes ─────────────────────────────────────────────
  ipcMain.handle('computer:listProcesses', async () => {
    try {
      let cmd: string;
      if (platform === 'darwin') {
        cmd = `ps aux | awk 'NR>1 {print $11}' | sort -u | grep -v '\\[' | head -40`;
      } else if (platform === 'win32') {
        cmd = `tasklist /FO CSV | head -40`;
      } else {
        cmd = `ps aux | awk 'NR>1 {print $11}' | sort -u | head -40`;
      }
      const result = await runCmd(cmd, 5000);
      return { processes: result.stdout.trim().split('\n').filter(Boolean) };    } catch (e: unknown) {
      console.error('[computer:listProcesses]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Permission check ──────────────────────────────────────────────────
  ipcMain.handle('computer:checkPermissions', async () => {
    try {
      if (platform !== 'darwin') {
        return { platform, accessibility: true, screenRecording: true, message: 'Permissions apply to macOS only.' };
      }

      // Check Accessibility
      const accessResult = await runCmd(
        `osascript -e 'tell application "System Events" to return name of first process whose frontmost is true' 2>&1`,
        5000
      );
      const hasAccessibility = accessResult.exitCode === 0 && !accessResult.stdout.includes('not allowed');

      // Check Screen Recording (try screenshot)
      const tmpCheck = path.join(os.tmpdir(), 'henry_perm_check.png');
      const srResult = await runCmd(`screencapture -x "${tmpCheck}" 2>&1 && rm -f "${tmpCheck}"`, 5000);
      const hasScreenRecording = srResult.exitCode === 0;

      return {
        platform: 'darwin',
        accessibility: hasAccessibility,
        screenRecording: hasScreenRecording,
        accessibilityInstructions: !hasAccessibility
          ? 'Open System Settings → Privacy & Security → Accessibility → enable Henry AI'
          : null,
        screenRecordingInstructions: !hasScreenRecording
          ? 'Open System Settings → Privacy & Security → Screen Recording → enable Henry AI'
          : null,
      };    } catch (e: unknown) {
      console.error('[computer:checkPermissions]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Unified Capability Check (cross-platform) ────────────────────────────
  ipcMain.handle('computer:checkCapabilities', async () => {
    try {
      const { execFile } = await import('child_process');
      const { clipboard } = await import('electron');
      const os = await import('os');

      const sessionType = detectLinuxSession();
      const isWayland = isWaylandSession();
      const isWSL = (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ? true : false;

      // Clipboard capability (Electron clipboard works everywhere)
      let clipboardStatus = { status: 'ready' as const, backend: 'electron', details: 'Electron clipboard API' };

      // Selected text capture capability
      let selectedTextStatus: { status: 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable'; backend?: string; details?: string } = { status: 'unavailable', details: 'Not implemented' };

      // Screen capture capability
      let screenCaptureStatus: { status: 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable'; backend?: string; details?: string; regionCapture?: boolean; windowCapture?: boolean } = { status: 'unavailable', details: 'Not implemented' };

      // Input automation capability
      let inputAutomationStatus: { status: 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable'; backend?: string; details?: string } = { status: 'unavailable', details: 'Not implemented' };

      if (platform === 'darwin') {
        // macOS
        // Selected text: osascript (needs Accessibility)
        const hasAccess = systemPreferences.isTrustedAccessibilityClient(false);
        selectedTextStatus = hasAccess
          ? { status: 'ready', backend: 'osascript', details: 'Simulates ⌘C via AppleScript' }
          : { status: 'dependency-missing', backend: 'osascript', details: 'Requires Accessibility permission' };

        // Screen capture: screencapture (needs Screen Recording)
        const tmp = path.join(os.tmpdir(), 'henry_cap_check.png');
        const srResult = await runCmd(`screencapture -x "${tmp}" 2>&1 && rm -f "${tmp}"`, 5000);
        const hasScreenRec = srResult.exitCode === 0;
        screenCaptureStatus = hasScreenRec
          ? { status: 'ready', backend: 'screencapture', details: 'macOS native screencapture', regionCapture: true, windowCapture: true }
          : { status: 'dependency-missing', backend: 'screencapture', details: 'Requires Screen Recording permission', regionCapture: false, windowCapture: false };

        // Input automation: osascript (needs Accessibility)
        inputAutomationStatus = hasAccess
          ? { status: 'ready', backend: 'osascript', details: 'AppleScript via System Events' }
          : { status: 'dependency-missing', backend: 'osascript', details: 'Requires Accessibility permission' };

      } else if (platform === 'linux') {
        // Linux: check available backends
        const checkBin = async (bins: string[]): Promise<string | null> => {
          for (const b of bins) {
            try {
              await new Promise<void>((resolve, reject) => {
                execFile('which', [b], { timeout: 2000 }, (err) => { if (err) reject(err); else resolve(); });
              });
              return b;
            } catch { /* continue */ }
          }
          return null;
        };

        // Clipboard: check external tools (for reference, Electron clipboard works)
        const xclip = await checkBin(['xclip']);
        const xsel = await checkBin(['xsel']);
        const wlCopy = await checkBin(['wl-copy']);
        const wlPaste = await checkBin(['wl-paste']);
        clipboardStatus = {
          status: 'ready',
          backend: 'electron',
          details: `Electron clipboard API${xclip ? ' + xclip' : ''}${xsel ? ' + xsel' : ''}${wlCopy ? ' + wl-clipboard' : ''}`
        };

        // Selected text capture
        if (!isWayland) {
          // X11: xclip/xsel for PRIMARY, xdotool for Ctrl+C fallback
          const xdotool = await checkBin(['xdotool']);
          const hasPrimary = !!(xclip || xsel);
          if (hasPrimary || xdotool) {
            selectedTextStatus = {
              status: hasPrimary ? 'ready' : 'degraded',
              backend: hasPrimary ? (xclip ? 'xclip' : 'xsel') : 'xdotool',
              details: hasPrimary
                ? `X11 PRIMARY selection via ${xclip ? 'xclip' : 'xsel'}${xdotool ? ' + Ctrl+C fallback' : ''}`
                : 'Ctrl+C simulation via xdotool (no PRIMARY selection support)'
            };
          } else {
            selectedTextStatus = { status: 'dependency-missing', details: 'Install xclip/xsel for PRIMARY selection, xdotool for Ctrl+C fallback' };
          }
        } else {
          // Wayland: wl-paste --primary (if supported), ydotool for Ctrl+C fallback
          const ydotool = await checkBin(['ydotool']);
          const wlPastePrimary = wlPaste; // wl-paste --primary support varies
          if (wlPastePrimary || ydotool) {
            selectedTextStatus = {
              status: wlPastePrimary ? 'ready' : 'degraded',
              backend: wlPastePrimary ? 'wl-paste' : 'ydotool',
              details: wlPastePrimary
                ? 'Wayland PRIMARY selection via wl-paste'
                : 'Ctrl+C simulation via ydotool (requires ydotoold running)'
            };
          } else {
            selectedTextStatus = { status: 'dependency-missing', details: 'Install wl-clipboard (wl-paste --primary) or ydotool for Wayland' };
          }
        }

        // Screen capture — PROBED, not assumed.
        //
        // This used to `which` each binary and report the first one present.
        // On this machine `import` (ImageMagick 7) exists but cannot grab a
        // frame in any invocation, so Henry advertised a backend that always
        // failed. probeScreenshotBackend runs the SAME ladder capture uses and
        // reports the first one that actually produced an image.
        const { probeScreenshotBackend } = await import('../../src/platform/screenshot');
        const probed = await probeScreenshotBackend();

        if (probed) {
          screenCaptureStatus = {
            status: 'ready',
            backend: probed.name,
            details: `Linux screenshot via ${probed.name} (verified by test capture)`,
            regionCapture: probed.region,
            windowCapture: probed.window
          };
        } else {
          screenCaptureStatus = {
            status: 'dependency-missing',
            details:
              `No screenshot backend could actually capture (${sessionType}). ` +
              'Install scrot (recommended) or grim, then re-check.'
          };
        }

        // Input automation
        const xdotool2 = await checkBin(['xdotool']);
        const wmctrl = await checkBin(['wmctrl']);
        const ydotool2 = await checkBin(['ydotool']);

        if (isWayland) {
          if (ydotool2) {
            inputAutomationStatus = { status: 'ready', backend: 'ydotool', details: 'Wayland synthetic input via ydotool (requires ydotoold)' };
          } else if (xdotool2) {
            inputAutomationStatus = { status: 'degraded', backend: 'xdotool (XWayland)', details: 'xdotool via XWayland (may not work on all Wayland compositors)' };
          } else {
            inputAutomationStatus = { status: 'dependency-missing', details: 'Install ydotool for Wayland native input, or xdotool for XWayland fallback' };
          }
        } else {
          if (xdotool2 || wmctrl) {
            inputAutomationStatus = {
              status: 'ready',
              backend: [xdotool2, wmctrl].filter(Boolean).join(' + '),
              details: `X11 input via ${xdotool2 ? 'xdotool' : ''}${xdotool2 && wmctrl ? ' + ' : ''}${wmctrl ? 'wmctrl' : ''}`
            };
          } else {
            inputAutomationStatus = { status: 'dependency-missing', details: 'Install xdotool or wmctrl for X11 input automation' };
          }
        }

      } else if (platform === 'win32') {
        // Windows
        // Clipboard: Electron works, also PowerShell
        clipboardStatus = { status: 'ready', backend: 'electron', details: 'Electron clipboard API + PowerShell Get-Clipboard/Set-Clipboard' };

        // Selected text: Ctrl+C simulation via PowerShell SendKeys
        selectedTextStatus = { status: 'ready', backend: 'powershell', details: 'Ctrl+C simulation via PowerShell SendKeys' };

        // Screen capture: PowerShell System.Drawing
        screenCaptureStatus = { status: 'ready', backend: 'powershell', details: 'PowerShell System.Drawing bitmap capture', regionCapture: false, windowCapture: false };

        // Input automation: PowerShell SendKeys
        inputAutomationStatus = { status: 'ready', backend: 'powershell', details: 'PowerShell SendKeys / WScript.Shell' };
      }

      return {
        platform,
        session: platform === 'linux' ? { type: sessionType, isWayland, isWSL } : undefined,
        clipboard: clipboardStatus,
        selectedText: selectedTextStatus,
        screenCapture: screenCaptureStatus,
        inputAutomation: inputAutomationStatus,
      };
    } catch (e: unknown) {
      console.error('[computer:checkCapabilities]', e instanceof Error ? e.message : String(e));
      return {
        platform: process.platform,
        clipboard: { status: 'unavailable', details: String(e) },
        selectedText: { status: 'unavailable', details: String(e) },
        screenCapture: { status: 'unavailable', details: String(e) },
        inputAutomation: { status: 'unavailable', details: String(e) },
      };
    }
  });

  // ── Create folder ─────────────────────────────────────────────────────
  // ── System stats — live Mac vitals ────────────────────────────────────────
  ipcMain.handle('computer:systemStats', async () => {
    const { execSync } = await import('child_process');
    const os = await import('os');
    try {
      const total = os.default.totalmem();
      const free = os.default.freemem();
      const cpus = os.default.cpus();
      const uptime = os.default.uptime();

      // CPU usage. `top -l 1` is macOS-only; on Linux/Windows it always threw
      // and the catch filled in a RANDOM number, so the HQ/system panel showed
      // invented load. Each platform now measures for real.
      let cpuPercent = 0;
      if (platform === 'darwin') {
        try {
          const topOut = execSync("top -l 1 -s 0 | grep 'CPU usage'", { encoding: 'utf8', timeout: 3000 });
          const m = topOut.match(/([\d.]+)% user.*?([\d.]+)% sys/);
          if (m) cpuPercent = parseFloat(m[1]) + parseFloat(m[2]);
        } catch { cpuPercent = 0; }
      } else if (platform === 'linux') {
        cpuPercent = await linuxCpuPercent();
      } else {
        try {
          const out = execSync(
            'powershell -NoProfile -Command "(Get-Counter \'\\Processor(_Total)\\% Processor Time\').CounterSamples.CookedValue"',
            { encoding: 'utf8', timeout: 5000 },
          );
          cpuPercent = parseFloat(out.trim()) || 0;
        } catch { cpuPercent = 0; }
      }

      // Battery
      const battery = { percent: null as number|null, charging: false, time: '' };
      if (platform === 'darwin') {
        try {
          const battOut = execSync('pmset -g batt', { encoding: 'utf8', timeout: 2000 });
          const bp = battOut.match(/(\d+)%/);
          if (bp) battery.percent = parseInt(bp[1]);
          battery.charging = /AC Power|charging/.test(battOut);
          const bt = battOut.match(/(\d+:\d+) remaining/);
          if (bt) battery.time = bt[1];
        } catch { /* no battery (desktop) */ }
      } else if (platform === 'linux') {
        // sysfs, not pmset — pmset does not exist here.
        try {
          const fs = await import('fs');
          const bases = fs.readdirSync('/sys/class/power_supply')
            .filter((d: string) => d.startsWith('BAT'));
          if (bases.length > 0) {
            const base = `/sys/class/power_supply/${bases[0]}`;
            const cap = fs.readFileSync(`${base}/capacity`, 'utf8').trim();
            const pct = parseInt(cap, 10);
            battery.percent = Number.isFinite(pct) ? pct : null;
            const status = fs.readFileSync(`${base}/status`, 'utf8').trim();
            battery.charging = status === 'Charging';
          }
        } catch { /* desktop or unreadable sysfs */ }
      } else {
        try {
          const out = execSync(
            'powershell -NoProfile -Command "(Get-CimInstance Win32_Battery | Select-Object -First 1 -ExpandProperty EstimatedChargeRemaining)"',
            { encoding: 'utf8', timeout: 5000 },
          );
          const pct = parseInt(out.trim(), 10);
          battery.percent = Number.isFinite(pct) ? pct : null;
          battery.charging = pct > 0;
        } catch { /* desktop */ }
      }

      // Network (active interface)
      let network = { interface: '', ip: '' };
      try {
        const ifaces = os.default.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifaces)) {
          if (!addrs) continue;
          const v4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
          if (v4) { network = { interface: name, ip: v4.address }; break; }
        }
      } catch { /* ignore */ }

      // Running apps (not just processes — visible apps)
      let runningApps: string[] = [];
      if (platform === 'darwin') {
        try {
          const appsOut = execSync(
            `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`,
            { encoding: 'utf8', timeout: 3000 }
          );
          runningApps = appsOut.trim().split(', ').filter(Boolean).slice(0, 20);
        } catch { runningApps = []; }
      } else if (platform === 'linux') {
        // wmctrl -l: the last column is the window title; the window is the
        // closest thing to a "running app" on a generic Linux desktop.
        const res = await runBin('wmctrl', ['-l'], 4000);
        if (res.exitCode === 0) {
          runningApps = res.stdout.split('\n')
            .map((line) => line.trim().split(/\s{2,}/).pop() || '')
            .filter(Boolean)
            .slice(0, 20);
        }
      } else {
        try {
          const appsOut = execSync(
            'powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty ProcessName -Unique"',
            { encoding: 'utf8', timeout: 5000 },
          );
          runningApps = appsOut.trim().split(/\r?\n/).filter(Boolean).slice(0, 20);
        } catch { runningApps = []; }
      }

      // Disk usage
      const disk = { total: 0, free: 0 };
      try {
        const dfOut = execSync("df -k / | tail -1", { encoding: 'utf8', timeout: 2000 });
        const parts = dfOut.trim().split(/\s+/);
        if (parts.length >= 4) {
          disk.total = parseInt(parts[1]) * 1024;
          disk.free = parseInt(parts[3]) * 1024;
        }
      } catch { /* ignore */ }

      return {
        cpu: { percent: Math.round(cpuPercent), cores: cpus.length, model: cpus[0]?.model || 'Unknown' },
        memory: { total, free, used: total - free, percent: Math.round((1 - free/total) * 100) },
        battery,
        network,
        disk,
        uptime: Math.round(uptime),
        runningApps,
        hostname: os.default.hostname(),
        platform: os.default.platform(),
      };
    } catch (e) {
      return { error: String(e) };
    }
  });

  // ── Clipboard operations ─────────────────────────────────────────────────
  ipcMain.handle('computer:clipboard:read', async () => {
    const { clipboard } = await import('electron');
    return { text: clipboard.readText(), html: clipboard.readHTML() };
  });
  ipcMain.handle('computer:clipboard:write', async (_e, text: string) => {
    const { clipboard } = await import('electron');
    clipboard.writeText(text);
    return { ok: true };
  });

  // ── Selected text capture (cross-platform) ───────────────────────────────
  ipcMain.handle('computer:captureSelectedText', async () => {
    try {
      const { clipboard } = await import('electron');
      let captured = '';
      let source = 'clipboard';

      if (platform === 'darwin') {
        // macOS: Use osascript to simulate ⌘C, requires Accessibility
        const originalText = clipboard.readText();
        const originalHTML = clipboard.readHTML();

        const hasAccess = systemPreferences.isTrustedAccessibilityClient(false);
        if (!hasAccess) {
          return { success: false, error: 'Accessibility permission required', captured: '', source: 'none' };
        }

        const { execFile } = await import('child_process');
        await new Promise<void>((resolve) => {
          execFile('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down'], { timeout: 1000 }, (err) => {
            if (err) console.warn('[captureSelectedText] osascript failed:', err.message);
            resolve();
          });
        });

        await new Promise(r => setTimeout(r, 150));

        const newText = clipboard.readText();
        if (newText && newText !== originalText && newText.length > 1) {
          captured = newText;
          source = 'selection';
          // Restore original clipboard
          if (originalText) clipboard.writeText(originalText);
          else clipboard.clear();
        } else if (originalText && originalText.length > 1) {
          captured = originalText;
          source = 'clipboard';
        }

      } else if (platform === 'linux') {
        // Linux: Try PRIMARY selection first (X11), then CLIPBOARD, fallback to Ctrl+C simulation
        const sessionType = process.env.XDG_SESSION_TYPE || '';
        const isWayland = sessionType === 'wayland';

        // Try xclip/xsel for PRIMARY selection (X11)
        if (!isWayland) {
          // Try xclip first
          try {
            const { execFile } = await import('child_process');
            const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
              execFile('xclip', ['-o', '-selection', 'primary'], { timeout: 2000 }, (err, stdout, stderr) => {
                resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', exitCode: err ? 1 : 0 });
              });
            });
            if (result.exitCode === 0 && result.stdout.trim().length > 1) {
              captured = result.stdout.trim();
              source = 'primary';
            }
          } catch {
            // xclip not available or failed
          }

          // Try xsel if xclip failed
          if (!captured) {
            try {
              const { execFile } = await import('child_process');
              const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
                execFile('xsel', ['-p'], { timeout: 2000 }, (err, stdout, stderr) => {
                  resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', exitCode: err ? 1 : 0 });
                });
              });
              if (result.exitCode === 0 && result.stdout.trim().length > 1) {
                captured = result.stdout.trim();
                source = 'primary';
              }
            } catch {
              // xsel not available
            }
          }
        }

        // Try wl-paste for Wayland (if supported)
        if (!captured && isWayland) {
          try {
            const { execFile } = await import('child_process');
            const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
              execFile('wl-paste', ['--primary'], { timeout: 2000 }, (err, stdout, stderr) => {
                resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', exitCode: err ? 1 : 0 });
              });
            });
            if (result.exitCode === 0 && result.stdout.trim().length > 1) {
              captured = result.stdout.trim();
              source = 'primary';
            }
          } catch {
            // wl-paste not available or --primary not supported
          }
        }

        // Fallback: use CLIPBOARD selection (Ctrl+C simulation)
        if (!captured) {
          const originalText = clipboard.readText();

          // Simulate Ctrl+C using xdotool (X11) or try ydotool (Wayland)
          if (!isWayland) {
            try {
              const { execFile } = await import('child_process');
              await new Promise<void>((resolve) => {
                execFile('xdotool', ['key', 'ctrl+c'], { timeout: 1000 }, (err) => {
                  if (err) console.warn('[captureSelectedText] xdotool failed:', err.message);
                  resolve();
                });
              });
              await new Promise(r => setTimeout(r, 150));
            } catch {
              // xdotool not available
            }
          } else {
            // Wayland: try ydotool
            try {
              const { execFile } = await import('child_process');
              await new Promise<void>((resolve) => {
                execFile('ydotool', ['key', 'ctrl+c'], { timeout: 1000 }, (err) => {
                  if (err) console.warn('[captureSelectedText] ydotool failed:', err.message);
                  resolve();
                });
              });
              await new Promise(r => setTimeout(r, 150));
            } catch {
              // ydotool not available
            }
          }

          const newText = clipboard.readText();
          if (newText && newText !== originalText && newText.length > 1) {
            captured = newText;
            source = 'clipboard';
            // Restore original clipboard
            if (originalText) clipboard.writeText(originalText);
            else clipboard.clear();
          } else if (originalText && originalText.length > 1) {
            captured = originalText;
            source = 'clipboard';
          }
        }

      } else if (platform === 'win32') {
        // Windows: Simulate Ctrl+C using PowerShell SendKeys
        const originalText = clipboard.readText();

        const { execFile } = await import('child_process');
        await new Promise<void>((resolve) => {
          execFile('powershell', [
            '-Command',
            '$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys(\'^c\')'
          ], { timeout: 1000 }, (err) => {
            if (err) console.warn('[captureSelectedText] PowerShell SendKeys failed:', err.message);
            resolve();
          });
        });

        await new Promise(r => setTimeout(r, 150));

        const newText = clipboard.readText();
        if (newText && newText !== originalText && newText.length > 1) {
          captured = newText;
          source = 'clipboard';
          // Restore original clipboard
          if (originalText) clipboard.writeText(originalText);
          else clipboard.clear();
        } else if (originalText && originalText.length > 1) {
          captured = originalText;
          source = 'clipboard';
        }
      }

      return { success: true, captured, source };
    } catch (e: unknown) {
      console.error('[computer:captureSelectedText]', e instanceof Error ? e.message : String(e));
      return { success: false, error: e instanceof Error ? e.message : String(e), captured: '', source: 'error' };
    }
  });

  // ── Volume / brightness / system controls ────────────────────────────────
  ipcMain.handle('computer:setVolume', async (_e, level: number) => {
    const { setVolume } = await import('../../src/platform/system');
    const result = await setVolume(level);
    return { ok: result.success };
  });
  ipcMain.handle('computer:getVolume', async () => {
    const { getVolume } = await import('../../src/platform/system');
    const result = await getVolume();
    return { volume: result.volume ?? 50 };
  });
  ipcMain.handle('computer:notify', async (_e, opts: { title: string; body?: string }) => {
    const { showNotification } = await import('../../src/platform/system');
    const result = await showNotification(opts.title, opts.body);
    return { ok: result.success };
  });

  // ── Desktop mode toggle ───────────────────────────────────────────────────
  ipcMain.handle('computer:desktopMode', async (_e, opts: { enable: boolean; fullscreen?: boolean }) => {
    const { getMainWindow } = await import('../main');
    const win = getMainWindow();
    if (!win) return { ok: false };
    if (opts.enable) {
      win.setAlwaysOnTop(false);
      win.setFullScreen(true);
      win.setWindowButtonVisibility(false);
      win.setBackgroundColor('#00000000');
      // On macOS: send window behind others
      win.webContents.executeJavaScript('document.body.setAttribute("data-desktop-mode","1")').catch(()=>{});
    } else {
      win.setFullScreen(false);
      win.setWindowButtonVisibility(true);
      win.setAlwaysOnTop(false);
      win.webContents.executeJavaScript('document.body.removeAttribute("data-desktop-mode")').catch(()=>{});
    }
    return { ok: true };
  });

  // ── Kill process ─────────────────────────────────────────────────────────
  ipcMain.handle('computer:killProcess', async (_e, pid: unknown) => {
    const { execFile } = await import('child_process');
    const platform = process.platform;
    // IPC payloads are not type-checked at runtime. Interpolating the raw
    // value into a shell string meant `kill 1; rm -rf ~` was one string away.
    const n = typeof pid === 'number' ? pid : Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'Invalid PID' };
    }
    try {
      // Must be awaited: the previous fire-and-forget form resolved before the
      // process was signalled, so killing a PID we do not own still reported
      // success (ESRCH/EPERM were discarded) and the UI removed the row.
      const { name: bin, args: argv } =
        platform === 'win32'
          ? { name: 'taskkill', args: ['/PID', String(n), '/F'] }
          : { name: 'kill', args: [String(n)] };
      const { promise, resolve, reject } = (() => {
        let res!: (v: null) => void;
        let rej!: (e: Error) => void;
        const p = new Promise<null>((a, b) => { res = a; rej = b; });
        return { promise: p, resolve: res, reject: rej };
      })();
      execFile(bin, argv, { timeout: 2000 }, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(null);
      });
      await promise;
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });

  // ── Schedule / automation ─────────────────────────────────────────────────
  const scheduledTasks = new Map<string, NodeJS.Timeout>();
  ipcMain.handle('computer:scheduleTask', async (_e, task: {
    id: string; intervalMs: number; command: string; label: string;
  }) => {
    const { exec } = await import('child_process');
    if (scheduledTasks.has(task.id)) clearInterval(scheduledTasks.get(task.id)!);
    const interval = setInterval(() => {
      exec(task.command, { timeout: 10000 }, (err, stdout) => {
        const { getMainWindow } = require('../main');
        getMainWindow()?.webContents.send('computer:scheduledTask:result', {
          id: task.id, label: task.label, output: stdout, error: err?.message,
        });
      });
    }, task.intervalMs);
    scheduledTasks.set(task.id, interval);
    return { ok: true, scheduled: task.id };
  });
  ipcMain.handle('computer:unscheduleTask', async (_e, id: string) => {
    if (scheduledTasks.has(id)) { clearInterval(scheduledTasks.get(id)!); scheduledTasks.delete(id); }
    return { ok: true };
  });
  ipcMain.handle('computer:listScheduled', () => ({ tasks: [...scheduledTasks.keys()] }));

  ipcMain.handle('computer:newFolder', async (_event, params: { path: string }) => {
    try {
      const home = os.homedir();
      const username = home.split('/').pop() || '';
      const target = params.path
        .replace(/^~/, home)
        .replace(/\/Users\/yourusername\//g, home + '/')
        .replace(/\/Users\/your_username\//g, home + '/')
        .replace(/\/Users\/USERNAME\//g, home + '/')
        .replace(/\/Users\/${username.toLowerCase()}_user\//g, home + '/');
      fs.mkdirSync(target, { recursive: true });
      return { ok: true, path: target };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[computer:newFolder]', msg);
      return { ok: false, error: msg };
    }
  });

  // ── Type text (cross-platform) ──────────────────────────────────────────
  ipcMain.handle('computer:typeText', async (_event, text: string) => {
    try {
      // argv form only — the previous shell string let a backslash or a $(...)
      // inside the typed text escape the quotes and execute as a command.
      let cmd: string;
      let args: string[];
      if (platform === 'darwin') {
        const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        cmd = 'osascript';
        args = ['-e', `tell application "System Events" to keystroke "${escaped}"`];
      } else if (platform === 'linux') {
        cmd = 'xdotool';
        args = ['type', '--', text];
      } else if (platform === 'win32') {
        // Use PowerShell to send text
        const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
        cmd = 'powershell';
        args = ['-Command', `$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${escaped}')`];
      } else {
        return { success: false, error: `Unsupported platform: ${platform}` };
      }
      const result = await runBin(cmd, args, 10000);
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };
    } catch (e: unknown) {
      console.error('[computer:typeText]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Activate application (cross-platform) ──────────────────────────────────
  ipcMain.handle('computer:activateApplication', async (_event, appName: string) => {
    try {
      // argv form only. The old Linux branch escaped just the double quote, so
      // `$(...)`, backticks or a backslash in an app name executed as a command.
      let cmd: string;
      let args: string[];
      let fallback: { cmd: string; args: string[] } | null = null;
      if (platform === 'darwin') {
        cmd = 'osascript';
        args = ['-e', `tell application "${appName.replace(/"/g, '\\"')}" to activate`];
      } else if (platform === 'linux') {
        cmd = 'wmctrl';
        args = ['-a', appName];
        fallback = { cmd: 'xdotool', args: ['search', '--name', appName, 'windowactivate'] };
      } else if (platform === 'win32') {
        cmd = 'powershell';
        args = ['-Command', `(Get-Process -ProcessName '${appName.replace(/'/g, "''")}' | Where-Object {$_.MainWindowTitle}).ForEach({Set-ForegroundWindow $_.MainWindowHandle})`];
      } else {
        return { success: false, error: `Unsupported platform: ${platform}` };
      }
      let result = await runBin(cmd, args, 10000);
      if (result.exitCode !== 0 && fallback) {
        // `xdotool search --name X windowactivate` exits 0 even when it matched
        // nothing, so success must be judged on whether a window was found.
        const found = await runBin(fallback.cmd, ['search', '--name', appName], 5000);
        if (found.exitCode === 0 && found.stdout.trim()) {
          result = await runBin(fallback.cmd, ['windowactivate', '--sync', found.stdout.trim().split('\n')[0].trim()], 5000);
        } else {
          result = { stdout: '', stderr: `No window matching "${appName}"`, exitCode: 1 };
        }
      }
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };
    } catch (e: unknown) {
      console.error('[computer:activateApplication]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Focus AI input / address bar (cross-platform) ──────────────────────────
  ipcMain.handle('computer:focusAiInput', async (_event, appName: string) => {
    try {
      let cmd: string;
      if (platform === 'darwin') {
        // macOS: Cmd+L to focus address bar
        cmd = `osascript -e 'tell application "System Events" to keystroke "l" using command down'`;
      } else if (platform === 'linux') {
        // Linux: Ctrl+L to focus address bar
        cmd = `xdotool key ctrl+l`;
      } else if (platform === 'win32') {
        // Windows: Ctrl+L to focus address bar
        cmd = `powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('${appName.replace(/'/g, "''")}'); Start-Sleep -Milliseconds 200; $wshell.SendKeys('^l')"`;
      } else {
        return { success: false, error: `Unsupported platform: ${platform}` };
      }
      const result = await runCmd(cmd, 5000);
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };
    } catch (e: unknown) {
      console.error('[computer:focusAiInput]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Press a key (cross-platform) ───────────────────────────────────────────
  ipcMain.handle('computer:pressKey', async (_event, key: string) => {
    try {
      // argv form only — the previous `xdotool key ${key}` was unquoted, so the
      // key parameter was shell-interpreted.
      let cmd: string;
      let args: string[];
      if (platform === 'darwin') {
        // Map key names to macOS key codes
        const keyCodes: Record<string, string> = {
          'enter': '36',
          'return': '36',
          'escape': '53',
          'space': '49',
        };
        const keyCode = keyCodes[key.toLowerCase()] || key;
        cmd = 'osascript';
        args = ['-e', `tell application "System Events" to key code ${keyCode}`];
      } else if (platform === 'linux') {
        // Linux: use xdotool key names
        const keyMap: Record<string, string> = {
          'enter': 'Return',
          'return': 'Return',
          'tab': 'Tab',
          'escape': 'Escape',
          'space': 'space',
        };
        const xdotoolKey = keyMap[key.toLowerCase()] || key;
        cmd = 'xdotool';
        args = ['key', xdotoolKey];
      } else if (platform === 'win32') {
        // Windows: use PowerShell SendKeys
        const keyMap: Record<string, string> = {
          'enter': '~',
          'return': '~',
          'tab': '{TAB}',
          'escape': '{ESC}',
          'space': ' ',
        };
        // Escape for a PowerShell single-quoted string, exactly as typeText
        // does. Without this a key containing ' terminated the string and the
        // remainder was executed as PowerShell.
        const escapedKey = (keyMap[key.toLowerCase()] || key).replace(/'/g, "''");
        cmd = 'powershell';
        args = ['-Command', `$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${escapedKey}')`];
      } else {
        return { success: false, error: `Unsupported platform: ${platform}` };
      }
      const result = await runBin(cmd, args, 5000);
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };
    } catch (e: unknown) {
      console.error('[computer:pressKey]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Click at coordinates (requires Accessibility) ─────────────────────
  ipcMain.handle('computer:click', async (_event, params: { x: number; y: number; button?: string }) => {
    try {
      if (platform !== 'darwin') {
        return { success: false, error: 'Mouse control via AppleScript is macOS only.' };
      }
      const { x, y, button = 'primary' } = params;
      const btnStr = button === 'right' ? 'right' : '';
      const result = await runCmd(
        `osascript -e 'tell application "System Events" to ${btnStr ? 'right ' : ''}click at {${x}, ${y}}'`,
        10000
      );
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };    } catch (e: unknown) {
      console.error('[computer:click]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Get system info ───────────────────────────────────────────────────
  ipcMain.handle('computer:systemInfo', async () => {
    try {
      const { getSystemInfo } = await import('../../src/platform/system');
      const info = await getSystemInfo();
      return { success: true, ...info };
    } catch (e: unknown) {
      console.error('[computer:systemInfo]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

}