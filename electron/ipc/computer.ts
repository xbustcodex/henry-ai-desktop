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
import { guardedEvent } from './validation';
import { safeResolve } from './_pathSafety';
import { detectLinuxSession, isWaylandSession } from './sessionDetect';
import { launchApplication, openUrl } from '../../src/platform/launcher';
import { discoverInstalledApps, InstalledApp } from '../../src/platform/installedApps';
import {
  performKeyPress,
  performMouseAction,
  performTypeText,
  measureScreenBounds,
  probeInputBackend,
  disposeInputHelper,
  type MouseAction,
  type ScreenBounds,
} from '../../src/platform/inputAutomation';
import * as files from '../../src/platform/fileOps';
import {
  AUTOMATION_ACTIONS,
  buildActionPlan,
  findAction,
  listActions,
  localInterfaces,
  lookupPublicIp,
  screenshotDirectory,
  timestampSlug,
} from '../../src/platform/automationActions';

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

/** Guards the one-time quit hook in registerComputerHandlers. */
let inputHelperCleanupRegistered = false;

/** `eth0 192.168.1.5, wlan0 10.0.0.4` — compact, and never a shell word. */
function describeInterfaces(list: ReturnType<typeof localInterfaces>): string {
  const external = list.filter((i) => i.family === 'IPv4' && !i.internal);
  return external.map((i) => `${i.name} ${i.address}`).join(', ')
    || 'none (no external IPv4 interface)';
}

export function registerComputerHandlers(winGetter: WindowGetter) {
  const platform = process.platform;

  // The file adapter is typed to the three platforms Henry ships for, which is
  // narrower than NodeJS.Platform ('aix', 'android', …). Anything else falls
  // back to the POSIX behaviour rather than reaching the adapter as a lie.
  const hostPlatform: files.FilePlatform =
    platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';

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


  // ── Shared input-automation probe ────────────────────────────────────────
  // One probe for every platform so the capability report and the handlers can
  // never disagree: `computer:click` runs the same backend this describes, and
  // `ready` now means "verified", not "assumed".
  async function describeInputBackend(): Promise<{
    status: 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable';
    backend?: string;
    details: string;
  }> {
    try {
      const probe = await probeInputBackend();
      return { status: probe.status, backend: probe.backend, details: probe.details };
    } catch (e: unknown) {
      return { status: 'unavailable', details: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Resolve a user-supplied path inside the home directory, or explain why not.
   *
   * Every file handler below goes through this. It delegates the traversal,
   * sibling-prefix and symlink decisions to the shared `safeResolve`, so the
   * confinement rule lives in exactly one place.
   */
  function confinedPath(requested: unknown): files.ConfineOutcome {
    return files.confineToHome(requested, os.homedir(), hostPlatform, safeResolve);
  }
  // ── Screenshot ────────────────────────────────────────────────────────
  // Delegates to the shared capture implementation so this handler and the
  // capability probe use the SAME backend ladder. It used to shell out to
  // `scrot || import` while the probe advertised a four-backend list, so a
  // "ready" capability could describe a backend this handler never ran.
  ipcMain.handle('computer:screenshot', guardedEvent('computer:screenshot', async (_event, params: { region?: { x: number; y: number; w: number; h: number } } = {}) => {
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
  }));

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
  ipcMain.handle('computer:openApp', guardedEvent('computer:openApp', async (_event, appName: string) => {
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
  }));

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
      // argv form only. The old shell string had to escape every single quote
      // in the caller's script by hand; argv removes the whole class of bug.
      const result = await runBin('osascript', ['-e', script], 30000);
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
  ipcMain.handle('computer:runShell', guardedEvent('computer:runShell', async (_event, params: { command: string; timeout?: number }) => {
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
  }));

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
        // `head` is a Unix command and is not present on Windows, so this
        // silently produced an empty process list there. Select the rows instead.
        cmd = `tasklist /FO CSV /NH`;
      } else {
        cmd = `ps aux | awk 'NR>1 {print $11}' | sort -u | head -40`;
      }
      const result = await runCmd(cmd, 5000);
      const rows = result.stdout.trim().split('\n').filter(Boolean).slice(0, 40);
      // Windows CSV rows lead with the image name; keep that, drop the rest.
      const processes =
        platform === 'win32'
          ? rows.map((r) => (r.split(',')[0] || r).replace(/^"/, '').trim()).filter(Boolean)
          : rows;
      return { processes };    } catch (e: unknown) {
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

        // Input automation: same probed backend, so macOS reports what the
        // shared adapter can actually do rather than a hardcoded claim.
        inputAutomationStatus = await describeInputBackend();

      } else if (platform === 'linux') {
        // Linux: check available backends
        const checkBin = async (bins: string[]): Promise<string | null> => {
          for (const b of bins) {
            try {
              await new Promise<void>((resolve, reject) => {
                // `which` is absent on Windows; whichBin uses `where`.
                execFile(process.platform === 'win32' ? 'where' : 'which', [b], { timeout: 3000 }, (err) => { if (err) reject(err); else resolve(); });
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

        // Input automation — PROBED, like the screenshot backend.
        //
        // This used to report `ready` whenever `wmctrl` happened to be
        // installed, which advertised pointer control on a machine with no
        // input tool at all. probeInputBackend actually tests the backend.
        inputAutomationStatus = await describeInputBackend();

      } else if (platform === 'win32') {
        // Windows
        // Clipboard: Electron works, also PowerShell
        clipboardStatus = { status: 'ready', backend: 'electron', details: 'Electron clipboard API + PowerShell Get-Clipboard/Set-Clipboard' };

        // Selected text: Ctrl+C simulation through the real input backend.
        // The old claim here was "PowerShell SendKeys", which cannot click
        // and mis-parses `+^%~(){}` as syntax.
        selectedTextStatus = { status: 'ready', backend: 'win32 SendInput', details: 'Ctrl+C simulation via Win32 SendInput' };

        // Screen capture: PowerShell System.Drawing
        screenCaptureStatus = { status: 'ready', backend: 'powershell', details: 'PowerShell System.Drawing bitmap capture', regionCapture: false, windowCapture: false };

        // Input automation: verified by a live user32.dll round trip. This
        // branch used to be an unconditional `ready` — it never ran anything,
        // so a machine where the shim would not compile still claimed control.
        inputAutomationStatus = await describeInputBackend();
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
        // Windows: Ctrl+C through the verified Win32 SendInput backend.
        // This used to go through WScript.Shell.SendKeys, the same string
        // parser that could not click and mis-parsed `^ % ~ ( ) { }`. Going
        // through the shared adapter also means the capability report and this
        // handler exercise the same code path.
        const originalText = clipboard.readText();

        const sent = await performKeyPress('ctrl+c');
        if (!sent.success) {
          console.warn('[captureSelectedText] Ctrl+C failed:', sent.error);
        }

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
    if (typeof opts?.title !== 'string' || !opts.title.trim()) {
      return { ok: false, error: 'A notification needs a title.' };
    }
    // The error and backend come back too. A bare `{ok:false}` is how
    // `computer:notify` ended up "not confirmed working" on the installed
    // build: nothing said that BurntToast was not installed and that the
    // fallback was a modal dialog.
    const result = await showNotification(opts.title, typeof opts.body === 'string' ? opts.body : undefined);
    return { ok: result.success, error: result.error, backend: result.backend };
  });

  // ── Desktop mode toggle ───────────────────────────────────────────────────
  ipcMain.handle('computer:desktopMode', async (_e, opts: { enable: boolean; fullscreen?: boolean }) => {
    const { getMainWindow } = await import('../main');
    const win = getMainWindow();
    if (!win) return { ok: false };
    if (opts.enable) {
      win.setAlwaysOnTop(false);
      win.setFullScreen(true);
      // macOS-only API; calling it on Windows/Linux throws.
      if (typeof win.setWindowButtonVisibility === 'function') win.setWindowButtonVisibility(false);
      win.setBackgroundColor('#00000000');
      // On macOS: send window behind others
      win.webContents.executeJavaScript('document.body.setAttribute("data-desktop-mode","1")').catch(()=>{});
    } else {
      win.setFullScreen(false);
      if (typeof win.setWindowButtonVisibility === 'function') win.setWindowButtonVisibility(true);
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
  //
  // The old handler handed `task.command` straight to `exec` on a timer, with
  // no classifier in front of it. `computer:runShell` refuses a fork bomb, a
  // Windows forced system delete and a volume format; scheduling the same
  // string bypassed every one of those checks and just ran it on a loop. It
  // also took an unvalidated `intervalMs`, so `0` (or `NaN`) became a
  // process-spawn loop.
  interface ScheduledEntry {
    id: string;
    label: string;
    command: string;
    intervalMs: number;
    runs: number;
    lastRunAt: number | null;
    lastError: string | null;
    running: boolean;
    timer: NodeJS.Timeout;
  }

  const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
  const MIN_INTERVAL_MS = 5_000;
  const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const scheduledTasks = new Map<string, ScheduledEntry>();


  // The Windows input helper is a child PowerShell process. Electron exiting
  // does not reap it on Windows, so shut it down explicitly rather than
  // leaving an idle PowerShell behind after every quit.
  if (!inputHelperCleanupRegistered) {
    inputHelperCleanupRegistered = true;
    app.once('before-quit', () => { disposeInputHelper(); });
  }
  function publishScheduledResult(entry: ScheduledEntry, output: string, error?: string): void {
    const win = winGetter();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('computer:scheduledTask:result', {
      id: entry.id,
      label: entry.label,
      output,
      error,
    });
  }

  async function runScheduledNow(entry: ScheduledEntry): Promise<void> {
    if (entry.running) {
      publishScheduledResult(entry, '', 'Skipped: the previous run is still going.');
      return;
    }
    entry.running = true;
    entry.runs += 1;
    entry.lastRunAt = Date.now();
    try {
      const r = await runCmd(entry.command, 60_000);
      entry.lastError = r.exitCode === 0 ? null : r.stderr.trim().slice(0, 500) || `exit ${r.exitCode}`;
      publishScheduledResult(entry, r.stdout.slice(0, 100_000), entry.lastError ?? undefined);
    } catch (e: unknown) {
      entry.lastError = e instanceof Error ? e.message : String(e);
      publishScheduledResult(entry, '', entry.lastError);
    } finally {
      entry.running = false;
    }
  }

  ipcMain.handle('computer:scheduleTask', guardedEvent('computer:scheduleTask', async (_e, task: {
    id: string; intervalMs: number; command: string; label: string;
  }) => {
    if (typeof task?.id !== 'string' || !SCHEDULE_ID_PATTERN.test(task.id)) {
      return { ok: false, error: 'A task id of 1–64 letters, digits, dot, dash, colon or underscore is required.' };
    }
    if (typeof task?.command !== 'string' || !task.command.trim()) {
      return { ok: false, error: 'A command is required.' };
    }
    if (typeof task.label !== 'string' || task.label.length > 200) {
      return { ok: false, error: 'A label of at most 200 characters is required.' };
    }
    if (!Number.isInteger(task?.intervalMs) || task.intervalMs < MIN_INTERVAL_MS || task.intervalMs > MAX_INTERVAL_MS) {
      return {
        ok: false,
        error: `intervalMs must be a whole number of milliseconds between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}.`,
      };
    }

    // Same classifier as computer:runShell and terminal:exec — a scheduled
    // task must not be a way around them.
    const verdict = classifyCommand(task.command);
    if (verdict.blocked) {
      return { ok: false, error: `Command blocked for safety: ${verdict.reason}.` };
    }

    const existing = scheduledTasks.get(task.id);
    if (existing) clearInterval(existing.timer);

    const entry: ScheduledEntry = {
      id: task.id,
      label: task.label.trim(),
      command: task.command,
      intervalMs: task.intervalMs,
      runs: existing?.runs ?? 0,
      lastRunAt: existing?.lastRunAt ?? null,
      lastError: existing?.lastError ?? null,
      running: false,
      timer: setInterval(() => { void runScheduledNow(entry); }, task.intervalMs),
    };
    scheduledTasks.set(task.id, entry);
    return { ok: true, scheduled: task.id };
  }));

  ipcMain.handle('computer:runScheduledTask', guardedEvent('computer:runScheduledTask', async (_e, id: string) => {
    const entry = scheduledTasks.get(id);
    if (!entry) return { ok: false, error: 'No such scheduled task.' };
    await runScheduledNow(entry);
    return { ok: true, runs: entry.runs, lastError: entry.lastError };
  }));

  ipcMain.handle('computer:unscheduleTask', guardedEvent('computer:unscheduleTask', async (_e, id: string) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'A task id is required.' };
    const entry = scheduledTasks.get(id);
    if (entry) { clearInterval(entry.timer); scheduledTasks.delete(id); }
    return { ok: true, removed: Boolean(entry) };
  }));

  // Used to return bare ids, so the UI could show a name but not the command,
  // the interval or whether the last run had failed.
  ipcMain.handle('computer:listScheduled', () => ({
    tasks: [...scheduledTasks.values()].map(({ timer: _timer, ...rest }) => rest),
  }));

  // ── Automation actions (row 7.10) ────────────────────────────────────────
  // The HQ "One-click Automations" grid used to assemble a shell string in the
  // renderer and fire it at computer:runShell. The catalogue now lives in one
  // place with the exact argv per platform, and everything that changes the
  // machine is `confirm` tier.
  ipcMain.handle('computer:automationActions', () => ({
    platform,
    actions: listActions(hostPlatform),
  }));

  ipcMain.handle('computer:runAutomationAction', guardedEvent('computer:runAutomationAction', async (_e, params: {
    action: string; confirmed?: boolean; publicIp?: boolean;
  }) => {
    const action = findAction(params?.action);
    if (!action) {
      const known = AUTOMATION_ACTIONS.map((a) => a.id).join(', ');
      return { ok: false, error: `Unknown automation action. Available: ${known}.` };
    }

    const plan = buildActionPlan(action, hostPlatform, { confirmed: params?.confirmed === true });
    if (!plan.ok) {
      return { ok: false, error: plan.error, needsConfirmation: action.mutatesSystem };
    }

    // Builtins run inside Electron rather than in a child process.
    if (plan.value.builtin === 'clearClipboard') {
      const { clipboard } = await import('electron');
      clipboard.clear();
      return { ok: true, output: 'Clipboard cleared.', action: action.id, tier: action.tier };
    }
    if (plan.value.builtin === 'showIp') {
      const local = localInterfaces();
      let publicAddress: string | null = null;
      if (params?.publicIp === true) {
        try {
          publicAddress = await lookupPublicIp();
        } catch (e: unknown) {
          publicAddress = null;
          return {
            ok: false,
            error: `Local addresses: ${describeInterfaces(local)}. The public lookup failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      return {
        ok: true,
        action: action.id,
        tier: action.tier,
        output: `Local addresses: ${describeInterfaces(local)}${publicAddress ? `\nPublic address: ${publicAddress}` : ''}`,
      };
    }
    if (plan.value.builtin === 'screenshot') {
      const { captureScreenshot } = await import('../../src/platform/screenshot');
      const shot = await captureScreenshot();
      if (!shot.success || !shot.base64) {
        return { ok: false, error: shot.error || 'The screen could not be captured.' };
      }
      const dir = confinedPath(screenshotDirectory(os.homedir(), hostPlatform));
      if (!dir.ok) return { ok: false, error: dir.error };
      const made = files.createFolder(dir.path);
      if (!made.ok) return { ok: false, error: made.error };
      const target = path.join(made.path, `HenryCapture_${timestampSlug()}.png`);
      try {
        fs.writeFileSync(target, Buffer.from(shot.base64, 'base64'));
      } catch (e: unknown) {
        return { ok: false, error: `Captured the screen but could not save it: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, action: action.id, tier: action.tier, path: target, output: `Saved to ${target}` };
    }
    const command = plan.value.plan;
    if (!command) {
      return { ok: false, error: `"${action.label}" produced no runnable plan on this platform.` };
    }
    const { cmd, args, capture } = command;
    const result = await runBin(cmd, args, 30_000);
    return {
      ok: result.exitCode === 0,
      action: action.id,
      tier: action.tier,
      command: [cmd, ...args].join(' '),
      output: capture === 'stdout' ? result.stdout.slice(0, 100_000) : '',
      error: result.exitCode === 0 ? undefined : result.stderr.trim() || `exit ${result.exitCode}`,
    };
  }));


  // ── File operations (row 7.6) ────────────────────────────────────────────
  // Every path below goes through confinedPath() first, which expands `~`,
  // rejects Win32 syntax that would alias to another name, and delegates the
  // confinement decision to the shared safeResolve. Nothing below ever sees a
  // path that has not been through it.

  ipcMain.handle('computer:newFolder', guardedEvent('computer:newFolder', async (_event, params: { path: string }) => {
    // This resolved whatever it was given and created it. `../../../escape-test`
    // made a folder outside the user's home during the Card 7 walk.
    const resolved = confinedPath(params?.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const created = files.createFolder(resolved.path);
    if (!created.ok) return { ok: false, error: created.error };
    return { ok: true, path: created.path, existed: created.existed === true };
  }));

  ipcMain.handle('computer:fileBrowse', guardedEvent('computer:fileBrowse', async (_event, params?: { path?: string; showHidden?: boolean; limit?: number }) => {
    // Defaults to the home directory, which is the confinement root.
    const requested = typeof params?.path === 'string' && params.path.trim() ? params.path : '~';
    const resolved = confinedPath(requested);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return files.browseDirectory(resolved.path, {
      showHidden: params?.showHidden === true,
      limit: typeof params?.limit === 'number' ? params.limit : undefined,
    });
  }));

  ipcMain.handle('computer:fileSearch', guardedEvent('computer:fileSearch', async (_event, params: {
    query?: string; root?: string; includeHidden?: boolean; content?: boolean;
    maxDepth?: number; maxResults?: number;
  }) => {
    if (typeof params?.query !== 'string' || !params.query.trim()) {
      return { ok: false, error: 'A search term is required.' };
    }
    const requested = typeof params.root === 'string' && params.root.trim() ? params.root : '~';
    const resolved = confinedPath(requested);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return files.searchPath(resolved.path, {
      query: params.query,
      includeHidden: params.includeHidden === true,
      content: params.content === true,
      maxDepth: params.maxDepth,
      maxResults: params.maxResults,
    });
  }));

  ipcMain.handle('computer:fileCopy', guardedEvent('computer:fileCopy', async (_event, params: { from: string; to: string; overwrite?: boolean }) => {
    const from = confinedPath(params?.from);
    if (!from.ok) return { ok: false, error: from.error };
    const to = confinedPath(params?.to);
    if (!to.ok) return { ok: false, error: to.error };
    return files.copyPath({ from: from.path, to: to.path, overwrite: params.overwrite === true, platform: hostPlatform });
  }));

  ipcMain.handle('computer:fileMove', guardedEvent('computer:fileMove', async (_event, params: { from: string; to: string; overwrite?: boolean }) => {
    const from = confinedPath(params?.from);
    if (!from.ok) return { ok: false, error: from.error };
    const to = confinedPath(params?.to);
    if (!to.ok) return { ok: false, error: to.error };
    return files.movePath({ from: from.path, to: to.path, overwrite: params.overwrite === true, platform: hostPlatform });
  }));

  ipcMain.handle('computer:fileRename', guardedEvent('computer:fileRename', async (_event, params: { path: string; newName: string }) => {
    const target = confinedPath(params?.path);
    if (!target.ok) return { ok: false, error: target.error };
    if (typeof params?.newName !== 'string') return { ok: false, error: 'A new name is required.' };
    return files.renamePath(target.path, params.newName, hostPlatform);
  }));

  ipcMain.handle('computer:fileDelete', guardedEvent('computer:fileDelete', async (_event, params: {
    path: string; recursive?: boolean; permanent?: boolean; confirmed?: boolean;
  }) => {
    // Delete protection, in order: refuse protected targets unconditionally,
    // then require confirmation, then trash rather than unlink. See
    // evaluateDeleteRequest in src/platform/fileOps.ts.
    //
    // There is deliberately NO policy switch in front of this. `confinedPath`
    // refuses to produce an outside-home path, and `evaluateDeleteRequest`
    // independently refuses any target whose real location is outside home —
    // both unconditionally, before `confirmed` is consulted. So an outside-home
    // delete has exactly one possible answer, and a "confirm before deleting
    // outside home" toggle could only have been either a no-op or a licence to
    // delete anywhere. It was removed rather than wired to something.
    const resolved = confinedPath(params?.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const decision = files.evaluateDeleteRequest({
      target: resolved.path,
      home: os.homedir(),
      platform: hostPlatform,
      recursive: params?.recursive === true,
      permanent: params?.permanent === true,
      confirmed: params?.confirmed === true,
      requireExists: true,
    });
    if (!decision.ok) {
      return {
        ok: false,
        error: decision.error,
        needsConfirmation: decision.needsConfirmation === true,
        summary: decision.summary,
      };
    }
    const done = await files.executeDelete(decision, hostPlatform);
    if (!done.ok) return { ok: false, error: done.error };
    return { ok: true, path: done.path, recoverable: done.recoverable === true };
  }));

  // ── Type text (cross-platform, real input backend) ──────────────────────
  ipcMain.handle('computer:typeText', guardedEvent('computer:typeText', async (_event, text: string) => {
    // Validated: this handler used to call text.replace() unguarded, so an
    // object arriving here threw a raw TypeError that surfaced in the
    // renderer as an unhandled rejection.
    if (typeof text !== 'string' || text.length === 0) {
      return { success: false, error: 'Text to type must be a non-empty string.' };
    }
    if (text.length > 32_000) {
      return { success: false, error: 'Text to type is too long.' };
    }
    // argv form only, on every platform. The previous Windows branch pushed
    // the text through WScript.Shell.SendKeys, which reads `+ ^ % ~ ( ) { }`
    // as syntax: typing `total (net)` threw or produced the wrong characters,
    // and a `'` or a backtick broke out of the PowerShell string. The Windows
    // backend is now SendInput with KEYEVENTF_UNICODE, which needs no escaping.
    const result = await performTypeText(text);
    return { success: result.success, error: result.error, backend: result.backend };
  }));

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
      // argv form only. The Windows branch used to interpolate appName into a
      // `sh -c`/`cmd /c` string with nothing but quote doubling, so a window
      // title containing `& calc` ran a command.
      let cmd: string;
      let args: string[];
      if (platform === 'darwin') {
        // macOS: Cmd+L to focus the address bar
        cmd = 'osascript';
        args = ['-e', 'tell application "System Events" to keystroke "l" using command down'];
      } else if (platform === 'linux') {
        // Linux: Ctrl+L to focus the address bar
        cmd = 'xdotool';
        args = ['key', 'ctrl+l'];
      } else if (platform === 'win32') {
        // Windows: Ctrl+L to focus the address bar, after activating the window
        const activated = appName.replace(/'/g, "''");
        cmd = 'powershell';
        args = [
          '-NoProfile', '-NonInteractive', '-Command',
          "$wshell = New-Object -ComObject wscript.shell; "
            + `$wshell.AppActivate('${activated}'); Start-Sleep -Milliseconds 200; $wshell.SendKeys('^l')`,
        ];
      } else {
        return { success: false, error: `Unsupported platform: ${platform}` };
      }
      const result = await runBin(cmd, args, 5000);
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };
    } catch (e: unknown) {
      console.error('[computer:focusAiInput]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // ── Press a key (cross-platform, real input backend) ──────────────────────
  ipcMain.handle('computer:pressKey', guardedEvent('computer:pressKey', async (_event, payload: unknown) => {
    // Same unguarded-call problem as typeText, plus two optional arguments:
    // a `ctrl+shift+t`-style chord and a repeat count. A bare string — which
    // is what preload sends today — still works unchanged.
    let expression: unknown = payload;
    let repeat: unknown;
    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      expression = p.key ?? p.name ?? p.keys;
      repeat = p.repeat ?? p.count;
    }
    if (typeof expression !== 'string' || expression.length === 0) {
      return { success: false, error: 'A key name string is required.' };
    }
    if (typeof expression !== 'string' || expression.length === 0) {
      return { success: false, error: 'A key name string is required.' };
    }
    if (expression.length > 64) {
      return { success: false, error: 'Key name is too long.' };
    }
    // argv form only, and the key must resolve to a token this platform can
    // actually press. The previous Windows branch interpolated the caller's
    // string into a PowerShell literal and handed it to SendKeys, so `{` and
    // `+` were syntax and a `'` ended the string.
    const result = await performKeyPress(expression, repeat);
    return { success: result.success, error: result.error, backend: result.backend };
  }));

  // ── Mouse: move, click, double-click, scroll, drag ───────────────────────
  ipcMain.handle('computer:mouse', guardedEvent('computer:mouse', async (_event, params: Record<string, unknown>) => {
    const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const action = typeof raw.action === 'string' ? (raw.action.trim().toLowerCase() as MouseAction) : 'click';
    if (!['move', 'click', 'doubleClick', 'scroll', 'drag'].includes(action)) {
      return {
        success: false,
        error: `Unknown mouse action "${String(raw.action).slice(0, 24)}". Use move, click, doubleClick, scroll or drag.`,
      };
    }
    const bounds = await measureScreenBounds();
    const result = await performMouseAction(action, {
      x: raw.x,
      y: raw.y,
      button: raw.button,
      clicks: raw.clicks,
      deltaX: raw.deltaX,
      deltaY: raw.deltaY,
      toX: raw.toX,
      toY: raw.toY,
    }, { bounds });
    return { success: result.success, error: result.error, backend: result.backend, bounds };
  }));

  // ── Click at coordinates ─────────────────────────────────────────────────
  ipcMain.handle('computer:click', guardedEvent('computer:click', async (_event, params: { x: number; y: number; button?: string }) => {
    // This was macOS-only and answered "Mouse control via AppleScript is macOS
    // only." everywhere else, while the capability probe advertised Windows
    // input automation as ready. It now drives the real backend on every
    // platform, and the coordinates — which reach an AppleScript string on
    // macOS and SetCursorPos everywhere else — are validated and clamped to
    // the measured desktop before anything runs.
    const bounds = await measureScreenBounds();
    const result = await performMouseAction('click', {
      x: params?.x,
      y: params?.y,
      button: params?.button,
    }, { bounds });
    return { success: result.success, error: result.error, backend: result.backend };
  }));


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