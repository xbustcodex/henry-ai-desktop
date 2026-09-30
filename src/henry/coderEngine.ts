/**
 * Coder Engine — renderer-side helper for Henry's developer mode.
 *
 * Routes coding requests through the main-process coder engine (IPC
 * `coder:run` / `coder:status` / `coder:cancel`, exposed on window.henryAPI):
 *
 *   DEFAULT  — Claude Code CLI (the owner's Claude subscription: big context,
 *              agentic file edits, zero per-token cost)
 *   FALLBACK — free local Ollama coder (qwen2.5-coder) when the CLI is
 *              missing, offline, or the user picks "Local" in settings.
 *
 * ChatView uses this when operatingMode === 'developer'; the events map onto
 * the normal streaming chat UI (text chunks append to streamingContent, tool
 * activity renders as markdown blockquote lines).
 */

export type CoderEngineChoice = 'auto' | 'claude-code' | 'opencode' | 'local';

export const CODER_ENGINE_SETTING_KEY = 'coder_engine';

export const CODER_ENGINE_LABELS: Record<CoderEngineChoice, string> = {
  auto: 'Auto',
  'claude-code': 'Claude Code',
  opencode: 'opencode',
  local: 'Local (free)',
};

export function isCoderEngineChoice(v: unknown): v is CoderEngineChoice {
  return v === 'auto' || v === 'claude-code' || v === 'opencode' || v === 'local';
}

/** True when the Electron coder bridge exists (false in web/mock mode). */
export function coderAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.henryAPI?.coderRun === 'function' &&
    typeof window.henryAPI?.coderStatus === 'function'
  );
}

/** Fetch engine availability; null when the bridge is missing or errors. */
export async function getCoderStatus(refresh = false): Promise<HenryCoderStatus | null> {
  if (!coderAvailable()) return null;
  try {
    return (await window.henryAPI.coderStatus!({ refresh })) ?? null;
  } catch {
    return null;
  }
}

/** Short human label for what will actually run ("Claude Code 2.1.x"). */
export function describeActiveEngine(status: HenryCoderStatus | null): string {
  if (!status) return 'unavailable';
  if (status.active === 'claude-code') {
    return `Claude Code${status.claude.version ? ` ${status.claude.version.split(' ')[0]}` : ''}`;
  }
  if (status.active === 'local') return `Local — ${status.local.model ?? 'qwen coder'}`;
  return 'no engine available';
}

// ── Claude Code session persistence (per conversation) ────────────────────

function sessionKey(conversationId: string): string {
  return `henry:coder_session:${conversationId}`;
}

export function readCoderSession(conversationId: string): string | undefined {
  try {
    return localStorage.getItem(sessionKey(conversationId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveCoderSession(conversationId: string, sessionId: string): void {
  try {
    localStorage.setItem(sessionKey(conversationId), sessionId);
  } catch {
    /* ignore */
  }
}

export function clearCoderSession(conversationId: string): void {
  try {
    localStorage.removeItem(sessionKey(conversationId));
  } catch {
    /* ignore */
  }
}

// ── Streaming-render helpers ───────────────────────────────────────────────

/** Markdown line for a tool event, rendered inline in the chat stream. */
export function formatToolActivity(name: string, summary: string): string {
  const detail = summary ? ` — \`${summary.replace(/`/g, "'")}\`` : '';
  return `\n\n> ⚙️ **${name}**${detail}\n\n`;
}

/** Separator so consecutive assistant text blocks render as paragraphs. */
export function joinTextChunk(accumulated: string, chunk: string): string {
  if (!accumulated) return chunk;
  if (accumulated.endsWith('\n\n') || chunk.startsWith('\n')) return chunk;
  return `\n\n${chunk}`;
}

// ── Run wrapper ────────────────────────────────────────────────────────────

export interface CoderTaskCallbacks {
  onInit?: (sessionId: string, model?: string) => void;
  onText: (text: string) => void;
  onTool?: (name: string, summary: string) => void;
  onResult: (result: {
    ok: boolean;
    text?: string;
    sessionId?: string;
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
  }) => void;
  onError: (message: string) => void;
}

export interface CoderTaskHandle {
  cancel: () => void;
}

/**
 * Start a coder run and map the normalized event stream onto callbacks.
 * Exactly one of onResult/onError fires last.
 */
export function runCoderTask(
  params: { prompt: string; cwd?: string; sessionId?: string },
  callbacks: CoderTaskCallbacks
): CoderTaskHandle {
  if (!coderAvailable()) {
    callbacks.onError('Coder engine is only available in the Henry desktop app.');
    return { cancel: () => {} };
  }

  const handle = window.henryAPI.coderRun!(params);
  handle.onEvent((event) => {
    switch (event.kind) {
      case 'init':
        callbacks.onInit?.(event.sessionId ?? '', event.model);
        break;
      case 'text':
        if (event.text) callbacks.onText(event.text);
        break;
      case 'tool':
        callbacks.onTool?.(event.name ?? 'tool', event.summary ?? '');
        break;
      case 'result':
        callbacks.onResult({
          ok: event.ok ?? false,
          text: event.text,
          sessionId: event.sessionId,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          numTurns: event.numTurns,
        });
        break;
      case 'error':
        callbacks.onError(event.message ?? 'Coder run failed.');
        break;
    }
  });

  return { cancel: () => handle.cancel() };
}
