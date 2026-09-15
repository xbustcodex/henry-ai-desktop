/**
 * Terminal — Execute shell commands from Henry.
 * 
 * Sandboxed execution with configurable working directory,
 * timeout, and output capture. Worker engine uses this for
 * code execution, npm tasks, git operations, etc.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import { isInsideRoot } from './_pathSafety';
import { classifyCommand } from './_commandSafety';

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

/**
 * Validate that the requested cwd is within an allowed root (workspace or home).
 * Falls back to workspacePath if cwd is outside allowed bounds. Uses the shared
 * isInsideRoot so the sibling-prefix bug can't reopen here.
 */
function safeCwd(requestedCwd: string | undefined, workspacePath: string): string {
  if (!requestedCwd) return workspacePath;
  const resolved = path.resolve(requestedCwd);
  const allowedRoots = [path.resolve(workspacePath), path.resolve(os.homedir())];
  if (!allowedRoots.some((root) => isInsideRoot(resolved, root))) {
    console.warn(`[terminal] cwd "${resolved}" outside allowed roots — falling back to workspace.`);
    return workspacePath;
  }
  return resolved;
}

export function registerTerminalHandlers(winGetter: WindowGetter, workspacePath: string) {
  getWindow = winGetter;

  // Execute a command
  ipcMain.handle('terminal:exec', async (_event, params: {
    command: string;
    cwd?: string;
    timeout?: number;
    channelId?: string;
  }) => {
    try {
      // Safety check — refuse catastrophic commands (shared classifier).
      const verdict = classifyCommand(params.command);
      if (verdict.blocked) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: `Command blocked for safety: ${verdict.reason}.`,
        };
      }

      const execId = randomUUID();
      // Guard against path traversal in cwd
      const cwd = safeCwd(params.cwd, workspacePath);
      const timeout = params.timeout || 30000; // Default 30s timeout

      return new Promise((resolve) => {
        const child = spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', params.command] : ['-c', params.command], {
          cwd,
          env: { ...process.env, TERM: process.platform === 'win32' ? undefined : 'xterm-256color' },
          timeout,
        });

        activeProcesses.set(execId, child);

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          // Stream output to renderer if channelId provided
          if (params.channelId) {
            safeSend(getWindow, 'terminal:output', {
              channelId: params.channelId,
              execId,
              type: 'stdout',
              data: chunk,
            });
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          if (params.channelId) {
            safeSend(getWindow, 'terminal:output', {
              channelId: params.channelId,
              execId,
              type: 'stderr',
              data: chunk,
            });
          }
        });

        child.on('close', (code) => {
          activeProcesses.delete(execId);
          if (params.channelId) {
            safeSend(getWindow, 'terminal:done', {
              channelId: params.channelId,
              execId,
              exitCode: code,
            });
          }
          resolve({
            success: code === 0,
            exitCode: code,
            stdout: stdout.slice(0, 100000), // Cap at 100KB
            stderr: stderr.slice(0, 50000),
            execId,
          });
        });

        child.on('error', (err) => {
          activeProcesses.delete(execId);
          resolve({
            success: false,
            exitCode: -1,
            stdout: '',
            stderr: err.message,
            execId,
          });
        });
      });
    } catch (e: unknown) {
      console.error('[terminal:exec]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // Kill a running process
  ipcMain.handle('terminal:kill', async (_event, execId: string) => {
    try {
      const child = activeProcesses.get(execId);
      if (child) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
        activeProcesses.delete(execId);
        return { killed: true };
      }
      return { killed: false, error: 'Process not found' };
    } catch (e: unknown) {
      console.error('[terminal:kill]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  // Get list of active processes
  ipcMain.handle('terminal:active', async () => {
    try {
      return {
        count: activeProcesses.size,
        ids: Array.from(activeProcesses.keys()),
      };
    } catch (e: unknown) {
      console.error('[terminal:active]', e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
}
