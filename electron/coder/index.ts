/**
 * Coder Engine — IPC registration (follows the ai.ts streaming pattern).
 *
 * Channels (match preload.ts):
 *   coder:status — which engine is active + availability of both engines
 *   coder:run    — start a coding run; events stream to 'coder:event'
 *   coder:cancel — kill/abort a running coder run by channelId
 *
 * Engine choice — settings key `coder_engine`:
 *   'auto'        (default) → Claude Code CLI when detected, else local Ollama
 *   'claude-code'           → Claude Code CLI only
 *   'local'                 → free local qwen coder only
 *
 * Every event sent to the renderer is { channelId, event: CoderStreamEvent },
 * on the 'coder:event' channel via webContents.send — the same forwarding
 * shape ai:stream uses for its chunk/done/error events.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import type { CoderStreamEvent } from './streamJson';
import {
  CODER_WORKSPACE_DIR,
  detectClaudeCli,
  ensureCoderWorkspace,
  runClaudeCode,
} from './claudeCode';
import { getLocalCoderStatus, runLocalCoder, LOCAL_CODER_PULL_HINT } from './localCoder';
import { detectOpencodeCli, runOpencode, type OpencodeCliInfo } from './opencode';

type WindowGetter = () => BrowserWindow | null;

export type CoderEngineSetting = 'auto' | 'claude-code' | 'opencode' | 'local';
export type CoderActiveEngine = 'claude-code' | 'opencode' | 'local' | 'none';

interface CoderRunParams {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  channelId: string;
}

/** Safely send to renderer — skips if window is destroyed (Vite HMR). */
function safeSend(getWin: WindowGetter, channel: string, data: unknown) {
  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

const activeRuns = new Map<string, { cancel: () => void }>();

function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function readEngineSetting(db: Database.Database): CoderEngineSetting {
  const raw = readSetting(db, 'coder_engine');
  return raw === 'claude-code' || raw === 'opencode' || raw === 'local' ? raw : 'auto';
}

export function registerCoderHandlers(db: Database.Database, getWindow: WindowGetter) {
  const sendEvent = (channelId: string, event: CoderStreamEvent) => {
    safeSend(getWindow, 'coder:event', { channelId, event });
    if (event.kind === 'result' || event.kind === 'error') {
      activeRuns.delete(channelId);
    }
  };

  // ── Status ────────────────────────────────────────────────────────────
  ipcMain.handle('coder:status', async (_e, opts?: { refresh?: boolean }) => {
    const engine = readEngineSetting(db);
    const claude = await detectClaudeCli(Boolean(opts?.refresh));
    const opencode: OpencodeCliInfo = await detectOpencodeCli(Boolean(opts?.refresh));
    const local = await getLocalCoderStatus(readSetting(db, 'ollama_base_url') ?? undefined);

    let active: CoderActiveEngine;
    if (engine === 'claude-code') {
      active = claude.available ? 'claude-code' : 'none';
    } else if (engine === 'opencode') {
      active = opencode.available ? 'opencode' : 'none';
    } else if (engine === 'local') {
      active = local.model ? 'local' : 'none';
    } else {
      // auto: a detected CLI beats a local model, claude-code first.
      active = claude.available ? 'claude-code'
        : opencode.available ? 'opencode'
        : local.model ? 'local' : 'none';
    }

    return { engine, active, claude, opencode, local, workspaceDir: CODER_WORKSPACE_DIR };
  });

  // ── Run ───────────────────────────────────────────────────────────────
  ipcMain.handle('coder:run', async (_e, params: CoderRunParams) => {
    const { channelId } = params;
    if (!channelId || !params.prompt?.trim()) {
      return { started: false, error: 'A prompt and channelId are required.' };
    }

    const engineSetting = readEngineSetting(db);
    const claude = await detectClaudeCli();
    const opencode = await detectOpencodeCli();

    // Resolve which engine actually runs this task.
    let engine: CoderActiveEngine = 'none';
    if (engineSetting === 'claude-code') {
      engine = claude.available ? 'claude-code' : 'none';
    } else if (engineSetting === 'opencode') {
      engine = opencode.available ? 'opencode' : 'none';
    } else if (engineSetting === 'local') {
      engine = 'local'; // availability is verified below with a precise hint
    } else {
      engine = claude.available ? 'claude-code' : opencode.available ? 'opencode' : 'local';
    }

    if (engine === 'none') {
      const message =
        engineSetting === 'opencode'
          ? 'opencode CLI not found. Install it (https://opencode.ai) and make sure `opencode` is on PATH — or switch the coder engine in Settings.'
          : 'No coder CLI found. Install Claude Code (npm i -g @anthropic-ai/claude-code) or opencode (https://opencode.ai) — or switch the coder engine to Local/Auto in Settings.';
      sendEvent(channelId, { kind: 'error', message });
      return { started: false, error: message };
    }

    if (engine === 'claude-code' && claude.path) {
      const child = runClaudeCode({
        cliPath: claude.path,
        prompt: params.prompt,
        cwd: params.cwd?.trim() || ensureCoderWorkspace(),
        sessionId: params.sessionId,
        configuredPermissionMode: readSetting(db, 'coder_permission_mode'),
        onEvent: (event) => sendEvent(channelId, event),
      });
      activeRuns.set(channelId, { cancel: () => child.kill('SIGTERM') });
      return { started: true, channelId, engine: 'claude-code' as const };
    }

    if (engine === 'opencode' && opencode.path) {
      const child = runOpencode({
        cliPath: opencode.path,
        prompt: params.prompt,
        cwd: params.cwd?.trim() || ensureCoderWorkspace(),
        sessionId: params.sessionId,
        model: readSetting(db, 'coder_opencode_model') ?? undefined,
        agent: readSetting(db, 'coder_opencode_agent') ?? undefined,
        onEvent: (event) => sendEvent(channelId, event),
      });
      activeRuns.set(channelId, { cancel: () => child.kill('SIGTERM') });
      return { started: true, channelId, engine: 'opencode' as const };
    }

    // Local engine — verify Ollama + model, with an actionable hint on failure.
    const baseUrl = readSetting(db, 'ollama_base_url') ?? undefined;
    const local = await getLocalCoderStatus(baseUrl);
    if (!local.model) {
      const message = !local.ollamaRunning
        ? `Local coder unavailable: ${local.hint ?? 'Ollama is not running.'}`
        : `Local coder model not installed — ${local.hint ?? LOCAL_CODER_PULL_HINT}`;
      sendEvent(channelId, { kind: 'error', message });
      return { started: false, error: message };
    }

    const controller = new AbortController();
    activeRuns.set(channelId, { cancel: () => controller.abort() });
    void runLocalCoder({
      prompt: params.prompt,
      model: local.model,
      cwd: params.cwd?.trim() || undefined,
      baseUrl,
      signal: controller.signal,
      onEvent: (event) => sendEvent(channelId, event),
    }).catch((err: unknown) => {
      sendEvent(channelId, {
        kind: 'error',
        message: `Local coder crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    return { started: true, channelId, engine: 'local' as const };
  });

  // ── Cancel ────────────────────────────────────────────────────────────
  ipcMain.handle('coder:cancel', (_e, channelId: string) => {
    const run = activeRuns.get(channelId);
    if (run) {
      try {
        run.cancel();
      } catch {
        /* already gone */
      }
      activeRuns.delete(channelId);
      return { cancelled: true };
    }
    return { cancelled: false };
  });
}
