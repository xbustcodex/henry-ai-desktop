/**
 * Cross-platform installed application discovery
 * Discovers GUI applications from platform-standard locations
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

export interface InstalledApp {
  id: string;
  name: string;
  displayName: string;
  executable: string;
  icon?: string;
  categories?: string[];
  platform: 'darwin' | 'linux' | 'win32';
  isTerminal?: boolean;
  isFileManager?: boolean;
  isBrowser?: boolean;
}

interface DesktopEntry {
  name: string;
  exec: string;
  icon?: string;
  noDisplay?: boolean;
  hidden?: boolean;
  terminal?: boolean;
  categories?: string;
  type?: string;
}

/**
 * Parse a .desktop file and extract relevant fields
 */
function parseDesktopFile(content: string): DesktopEntry | null {
  const entry: DesktopEntry = {
    name: '',
    exec: '',
    noDisplay: false,
    hidden: false,
    terminal: false,
  };

  let inDesktopEntry = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[Desktop Entry]') {
      inDesktopEntry = true;
      continue;
    }
    if (trimmed.startsWith('[') && trimmed !== '[Desktop Entry]') {
      inDesktopEntry = false;
      continue;
    }
    if (!inDesktopEntry) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    switch (key) {
      case 'Name':
        entry.name = value;
        break;
      case 'Exec':
        entry.exec = value;
        break;
      case 'Icon':
        entry.icon = value;
        break;
      case 'NoDisplay':
        entry.noDisplay = value.toLowerCase() === 'true';
        break;
      case 'Hidden':
        entry.hidden = value.toLowerCase() === 'true';
        break;
      case 'Terminal':
        entry.terminal = value.toLowerCase() === 'true';
        break;
      case 'Categories':
        entry.categories = value;
        break;
      case 'Type':
        entry.type = value;
        break;
    }
  }

  if (!entry.name || entry.type === 'Directory' || entry.hidden || entry.noDisplay) {
    return null;
  }

  return entry;
}

/**
 * Clean up Exec field from .desktop file - remove field codes
 */
function cleanExec(exec: string): string {
  return exec
    .replace(/%[fFuUicck]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract executable name from Exec field
 */
function extractExecutable(exec: string): string {
  const cleaned = cleanExec(exec);
  const parts = cleaned.split(' ');
  return parts[0];
}

/**
 * Deduplicate applications by name (case-insensitive)
 */
function deduplicateApps(apps: InstalledApp[]): InstalledApp[] {
  const seen = new Map<string, InstalledApp>();
  for (const app of apps) {
    const key = app.name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, app);
    }
  }
  return Array.from(seen.values());
}

/**
 * Linux: Discover applications from .desktop files
 */
async function discoverLinuxApps(): Promise<InstalledApp[]> {
  const apps: InstalledApp[] = [];
  const desktopDirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(os.homedir(), '.local/share/applications'),
  ];

  for (const dir of desktopDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.desktop')) continue;

        const filePath = path.join(dir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const entry = parseDesktopFile(content);
          if (!entry) continue;

          const executable = extractExecutable(entry.exec);
          const categories = entry.categories ? entry.categories.split(';').filter(Boolean) : [];

          const isTerminal = entry.terminal || categories.some(c => 
            ['TerminalEmulator', 'System', 'ConsoleOnly'].includes(c)
          );
          const isFileManager = categories.some(c => 
            ['FileManager', 'Core', 'FileTools'].includes(c)
          );
          const isBrowser = categories.some(c => 
            ['Network', 'WebBrowser'].includes(c)
          );

          apps.push({
            id: `linux-${file.replace('.desktop', '')}`,
            name: entry.name,
            displayName: entry.name,
            executable,
            icon: entry.icon,
            categories,
            platform: 'linux',
            isTerminal,
            isFileManager,
            isBrowser,
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return deduplicateApps(apps);
}

/**
 * macOS: Discover applications from /Applications and ~/Applications
 */
async function discoverMacOSApps(): Promise<InstalledApp[]> {
  const apps: InstalledApp[] = [];
  const appDirs = [
    '/Applications',
    path.join(os.homedir(), 'Applications'),
    '/System/Applications',
  ];

  for (const dir of appDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.app')) continue;

        const appName = file.replace('.app', '');
        const appPath = path.join(dir, file);

        try {
          // Read Info.plist for better name/icon
          const plistPath = path.join(appPath, 'Contents/Info.plist');
          let displayName = appName;
          let icon: string | undefined;
          let categories: string[] = [];

          if (fs.existsSync(plistPath)) {
            try {
              const plistContent = fs.readFileSync(plistPath, 'utf8');
              const cfBundleName = plistContent.match(/<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/);
              const cfBundleDisplayName = plistContent.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/);
              const cfBundleIconFile = plistContent.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);

              if (cfBundleDisplayName) displayName = cfBundleDisplayName[1];
              else if (cfBundleName) displayName = cfBundleName[1];
              if (cfBundleIconFile) icon = cfBundleIconFile[1];
            } catch {
              // Ignore plist parse errors
            }
          }

          const isTerminal = ['Terminal', 'iTerm', 'iTerm2', 'Alacritty', 'Kitty', 'WezTerm'].some(t => 
            appName.toLowerCase().includes(t.toLowerCase())
          );
          const isFileManager = ['Finder', 'Path Finder', 'ForkLift'].some(t => 
            appName.toLowerCase().includes(t.toLowerCase())
          );
          const isBrowser = ['Safari', 'Chrome', 'Firefox', 'Brave', 'Edge', 'Opera', 'Vivaldi'].some(t => 
            appName.toLowerCase().includes(t.toLowerCase())
          );

          apps.push({
            id: `macos-${appName.toLowerCase().replace(/\s+/g, '-')}`,
            name: appName,
            displayName,
            executable: appPath,
            icon,
            categories,
            platform: 'darwin',
            isTerminal,
            isFileManager,
            isBrowser,
          });
        } catch {
          // Skip apps we can't read
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return deduplicateApps(apps);
}

/**
 * Windows: Discover applications from Start Menu and common locations
 */
async function discoverWindowsApps(): Promise<InstalledApp[]> {
  const apps: InstalledApp[] = [];
  const seen = new Set<string>();

  try {
    // Use PowerShell to get Start Menu apps
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn('powershell', [
        '-Command',
        `Get-StartApps | Where-Object { $_.AppID -notlike '*WindowsStore*' } | Select-Object Name, AppID | ConvertTo-Json`
      ], { timeout: 10000 });
      
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => {});
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout });
        else reject(new Error(`Exit code ${code}`));
      });
      child.on('error', reject);
    });

    const startApps = JSON.parse(result.stdout);
    for (const app of startApps) {
      const name = app.Name;
      const appId = app.AppID;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const isTerminal = ['terminal', 'cmd', 'powershell', 'wsl', 'mintty'].some(t => 
        name.toLowerCase().includes(t)
      );
      const isFileManager = ['explorer', 'file explorer', 'files'].some(t => 
        name.toLowerCase().includes(t)
      );
      const isBrowser = ['chrome', 'firefox', 'edge', 'brave', 'opera', 'vivaldi'].some(t => 
        name.toLowerCase().includes(t)
      );

      apps.push({
        id: `win32-${key.replace(/\s+/g, '-')}`,
        name,
        displayName: name,
        executable: appId,
        categories: [],
        platform: 'win32',
        isTerminal,
        isFileManager,
        isBrowser,
      });
    }
  } catch {
    // Fallback: common Windows apps
    const commonApps = [
      { name: 'File Explorer', executable: 'explorer.exe', isFileManager: true },
      { name: 'Command Prompt', executable: 'cmd.exe', isTerminal: true },
      { name: 'PowerShell', executable: 'powershell.exe', isTerminal: true },
      { name: 'Windows Terminal', executable: 'wt.exe', isTerminal: true },
      { name: 'Notepad', executable: 'notepad.exe' },
      { name: 'Calculator', executable: 'calc.exe' },
    ];

    for (const a of commonApps) {
      const key = a.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      apps.push({
        id: `win32-${key.replace(/\s+/g, '-')}`,
        name: a.name,
        displayName: a.name,
        executable: a.executable,
        categories: [],
        platform: 'win32',
        isTerminal: a.isTerminal || false,
        isFileManager: a.isFileManager || false,
        isBrowser: false,
      });
    }
  }

  return apps;
}

/**
 * Discover installed applications for the current platform
 */
export async function discoverInstalledApps(): Promise<InstalledApp[]> {
  const platform = process.platform;
  
  if (platform === 'linux') {
    return discoverLinuxApps();
  } else if (platform === 'darwin') {
    return discoverMacOSApps();
  } else if (platform === 'win32') {
    return discoverWindowsApps();
  }
  
  return [];
}

/**
 * Get application by name (fuzzy match)
 */
export async function findAppByName(name: string): Promise<InstalledApp | null> {
  const apps = await discoverInstalledApps();
  const lowerName = name.toLowerCase();
  
  // Exact match first
  let match = apps.find(a => a.name.toLowerCase() === lowerName);
  if (match) return match;

  // Partial match
  match = apps.find(a => a.name.toLowerCase().includes(lowerName));
  if (match) return match;

  // Try executable name match
  match = apps.find(a => a.executable.toLowerCase().includes(lowerName));
  if (match) return match;

  return null;
}

/**
 * Get default file manager for the platform
 */
export async function getDefaultFileManager(): Promise<InstalledApp | null> {
  const apps = await discoverInstalledApps();
  return apps.find(a => a.isFileManager) || null;
}

/**
 * Get default terminal for the platform
 */
export async function getDefaultTerminal(): Promise<InstalledApp | null> {
  const apps = await discoverInstalledApps();
  return apps.find(a => a.isTerminal) || null;
}

/**
 * Get default browser for the platform
 */
export async function getDefaultBrowser(): Promise<InstalledApp | null> {
  const apps = await discoverInstalledApps();
  return apps.find(a => a.isBrowser) || null;
}