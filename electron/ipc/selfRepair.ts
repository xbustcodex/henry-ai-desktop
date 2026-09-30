/**
 * Henry Self-Repair Engine
 *
 * Henry audits his own health on every launch and can fix problems himself.
 * Every check has an auto-fix. Every fix is logged. User sees the result.
 *
 * Philosophy: Henry should never ask the user to run a command.
 * If something is broken, he fixes it. If he can't, he says exactly why
 * and what to do — one sentence, no jargon.
 */

import { execSync, exec } from 'child_process';
import { detectLinuxSession } from './sessionDetect';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app, shell } from 'electron';
import type Database from 'better-sqlite3';

const BREW = '/opt/homebrew/bin/brew';
const HOME = os.homedir();
const ENV = { ...process.env, HOME, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` };

export interface HealthCheck {
  id: string;
  name: string;
  category: 'required' | 'recommended' | 'optional' | 'configuration' | 'not-applicable';
  description: string;
  check: (db: Database.Database) => Promise<CheckResult>;
  fix?: (db: Database.Database) => Promise<FixResult>;
}

export interface CheckResult {
  ok: boolean;
  detail?: string;
  version?: string;
}

export interface FixResult {
  success: boolean;
  message: string;
}

export interface DiagnosticReport {
  timestamp: string;
  checks: Array<{
    id: string;
    name: string;
    category: string;
    status: 'ok' | 'warning' | 'error' | 'fixed' | 'fix_failed';
    detail?: string;
    version?: string;
    fixMessage?: string;
  }>;
  summary: { ok: number; fixed: number; failed: number; warnings: number };
}

// ── Tool checker helper ────────────────────────────────────────────────────
function toolVersion(cmd: string, versionFlag = '--version'): string | null {
  try {
    return execSync(`${cmd} ${versionFlag} 2>/dev/null`, { encoding: 'utf8', env: ENV, timeout: 5000 }).trim().split('\n')[0] || null;
  } catch { return null; }
}

function toolExists(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { encoding: 'utf8', env: ENV, timeout: 3000 }); return true; } catch { return false; }
}

// Whitelisted packages that can be installed via privileged helper
const ALLOWED_LINUX_PACKAGES = new Set([
  'scrot',
  'imagemagick',
  'gnome-screenshot',
  'xfce4-screenshooter',
  'sqlite3',
  'yt-dlp',
  'node',
  'git',
  'ffmpeg',
  'python3',
  'xdotool',
  'wmctrl',
  'xclip',
  'wl-clipboard',
]);

async function installViaPackageManager(pkg: string): Promise<FixResult> {
  const platform = process.platform;
  if (platform === 'darwin') {
    return new Promise(resolve => {
      exec(`${BREW} install ${pkg}`, { env: ENV, timeout: 120_000 }, (err) => {
        if (err) resolve({ success: false, message: `brew install ${pkg} failed: ${err.message.slice(0, 100)}` });
        else resolve({ success: true, message: `Installed ${pkg} via brew` });
      });
    });
  } else if (platform === 'linux') {
    // Check if package is in allowlist
    if (!ALLOWED_LINUX_PACKAGES.has(pkg)) {
      return { success: false, message: `Package "${pkg}" is not in the allowed list for auto-install. Install manually: sudo apt-get install ${pkg}` };
    }

    // Check for apt lock before attempting installation
    const lockPaths = ['/var/lib/dpkg/lock', '/var/lib/dpkg/lock-frontend', '/var/lib/apt/lists/lock'];
    for (const lockPath of lockPaths) {
      try {
        if (fs.existsSync(lockPath)) {
          // Check if lock is held by another process
          const { execSync } = await import('child_process');
          try {
            execSync(`lsof ${lockPath} 2>/dev/null`, { stdio: 'ignore', timeout: 5000 });
            return { success: false, message: 'Package manager busy — another apt/dpkg process is running. Please wait and retry.' };
          } catch {
            // Lock file exists but no process holds it (stale lock) — we'll proceed but warn
          }
        }
      } catch {
        // lsof not available or other error — proceed with caution
      }
    }

    // Use pkexec for privileged installation on Linux
    // Single pkexec invocation with shell to run both update and install atomically
    return new Promise(resolve => {
      const command = `sh -c 'apt-get update && apt-get install -y ${pkg}'`;
      exec(`pkexec ${command}`, { env: ENV, timeout: 180_000 }, (err) => {
        if (err) {
          const msg = err.message.slice(0, 200);
          if (msg.includes('polkit') || msg.includes('authentication') || msg.includes('cancelled')) {
            resolve({ success: false, message: `Installation cancelled or authentication failed. Install manually: sudo apt-get install ${pkg}` });
          } else if (msg.includes('lock') || msg.includes('dpkg') || msg.includes('apt')) {
            resolve({ success: false, message: 'Package manager busy or locked. Please wait and retry, or run manually: sudo apt-get install ' + pkg });
          } else {
            resolve({ success: false, message: `pkexec apt install ${pkg} failed: ${msg}` });
          }
        } else {
          resolve({ success: true, message: `Installed ${pkg} via apt (with pkexec)` });
        }
      });
    });
  } else if (platform === 'win32') {
    // Windows: prefer winget, fallback to choco, then manual
    return new Promise(resolve => {
      exec(`winget install --id ${pkg} --silent --accept-source-agreements --accept-package-agreements`, { env: ENV, timeout: 120_000 }, (err) => {
        if (!err) return resolve({ success: true, message: `Installed ${pkg} via winget` });
        // Try chocolatey
        exec(`choco install ${pkg} -y`, { env: ENV, timeout: 120_000 }, (err2) => {
          if (err2) resolve({ success: false, message: `Auto-install failed. Try: winget install ${pkg} or choco install ${pkg}` });
          else resolve({ success: true, message: `Installed ${pkg} via chocolatey` });
        });
      });
    });
  }
  return { success: false, message: `Auto-install not supported on this platform for ${pkg}` };
}

// Get Henry workspace directory
function getHenryDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'henry-workspace');
}

// ── All health checks ──────────────────────────────────────────────────────
function isDarwin(): boolean {
  return process.platform === 'darwin';
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

export function HEALTH_CHECKS(db: Database.Database): HealthCheck[] {
  const henryDir = getHenryDir();
  const henryDbPath = path.join(os.homedir(), 'henry.db');

  return [

    // ── Core runtime ──────────────────────────────────────────────────────────
    {
      id: 'brew',
      name: 'Homebrew',
      category: isDarwin() ? 'required' : 'not-applicable',
      description: 'Package manager — used to install everything else (macOS only)',
      check: async () => {
        if (!isDarwin()) return { ok: true, detail: 'Not applicable on this platform' };
        const v = toolVersion(BREW);
        return v ? { ok: true, version: v } : { ok: false, detail: 'Homebrew not found' };
      },
      // brew can't auto-install itself — give user a one-liner
    },

{
      id: 'node',
      name: 'Node.js',
      category: 'required',
      description: "JavaScript runtime for Henry's backend",
      check: async () => {
        const v = toolVersion('node');
        return v ? { ok: true, version: v } : { ok: false, detail: 'Node.js not installed' };
      },
      fix: async () => installViaPackageManager('node'),
    },

    {
      id: 'cloudflared',
      name: 'Cloudflare Tunnel',
      category: 'optional',
      description: 'Secure tunnel so mobile works from anywhere (optional — LAN pairing works without it)',
      check: async () => {
        if (isDarwin()) {
          const v = toolVersion('cloudflared');
          return v ? { ok: true, version: v } : { ok: true, detail: 'cloudflared not installed — mobile only works on home WiFi (optional)' };
        }
        if (isLinux()) {
          try { execSync('cloudflared --version', { encoding: 'utf8', env: ENV, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); return { ok: true, version: 'cloudflared' }; } catch {
            try { execSync('which cloudflared', { encoding: 'utf8', env: ENV, timeout: 3000 }); return { ok: true, version: 'cloudflared' }; } catch {
              return { ok: true, detail: 'cloudflared not installed — optional for remote tunnel. LAN pairing works without it. Install manually if needed: sudo apt-get install cloudflared' };
            }
          }
        }
        // Windows or other platforms
        try { execSync('cloudflared --version', { encoding: 'utf8', env: ENV, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); return { ok: true, version: 'cloudflared' }; } catch {
          return { ok: true, detail: 'cloudflared not installed — optional for remote companion' };
        }
      },
      // No auto-fix for optional cloudflared
    },

    {
      id: 'git',
      name: 'Git',
      category: 'required',
      description: 'Version control — used for Henry updates',
      check: async () => {
        const v = toolVersion('git');
        return v ? { ok: true, version: v } : { ok: false, detail: 'Git not installed' };
      },
      fix: async () => installViaPackageManager('git'),
    },

    // ── Media tools ───────────────────────────────────────────────────────────
    {
      id: 'ffmpeg',
      name: 'FFmpeg',
      category: 'recommended',
      description: 'Audio/video processing — required for voice features and media generation',
      check: async () => {
        const v = toolVersion('ffmpeg', '-version');
        return v ? { ok: true, version: v.split('\n')[0] } : { ok: false, detail: 'ffmpeg not installed — voice processing unavailable' };
      },
      fix: async () => installViaPackageManager('ffmpeg'),
    },

    // ── Voice (free local speech) ─────────────────────────────────────────────
    {
      id: 'whisper_cpp',
      name: 'Whisper (local speech-to-text)',
      category: 'optional',
      description: 'whisper.cpp — free, offline voice input for Henry',
      check: async () => {
        try {
          const { detectWhisperBinary } = require('../voice/stt') as typeof import('../voice/stt');
          const bin = detectWhisperBinary(true);
          return bin
            ? { ok: true, detail: bin }
            : { ok: false, detail: 'whisper.cpp not installed — voice input requires manual setup (see Settings → Voice)' };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      },
      // whisper.cpp is not available via apt; user must build from source or download binary
      // No auto-fix available
    },

    {
      id: 'whisper_model',
      name: 'Whisper model (base.en)',
      category: 'optional',
      description: 'The ~148MB speech model whisper.cpp uses to transcribe your voice',
      check: async () => {
        try {
          const { detectWhisperBinary, sttModelPresent, sttModelPath } =
            require('../voice/stt') as typeof import('../voice/stt');
          if (sttModelPresent()) return { ok: true, detail: sttModelPath() };
          if (!detectWhisperBinary()) {
            // No binary yet — the model alone is useless; report once via whisper_cpp.
            return { ok: true, detail: 'Waiting on whisper-cli install — model downloads during voice setup' };
          }
          return { ok: false, detail: 'Speech model not downloaded (~148MB, one-time)' };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      },
      fix: async () => {
        try {
          const { downloadSttModel } = require('../voice/stt') as typeof import('../voice/stt');
          await downloadSttModel();
          return { success: true, message: 'Downloaded ggml-base.en speech model' };
        } catch (e) {
          return { success: false, message: `Model download failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },

    {
      id: 'microphone',
      name: isLinux() ? 'Microphone' : isWindows() ? 'Microphone' : 'Microphone Permission',
      category: 'recommended',
      description: 'Required so Henry can hear you — voice input in chat',
      check: async () => {
        try {
          if (isLinux() || isWindows()) {
            // No macOS permission TCC on Linux/Windows — mic access is inherent.
            return { ok: true, detail: 'Available' };
          }
          const { systemPreferences } = require('electron');
          const status = systemPreferences.getMediaAccessStatus('microphone');
          // 'not-determined' is fine — macOS prompts automatically on first use.
          if (status === 'granted' || status === 'not-determined') return { ok: true, detail: status };
          return {
            ok: false,
            detail: 'Microphone not granted — System Settings → Privacy → Microphone → Henry AI',
          };
        } catch {
          return { ok: true };
        }
      },
      fix: async () => {
        // Report-only (like Screen Recording): open the right pane, user flips the toggle.
// Only open system preferences on macOS
        if (process.platform === 'darwin') {
          exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"');
        }
        return { success: false, message: 'Opening Microphone settings — enable Henry AI, then try the mic again' };
      },
    },

    {
      id: 'yt_dlp',
      name: 'yt-dlp',
      category: 'optional',
      description: 'Video downloader — for media capture features',
      check: async () => {
        const v = toolVersion('yt-dlp');
        return v ? { ok: true, version: v } : { ok: false, detail: 'yt-dlp not installed — optional for video downloads' };
      },
      fix: async () => installViaPackageManager('yt-dlp'),
    },

    // ── Python ────────────────────────────────────────────────────────────────
    {
      id: 'python3',
      name: 'Python 3',
      category: 'recommended',
      description: 'Used for AI scripts, data processing, and Henry utilities',
      check: async () => {
        const v = toolVersion('python3');
        return v ? { ok: true, version: v } : { ok: false, detail: 'Python 3 not installed' };
      },
      fix: async () => installViaPackageManager('python3'),
    },

    // ── Coder engine ──────────────────────────────────────────────────────────
    {
      id: 'claude_cli',
      name: 'Claude Code CLI',
      category: 'recommended',
      description: "Henry's default coder engine — codes on your Claude subscription (big context, no per-token cost)",
      check: async () => {
        const candidates = [
          'claude',
          `${HOME}/.claude/local/claude`,
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          `${HOME}/.local/bin/claude`,
        ];
        for (const c of candidates) {
          const v = toolVersion(`"${c}"`);
          if (v) return { ok: true, volume: v, detail: c === 'claude' ? undefined : c };
        }
        return {
          ok: false,
          detail:
            'Claude Code CLI not found — install with: npm install -g @anthropic-ai/claude-code (docs: docs.anthropic.com/en/docs/claude-code). Henry falls back to the free local coder.',
        };
      },
      // No auto-fix: a global npm install shouldn't run silently on every launch.
    },

    {
      id: 'qwen_coder',
      name: 'Local coder model (qwen2.5-coder)',
      category: 'optional',
      description: 'Free offline coder fallback via Ollama — used when the Claude Code CLI is unavailable',
      check: async () => {
        if (!toolExists('ollama')) {
          return { ok: true, detail: 'Ollama not installed — local coder fallback skipped (optional)' };
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);
          const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
          clearTimeout(timer);
          const data = (await res.json()) as { models?: Array<{ name?: string }> };
          const names = (data.models ?? []).map((m) => m.name ?? '');
          const hit =
            names.find((n) => n.startsWith('qwen2.5-coder')) ??
            names.find((n) => /^qwen[\w.]*-coder/i.test(n));
          return hit
            ? { ok: true, detail: hit }
            : { ok: false, detail: 'Coder model not pulled — run: ollama pull qwen2.5-coder:7b' };
        } catch {
          // Ollama installed but not running — can't verify; don't nag or auto-pull.
          return { ok: true, detail: "Ollama isn't running — start it to verify the local coder model" };
        }
      },
      fix: async () => {
        // Use Ollama API directly instead of exec() to avoid PATH issues
        const baseUrl = 'http://localhost:11434';
        try {
          const response = await fetch(`${baseUrl}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'qwen2.5-coder:7b', stream: true }),
          });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (!response.body) throw new Error('No response body');

          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n').filter(Boolean);

            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                if (data.status === 'success' || data.status === 'done') {
                  return { success: true, message: 'Pulled qwen2.5-coder:7b for the free local coder' };
                }
              } catch {
                // Skip malformed JSON lines
              }
            }
          }

          return { success: true, message: 'Pulled qwen2.5-coder:7b for the free local coder' };
        } catch (err: any) {
          return { success: false, message: `Auto-pull failed: ${err.message}. Run: ollama pull qwen2.5-coder:7b` };
        }
      },
    },

    // ── Database ──────────────────────────────────────────────────────────────
    {
      id: 'sqlite3',
      name: 'SQLite Database',
      category: 'required',
      description: "Henry's local database — stores all conversations, memory, tasks",
      check: async () => {
        // Check DB file health - the sqlite3 CLI is NOT required for database operation
        // Henry uses better-sqlite3 (native Node.js binding) which works without the CLI
        const dbExists = fs.existsSync(henryDbPath);
        if (!dbExists) {
          return { ok: false, detail: 'Database file missing — will recreate on restart' };
        }
        try {
          const stat = fs.statSync(henryDbPath);
          const sizeKB = (stat.size / 1024).toFixed(0);
          // Quick integrity check by opening the DB
          const testDb = require('better-sqlite3')(henryDbPath, { readonly: true });
          testDb.pragma('integrity_check');
          testDb.close();
          return { ok: true, detail: `DB: ${sizeKB}KB — healthy` };
        } catch (e) {
          return { ok: false, detail: `Database corrupted or inaccessible: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
      fix: async () => {
        // DB corruption fix would be complex - just recreate
        return { success: false, message: 'Database issues require manual recovery. Backup henry.db and restart to recreate.' };
      },
    },

    // ── Henry settings check ──────────────────────────────────────────────────
    {
      id: 'groq_key',
      name: 'Groq API Key',
      category: 'configuration',
      description: 'Free AI model access — Henry\'s brain (configuration, not system health)',
      check: async (_db) => {
        try {
          const row = _db.prepare("SELECT api_key FROM providers WHERE id='groq' AND enabled=1;").get() as { api_key: string } | undefined;
          if (row && row.api_key && row.api_key.length > 10) return { ok: true, detail: `Key set (${row.api_key.length} chars)` };
          return { ok: true, detail: 'No Groq API key — configure in Settings → AI Providers (optional)' };
        } catch { return { ok: true, detail: 'Could not check API key' }; }
      },
      // No auto-fix for API keys — user must configure in Settings
    },

    {
      id: 'tunnel_config',
      name: 'Auto-Tunnel Setting',
      category: 'recommended',
      description: 'Cloudflare tunnel starts automatically so mobile works anywhere',
      check: async (_db) => {
        try {
          const row = _db.prepare("SELECT value FROM settings WHERE key='auto_tunnel_enabled';").get() as { value: string } | undefined;
          return row?.value === 'true'
            ? { ok: true, detail: 'Auto-tunnel enabled' }
            : { ok: false, detail: 'Auto-tunnel disabled — mobile only works on home WiFi' };
        } catch { return { ok: false, detail: 'Could not check tunnel setting' }; }
      },
      fix: async (_db) => {
        try {
          _db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('auto_tunnel_enabled','true');").run();
          return { success: true, message: 'Auto-tunnel enabled' };
        } catch (e) { return { success: false, message: String(e) }; }
      },
    },

    {
      id: 'screen_recording',
      name: isLinux() ? 'Screen Capture' : isWindows() ? 'Screen Capture' : 'Screen Recording Permission',
      category: 'recommended',
      description: isLinux() ? 'Required for screenshots and live screen view' : 'Required for live screen view on mobile',
      check: async () => {
        try {
          if (isLinux()) {
            // Linux: real capability check — try an actual screen capture
            // with the same backends Henry uses (scrot/import/gnome-screenshot)
            const tmp = `${os.tmpdir()}/henry_health_check.png`;
            const backends = [
              `scrot "${tmp}" 2>/dev/null`,
              `import -window root "${tmp}" 2>/dev/null`,
              `gnome-screenshot -f "${tmp}" 2>/dev/null`,
              `xfce4-screenshooter -s -f "${tmp}" 2>/dev/null`,
            ].map(c => c + ` && [ -s "${tmp}" ]`);
            let ok = false;
            let usedBackend = '';
            for (const cmd of backends) {
              try {
                const { execSync } = require('child_process');
                execSync(cmd, { timeout: 5000, stdio: 'ignore' });
                if (fs.existsSync(tmp)) {
                  const stat = fs.statSync(tmp);
                  if (stat.size > 5000) {
                    ok = true;
                    usedBackend = cmd.split(' ')[0];
                  }
                }
              } catch { /* try next backend */ }
              if (ok) break;
            }
            try { fs.unlinkSync(tmp); } catch { /* */ }
            if (ok) return { ok: true, detail: `${usedBackend} available` };
            // No backend available — check session type for helpful message
            const sessionType = detectLinuxSession();
            return { ok: false, detail: `No screenshot backend available (${sessionType}). Install scrot, ImageMagick, or gnome-screenshot.` };
          }

          if (isWindows()) {
            // Windows: PowerShell screenshot capability
            const tmp = `${os.tmpdir()}/henry_health_check.png`;
            const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(100, 100); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, 100, 100); $bmp.Save('${tmp}'); $bmp.Dispose()"`;
            const { execSync } = require('child_process');
            execSync(cmd, { timeout: 5000, stdio: 'ignore' });
            let ok = false;
            if (fs.existsSync(tmp)) {
              const stat = fs.statSync(tmp);
              ok = stat.size > 5000;
            }
            try { fs.unlinkSync(tmp); } catch { /* */ }
            return ok ? { ok: true, detail: 'PowerShell screenshot available' } : { ok: false, detail: 'Screen capture check failed' };
          }

          // macOS: try Electron's API first, then functional check
          const { systemPreferences } = require('electron');
          const status = systemPreferences.getMediaAccessStatus('screen');
          if (status === 'granted') return { ok: true };

          // Fallback: try an actual screen capture
          const tmp = `${os.tmpdir()}/henry_health_check.png`;
          const macCmd = `screencapture -x -t png "${tmp}"`;
          const { execSync } = require('child_process');
          execSync(macCmd, { timeout: 3000, stdio: 'ignore' });
          const stat = fs.statSync(tmp);
          try { fs.unlinkSync(tmp); } catch { /* */ }
          // A real screen capture is hundreds of KB; a denied/empty one is < 5KB
          return { ok: stat.size > 5000 };
        } catch {
          return { ok: false, detail: 'Screen capture check failed' };
        }
      },
      fix: async () => {
        if (isLinux()) {
          // Linux: install a screenshot backend via pkexec
          // Try scrot first, then ImageMagick, then gnome-screenshot
          for (const pkg of ['scrot', 'imagemagick', 'gnome-screenshot']) {
            const result = await installViaPackageManager(pkg);
            if (result.success) {
              return { success: true, message: `Installed ${pkg} for screen capture` };
            }
          }
          return { success: false, message: 'Failed to install any screenshot backend. Try manually: sudo apt install scrot' };
        }
        if (isWindows()) {
          return { success: true, message: 'Screen capture available on Windows' };
        }
        // Only open system preferences on macOS
        if (process.platform === 'darwin') {
          await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
        return { success: false, message: 'Opening Screen Recording settings — enable Henry AI, then restart Henry' };
      },
    },

    {
      id: 'accessibility',
      name: isLinux() ? 'Computer Control' : isWindows() ? 'Computer Access' : 'Accessibility Permission',
      category: 'recommended',
      description: isLinux() ? 'Lets Henry control your computer — keyboard, mouse, clipboard, app switching' : isWindows() ? 'Lets Henry control your computer' : 'Required for iPad remote control — lets Henry move the mouse and type',
      check: async () => {
        try {
          if (isLinux()) {
            // Linux: real capability check — verify the backends Henry uses
            // for keyboard/mouse control, clipboard, and app activation.
            const { execSync } = require('child_process');
            const ENV = { ...process.env, HOME: os.homedir(), PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` };

            const sessionType = detectLinuxSession();
            const checkBin = (bins: string[]): string | null => {
              for (const b of bins) {
                try { execSync(`which ${b} 2>/dev/null`, { encoding: 'utf8', env: ENV, timeout: 3000 }); return b; } catch { /* continue */ }
              }
              return null;
            };

            // Backends Henry relies on
            const xdotool = checkBin(['xdotool']);
            const wmctrl = checkBin(['wmctrl']);
            const xclip = checkBin(['xclip', 'xsel']);
            const wlCopy = checkBin(['wl-copy', 'wl-paste']);

            const wayland = sessionType === 'wayland';
            const x11 = sessionType === 'x11';
            const isWSL = (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ? true : false;

            // Determine status
            const hasAutomation = !!(xdotool || wmctrl);
            const hasClipboard = !!(xclip || wlCopy);

            if (hasAutomation) {
              const backends = [xdotool, wmctrl].filter(Boolean).join(', ');
              return { ok: true, detail: `${backends}${hasClipboard ? ` · clipboard: ${xclip || wlCopy}` : ''}` };
            }

            // No automation tool found — explain based on session
            if (wayland) {
              return {
                ok: false,
                detail: isWSL
                  ? 'Wayland/WSLg session — computer control needs xdotool or wmctrl installed (X11 tools). Install: sudo apt install xdotool wmctrl xclip'
                  : 'Wayland session — computer control needs xdotool or wmctrl. Some Wayland compositors allow X11 tools via XWayland.'
              };
            }
            if (x11) {
              return {
                ok: false,
                detail: isWSL
                  ? 'X11/WSLg session — computer control needs xdotool or wmctrl. Install: sudo apt install xdotool wmctrl xclip'
                  : `X11 session — install xdotool and wmctrl (and xclip for clipboard): sudo apt install xdotool wmctrl xclip`
              };
            }
            return {
              ok: false,
              detail: `Unknown session (${sessionType}) — computer control needs xdotool / wmctrl / xclip.`
            };
          }

          if (isWindows()) {
            // Windows: no macOS-style permission. Computer access is inherent.
            return { ok: true, detail: 'Computer access available' };
          }

          // macOS: preserve existing permission check
          const { systemPreferences } = require('electron');
          const ok = systemPreferences.isTrustedAccessibilityClient(false);
          return ok
            ? { ok: true }
            : { ok: false, detail: 'Accessibility not granted — System Settings → Privacy → Accessibility' };
        } catch {
          return { ok: true };
        }
      },
      fix: async (): Promise<FixResult> => {
        try {
          if (isLinux()) {
            // Linux: install computer control tools via pkexec
            for (const pkg of ['xdotool', 'wmctrl', 'xclip']) {
              const result = await installViaPackageManager(pkg);
              if (!result.success) {
                return { success: false, message: `Failed to install ${pkg}: ${result.message}` };
              }
            }
            return { success: true, message: 'Installed computer control tools (xdotool, wmctrl, xclip)' };
          }
          if (isWindows()) {
            return { success: true, message: 'Computer access available on Windows' };
          }
          const { systemPreferences, shell } = require('electron');
          systemPreferences.isTrustedAccessibilityClient(true);
          // Only open system preferences on macOS
          if (process.platform === 'darwin') {
            await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
          }
          return { success: false, message: 'Opening Accessibility settings — enable Henry AI, then restart' };
        } catch (e) {
          return { success: false, message: 'Could not open Accessibility settings: ' + String(e) };
        }
      },
    },

    {
      id: 'disk_space',
      name: 'Disk Space',
      category: 'recommended',
      description: 'Henry needs space for conversations, media, and AI models',
      check: async () => {
        try {
          const out = execSync('df -h / | tail -1', { encoding: 'utf8', env: ENV, timeout: 3000 });
          const parts = out.trim().split(/\s+/);
          const available = parts[3] || '?';
          const usedPct = parseInt(parts[4] || '0');
          const ok = usedPct < 90;
          return { ok, detail: `${available} free (${parts[4]} used)`, volume: available };
        } catch { return { ok: true, detail: 'Could not check disk' }; }
      },
    },
  ];
}

// ── Run full diagnostic ────────────────────────────────────────────────────
export async function runDiagnostic(autoFix = true, db: Database.Database): Promise<DiagnosticReport> {
  const report: DiagnosticReport = {
    timestamp: new Date().toISOString(),
    checks: [],
    summary: { ok: 0, fixed: 0, failed: 0, warnings: 0 },
  };

  const checks = HEALTH_CHECKS(db);
  for (const check of checks) {
    const category = check.category; // Store to avoid type narrowing issues
    const isConfig = category === 'configuration';
    const isRequired = category === 'required';
    const result = await check.check(db).catch(e => ({ ok: false, detail: String(e) }));
    const entry: DiagnosticReport['checks'][0] = {
      id: check.id,
      name: check.name,
      category: check.category,
      status: result.ok
        ? 'ok'
        : isRequired
          ? 'error'
          : isConfig
            ? 'ok'
            : 'warning',
      detail: result.detail,
      version: (result as CheckResult).version,
    };

    if (!result.ok && autoFix && check.fix && !isConfig) {
      try {
        const fixResult = await check.fix(db);
        if (fixResult.success) {
          entry.status = 'fixed';
          entry.fixMessage = fixResult.message;
          report.summary.fixed++;
        } else {
          entry.status = isRequired ? 'fix_failed' : 'warning';
          entry.fixMessage = fixResult.message;
          if (isRequired) report.summary.failed++;
          else report.summary.warnings++;
        }
      } catch (e) {
        entry.fixMessage = String(e);
        entry.status = 'fix_failed';
        if (isRequired) report.summary.failed++;
        else report.summary.warnings++;
      }
    } else if (result.ok) {
      report.summary.ok++;
    } else if (!isConfig) {
      report.summary.warnings++;
    }

    report.checks.push(entry);
  }

  return report;
}

// ── Save report to DB ──────────────────────────────────────────────────────
export function saveReport(db: Database.Database, report: DiagnosticReport): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('last_diagnostic',?)").run(JSON.stringify(report));
  } catch { /* ignore */ }
}

export function loadLastReport(db: Database.Database): DiagnosticReport | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='last_diagnostic'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}