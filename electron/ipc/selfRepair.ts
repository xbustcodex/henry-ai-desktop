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
import { probeTool, describeProbe } from './toolProbe';
import { getDbFilePath } from './database';
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
  /**
   * Which of the four states this check actually established. Left undefined
   * for checks that are not dependency probes and answer definitively.
   * A probe that could not run reports 'probe-failed' or 'unresolved', and
   * the runner never offers to install anything for those — telling someone
   * to install software we merely failed to find is worse than saying
   * nothing.
   */
  state?: 'installed' | 'missing' | 'unresolved' | 'probe-failed';
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
/**
 * Locate a dependency and read its version.
 *
 * This used to be `execSync(`${cmd} --version 2>/dev/null`)`. On Windows
 * execSync runs through cmd.exe, which has no /dev/null, so every probe died
 * with "The system cannot find the path specified", the error was swallowed,
 * and healthy installs of Node, Git and Python were reported as missing with
 * an offer to install them. It was also synchronous, which froze the Electron
 * main process — up to 5s per tool — and that is what made the installed app
 * go "Not Responding" while a health check ran.
 *
 * probeTool is async, uses no shell redirection, and reports four distinct
 * outcomes so a probe that could not run is never presented as "not
 * installed".
 */
async function toolProbe(cmd: string, versionFlag = '--version') {
  return probeTool(cmd.replace(/^["']|["']$/g, ''), { versionFlag });
}

/** Convenience for checks that only care whether it is really absent. */
async function toolMissing(cmd: string, label: string, versionFlag = '--version') {
  const p = await toolProbe(cmd, versionFlag);
  return p.state === 'missing' ? { ok: false, state: p.state, detail: `${label} not installed` }
    : { ok: true, state: p.state, version: p.version, detail: describeProbe(p, label) };
}

/** Run a shell command without blocking the Electron main process. */
function runAsync(cmd: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(new Error(`timed out after ${timeoutMs}ms`));
          return;
        }
        if (err && !stdout && !stderr) { reject(err); return; }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? 1 : 0 });
      });
  });
}

function toolExists(cmd: string): boolean {
  // `which` does not exist on Windows; whichBin uses `where` there.
  try { const { whichBin } = require('./platformCommands') as typeof import('./platformCommands'); return whichBin(cmd) !== null; } catch { return false; }
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
    // Windows: prefer winget, fallback to choco, then manual.
    // winget package IDs are namespaced (Git.Git, not "git"); the bare names
    // this used to pass are not valid IDs, so the install could never succeed
    // even on a machine where winget was present.
    const wingetId = WINGET_IDS[pkg];
    return new Promise(resolve => {
      exec(`winget install --id ${wingetId ?? pkg} --silent --accept-source-agreements --accept-package-agreements`, { env: ENV, timeout: 120_000, windowsHide: true }, (err) => {
        if (!err) return resolve({ success: true, message: `Installed ${pkg} via winget` });
        // Try chocolatey
        exec(`choco install ${pkg} -y`, { env: ENV, timeout: 120_000, windowsHide: true }, (err2) => {
          if (err2) resolve({ success: false, message: `Auto-install failed. Try: winget install ${pkg} or choco install ${pkg}` });
          else resolve({ success: true, message: `Installed ${pkg} via chocolatey` });
        });
      });
    });
  }
  return { success: false, message: `Auto-install not supported on this platform for ${pkg}` };
}

/** Real winget identifiers. The bare package names used before are not IDs. */
const WINGET_IDS: Record<string, string> = {
  node: 'OpenJS.NodeJS.LTS',
  git: 'Git.Git',
  ffmpeg: 'Gyan.FFmpeg',
  python3: 'Python.Python.3.12',
  'yt-dlp': 'yt-dlp.yt-dlp',
  cloudflared: 'Cloudflare.cloudflared',
};

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
  // Ask the database module where it actually lives. This hardcoded
  // $HOME/henry.db, but Henry stores it under Electron's userData directory,
  // so the check reported "Database file missing" and offered to repair a
  // healthy database on every run.
  const henryDbPath = getDbFilePath();

  return [

    // ── Core runtime ──────────────────────────────────────────────────────────
    {
      id: 'brew',
      name: 'Homebrew',
      category: isDarwin() ? 'required' : 'not-applicable',
      description: 'Package manager — used to install everything else (macOS only)',
      check: async () => {
        if (!isDarwin()) return { ok: true, detail: 'Not applicable on this platform' };
        const p = await toolProbe(BREW);
        return p.state === 'installed'
          ? { ok: true, state: p.state, version: p.version }
          : { ok: false, state: p.state, detail: describeProbe(p, 'Homebrew') };
      },
      // brew can't auto-install itself — give user a one-liner
    },

{
      id: 'node',
      name: 'Node.js',
      category: 'required',
      description: "JavaScript runtime for Henry's backend",
      check: async () => {
        return toolMissing('node', 'Node.js');
      },
      fix: async () => installViaPackageManager('node'),
    },

    {
      id: 'cloudflared',
      name: 'Cloudflare Tunnel',
      category: 'optional',
      description: 'Secure tunnel so mobile works from anywhere (optional — LAN pairing works without it)',
      check: async () => {
        // Optional: being absent is a perfectly healthy state, so this always
        // reports ok. It no longer shells out three times per platform, which
        // was blocking the main process for up to 9s.
        const p = await toolProbe('cloudflared');
        if (p.state === 'installed') return { ok: true, state: p.state, version: p.version };
        const hint = isDarwin() ? 'brew install cloudflared' : isLinux() ? 'sudo apt-get install cloudflared' : 'winget install Cloudflare.cloudflared';
        return {
          ok: true,
          state: p.state,
          detail: `${describeProbe(p, 'cloudflared')} — optional. LAN pairing works without it; install with: ${hint}`,
        };
      },
      // No auto-fix for optional cloudflared
    },

    {
      id: 'git',
      name: 'Git',
      category: 'required',
      description: 'Version control — used for Henry updates',
      check: async () => {
        return toolMissing('git', 'Git');
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
        const p = await toolProbe('ffmpeg', '-version');
        return p.state === 'installed'
          ? { ok: true, state: p.state, version: p.version?.split('\n')[0] }
          : { ok: false, state: p.state, detail: `${describeProbe(p, 'ffmpeg')} — voice processing unavailable` };
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
        const p = await toolProbe('yt-dlp');
        return p.state === 'installed'
          ? { ok: true, state: p.state, version: p.version }
          : { ok: false, state: p.state, detail: `${describeProbe(p, 'yt-dlp')} — optional for video downloads` };
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
        // On Windows the launcher is `python`, not `python3`.
        const first = await toolProbe('python3');
        if (first.state !== 'missing') {
          return first.state === 'installed'
            ? { ok: true, state: first.state, version: first.version }
            : { ok: false, state: first.state, detail: describeProbe(first, 'Python 3') };
        }
        const alt = await toolProbe('python');
        return alt.state === 'installed'
          ? { ok: true, state: alt.state, version: alt.version }
          : { ok: false, state: first.state, detail: `${describeProbe(first, 'Python 3')}` };
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
          const p = await probeTool('claude', { pathHint: c }).catch(() => null);
          if (p && p.state === 'installed') {
            return { ok: true, state: p.state, version: p.version, detail: c === 'claude' ? undefined : c };
          }
        }
        // Not in the known locations — ask PATH properly before concluding.
        const onPath = await toolProbe('claude');
        if (onPath.state === 'installed') {
          return { ok: true, state: onPath.state, version: onPath.version };
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
        if (!henryDbPath) {
          // Not knowing where the database is is not the same as it being
          // absent. Never offer to "repair" something we could not look at.
          return { ok: false, state: 'probe-failed', detail: 'Database location is not known yet — could not verify. This does not mean the database is missing.' };
        }
        const dbExists = fs.existsSync(henryDbPath);
        if (!dbExists) {
          return { ok: false, state: 'missing', detail: `Database file not found at ${henryDbPath} — will recreate on restart` };
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
            // Two defects in the old probe, both found by running it on a real
            // Windows machine:
            //
            //  1. `$bmp.Save(path)` with no explicit format throws
            //     MethodInvocationException — yet PowerShell still exits 0, so
            //     the exit status could never detect it, and it left a
            //     DIRECTORY at the path, which existsSync reported as success.
            //  2. The "is it a real image" test was `size > 5000`. A flat white
            //     100x100 PNG compresses to a few hundred bytes, so even a
            //     perfectly good capture could never clear that threshold —
            //     the check was guaranteed to fail.
            //
            // So: capture the real screen, save with an explicit format, and
            // confirm it is a real file rather than guessing from its size. The
            // script prints OK/ERR itself because the exit code lies.
            const tmp = `${os.tmpdir()}/henry_health_check.png`;
            const cmd =
              `powershell -NoProfile -Command ` +
              `"$ErrorActionPreference='Stop';` +
              `try {` +
              `Add-Type -AssemblyName System.Drawing;` +
              `Add-Type -AssemblyName System.Windows.Forms;` +
              `$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen;` +
              `$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height);` +
              `$g = [System.Drawing.Graphics]::FromImage($bmp);` +
              `$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size);` +
              `$bmp.Save('${tmp}', [System.Drawing.Imaging.ImageFormat]::Png);` +
              `$g.Dispose(); $bmp.Dispose();` +
              `Write-Output 'HENRY_PROBE_OK';` +
              `} catch { Write-Output ('HENRY_PROBE_ERR:' + $_.Exception.Message) }"`;

            let out = '';
            let ranOk = false;
            try {
              const r = await runAsync(cmd, 12_000);
              out = String(r.stdout || '');
              ranOk = out.includes('HENRY_PROBE_OK');
            } catch {
              // PowerShell could not be run at all — a failed probe, NOT proof
              // that screen capture is unavailable.
              return {
                ok: false,
                state: 'probe-failed',
                detail: 'Could not run the PowerShell screen-capture probe. This does not mean screen capture is unavailable.',
              };
            }

            let real = false;
            try {
              const st = fs.statSync(tmp);
              // isFile, not exists: the broken probe used to leave a directory.
              real = st.isFile() && st.size > 0;
            } catch {
              real = false;
            }
            try {
              if (fs.existsSync(tmp)) {
                if (fs.statSync(tmp).isFile()) fs.unlinkSync(tmp);
                else fs.rmdirSync(tmp);   // tidy up the stray directory
              }
            } catch { /* best effort */ }

            if (ranOk && real) {
              return { ok: true, state: 'installed', detail: 'Screen capture works — a real screenshot was taken and read back.' };
            }
            const reason = out.includes('HENRY_PROBE_ERR:')
              ? out.split('HENRY_PROBE_ERR:')[1].trim().slice(0, 160)
              : real ? '' : 'no image file was produced';
            return {
              ok: false,
              state: ranOk ? 'installed' : 'probe-failed',
              detail: `Screen capture probe could not complete${reason ? `: ${reason}` : ''}. This is not the same as screen capture being unavailable.`,
            };
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
          // The old fix returned success:true without doing anything, which is
          // why the panel showed "Screen capture available on Windows" directly
          // beneath "probe ran but produced no image". Windows includes screen
          // capture, so there is nothing to install — say what is actually true
          // instead of pretending to have fixed it.
          return {
            success: false,
            message:
              'Nothing to install — Windows already includes screen capture. ' +
              'Check that PowerShell can load System.Drawing and Windows.Forms, and that antivirus is not blocking it.',
          };
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
                // `which` does not exist on Windows; whichBin uses `where` there.
                try { const { whichBin } = require('./platformCommands') as typeof import('./platformCommands'); if (whichBin(b)) return b; } catch { /* continue */ }
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
          // `df` does not exist on Windows; use the cross-platform reader.
          const { getDiskBytes, formatBytes } = await import('./platformCommands') as typeof import('./platformCommands');
          const d = getDiskBytes();
          if (!d || !d.total) return { ok: true, detail: 'Could not check disk space' };
          const usedPct = Math.round((d.used / d.total) * 100);
          const available = formatBytes(d.free);
          return { ok: usedPct < 90, detail: `${available} free (${usedPct}% used)`, volume: available };
        } catch { return { ok: true, detail: 'Could not check disk space' }; }
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
    const result: CheckResult = await check.check(db).catch(e => ({
      ok: false,
      state: 'probe-failed' as const,
      detail: `check could not complete: ${String(e)}`,
    }));
    // A probe that merely failed to run is not evidence of absence. Only a
    // definitive 'missing' justifies telling the user to install something —
    // that is what made Henry offer to reinstall Node and Git on a machine
    // that already had both.
    const indeterminate = result.state === 'probe-failed' || result.state === 'unresolved';
    const entry: DiagnosticReport['checks'][0] = {
      id: check.id,
      name: check.name,
      category: check.category,
      status: result.ok
        ? 'ok'
        : indeterminate
          ? 'warning'
          : isRequired
            ? 'error'
            : isConfig
              ? 'ok'
              : 'warning',
      detail: result.detail,
      version: result.version,
    };

    // Optional tools are allowed to be absent, so never try to install one on
    // launch: that is what produced "Auto-install failed. Try: winget install
    // yt-dlp" for a tool nothing depends on. Anything that actually needs it
    // says so in its own description.
    const isOptional = category === 'optional';
    if (!result.ok && !indeterminate && !isOptional && autoFix && check.fix && !isConfig) {
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