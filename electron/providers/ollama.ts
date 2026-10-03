/**
 * Ollama adapter — real incremental streaming and real tool calling.
 *
 * Why this module exists: `electron/ipc/ai.ts` had `streamOpenAI`,
 * `streamAnthropic` and `streamGroq` but no Ollama streamer, so an Ollama chat
 * turn fell through to the non-streaming `callAI` and the user watched a blank
 * screen for the whole generation and then got one buffered chunk. Measured on
 * the installed package: 626 characters after 20.7 s of silence, with
 * `firstChunkMs == lastChunkMs`.
 *
 * The same gap existed for tool calling: `callAIWithTools` only routed
 * `openai`, `groq` and `anthropic`, and every other provider — including
 * Ollama, which advertises a `tools` capability per model — degraded to a plain
 * text round that returns `toolCalls: []` by construction.
 *
 * This module is deliberately free of Electron imports so it can be tested
 * against a stubbed transport with no network and no credentials.
 */

import type { ModelTool } from '../agent/types';
import type { RunnerMessage } from '../agent/toolRunner';
import type { MessagePart } from '../ipc/contentParts';
import { readNdjsonStream, type NdjsonResponse } from './ndjson';
import {
  parseInlineToolCalls,
  parseOpenAIToolCalls,
  type ParsedToolCall,
} from './toolCalls';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export type StreamTokenUsage = { input: number; output: number };

/** The subset of a `fetch` Response this adapter reads. */
export interface OllamaHttpResponse {
  ok: boolean;
  status: number;
  body?: NdjsonResponse['body'] | null;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

/** The `fetch` surface this adapter needs — injected in tests. */
export type OllamaFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<OllamaHttpResponse>;

/** Normalises a trailing slash and an empty override into a usable base URL. */
export function resolveOllamaBaseUrl(apiUrl?: string): string {
  return (apiUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
}

function modelNotLoadedError(model: string): string {
  return `Model "${model}" isn't loaded in Ollama.\n\nRun this in Terminal:\n\n  ollama pull ${model}`;
}

/**
 * What the user is told when the socket to Ollama never opened. A raw
 * `fetch failed` names a protocol, not a fix, and this is the one failure a
 * local user can actually do something about.
 */
export function ollamaNotRunningError(): string {
  return (
    "Ollama isn't running. Start it in Terminal:\n\n  ollama serve\n\n" +
    'If Ollama is on a different machine, update the URL in Settings → Engines.'
  );
}

async function readErrorBody(res: { text?: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text?.()) ?? '';
  } catch {
    return '';
  }
}

// ── Streaming ──────────────────────────────────────────────────────────────

export interface OllamaStreamParams {
  model: string;
  /** Already provider-shaped messages (vision capability already applied). */
  messages: unknown[];
  apiUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: OllamaFetch;
}

export interface OllamaStreamHandlers {
  onChunk: (text: string) => void;
  onDone: (fullText: string, usage?: StreamTokenUsage) => void;
  onError: (error: string) => void;
}

/**
 * One `/api/chat` round with `stream: true`.
 *
 * Ollama sends one NDJSON object per generated token with `message.content`
 * holding that token's delta, and a final object with `done: true` carrying the
 * token counts. Each delta is handed to `onChunk` as it arrives — nothing is
 * buffered until the end and nothing is synthesised by slicing a completed
 * response.
 */
export async function streamOllamaChat(
  params: OllamaStreamParams,
  handlers: OllamaStreamHandlers
): Promise<void> {
  const base = resolveOllamaBaseUrl(params.apiUrl);
  const doFetch = params.fetchImpl ?? (globalThis.fetch as unknown as OllamaFetch);
  let fullText = '';
  let usage: StreamTokenUsage | undefined;
  let sawRecord = false;

  try {
    const response = await doFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: true,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 4096,
        },
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        handlers.onError(modelNotLoadedError(params.model));
        return;
      }
      const errText = await readErrorBody(response);
      handlers.onError(
        `Ollama returned an error (${response.status}${errText ? ': ' + errText.slice(0, 120) : ''}). ` +
          'Check the model name in Settings → Engines.'
      );
      return;
    }
    if (!response.body) {
      handlers.onError('Ollama returned no response body to stream.');
      return;
    }

    await readNdjsonStream(response as NdjsonResponse, (record) => {
      sawRecord = true;
      if (!record || typeof record !== 'object') return;
      const r = record as Record<string, unknown>;

      // A mid-stream failure is reported as an error object, not an HTTP status.
      if (typeof r.error === 'string' && r.error) {
        throw new Error(r.error);
      }

      const message = r.message as Record<string, unknown> | undefined;
      const delta = message?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        fullText += delta;
        handlers.onChunk(delta);
      }

      if (r.done === true) {
        usage = {
          input: typeof r.prompt_eval_count === 'number' ? r.prompt_eval_count : 0,
          output: typeof r.eval_count === 'number' ? r.eval_count : 0,
        };
      }
    });

    // An empty stream is still a completed turn — it produced no text and no
    // usage. Silently ending is indistinguishable from a hang for the user, so
    // the done event fires and the caller decides what to show.
    handlers.onDone(fullText, sawRecord ? usage : undefined);
  } catch (err: unknown) {
    if (isConnectionFailure(err)) {
      handlers.onError(ollamaNotRunningError());
      return;
    }
    handlers.onError(err instanceof Error ? err.message : 'Stream error');
  }
}

/**
 * undici reports a refused connection as a bare `TypeError: fetch failed`;
 * there is no status code to branch on, so the message is the only signal.
 */
function isConnectionFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const code = cause?.code ?? '';
  return (
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(
      `${message} ${code} ${cause?.message ?? ''}`
    )
  );
}

// ── Tool calling ───────────────────────────────────────────────────────────

export interface OllamaToolRound {
  content: string;
  toolCalls: ParsedToolCall[];
  usage?: StreamTokenUsage;
}

export interface OllamaToolParams {
  model: string;
  messages: RunnerMessage[];
  modelTools: ModelTool[];
  apiUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: OllamaFetch;
}

/**
 * RunnerMessage[] → Ollama `/api/chat` messages.
 *
 * Ollama's native tool protocol is: the assistant turn carries `tool_calls`,
 * then each result comes back as a `role: 'tool'` message carrying the plain
 * result text. There is no `tool_call_id` to echo, so the linkage is positional
 * and order matters — results must immediately follow the assistant turn that
 * requested them.
 */
export function toOllamaToolMessages(messages: RunnerMessage[]): unknown[] {
  return messages.map((m) => {
    const images = m.images ?? (Array.isArray(m.content) ? m.content.filter(isImage) : []);
    const text = typeof m.content === 'string' ? m.content : flattenText(m.content);

    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: text,
        tool_calls: m.toolCalls.map((tc) => ({
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments ?? {} },
        })),
      };
    }
    if (m.role === 'tool') {
      // Ollama's tool result carries text only; a picture cannot ride along, so
      // it is named explicitly rather than silently dropped.
      return {
        role: 'tool',
        name: m.name ?? 'tool',
        content: images.length ? `${text}\n[${m.name ?? 'tool'} returned an image, shown in the next turn]` : text,
      };
    }
    if (images.length > 0) {
      return { role: m.role, content: text, images: images.map((i) => i.data) };
    }
    return { role: m.role, content: text };
  });
}

function isImage(part: MessagePart): part is Extract<MessagePart, { type: 'image' }> {
  return (part as { type?: string })?.type === 'image';
}

function flattenText(content: MessagePart[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => (p as { type?: string })?.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('');
}

/**
 * One non-streaming model round with tools attached.
 *
 * Two response shapes are handled, because Ollama serves both: the native
 * `/api/chat` shape (`message.tool_calls`, `arguments` as an object) and the
 * OpenAI-compatible `/v1` shape (`arguments` as a JSON string). When a model
 * advertises `tools` but writes the call as plain text in `content`, the text
 * is mined for a tool call rather than reported as "no tool calls".
 */
export async function callOllamaToolsRound(params: OllamaToolParams): Promise<OllamaToolRound> {
  const base = resolveOllamaBaseUrl(params.apiUrl);
  const doFetch = params.fetchImpl ?? (globalThis.fetch as unknown as OllamaFetch);

  let response: OllamaHttpResponse;
  try {
    response = await doFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: toOllamaToolMessages(params.messages),
        stream: false,
        tools: params.modelTools,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 4096,
        },
      }),
      signal: params.signal,
    });
  } catch (err: unknown) {
    if (isConnectionFailure(err)) throw new Error(ollamaNotRunningError());
    throw err;
  }

  if (!response.ok) {
    if (response.status === 404) throw new Error(modelNotLoadedError(params.model));
    const errText = await readErrorBody(response);
    throw new Error(
      `Ollama returned an error (${response.status}${errText ? ': ' + errText.slice(0, 120) : ''}). ` +
        'Check the model name in Settings → Engines.'
    );
  }

  const data = (await response.json!()) as Record<string, unknown>;
  const message = (data?.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === 'string' ? message.content : '';
  return finishRound(
    content,
    parseOpenAIToolCalls(message.tool_calls),
    {
      input: typeof data?.prompt_eval_count === 'number' ? data.prompt_eval_count : 0,
      output: typeof data?.eval_count === 'number' ? data.eval_count : 0,
    }
  );
}

// ── Tool-capable streaming ─────────────────────────────────────────────────

export interface OllamaToolStreamParams extends OllamaToolParams {
  /**
   * Called with each content delta as Ollama produces it.
   *
   * Optional: omit it and the round behaves exactly like
   * `callOllamaToolsRound`, just over a stream. The callback exists so the
   * agent loop can surface the final answer as it is written instead of
   * holding it until the round closes.
   */
  onDelta?: (text: string) => void;
}

/**
 * Merge tool calls seen across a stream's records.
 *
 * Ollama may repeat a call across records, and may split one call's arguments
 * over several. De-duplicating by id — or, when there is no id, by name and
 * argument signature — means a repeated record cannot cause the tool to run
 * twice for one decision, which is the failure mode a naive per-record append
 * produces.
 */
function mergeToolCalls(into: ParsedToolCall[], incoming: ParsedToolCall[]): void {
  for (const call of incoming) {
    const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
    const duplicate = into.some(
      (existing) =>
        (call.id && existing.id === call.id) ||
        `${existing.name}:${JSON.stringify(existing.arguments)}` === signature
    );
    if (!duplicate) into.push(call);
  }
}

/**
 * One `/api/chat` round with BOTH `stream: true` and `tools`.
 *
 * This is deliberately a separate function from `streamOllamaChat` rather than
 * a flag on it. `streamOllamaChat` is the ordinary chat path: its params carry
 * no tools and its body must keep carrying none, because row 2.1 depends on it
 * and the plain chat path has no business advertising a tool protocol. Adding
 * `tools` there would change a contract that is proven working.
 *
 * A streamed round can interleave text deltas and a tool call, and both are
 * preserved: every delta goes to `onDelta`, and every tool call is collected
 * and returned. Dropping either would be worse than the pause this replaces —
 * a dropped tool call degrades the agent into a chatty model that never acts,
 * and it would look like it worked.
 */
export async function streamOllamaToolsRound(params: OllamaToolStreamParams): Promise<OllamaToolRound> {
  const base = resolveOllamaBaseUrl(params.apiUrl);
  const doFetch = params.fetchImpl ?? (globalThis.fetch as unknown as OllamaFetch);

  let response: OllamaHttpResponse;
  try {
    response = await doFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: toOllamaToolMessages(params.messages),
        stream: true,
        tools: params.modelTools,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 4096,
        },
      }),
      signal: params.signal,
    });
  } catch (err: unknown) {
    if (isConnectionFailure(err)) throw new Error(ollamaNotRunningError());
    throw err;
  }

  if (!response.ok) {
    if (response.status === 404) throw new Error(modelNotLoadedError(params.model));
    const errText = await readErrorBody(response);
    throw new Error(
      `Ollama returned an error (${response.status}${errText ? ': ' + errText.slice(0, 120) : ''}). ` +
        'Check the model name in Settings → Engines.'
    );
  }

  // Ollama honours `stream: true`, but a build that ignores it answers with one
  // JSON object. The NDJSON reader handles both: a single line with no trailing
  // newline still arrives as exactly one complete record.
  if (!response.body) {
    const data = (await response.json!()) as Record<string, unknown>;
    return callRoundFromPayload(data, params.onDelta);
  }

  let content = '';
  const toolCalls: ParsedToolCall[] = [];
  let usage: StreamTokenUsage | undefined;

  await readNdjsonStream(response as NdjsonResponse, (record) => {
    if (!record || typeof record !== 'object') return;
    const r = record as Record<string, unknown>;
    if (typeof r.error === 'string' && r.error) throw new Error(r.error);

    const message = r.message as Record<string, unknown> | undefined;
    const delta = message?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      content += delta;
      params.onDelta?.(delta);
    }

    // Tool calls can arrive before, after or interleaved with the text, so
    // every record is inspected rather than only the terminal one.
    if (message?.tool_calls !== undefined) {
      mergeToolCalls(toolCalls, parseOpenAIToolCalls(message.tool_calls));
    }
    if (r.done === true) {
      usage = {
        input: typeof r.prompt_eval_count === 'number' ? r.prompt_eval_count : 0,
        output: typeof r.eval_count === 'number' ? r.eval_count : 0,
      };
    }
  });

  return finishRound(content, toolCalls, usage);
}

/** Pull a tool call out of a whole-payload response, ignoring any stream. */
function callRoundFromPayload(data: Record<string, unknown>, onDelta?: (text: string) => void): OllamaToolRound {
  const message = (data?.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) onDelta?.(content);
  const usage: StreamTokenUsage = {
    input: typeof data?.prompt_eval_count === 'number' ? data.prompt_eval_count : 0,
    output: typeof data?.eval_count === 'number' ? data.eval_count : 0,
  };
  return finishRound(content, parseOpenAIToolCalls(message.tool_calls), usage);
}

/**
 * Resolve a round's text against its tool calls.
 *
 * The raw-text recovery is preserved here exactly as in the non-streaming
 * round: qwen2.5-coder:7b emits its whole call as `content` rather than in
 * `tool_calls`, and recovering it only in the buffered path would look like a
 * regression on that model the moment the agent loop moved to streaming. It is
 * applied to the ACCUMULATED text, not per delta — a JSON object split across
 * three deltas parses as nothing at all if each piece is parsed alone.
 */
function finishRound(
  content: string,
  structured: ParsedToolCall[],
  usage?: StreamTokenUsage
): OllamaToolRound {
  if (structured.length > 0) return { content, toolCalls: structured, usage };
  // Only the model's own turn is mined. Tool results are never parsed for
  // calls — see ToolCallTextSource.
  const inline = parseInlineToolCalls(content, 'model-output');
  return { content: inline.content, toolCalls: inline.toolCalls, usage };
}
