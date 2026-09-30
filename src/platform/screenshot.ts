/**
 * Cross-platform screenshot capture
 * Handles taking screenshots appropriately for each OS
 */

import { app } from 'electron';

/**
 * Screenshot result
 */
export interface ScreenshotResult {
  success: boolean;
  base64?: string;
  mimeType?: string;
  error?: string;
}


/** Read a captured PNG off disk, base64 it for the renderer, and delete it. */
async function readResult(file: string): Promise<ScreenshotResult> {
  const { readFileSync, unlinkSync } = await import('fs');
  const base64 = readFileSync(file).toString('base64');
  try { unlinkSync(file); } catch { /* best effort */ }
  return { success: true, base64, mimeType: 'image/png' };
}

/**
 * Ordered Linux/BSD screenshot backends.
 *
 * Exported so `computer:checkCapabilities` probes the SAME list capture uses.
 * Previously the probe advertised backends (gnome-screenshot, xfce4-screenshooter,
 * grim) that capture never invoked, and it only checked that a binary existed —
 * so it reported "ready" for tools that cannot actually grab a frame.
 */
export function screenshotCandidates(
  region: { x: number; y: number; w: number; h: number } | undefined,
  outFile: string,
): Array<{ cmd: string; args: string[]; name: string; region: boolean; window: boolean }> {
  if (region) {
    const { x, y, w, h } = region;
    const geom = `${w}x${h}+${x}+${y}`;
    return [
      // scrot needs `-a X,Y,W,H`; a bare `-X,Y,W,H` is not valid and always failed.
      { cmd: 'scrot', args: ['-a', `${x},${y},${w},${h}`, outFile], name: 'scrot', region: true, window: false },
      // gnome-screenshot's area option is WIDTHxHEIGHT+X+Y (not scrot's X,Y,W,H).
      { cmd: 'gnome-screenshot', args: ['-a', geom, '-f', outFile], name: 'gnome-screenshot', region: true, window: true },
      { cmd: 'xfce4-screenshooter', args: ['--region', geom, '-f', outFile], name: 'xfce4-screenshooter', region: true, window: true },
      { cmd: 'grim', args: ['-g', geom, outFile], name: 'grim', region: true, window: false },
    ];
  }
  return [
    { cmd: 'scrot', args: [outFile], name: 'scrot', region: true, window: false },
    { cmd: 'gnome-screenshot', args: ['-f', outFile], name: 'gnome-screenshot', region: true, window: true },
    { cmd: 'xfce4-screenshooter', args: ['-f', outFile], name: 'xfce4-screenshooter', region: true, window: true },
    { cmd: 'grim', args: [outFile], name: 'grim', region: true, window: false },
  ];
}

/**
 * Actually attempt a capture with the given candidate and report whether it
 * produced a real PNG. Used by the capability probe so "ready" means "works".
 */
async function candidateCaptures(
  cand: { cmd: string; args: string[] },
  spawn: typeof import('child_process').spawn,
  existsSync: (p: string) => boolean,
  unlinkSync: (p: string) => void,
  file: string,
): Promise<boolean> {
  const res = await new Promise<{ exitCode: number }>((resolve) => {
    const child = spawn(cand.cmd, cand.args);
    child.on('error', () => resolve({ exitCode: -1 }));
    child.on('close', (code: number | null) => resolve({ exitCode: code ?? -1 }));
  });
  const wrote = existsSync(file);
  if (wrote) unlinkSync(file);
  return res.exitCode === 0 && wrote;
}

/**
 * Functional probe: find the first screenshot backend that really works here.
 * Returns null when none do — which is the honest answer, and what the UI
 * should show.
 */
export async function probeScreenshotBackend(): Promise<{ name: string; region: boolean; window: boolean } | null> {
  const { spawn } = await import('child_process');
  const { existsSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  for (const region of [undefined, { x: 0, y: 0, w: 8, h: 8 }]) {
    const file = join(tmpdir(), `henry_probe_${process.pid}_${Date.now()}.png`);
    for (const cand of screenshotCandidates(region, file)) {
      try {
        if (await candidateCaptures(cand, spawn, existsSync, unlinkSync, file)) {
          return { name: cand.name, region: cand.region, window: cand.window };
        }
      } catch { /* try the next backend */ }
    }
    try { if (existsSync(file)) unlinkSync(file); } catch { /* best effort */ }
  }
  return null;
}

/**
 * Takes a screenshot of the entire screen or a region
 * @param region - Optional region to capture (x, y, width, height)
 * @returns Promise resolving to screenshot result
 */
export async function captureScreenshot(region?: { x: number; y: number; w: number; h: number }): Promise<ScreenshotResult> {
  const { spawn } = await import('child_process');
  const { join } = await import('path');
  const { tmpdir } = require('os');
  let platformString: string;
  if (typeof window !== 'undefined') {
    // Renderer: use the value exposed by the preload contextBridge
    platformString = window.henryAPI.platform();
  } else {
    // Main process: use Node's os.platform directly
    const os = require('os');
    platformString = os.platform();
  }
  const { existsSync, unlinkSync } = await import('fs');

  const tmpFile = join(tmpdir(), `henry_screenshot_${Date.now()}.png`);

  try {
    let command: string;
    let args: string[] = [];

    if (platformString === 'darwin') {
      // macOS: use screencapture
      if (region) {
        const { x, y, w, h } = region;
        command = 'screencapture';
        args = ['-x', `-R${x},${y},${w},${h}`, tmpFile];
      } else {
        command = 'screencapture';
        args = ['-x', tmpFile];
      }
    } else if (platformString === 'win32') {
      // Windows: use PowerShell screenshot method
      if (region) {
        const { x, y, w, h } = region;
        command = 'powershell';
        args = [
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${tmpFile}') }`
        ];
      } else {
        command = 'powershell';
        args = [
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${tmpFile}') }`
        ];
      }
    } else {
      // Try each backend in order until one actually writes the file. The list
      // comes from screenshotCandidates(), which the capability probe also
      // uses — so "ready" can never describe a backend capture cannot use.
      const candidates = screenshotCandidates(region, tmpFile);

      const errors: string[] = [];
      let captured = false;
      for (const cand of candidates) {
        const res = await new Promise<{ stderr: string; exitCode: number }>((resolve) => {
          const child = spawn(cand.cmd, cand.args);
          let stderr = '';
          child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.on('error', (err: Error) => resolve({ stderr: err.message, exitCode: -1 }));
          child.on('close', (code: number) => resolve({ stderr, exitCode: code }));
        });
        if (res.exitCode === 0 && existsSync(tmpFile)) { captured = true; break; }
        errors.push(`${cand.cmd}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
        try { unlinkSync(tmpFile); } catch { /* nothing was written */ }
      }
      if (!captured) {
        throw new Error(
          `No screenshot backend could capture the screen. Tried:\n${errors.join('\n')}`,
        );
      }
      return readResult(tmpFile);
    }

    // Execute the command
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('close', (code: number) => resolve({ stdout, stderr, exitCode: code }));
      child.on('error', (err: Error) => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
    });

    if (result.exitCode !== 0) {
      throw new Error(`Screenshot command failed: ${result.stderr}`);
    }

    if (!existsSync(tmpFile)) {
      throw new Error('Screenshot file was not created');
    }

    return readResult(tmpFile);
  } catch (err) {
    // Clean up temp file if it exists
    if (existsSync(tmpFile)) {
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * IPC registration for screenshot operations
 */
export function registerPlatformScreenshotHandlers() {
  // Note: The actual IPC handling will be done in the computer.ts file
  // This is just for consistency with other platform modules
}