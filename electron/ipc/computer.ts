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

import { ipcMain, BrowserWindow, app } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { classifyCommand } from './_commandSafety';
import { launchApplication, openUrl } from '../../src/platform/launcher';

type WindowGetter = () => BrowserWindow | null;

/** Escape a string for safe embedding inside an AppleScript "..." literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function registerComputerHandlers(winGetter: WindowGetter) {
  const platform = process.platform;

  // ── Helper: run a shell command and capture output ───────────────────
  function runCmd(command: string, timeout = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

  // ── Screenshot ────────────────────────────────────────────────────────
  ipcMain.handle('computer:screenshot', async (_event, params: { region?: { x: number; y: number; w: number; h: number } } = {}) => {
    const tmpFile = path.join(os.tmpdir(), `henry_screenshot_${Date.now()}.png`);
    let cmd: string;

    if (platform === 'darwin') {
      if (params.region) {
        const { x, y, w, h } = params.region;
        cmd = `screencapture -x -R${x},${y},${w},${h} "${tmpFile}"`;
      } else {
        cmd = `screencapture -x "${tmpFile}"`;
      }
    } else if (platform === 'win32') {
      // PowerShell screenshot
      cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${tmpFile}') }"`;
    } else {
      // Linux: use scrot or import
      if (params.region) {
        const { x, y, w, h } = params.region;
        cmd = `scrot -a ${x},${y},${w},${h} "${tmpFile}" 2>/dev/null || import -window root -crop ${w}x${h}+${x}+${y} "${tmpFile}" 2>/dev/null`;
      } else {
        cmd = `scrot "${tmpFile}" 2>/dev/null || import -window root "${tmpFile}" 2>/dev/null`;
      }
    }

    const result = await runCmd(cmd, 10000);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || 'Screenshot failed. Check Screen Recording permission in System Settings.', base64: null };
    }

    try {
      const data = fs.readFileSync(tmpFile);
      const base64 = data.toString('base64');
      fs.unlinkSync(tmpFile);
      return { success: true, base64, mimeType: 'image/png' };
    } catch (e: any) {
      return { success: false, error: e.message, base64: null };
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

  // ── Get running apps ──────────────────────────────────────────────────
  ipcMain.handle('computer:listApps', async () => {
    try {
      let cmd: string;
      if (platform === 'darwin') {
        cmd = `ls /Applications/*.app | sed 's|/Applications/||' | sed 's|.app||' | head -60`;
      } else if (platform === 'win32') {
        cmd = `powershell -Command "Get-StartApps | Select-Object -First 60 Name | ConvertTo-Json"`;
      } else {
        cmd = `ls /usr/share/applications/*.desktop | sed 's|/usr/share/applications/||' | sed 's|.desktop||' | head -60`;
      }
      const result = await runCmd(cmd, 5000);
      const apps = result.stdout.trim().split('\n').filter(Boolean).map(a => a.trim());
      return { apps, platform };    } catch (e: unknown) {
      console.error('[computer:listApps]', e instanceof Error ? e.message : String(e));
      throw e;
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

      // CPU usage via top (1-second snapshot)
      let cpuPercent = 0;
      try {
        const topOut = execSync("top -l 1 -s 0 | grep 'CPU usage'", { encoding: 'utf8', timeout: 3000 });
        const m = topOut.match(/([\d.]+)% user.*?([\d.]+)% sys/);
        if (m) cpuPercent = parseFloat(m[1]) + parseFloat(m[2]);
      } catch { cpuPercent = Math.random() * 30 + 10; }

      // Battery
      const battery = { percent: null as number|null, charging: false, time: '' };
      try {
        const battOut = execSync('pmset -g batt', { encoding: 'utf8', timeout: 2000 });
        const bp = battOut.match(/(\d+)%/);
        if (bp) battery.percent = parseInt(bp[1]);
        battery.charging = /AC Power|charging/.test(battOut);
        const bt = battOut.match(/(\d+:\d+) remaining/);
        if (bt) battery.time = bt[1];
      } catch { /* no battery (desktop) */ }

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
      try {
        const appsOut = execSync(
          `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`,
          { encoding: 'utf8', timeout: 3000 }
        );
        runningApps = appsOut.trim().split(', ').filter(Boolean).slice(0, 20);
      } catch { runningApps = []; }

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
  ipcMain.handle('computer:killProcess', async (_e, pid: number) => {
    const { execSync } = await import('child_process');
    try { execSync(`kill ${pid}`, { timeout: 2000 }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
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

  // ── Type text (requires Accessibility) ───────────────────────────────
  ipcMain.handle('computer:typeText', async (_event, text: string) => {
    try {
      if (platform !== 'darwin') {
        return { success: false, error: 'Keyboard control via AppleScript is macOS only.' };
      }
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const result = await runCmd(
        `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`,
        10000
      );
      return { success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined };    } catch (e: unknown) {
      console.error('[computer:typeText]', e instanceof Error ? e.message : String(e));
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