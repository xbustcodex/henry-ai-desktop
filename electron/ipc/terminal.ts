/**
 * Terminal — execute shell commands from Henry.
 *
 * Sandboxed execution with configurable working directory, timeout, output
 * streaming and cancellation. The worker engine uses this for code execution,
 * npm tasks and git operations.
 *
 * WHAT CHANGED, AND WHY (parity row 7.8)
 * ----------------------------------------
 * `run_shell` was already registered, confirm-tier and classified; this module
 * was the part that had never been exercised on a real machine.
 *
 * 1. Windows shell selection. Every command went through `cmd /c`, whatever
 *    the user meant. `powershell` was unreachable, and a POSIX-flavoured
 *    command silently failed under cmd's quoting rules. The shell is now an
 *    explicit, allow-listed parameter, resolved against the real PATH with
 *    `where` (never `which`, which does not exist on Windows).
 *
 * 2. Cancellation actually cancelled. `child.kill('SIGTERM')` on Windows
 *    terminates the `cmd.exe` wrapper and leaves the command it started
 *    running — the classic shape of this bug is `tasklist … | head -40`
 *    silently failing on Windows for the same reason: a Unix assumption in a
 *    Windows code path. `taskkill /T /F` kills the whole tree, and on POSIX
 *    the child is spawned in its own process group so the group can be
 *    signalled together.
 *
 * 3. Payload validation. `params.command` went straight into `spawn`, so a
 *    non-string threw a raw TypeError across IPC instead of the clean refusal
 *    every other channel gives. The working directory is now reported when it
 *    is clamped back into bounds rather than silently changed.
 *
 * 4. Interactive processes. There is no PTY: nothing in the product advertises
 *    one, and `node-pty` is a native module that would need rebuilding for
 *    every target. Instead the child gets a real stdin pipe, so a prompt can
 *    be answered and output streams both ways. `terminal:write` exposes it.
 *
 * Safety is unchanged and deliberately so: the shared classifier runs before
 * anything spawns, and the cwd guard still goes through `isInsideRoot`.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import { isInsideRoot } from './_pathSafety';
import { classifyCommand } from './_commandSafety';
import { whichBin } from './platformCommands';

type WindowGetter = () => BrowserWindow | null;

/** Safely send to renderer — skips if window is destroyed (Vite HMR). */
function safeSend(getWin: WindowGetter, channel: string, data: unknown) {
  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

let getWindow: WindowGetter;
const activeProcesses: Map<string, ChildProcess> = new Map();

const MAX_COMMAND_LENGTH = 32_000;
const MAX_CHANNEL_ID_LENGTH = 128;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 3_600_000;

// ── Shell selection ─────────────────────────────────────────────────────────

/** Shells a caller may ask for. Anything else is refused by name. */
export const SHELL_ALIASES: Record<string, readonly string[]> = {
  // Windows
  cmd: ['cmd.exe', 'cmd'],
  powershell: ['powershell.exe', 'powershell'],
  pwsh: ['pwsh.exe', 'pwsh'],
  // POSIX
  sh: ['sh'],
  bash: ['bash'],
  zsh: ['zsh'],
};

export type ShellRequest = keyof typeof SHELL_ALIASES;

export interface ResolvedShell {
  /** Absolute path to the shell binary. */
  bin: string;
  /** How the command is handed to it. */
  kind: 'windows' | 'posix';
  /** argv prefix, e.g. ['/d', '/s', '/c'] for cmd.exe. */
  prefix: string[];
  /** The name the caller asked for, for reporting. */
  requested: string;
}


/**
 * Per-exec cancellation hooks.
 *
 * `activeProcesses` holds the `ChildProcess`; this holds the closure that also
 * records that *we* killed it, so `terminal:kill` is distinguishable from a
 * timeout in what the renderer is told.
 */
const cancelRegistry = new Map<string, () => void>();


export interface ShellSelectionFailure {
  ok: false;
  error: string;
}

export type ShellOutcome =
  | { ok: true; shell: ResolvedShell }
  | ShellSelectionFailure;

/**
 * Choose which shell to run a command in.
 *
 * The allow-list is the point: an arbitrary `shell` value would put a caller
 * in charge of choosing any executable on the machine with the user's
 * privileges and a full command string as its argument. `default` picks the
 * platform's own shell, which is `cmd.exe` on Windows and `sh` elsewhere.
 *
 * Resolution uses `whichBin`, which probes with `where` on Windows. That is
 * the same lesson as the process-list bug: `which` does not exist there.
 */
export function resolveShell(
  requested: unknown,
  platform: NodeJS.Platform = process.platform,
): ShellOutcome {
  const wanted =
    requested === undefined || requested === null || requested === 'default' || requested === ''
      ? (platform === 'win32' ? 'cmd' : 'sh')
      : String(requested).trim().toLowerCase();

  const candidates = SHELL_ALIASES[wanted];
  if (!candidates) {
    const known = Object.keys(SHELL_ALIASES).join(', ');
    return { ok: false, error: `Unknown shell "${String(requested).slice(0, 24)}". Available: default, ${known}.` };
  }

  for (const candidate of candidates) {
    const bin = whichBin(candidate);
    if (!bin) continue;
    const kind: 'windows' | 'posix' = platform === 'win32' ? 'windows' : 'posix';
    // `/d` skips AutoRun commands in the registry, which can otherwise run
    // arbitrary startup code before every command. `/s` marks the rest of the
    // line as one command so cmd's own quote rules do not mangle it.
    const prefix = candidate.toLowerCase().startsWith('cmd') ? ['/d', '/s', '/c'] : ['-c'];
    return { ok: true, shell: { bin, kind, prefix, requested: wanted } };
  }

  return {
    ok: false,
    error: `${wanted} is not installed on this machine (looked for ${candidates.join(', ')} using ${platform === 'win32' ? 'where' : 'which'}).`,
  };
}

/**
 * Validate that the requested cwd is within an allowed root (workspace or
 * home). Falls back to workspacePath when it is not — and says so, because a
 * silently relocated working directory is how a build writes to the wrong
 * place and nobody notices until later.
 */
export function resolveCwd(
  requestedCwd: unknown,
  workspacePath: string,
): { cwd: string; relocated: boolean; reason?: string } {
  const fallback = path.resolve(workspacePath);
  if (requestedCwd === undefined || requestedCwd === null || requestedCwd === '') {
    return { cwd: fallback, relocated: false };
  }
  if (typeof requestedCwd !== 'string') {
    return { cwd: fallback, relocated: true, reason: 'cwd must be a string.' };
  }
  let resolved: string;
  try {
    resolved = path.resolve(requestedCwd);
  } catch {
    return { cwd: fallback, relocated: true, reason: 'cwd could not be resolved.' };
  }
  const allowedRoots = [fallback, path.resolve(os.homedir())];
  if (allowedRoots.some((root) => isInsideRoot(resolved, root))) {
    return { cwd: resolved, relocated: false };
  }
  return {
    cwd: fallback,
    relocated: true,
    reason: `${requestedCwd} is outside the workspace and your home directory; using ${fallback} instead.`,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ExecValidationFailure {
  ok: false;
  error: string;
}

export type ExecValidation =
  | { ok: true; command: string; timeout: number; channelId?: string }
  | ExecValidationFailure;

/**
 * Check an exec payload before anything spawns.
 *
 * The classifier still runs inside the handler — this only covers the shape,
 * so a wrong-typed payload is refused with a message instead of a TypeError
 * thrown back across IPC.
 */
export function validateExecParams(params: unknown): ExecValidation {
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'An exec request needs { command, cwd?, timeout?, shell? }.' };
  }
  const p = params as Record<string, unknown>;

  if (typeof p.command !== 'string' || p.command.trim() === '') {
    return { ok: false, error: 'A command is required.' };
  }
  if (p.command.length > MAX_COMMAND_LENGTH) {
    return { ok: false, error: `Command is too long (${p.command.length} characters, max ${MAX_COMMAND_LENGTH}).` };
  }

  let timeout = 600_000;
  if (p.timeout !== undefined && p.timeout !== null) {
    if (typeof p.timeout !== 'number' || !Number.isFinite(p.timeout)) {
      return { ok: false, error: 'timeout must be a number of milliseconds.' };
    }
    if (p.timeout < MIN_TIMEOUT_MS || p.timeout > MAX_TIMEOUT_MS) {
      return { ok: false, error: `timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.` };
    }
    timeout = Math.round(p.timeout);
  }

  let channelId: string | undefined;
  if (p.channelId !== undefined && p.channelId !== null) {
    if (typeof p.channelId !== 'string' || p.channelId.length === 0 || p.channelId.length > MAX_CHANNEL_ID_LENGTH) {
      return { ok: false, error: `channelId must be a string of 1–${MAX_CHANNEL_ID_LENGTH} characters.` };
    }
    channelId = p.channelId;
  }

  return { ok: true, command: p.command, timeout, channelId };
}

// ── Cancellation ────────────────────────────────────────────────────────────

/**
 * Kill a child and everything it started.
 *
 * On Windows `child.kill` terminates only the shell wrapper, so `cmd /c start
 * something` leaves `something` running. `taskkill /T /F` takes the tree.
 * On POSIX the child runs in its own process group, so the negative pid
 * signals the whole group.
 */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // taskkill missing — fall through to the generic path.
    }
  }
  try {
    if (platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerTerminalHandlers(winGetter: WindowGetter, workspacePath: string) {
  getWindow = winGetter;

  ipcMain.handle('terminal:exec', async (_event, params: {
    command: string;
    cwd?: string;
    timeout?: number;
    channelId?: string;
    shell?: string;
  }) => {
    const validated = validateExecParams(params);
    if (!validated.ok) {
      return { success: false, exitCode: -1, stdout: '', stderr: validated.error };
    }

    // Safety check — refuse catastrophic commands (shared classifier).
    const verdict = classifyCommand(validated.command);
    if (verdict.blocked) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: `Command blocked for safety: ${verdict.reason}.`,
      };
    }

    const shell = resolveShell((params as Record<string, unknown>).shell);
    if (!shell.ok) {
      return { success: false, exitCode: -1, stdout: '', stderr: shell.error };
    }

    const execId = randomUUID();
    const cwdResult = resolveCwd((params as Record<string, unknown>).cwd, workspacePath);
    const cwd = cwdResult.cwd;
    const channelId = validated.channelId;

    const env = { ...process.env };
    // TERM is a POSIX concept. Setting it on Windows put a literal
    // "undefined" into the child environment, because an undefined value in a
    // copied object is stringified rather than dropped.
    if (shell.shell.kind === 'posix') env.TERM = env.TERM || 'xterm-256color';

    return new Promise((resolve) => {
      const child = spawn(shell.shell.bin, [...shell.shell.prefix, validated.command], {
        cwd,
        env,
        timeout: validated.timeout,
        // Its own process group, so cancellation can signal the whole tree.
        detached: shell.shell.kind === 'posix',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      activeProcesses.set(execId, child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let capped = false;
      let killed = false;

      const CAP_STDOUT = 100_000;
      const CAP_STDERR = 50_000;

      const emit = (type: 'stdout' | 'stderr', chunk: string) => {
        if (!channelId) return;
        safeSend(getWindow, 'terminal:output', { channelId, execId, type, data: chunk });
      };

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length < CAP_STDOUT) {
          stdout += chunk;
          if (stdout.length > CAP_STDOUT) {
            stdout = stdout.slice(0, CAP_STDOUT);
            capped = true;
          }
        } else {
          capped = true;
        }
        emit('stdout', chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length < CAP_STDERR) {
          stderr += chunk;
          if (stderr.length > CAP_STDERR) stderr = stderr.slice(0, CAP_STDERR);
        }
        emit('stderr', chunk);
      });

      child.on('close', (code, signal) => {
        activeProcesses.delete(execId);
        if (channelId) {
          safeSend(getWindow, 'terminal:done', {
            channelId,
            execId,
            exitCode: code,
            signal: signal ?? null,
            timedOut,
            killed,
          });
        }
        resolve({
          success: code === 0,
          exitCode: code ?? -1,
          stdout,
          stderr,
          execId,
          cwd,
          shell: shell.shell.requested,
          relocatedCwd: cwdResult.relocated ? cwdResult.reason : undefined,
          timedOut,
          truncated: capped,
        });
      });

      child.on('error', (err) => {
        activeProcesses.delete(execId);
        resolve({
          success: false,
          exitCode: -1,
          stdout,
          stderr: err.message,
          execId,
          cwd,
          shell: shell.shell.requested,
        });
      });

      // Node's own `timeout` kills the direct child only, which on Windows
      // means the command keeps running. Cancel through the tree instead.
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, validated.timeout);
      child.on('close', () => clearTimeout(timer));

      // Expose cancellation of a specific exec from inside the handler.
      cancelRegistry.set(execId, () => {
        killed = true;
        killTree(child);
      });
      child.on('close', () => cancelRegistry.delete(execId));
    });
  });

  // Write to a running command's stdin. This is what makes an interactive
  // prompt answerable: `python`, `git commit`, `ssh`, anything that waits.
  ipcMain.handle('terminal:write', async (_event, payload: { execId: string; data: string }) => {
    const execId = (payload as Record<string, unknown>)?.execId;
    const data = (payload as Record<string, unknown>)?.data;
    if (typeof execId !== 'string' || !execId) return { ok: false, error: 'An execId is required.' };
    if (typeof data !== 'string') return { ok: false, error: 'data must be a string.' };
    if (data.length > 64 * 1024) return { ok: false, error: 'data is too large (max 64 KB per write).' };
    const child = activeProcesses.get(execId);
    if (!child) return { ok: false, error: 'No such running command.' };
    try {
      child.stdin?.write(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('terminal:kill', async (_event, execId: string) => {
    if (typeof execId !== 'string' || !execId) {
      return { killed: false, error: 'An execId is required.' };
    }
    const cancel = cancelRegistry.get(execId);
    const child = activeProcesses.get(execId);
    if (!cancel && !child) {
      return { killed: false, error: 'Process not found' };
    }
    if (cancel) cancel();
    else if (child) killTree(child);
    return { killed: true };
  });

  ipcMain.handle('terminal:active', async () => {
    return {
      count: activeProcesses.size,
      ids: [...activeProcesses.keys()],
    };
  });
}

/**
 * Per-exec cancellation hooks.
 *
 * `activeProcesses` holds the `ChildProcess`; this holds the closure that also
 * records that *we* killed it, so `terminal:kill` is distinguishable from a
 * timeout in what the renderer is told.
 */
