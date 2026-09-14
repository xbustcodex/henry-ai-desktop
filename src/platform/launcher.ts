/**
 * Cross-platform application launcher
 * Handles opening applications and URLs appropriately for each OS
 */

import { app } from 'electron';

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
 * Launches an application by name
 * @param appName - Name or path of the application to launch
 * @returns Promise resolving to success status and output/error
 */
export async function launchApplication(appName: string): Promise<{ success: boolean; output: string; error?: string }> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    let command: string;
    let args: string[] = [];

    if (platformString === 'darwin') {
      // macOS: use open -a
      command = 'open';
      args = ['-a', appName];
    } else if (platformString === 'win32') {
      // Windows: use start
      command = 'cmd';
      args = ['/c', 'start', '', appName];
    } else {
      // Linux and other Unix-like: try xdg-open, gtk-launch, or direct execution
      // First check if it's a desktop file or executable path
      if (appName.includes('/') || appName.startsWith('./') || appName.startsWith('../')) {
        // Treat as path
        command = appName;
      } else {
        // Try to find via desktop file or use xdg-open
        command = 'xdg-open';
        args = [appName];
      }
    }

    // Handle special case for Linux direct execution
    if (platformString !== 'darwin' && platformString !== 'win32' && !args.length) {
      // If we're treating appName as a direct command
      if (command === appName) {
        args = [];
      } else {
        // xdg-open case
        args = [appName];
      }
    }

    const child = spawn(command, args);
    let output = '';
    let errorOutput = '';

    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    child.on('close', (code: number) => {
      resolve({
        success: code === 0,
        output: output.trim(),
        error: code !== 0 ? errorOutput.trim() : undefined
      });
    });

    child.on('error', (err: Error) => {
      resolve({
        success: false,
        output: '',
        error: err.message
      });
    });
  });
}

/**
 * Opens a URL in the default browser
 * @param url - URL to open
 * @returns Promise resolving to success status and output/error
 */
export async function openUrl(url: string): Promise<{ success: boolean; output: string; error?: string }> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    let command: string;
    let args: string[];

    if (platformString === 'darwin') {
      // macOS: use open
      command = 'open';
      args = [url];
    } else if (platformString === 'win32') {
      // Windows: use start
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      // Linux and other Unix-like: use xdg-open
      command = 'xdg-open';
      args = [url];
    }

    const child = spawn(command, args);
    let output = '';
    let errorOutput = '';

    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    child.on('close', (code: number) => {
      resolve({
        success: code === 0,
        output: output.trim(),
        error: code !== 0 ? errorOutput.trim() : undefined
      });
    });

    child.on('error', (err: Error) => {
      resolve({
        success: false,
        output: '',
        error: err.message
      });
    });
  });
}

/**
 * Attempts to launch an application using desktop file lookup first,
 * falling back to direct launch if needed
 * @param appName - Application name (e.g., "firefox", "gedit")
 * @returns Promise resolving to success status and output/error
 */
export async function launchAppByName(appName: string): Promise<{ success: boolean; output: string; error?: string }> {
  if (platformString === 'darwin') {
    return launchApplication(appName);
  } else if (platformString === 'win32') {
    return launchApplication(appName);
  } else {
    // Linux: try desktop file lookup first
    try {
      const { spawn } = await import('child_process');
      const { existsSync } = await import('fs');

      // Common desktop file locations
      const desktopPaths = [
        `/usr/share/applications/${appName}.desktop`,
        `/usr/local/share/applications/${appName}.desktop`,
        `${process.env.HOME}/.local/share/applications/${appName}.desktop`
      ];

      for (const desktopPath of desktopPaths) {
        if (existsSync(desktopPath)) {
          // Found desktop file, launch with gtk-launch
          const child = spawn('gtk-launch', [appName]);

          let output = '';
          let errorOutput = '';

          child.stdout?.on('data', (data: Buffer) => {
            output += data.toString();
          });

          child.stderr?.on('data', (data: Buffer) => {
            errorOutput += data.toString();
          });

          return new Promise((resolve) => {
            child.on('close', (code: number) => {
              resolve({
                success: code === 0,
                output: output.trim(),
                error: code !== 0 ? errorOutput.trim() : undefined
              });
            });

            child.on('error', (err: Error) => {
              resolve({
                success: false,
                output: '',
                error: err.message
              });
            });
          });
        }
      }

      // No desktop file found, fall back to xdg-open
      return launchApplication(appName);
    } catch (err) {
      // If anything goes wrong, fall back to basic launch
      return launchApplication(appName);
    }
  }
}