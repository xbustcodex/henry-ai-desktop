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

/**
 * Takes a screenshot of the entire screen or a region
 * @param region - Optional region to capture (x, y, width, height)
 * @returns Promise resolving to screenshot result
 */
export async function captureScreenshot(region?: { x: number; y: number; w: number; h: number }): Promise<ScreenshotResult> {
  const { spawn } = await import('child_process');
  const { join } = await import('path');
  const os = await import('os');
  const { tmpdir } = os;
  const platformString = os.platform(); // Call the function to get the string
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
      // Linux and other Unix-like: try scrot first, then import
      if (region) {
        const { x, y, w, h } = region;
        // Try scrot with region specification
        command = 'scrot';
        args = [`-${x},${y},${w},${h}`, tmpFile];
      } else {
        // Try scrot for full screen
        command = 'scrot';
        args = [tmpFile];
      }
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

    // Check if command succeeded
    if (result.exitCode !== 0) {
      // If scrot failed, try import as fallback on Linux
      if (platformString !== 'darwin' && platformString !== 'win32' && command === 'scrot') {
        try {
          const fallbackResult = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            let fallbackCommand = 'import';
            let fallbackArgs: string[] = [];

            if (region) {
              const { x, y, w, h } = region;
              fallbackArgs = [`-window root -crop ${w}x${h}+${x}+${y}`, tmpFile];
            } else {
              fallbackArgs = ['-window root', tmpFile];
            }

            const child = spawn(fallbackCommand, fallbackArgs);
            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
            child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
            child.on('close', (code: number) => resolve({ stdout, stderr, exitCode: code }));
            child.on('error', (err: Error) => resolve({ stdout: '', stderr: err.message, exitCode: -1 }));
          });

          if (fallbackResult.exitCode !== 0) {
            throw new Error(`Both scrot and import failed. scrot: ${result.stderr}, import: ${fallbackResult.stderr}`);
          }
        } catch (fallbackErr) {
          throw new Error(`Screenshot capture failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
        }
      } else {
        throw new Error(`Screenshot command failed: ${result.stderr}`);
      }
    }

    // Check if file was created
    if (!existsSync(tmpFile)) {
      throw new Error('Screenshot file was not created');
    }

    // Read and encode the image
    const { readFileSync } = await import('fs');
    const data = readFileSync(tmpFile);
    const base64 = data.toString('base64');

    // Clean up
    unlinkSync(tmpFile);

    return {
      success: true,
      base64,
      mimeType: 'image/png'
    };
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