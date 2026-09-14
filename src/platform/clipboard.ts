/**
 * Cross-platform clipboard operations
 * Handles copying and pasting text appropriately for each OS
 */

import { clipboard } from 'electron';

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
 * Reads text from the clipboard
 * @returns Promise resolving to the clipboard text content
 */
export async function readText(): Promise<string> {
  // Electron's clipboard API is cross-platform
  return clipboard.readText();
}

/**
 * Writes text to the clipboard
 * @param text - Text to write to the clipboard
 * @returns Promise resolving to success status
 */
export async function writeText(text: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Electron's clipboard API is cross-platform
    clipboard.writeText(text);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Reads HTML from the clipboard
 * @returns Promise resolving to the clipboard HTML content
 */
export async function readHTML(): Promise<string> {
  // Electron's clipboard API is cross-platform
  return clipboard.readHTML();
}

/**
 * Writes HTML to the clipboard
 * @param html - HTML to write to the clipboard
 * @returns Promise resolving to success status
 */
export async function writeHTML(html: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Electron's clipboard API is cross-platform
    clipboard.writeHTML(html);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Checks if clipboard utilities are available on Linux
 * This is mainly for diagnostic purposes since Electron's clipboard works cross-platform
 * @returns Object indicating availability of various clipboard utilities
 */
export async function checkLinuxClipboardUtilities(): Promise<{
  xclip: boolean;
  xsel: boolean;
  wlClipboard: boolean;
  electron: boolean;
}> {
  // Electron clipboard always works
  const result: {
    xclip: boolean;
    xsel: boolean;
    wlClipboard: boolean;
    electron: boolean;
  } = {
    xclip: false,
    xsel: false,
    wlClipboard: false,
    electron: true
  };

  if (platformString !== 'linux') {
    return result;
  }

  try {
    const { execFile } = await import('child_process');

    // Check for xclip
    try {
      await new Promise((resolve, reject) => {
        execFile('xclip', ['-version'], { timeout: 1000 }, (err) => {
          if (err) reject(err);
          else resolve(true);
        });
      });
      result.xclip = true;
    } catch {
      result.xclip = false;
    }

    // Check for xsel
    try {
      await new Promise((resolve, reject) => {
        execFile('xsel', ['--version'], { timeout: 1000 }, (err) => {
          if (err) reject(err);
          else resolve(true);
        });
      });
      result.xsel = true;
    } catch {
      result.xsel = false;
    }

    // Check for wl-clipboard (Wayland)
    try {
      await new Promise((resolve, reject) => {
        execFile('wl-copy', ['--version'], { timeout: 1000 }, (err) => {
          if (err) reject(err);
          else resolve(true);
        });
      });
      result.wlClipboard = true;
    } catch {
      result.wlClipboard = false;
    }
  } catch {
    // If we can't check, assume utilities aren't available
    // Electron clipboard will still work
  }

  return result;
}