/**
 * Henry AI — Capability Registry
 *
 * Single source of truth for what Henry can actually do at runtime.
 * Reads live connection state and reflects actual implementation status.
 *
 * Rules:
 *   - A capability is listed as `true` only if it is fully implemented and working.
 *   - Connection status is read directly from the same token source the UI uses.
 *   - This registry is injected into the system prompt so Henry never claims
 *     capabilities that do not exist.
 *
 * Do NOT mark anything `true` here unless the code fully implements it.
 */
import { getPlatform } from '../utils/platform';

// ── Computer / Device Capabilities ───────────────────────────────────────────

const platform = getPlatform();

/**
 * What Henry can actually do at the OS / device layer.
 *
 * These are hard-coded constants — they reflect what is implemented in
 * electron/ipc/* and the preload bridge. Update here only when the
 * feature is actually built and shipped.
 */
/**
 * Computer / device capabilities.
 *
 * These reflect what is actually registered in electron/ipc/computer.ts.
 * Each entry is true only when the IPC handler exists AND works on the
 * current platform.
 *
 * macOS-only features (AppleScript, screenshot, type, click) require macOS
 * Accessibility and Screen Recording permissions to be granted in System
 * Settings → Privacy & Security.
 *
 * Linux uses capability-based checks (xdotool/xclip/scrot backends).
 * Windows uses PowerShell-based implementations.
 */
export const COMPUTER_CAPABILITIES = {
  /** Read/write text files inside the configured workspace folder (IPC: fs:readFile, fs:writeFile). */
  workspaceFileAccess: true,

  /** Shell command execution with a short dangerous-command blocklist (IPC: computer:runShell). */
  shellAccess: true,

  /** AppleScript execution — app control, UI automation (IPC: computer:osascript, macOS only). */
  applescript: platform === 'darwin',

  /** Keyboard typing via AppleScript (IPC: computer:typeText, macOS only). */
  typeText: platform === 'darwin',

  /** Mouse click at coordinates via AppleScript (IPC: computer:click, macOS only). */
  mouseClick: platform === 'darwin',

  /** Keyboard typing on Linux via xdotool (IPC: computer:typeText). */
  linuxTypeText: platform === 'linux',

  /** Mouse click on Linux via xdotool (IPC: computer:click). */
  linuxMouseClick: platform === 'linux',

  /** Screenshot capture (IPC: computer:screenshot — screencapture on macOS, scrot/import on Linux, PowerShell on Windows). */
  screenshot: true,

  /** Open an app by name (IPC: computer:openApp — open -a on macOS, xdg-open on Linux). */
  openApp: true,

  /** Open a URL in the default browser (IPC: computer:openUrl). */
  openUrl: true,

  /** List installed/running apps and processes (IPC: computer:listApps, computer:listProcesses). */
  listApps: true,

  /** Check macOS Accessibility + Screen Recording permissions (IPC: computer:checkPermissions, macOS only). */
  checkPermissions: platform === 'darwin',
} as const;

// ── System Prompt Block ───────────────────────────────────────────────────────

/**
 * Returns a compact capability truth block for injection into the system prompt.
 * Henry reads this to know what is real right now — not what could theoretically exist.
 */
export function buildCapabilityRegistryBlock(): string {
  // Computer layer — reflects what electron/ipc/computer.ts actually implements
  const computerLines: string[] = [
    `  Workspace file access (read/write text files in workspace): YES`,
    `  Shell command execution (computer:runShell, with safety blocklist): YES`,
    platform === 'darwin'
      ? `  AppleScript / app UI control (computer:osascript — macOS only): YES`
      : `  AppleScript / app UI control: NO (macOS only)`,
    platform === 'darwin'
      ? `  Keyboard input / typing (computer:typeText — macOS, needs Accessibility permission): YES`
      : platform === 'linux'
        ? `  Keyboard input / typing (computer:typeText via xdotool): YES`
        : `  Keyboard input / typing: YES`,
    platform === 'darwin'
      ? `  Mouse click at coordinates (computer:click — macOS, needs Accessibility permission): YES`
      : `  Mouse click at coordinates: YES`,
    `  Screenshot capture (computer:screenshot — ${platform === 'darwin' ? 'screencapture' : platform === 'linux' ? 'scrot/import' : 'PowerShell'}): YES`,
    `  Open app by name (computer:openApp): YES`,
    `  Open URL in browser (computer:openUrl): YES`,
    `  List apps and processes (computer:listApps, computer:listProcesses): YES`,
    platform === 'darwin'
      ? `  Permission check (computer:checkPermissions — macOS Accessibility + Screen Recording): YES`
      : `  Permission check: N/A (no macOS permissions on this platform)`,
    platform === 'darwin'
      ? `  NOTE: AppleScript/typeText/click/screenshot require macOS Accessibility + Screen Recording`
      : platform === 'linux'
        ? `  NOTE: Linux computer control requires xdotool/wmctrl; screenshots need scrot/ImageMagick`
        : `  NOTE: Windows uses PowerShell-based computer control`,
    `  NOTE: These only work in the desktop Electron app — not in a browser context`,
  ];

  return `## Runtime Capability State (what is actually true right now)

Computer / device layer:
${computerLines.join('\n')}

This is the ground truth. Henry must ONLY claim capabilities listed as active above.`.trim();
}