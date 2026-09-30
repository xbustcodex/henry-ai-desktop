/**
 * OpenCode bridge — a loopback, OpenAI-compatible façade in front of the
 * `opencode` CLI.
 *
 * Why this exists: opencode can reach 395 models across its own "zen" service
 * and OpenRouter, but it only speaks them through its CLI, and its built-in
 * `opencode serve` did not answer on an OpenAI-shaped route here. Henry's
 * provider layer is OpenAI-compatible, so a tiny local server that translates
 * one request into one `opencode run` and the reply back into an
 * OpenAI-shaped response lets ALL of those models be selected in the normal
 * Settings model list and used by chat, with no change to the provider code.
 *
 * It runs entirely in the background on 127.0.0.1 and is started lazily, so it
 * costs nothing when unused and is never visible to the user. A per-process
 * token is required, so only Henry itself can drive it.
 */

import * as http from 'http';
import { ipcMain } from 'electron';
import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { detectOpencodeCli, listOpencodeModels, readOpencodeError, CODER_WORKSPACE_DIR, type OpencodeModel } from '../coder/opencode';

const BRIDGE_PORT = 11540;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 600_000;

let server: http.Server | null = null;
let token = '';
let modelsCache: { at: number; models: OpencodeModel[] } | null = null;
/** Spawned CLI processes, so an aborted request can stop them. */
const activeChildren = new Set<import('child_process').ChildProcess>();

export interface BridgeInfo {
  running: boolean;
  port: number;
  baseUrl: string;
  modelCount: number;
  error?: string;
}

function log(msg: string): void {
  console.log(`[OpenCodeBridge] ${msg}`);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Flatten a chat message list into the single prompt the CLI accepts, keeping
 * role labels so multi-turn context and system instructions survive.
 */
export function messagesToPrompt(messages: Array<{ role?: string; content?: unknown }>): string {
  const parts: string[] = [];
  for (const m of messages ?? []) {
    if (!m) continue;
    let content = '';
    const c = m.content;
    if (typeof c === 'string') content = c;
    else if (Array.isArray(c)) {
      // OpenAI content parts: [{type:'text',text}, {type:'image_url',...}]
      content = c
        .map((p: { type?: string; text?: string }) => (typeof p?.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (!content.trim()) continue;
    const role = (m.role || 'user').toUpperCase();
    parts.push(role === 'USER' ? content : `[${role}]\n${content}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * Turn the CLI's NDJSON event stream into plain assistant text.
 *
 * A failed run emits a top-level `error` event and no text, so it must throw —
 * otherwise the caller sees an empty string and reports success.
 */
export function extractTextFromEventLines(stdout: string): string {
  let text = '';
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: {
      error?: unknown;
      part?: { type?: string; text?: string; error?: unknown };
    };
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.error) throw new Error(readOpencodeError(ev.error));
    const p = ev.part;
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') text += p.text;
    else if (p.type === 'error') throw new Error(readOpencodeError(p.error ?? p));
  }
  return text.trim();
}

interface RunOutcome { content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }

/**
 * Pull the token counts the CLI emits on its step_finish part, so the
 * OpenAI-shaped response carries real usage instead of zeros. The last part
 * wins, which is the final tally for the run.
 */
export function extractUsage(stdout: string): RunOutcome['usage'] {
  let out: RunOutcome['usage'];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: { part?: { type?: string; tokens?: { input?: number; output?: number; total?: number } } };
    try { ev = JSON.parse(t); } catch { continue; }
    const p = ev.part;
    if (p?.type !== 'step-finish' || !p.tokens) continue;
    const input = Number(p.tokens.input ?? 0);
    const output = Number(p.tokens.output ?? 0);
    const total = Number(p.tokens.total ?? input + output);
    out = { prompt_tokens: input, completion_tokens: output, total_tokens: total };
  }
  return out;
}

async function runModel(model: string, prompt: string): Promise<RunOutcome> {
  const cli = await detectOpencodeCli();
  if (!cli.available || !cli.path) {
    throw new Error(cli.error ?? 'opencode is not installed.');
  }
  const { spawn } = await import('child_process');
  const { buildCoderChildEnv } = await import('../coder/opencode');
  // process.cwd() is wherever the app happened to be launched; use Henry's own
  // workspace so a run never depends on the launch directory.
  const { mkdirSync } = await import('fs');
  try { mkdirSync(CODER_WORKSPACE_DIR, { recursive: true }); } catch { /* best effort */ }

  return new Promise<RunOutcome>((resolve, reject) => {
    const child = spawn(cli.path!, ['run', '--format', 'json', '--model', model, '--dir', CODER_WORKSPACE_DIR, prompt], {
      env: buildCoderChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    activeChildren.add(child);
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(`opencode timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s.`));
    }, RUN_TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (code !== 0 && !stdout.includes('"type":"text"')) {
        reject(new Error(`opencode exited with code ${code}: ${stderr.slice(-300)}`));
        return;
      }
      try {
        const text = extractTextFromEventLines(stdout);
        if (!text) {
          // Include the tail of both streams so the cause is visible in the UI
          // rather than an opaque "no text".
          reject(new Error(
            `opencode produced no text for ${model} (exit ${code}). ` +
            `stderr: ${stderr.slice(-200) || '(empty)'} | stdout tail: ${stdout.slice(-200) || '(empty)'}`,
          ));
        } else {
          // Real token counts when the CLI reported them on step_finish.
          resolve({ content: text, usage: extractUsage(stdout) });
        }
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // If the caller (Henry) aborts or the connection drops, kill the spawned CLI
  // rather than leaving it running for the rest of its 10-minute timeout.
  const killOnClose = () => { for (const c of activeChildren) c.kill('SIGTERM'); };
  res.on('close', killOnClose);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Loopback only, plus a per-process token: nothing else on the machine can
  // drive this server.
  const peer = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const auth = req.headers.authorization ?? '';
  if (peer !== '127.0.0.1' && peer !== '::1') {
    return json(res, 403, { error: { message: 'loopback only', type: 'forbidden' } });
  }
  if (auth !== `Bearer ${token}`) {
    return json(res, 401, { error: { message: 'invalid bridge token', type: 'unauthorized' } });
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    const { models } = await listOpencodeModels();
    return json(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: m.provider,
        created: 0,
      })),
    });
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
        max_tokens?: number;
        stream?: boolean;
      };
      const model = String(body.model ?? '').trim();
      if (!model) {
        return json(res, 400, { error: { message: 'model is required', type: 'invalid_request_error' } });
      }
      const prompt = messagesToPrompt(body.messages ?? []);
      if (!prompt) {
        return json(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } });
      }

      const { content, usage } = await runModel(model, prompt);
      return json(res, 200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
        ],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return json(res, 500, { error: { message, type: 'opencode_error' } });
    }
  }

  return json(res, 404, { error: { message: 'not found', type: 'not_found' } });
}

export async function ensureOpencodeBridge(): Promise<BridgeInfo> {
  if (server && server.listening) {
    return {
      running: true,
      port: BRIDGE_PORT,
      baseUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1`,
      modelCount: modelsCache?.models.length ?? 0,
    };
  }
  try {
    token = crypto.randomBytes(24).toString('hex');
    server = http.createServer((req, res) => {
      handle(req, res).catch((e: unknown) => {
        try { json(res, 500, { error: { message: String(e), type: 'bridge_error' } }); } catch { /* gone */ }
      });
    });
    // Loopback only — this must never be reachable from the LAN.
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(BRIDGE_PORT, '127.0.0.1', () => resolve());
    });
    server.unref?.();
    log(`listening on 127.0.0.1:${BRIDGE_PORT} (loopback, token required)`);
  } catch (e: unknown) {
    return {
      running: false,
      port: BRIDGE_PORT,
      baseUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1`,
      modelCount: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const { models } = await listOpencodeModels().catch(() => ({ models: [] as OpencodeModel[] }));
  return {
    running: true,
    port: BRIDGE_PORT,
    baseUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1`,
    modelCount: models.length,
  };
}

export function stopOpencodeBridge(): void {
  server?.close();
  server = null;
  modelsCache = null;
}

/** Cached model list, so the settings list does not shell out on every render. */
export async function bridgeModels(maxAgeMs = 60_000): Promise<OpencodeModel[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < maxAgeMs) return modelsCache.models;
  const { models } = await listOpencodeModels();
  modelsCache = { at: now, models };
  return models;
}

export function opencodeBridgeToken(): string {
  return token;
}

export function _resetBridgeForTests(): void {
  stopOpencodeBridge();
  modelsCache = null;
}

/**
 * IPC for the settings panel: which models opencode can reach, and whether the
 * bridge is up. The bridge itself is started lazily on first use so it costs
 * nothing when no opencode model is selected.
 */
export function registerOpencodeBridgeHandlers(getWindow: () => BrowserWindow | null): void {
  void getWindow; // the bridge is a plain loopback server, no window needed

  ipcMain.handle('opencode:status', async () => {
    const cli = await detectOpencodeCli();
    if (!cli.available) {
      return { available: false, version: undefined, path: undefined, error: cli.error };
    }
    return { available: true, version: cli.version, path: cli.path, error: undefined };
  });

  ipcMain.handle('opencode:models', async () => {
    const { ok, models, error } = await listOpencodeModels();
    return { ok, models, error };
  });

  ipcMain.handle('opencode:bridgeStatus', async () => ensureOpencodeBridge());

  ipcMain.handle('opencode:test', async (_e, model: string) => {
    try {
      const { ensureOpencodeBridge: ensure } = await import('./opencodeBridge') as typeof import('./opencodeBridge');
      const bridge = await ensure();
      if (!bridge.running) return { ok: false, error: bridge.error ?? 'bridge unavailable' };
      const { opencodeBridgeToken: tok } = await import('./opencodeBridge') as typeof import('./opencodeBridge');
      const res = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
          max_tokens: 32,
        }),
      });
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
      return { ok: true, reply: data.choices?.[0]?.message?.content ?? '' };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
