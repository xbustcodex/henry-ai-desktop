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
  category: 'required' | 'recommended' | 'optional';
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

async function brewInstall(pkg: string): Promise<FixResult> {
  return new Promise(resolve => {
    exec(`${BREW} install ${pkg}`, { env: ENV, timeout: 120_000 }, (err) => {
      if (err) resolve({ success: false, message: `brew install ${pkg} failed: ${err.message.slice(0, 100)}` });
      else resolve({ success: true, message: `Installed ${pkg} via brew` });
    });
  });
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
      category: isDarwin() ? 'required' : 'optional',
      description: 'Package manager — used to install everything else',
      check: async () => {
        if (!isDarwin()) return { ok: true, detail: 'Homebrew is only available on macOS' };
        const v = toolVersion(BREW);
        return v ? { ok: true, version: v } : { ok: false, detail: 'Homebrew not found' };
      },
      // brew can't auto-install itself — give user a one-liner
    },

    {
      id: 'node',
      name: 'Node.js',
      category: 'required',
      description: 'JavaScript runtime for Henry\'s backend',
      check: async () => {
        const v = toolVersion('node');
        return v ? { ok: true, volume: v } : { ok: false, detail: 'Node.js not installed' };
      },
      fix: async () => brewInstall('node'),
    },

    {
      id: 'cloudflared',
      name: 'Cloudflare Tunnel',
      category: 'optional',
      description: 'Secure tunnel so mobile works from anywhere',
      check: async () => {
        if (isDarwin()) {
          const v = toolVersion('cloudflared');
          return v ? { ok: true, volume: v } : { ok: false, detail: 'cloudflared not installed — mobile only works on home WiFi' };
        }
        if (isLinux()) {
          try { execSync('cloudflared --version', { encoding: 'utf8', env: ENV, timeout: 3000 }); return { ok: true, volume: 'cloudflared' }; } catch {
            // Check via PATH or default install locations
            try { execSync('which cloudflared', { encoding: 'utf8', env: ENV, timeout: 3000 }); return { ok: true, volume: 'cloudflared' }; } catch {
              return { ok: false, detail: 'cloudflared not installed — install via: sudo apt-get install cloudflared, or download from https://developers.cloudflare.com/cloudflare-one/connections/how-to/install-cloudflared/' };
            }
          }
        }
        // Windows or other platforms
        try { execSync('cloudflared --version', { encoding: 'utf8', env: ENV, timeout: 3000 }); return { ok: true, volume: 'cloudflared' }; } catch {
          return { ok: false, detail: 'cloudflared not installed — optional for remote companion' };
        }
      },
      fix: async () => {
        if (isDarwin()) {
          return brewInstall('cloudflared');
        }
        if (isLinux()) {
          try { execSync('apt-get update && apt-get install -y cloudflared', { env: ENV, timeout: 120_000 }); return { success: true, message: 'Installed cloudflared via apt' }; } catch {
            return { success: false, message: 'Auto-install failed — install cloudflared manually: sudo apt-get install cloudflared' };
          }
        }
        // Windows
        return { success: false, message: 'Auto-install not supported on this platform — install cloudflared manually' };
      },
    },

    {
      id: 'git',
      name: 'Git',
      category: 'required',
      description: 'Version control — used for Henry updates',
      check: async () => {
        const v = toolVersion('git');
        return v ? { ok: true, volume: v } : { ok: false, detail: 'Git not installed' };
      },
      fix: async () => brewInstall('git'),
    },

    // ── Media tools ───────────────────────────────────────────────────────────
    {
      id: 'ffmpeg',
      name: 'FFmpeg',
      category: 'recommended',
      description: 'Audio/video processing — required for voice features and media generation',
      check: async () => {
        const v = toolVersion('ffmpeg', '-version');
        return v ? { ok: true, volume: v.split('\n')[0] } : { ok: false, detail: 'ffmpeg not installed — voice processing unavailable' };
      },
      fix: async () => brewInstall('ffmpeg'),
    },

    // ── Voice (free local speech) ─────────────────────────────────────────────
    {
      id: 'whisper_cpp',
      name: 'Whisper (local speech-to-text)',
      category: 'recommended',
      description: 'whisper.cpp — free, offline voice input for Henry',
      check: async () => {
        try {
          const { detectWhisperBinary } = require('../voice/stt') as typeof import('../voice/stt');
          const bin = detectWhisperBinary(true);
          return bin
            ? { ok: true, detail: bin }
            : { ok: false, detail: 'whisper-cli not installed — voice input runs one-time setup on first use' };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      },
      fix: async () => {
        if (!toolVersion(BREW)) {
          return { success: false, message: 'Homebrew not found — cannot auto-install whisper-cpp' };
        }
        return brewInstall('whisper-cpp');
      },
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
        return v ? { ok: true, volume: v } : { ok: false, detail: 'yt-dlp not installed' };
      },
      fix: async () => brewInstall('yt-dlp'),
    },

    // ── Python ────────────────────────────────────────────────────────────────
    {
      id: 'python3',
      name: 'Python 3',
      category: 'recommended',
      description: 'Used for AI scripts, data processing, and Henry utilities',
      check: async () => {
        const v = toolVersion('python3');
        return v ? { ok: true, volume: v } : { ok: false, detail: 'Python 3 not installed' };
      },
      fix: async () => brewInstall('python3'),
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
        return new Promise((resolve) => {
          exec('ollama pull qwen2.5-coder:7b', { env: ENV, timeout: 600_000 }, (err) => {
            if (err) resolve({ success: false, message: 'Auto-pull failed — run: ollama pull qwen2.5-coder:7b' });
            else resolve({ success: true, message: 'Pulled qwen2.5-coder:7b for the free local coder' });
          });
        });
      },
    },

    // ── Database ──────────────────────────────────────────────────────────────
    {
      id: 'sqlite3',
      name: 'SQLite',
      category: 'required',
      description: 'Henry\'s local database — stores all conversations, memory, tasks',
      check: async () => {
        const v = toolVersion('sqlite3');
        // Also check DB file health
        const dbExists = fs.existsSync(henryDbPath);
        return v && dbExists
          ? { ok: true, volume: v, detail: `DB: ${(fs.statSync(henryDbPath).size / 1024).toFixed(0)}KB` }
          : { ok: false, detail: !dbExists ? 'Database file missing — will recreate on restart' : 'sqlite3 not installed' };
      },
      fix: async () => brewInstall('sqlite3'),
    },

    // ── Henry settings check ──────────────────────────────────────────────────
    {
      id: 'groq_key',
      name: 'Groq API Key',
      category: 'optional',
      description: 'Free AI model access — Henry\'s brain',
      check: async (_db) => {
        try {
          const row = _db.prepare("SELECT api_key FROM providers WHERE id='groq' AND enabled=1;").get() as { api_key: string } | undefined;
          if (row && row.api_key && row.api_key.length > 10) return { ok: true, detail: `Key set (${row.api_key.length} chars)` };
          return { ok: false, detail: 'No Groq API key — configure in Settings → AI Providers' };
        } catch { return { ok: false, detail: 'Could not check API key' }; }
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
            const sessionType = process.env.XDG_SESSION_TYPE || process.env.XDG_CURRENT_DESKTOP || 'unknown';
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
          // Linux: install a screenshot backend (scrot/ImageMagick/gnome-screenshot)
          return { success: false, message: 'Install a screenshot tool: sudo apt install scrot (or ImageMagick for "import")' };
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

            const sessionType = process.env.XDG_SESSION_TYPE || process.env.XDG_CURRENT_DESKTOP || 'unknown';
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
            const x11 = sessionType === 'x11' || sessionType === 'org.kde.plasma';
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
            // Linux: no macOS permissions. Report how to install the tools.
            const pkg = 'xdotool wmctrl';
            return { success: false, message: `Install computer control tools: sudo apt install ${pkg}` };
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
    const result = await check.check(db).catch(e => ({ ok: false, detail: String(e) }));
    const entry: DiagnosticReport['checks'][0] = {
      id: check.id,
      name: check.name,
      category: check.category,
      status: result.ok ? 'ok' : (check.category === 'required' ? 'error' : 'warning'),
      detail: result.detail,
      version: (result as CheckResult).version,
    };

    if (!result.ok && autoFix && check.fix) {
      try {
        const fixResult = await check.fix(db);
        if (fixResult.success) {
          entry.status = 'fixed';
          entry.fixMessage = fixResult.message;
          report.summary.fixed++;
        } else {
          entry.status = check.category === 'required' ? 'fix_failed' : 'warning';
          entry.fixMessage = fixResult.message;
          if (check.category === 'required') report.summary.failed++;
          else report.summary.warnings++;
        }
      } catch (e) {
        entry.fixMessage = String(e);
        entry.status = 'fix_failed';
        if (check.category === 'required') report.summary.failed++;
        else report.summary.warnings++;
      }
    } else if (result.ok) {
      report.summary.ok++;
    } else if (check.category === 'required') {
      report.summary.failed++;
    } else {
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