/**
 * Coder Engine — Claude Code CLI runner (Henry's DEFAULT coder).
 *
 * Uses the Claude Code CLI headless (`claude -p … --output-format stream-json
 * --verbose`) so coding runs on the user's Claude subscription: big context,
 * agentic edits, no per-token cost. Detection is cached; runs stream
 * normalized CoderStreamEvents back to the caller (electron/coder/index.ts
 * forwards them to the renderer on the 'coder:event' channel, mirroring how
 * ai:stream forwards chunks).
 *
 * Safety:
 *   - permission mode is 'acceptEdits' ONLY inside Henry's coder workspace
 *     (~/HenryAI/coder-projects); anywhere else it stays 'default' so Claude
 *     Code's own permission prompts apply. --dangerously-skip-permissions is
 *     never used.
 *   - CLAUDECODE / CLAUDE_CODE_* env vars are stripped from the child env so
 *     a Henry dev instance launched from inside a Claude Code session doesn't
 *     confuse the nested CLI.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLineBuffer, parseClaudeStreamJsonLine, type CoderStreamEvent } from './streamJson';
import { buildCoderChildEnv } from './opencode';

const execFileP = promisify(execFile);

// ── Coder workspace ───────────────────────────────────────────────────────

/** Henry's dedicated coder sandbox — auto-edits are allowed only in here. */
export const CODER_WORKSPACE_DIR = path.join(os.homedir(), 'HenryAI', 'coder-projects');

/** Create the coder workspace on demand and return its path. */
export function ensureCoderWorkspace(): string {
  try {
    fs.mkdirSync(CODER_WORKSPACE_DIR, { recursive: true });
  } catch {
    /* mkdir failure surfaces later as a spawn cwd error */
  }
  return CODER_WORKSPACE_DIR;
}

/** True when `dir` resolves to a path inside (or equal to) the coder workspace. */
export function isInsideCoderWorkspace(dir: string): boolean {
  const abs = path.resolve(dir);
  const ws = path.resolve(CODER_WORKSPACE_DIR);
  return abs === ws || abs.startsWith(ws + path.sep);
}

export type ClaudePermissionMode = 'default' | 'plan' | 'acceptEdits';

/**
 * Resolve the --permission-mode for a run. The configured setting
 * (`coder_permission_mode`) is honored, EXCEPT that 'acceptEdits' is only
 * allowed inside the Henry coder workspace — outside it we always fall back
 * to 'default' (or 'plan' if configured) so nothing is auto-applied to the
 * user's real repos without Claude Code's own prompts.
 */
export function resolvePermissionMode(cwd: string, configured?: string | null): ClaudePermissionMode {
  const inside = isInsideCoderWorkspace(cwd);
  if (configured === 'plan') return 'plan';
  if (configured === 'default') return 'default';
  if (configured === 'acceptEdits') return inside ? 'acceptEdits' : 'default';
  // No/unknown setting → workspace default.
  return inside ? 'acceptEdits' : 'default';
}

// ── CLI detection ─────────────────────────────────────────────────────────

export interface ClaudeCliInfo {
  available: boolean;
  path?: string;
  version?: string;
}

/** PATH + the common install locations Henry knows about. */
function candidateBinaries(): string[] {
  const home = os.homedir();
  return [
    'claude', // resolved against the (extended) PATH below
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.local', 'bin', 'claude'),
  ];
}

/**
 * Child env for detection + runs: extended PATH (GUI apps on macOS get a bare
 * PATH) and NO Claude Code session vars, so headless runs never think they're
 * nested inside another Claude Code session.
 */
/** Child env for detection + runs. Shared with the opencode engine. */
export const buildClaudeChildEnv = buildCoderChildEnv;

let cachedCli: ClaudeCliInfo | null = null;

/**
 * Find the Claude Code CLI. Result is cached for the app session; pass
 * refresh=true to re-detect (e.g. after the user installs it).
 */
export async function detectClaudeCli(refresh = false): Promise<ClaudeCliInfo> {
  if (cachedCli && !refresh) return cachedCli;
  const env = buildClaudeChildEnv();
  for (const bin of candidateBinaries()) {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { env, timeout: 8_000 });
      const version = stdout.trim().split('\n')[0] || undefined;
      cachedCli = { available: true, path: bin, version };
      return cachedCli;
    } catch {
      // try the next candidate
    }
  }
  cachedCli = { available: false };
  return cachedCli;
}

// ── Headless run ──────────────────────────────────────────────────────────

export interface ClaudeCodeRunOptions {
  /** Resolved CLI binary (from detectClaudeCli().path). */
  cliPath: string;
  /** The coding task. */
  prompt: string;
  /** Target project directory (defaults to the Henry coder workspace). */
  cwd?: string;
  /** Resume a previous CLI session (session_id from a prior init event). */
  sessionId?: string;
  /** Setting value for coder_permission_mode (validated in resolvePermissionMode). */
  configuredPermissionMode?: string | null;
  /** Receives every normalized event, ending with exactly one result/error. */
  onEvent: (event: CoderStreamEvent) => void;
}

/**
 * Spawn a headless Claude Code run. Returns the child process so the caller
 * can cancel with child.kill(). Exactly one terminal event ('result' or
 * 'error') is guaranteed.
 */
export function runClaudeCode(opts: ClaudeCodeRunOptions): ChildProcess {
  const cwd = opts.cwd?.trim() ? path.resolve(opts.cwd.trim()) : ensureCoderWorkspace();
  const permissionMode = resolvePermissionMode(cwd, opts.configuredPermissionMode);

  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    permissionMode,
  ];
  if (opts.sessionId) args.push('--resume', opts.sessionId);

  const child = spawn(opts.cliPath, args, {
    cwd,
    env: buildClaudeChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let terminalSent = false;
  const emit = (event: CoderStreamEvent) => {
    if (terminalSent) return;
    if (event.kind === 'result' || event.kind === 'error') terminalSent = true;
    try {
      opts.onEvent(event);
    } catch {
      /* renderer gone — nothing to do */
    }
  };

  const lineBuffer = createLineBuffer((line) => {
    for (const event of parseClaudeStreamJsonLine(line)) emit(event);
  });

  let stderrTail = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => lineBuffer.push(chunk));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
  });

  child.on('error', (err) => {
    emit({ kind: 'error', message: `Could not start Claude Code: ${err.message}` });
  });

  child.on('close', (code, signal) => {
    lineBuffer.flush();
    if (terminalSent) return;
    if (signal) {
      emit({ kind: 'error', message: 'Claude Code run cancelled.' });
    } else {
      const detail = stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      emit({
        kind: 'error',
        message: `Claude Code exited (code ${code ?? '?'}) without a result${detail ? `: ${detail}` : '.'}`,
      });
    }
  });

  return child;
}
