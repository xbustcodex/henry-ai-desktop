/**
 * Adapter-level tests for `electron/ipc/ai.ts`.
 *
 * These run against a stubbed transport — no network, no credentials, no
 * provider account. They prove the request shape, the streaming event parsing
 * and the tool-call round-trip. They are NOT provider-live verification and
 * must not be reported as such: nothing here proves a real OpenAI or
 * Anthropic key works.
 *
 * The `ai:stream` tests go through the real IPC dispatcher, which is the point:
 * the Ollama row in the ledger (`firstChunkMs == lastChunkMs`, one buffered
 * chunk after 20.7 s) was a missing `case` in that dispatcher, so a test that
 * called a helper directly would not have caught it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  BrowserWindow: class {},
}));

vi.mock('./database', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}));

import { registerAIHandlers, callAI, callAIWithTools, calculateCost } from './ai';
import type { ModelTool } from '../agent/types';

const enc = (s: string) => new TextEncoder().encode(s);

// ── Transport doubles ───────────────────────────────────────────────────────

interface Recorded {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

let recorded: Recorded[] = [];

function readerFor(reads: string[]) {
  let i = 0;
  return {
    async read() {
      if (i >= reads.length) return { done: true as const };
      return { done: false as const, value: enc(reads[i++]) };
    },
    releaseLock() {},
  };
}

function sseResponse(events: unknown[]): unknown {
  const reads = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  return { ok: true, status: 200, body: { getReader: () => readerFor(reads) } };
}

function jsonResponse(payload: unknown, status = 200): unknown {
  return {
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };

function stubFetch(handler: (rec: Recorded) => unknown): void {
  const impl = vi.fn(async (url: string, init?: FetchInit): Promise<Response> => {
    const rec: Recorded = {
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    };
    recorded.push(rec);
    return handler(rec) as Response;
  });
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

// ── Renderer channel capture ────────────────────────────────────────────────

interface Sent {
  channel: string;
  payload: Record<string, unknown>;
}

let sent: Sent[] = [];
let registered = false;

function ensureRegistered() {
  if (registered) return;
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
  };
  registerAIHandlers({} as never, () => win as never);
  registered = true;
}

function invoke(channel: string, payload: unknown) {
  ensureRegistered();
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, payload);
}

const chunksFor = (channelId: string) =>
  sent.filter((s) => s.channel === 'ai:stream:chunk' && s.payload.channelId === channelId).map((s) => s.payload.chunk as string);

beforeEach(() => {
  recorded = [];
  sent = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Streaming dispatch ──────────────────────────────────────────────────────

describe('ai:stream — Ollama', () => {
  it('delivers each provider delta as its own chunk', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      body: {
        getReader: () =>
          readerFor([
            '{"message":{"content":"Streaming"}}\n',
            '{"message":{"content":" works"}}\n',
            '{"message":{"content":" now."}}\n',
            '{"done":true,"prompt_eval_count":11,"eval_count":3}\n',
          ]),
      },
    }));

    await invoke('ai:stream', {
      provider: 'ollama',
      model: 'llama3.2:3b',
      apiKey: '',
      messages: [{ role: 'user', content: 'hi' }],
      channelId: 'c1',
    });

    // Not one buffered write: three separate deltas, in order.
    expect(chunksFor('c1')).toEqual(['Streaming', ' works', ' now.']);

    const done = sent.find((s) => s.channel === 'ai:stream:done');
    expect(done?.payload.fullText).toBe('Streaming works now.');
    expect(done?.payload.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
      cost: 0,
    });
    expect(sent.filter((s) => s.channel === 'ai:stream:error')).toEqual([]);
  });

  it('does not fall back to the non-streaming callAI path', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      body: { getReader: () => readerFor(['{"message":{"content":"x"}}\n', '{"done":true}\n']) },
    }));
    await invoke('ai:stream', { provider: 'ollama', model: 'm', apiKey: '', messages: [], channelId: 'c1' });
    // Exactly one HTTP call, and it asks for a stream.
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0].body!).stream).toBe(true);
  });

  it('reports the model-not-installed case as a stream error', async () => {
    stubFetch(() => ({ ok: false, status: 404, text: async () => 'not found' }));
    await invoke('ai:stream', { provider: 'ollama', model: 'ghost', apiKey: '', messages: [], channelId: 'c1' });
    const err = sent.find((s) => s.channel === 'ai:stream:error');
    expect(String(err?.payload.error)).toContain('ollama pull ghost');
    expect(sent.filter((s) => s.channel === 'ai:stream:done')).toEqual([]);
  });
});

describe('ai:stream — OpenAI', () => {
  it('emits one chunk per SSE delta and reports usage from the final event', async () => {
    stubFetch(() =>
      sseResponse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {} }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
        '[DONE]',
      ])
    );
    await invoke('ai:stream', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-not-real',
      messages: [{ role: 'user', content: 'hi' }],
      channelId: 'c1',
    });
    expect(chunksFor('c1')).toEqual(['Hel', 'lo']);
    const done = sent.find((s) => s.channel === 'ai:stream:done');
    expect(done?.payload.fullText).toBe('Hello');
    expect(done?.payload.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 2 });
  });

  it('sends the key as a bearer token and never in the body', async () => {
    stubFetch(() => sseResponse(['[DONE]']));
    await invoke('ai:stream', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-not-real',
      messages: [{ role: 'user', content: 'hi' }],
      channelId: 'c1',
    });
    expect(recorded[0].headers?.Authorization).toBe('Bearer sk-test-not-real');
    expect(recorded[0].body).not.toContain('sk-test-not-real');
  });

  it('surfaces a mid-stream error event instead of ending as a short success', async () => {
    stubFetch(() =>
      sseResponse([
        { choices: [{ delta: { content: 'partial' } }] },
        { error: { message: 'rate limit reached' } },
      ])
    );
    await invoke('ai:stream', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'k',
      messages: [],
      channelId: 'c1',
    });
    const err = sent.find((s) => s.channel === 'ai:stream:error');
    expect(err?.payload.error).toBe('rate limit reached');
    expect(sent.filter((s) => s.channel === 'ai:stream:done')).toEqual([]);
  });

  it('maps a 401 to the provider message without echoing the key', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401));
    await invoke('ai:stream', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-secret-value',
      messages: [],
      channelId: 'c1',
    });
    const err = sent.find((s) => s.channel === 'ai:stream:error');
    expect(String(err?.payload.error)).toBe('Incorrect API key provided');
    expect(JSON.stringify(err?.payload)).not.toContain('sk-secret-value');
  });
});

describe('ai:stream — Anthropic', () => {
  it('emits one chunk per content_block_delta and combines split usage', async () => {
    stubFetch(() =>
      sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 12 } } },
        { type: 'content_block_delta', delta: { text: 'Good ' } },
        { type: 'content_block_delta', delta: { text: 'morning' } },
        { type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ])
    );
    await invoke('ai:stream', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test',
      messages: [{ role: 'user', content: 'hi' }],
      channelId: 'c1',
    });
    expect(chunksFor('c1')).toEqual(['Good ', 'morning']);
    const done = sent.find((s) => s.channel === 'ai:stream:done');
    expect(done?.payload.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 5 });
  });

  it('places the system prompt in the top-level system field, not as a message', async () => {
    stubFetch(() => sseResponse([{ type: 'message_stop' }]));
    await invoke('ai:stream', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      messages: [
        { role: 'system', content: 'You are Henry.' },
        { role: 'user', content: 'hi' },
      ],
      channelId: 'c1',
    });
    const body = JSON.parse(recorded[0].body!);
    expect(body.system).toBe('You are Henry.');
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    expect(body.max_tokens).toBe(4096);
  });

  it('surfaces an Anthropic error event', async () => {
    stubFetch(() => sseResponse([{ type: 'error', error: { message: 'overloaded' } }]));
    await invoke('ai:stream', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      messages: [],
      channelId: 'c1',
    });
    expect(sent.find((s) => s.channel === 'ai:stream:error')?.payload.error).toBe('overloaded');
  });
});

describe('ai:cancel', () => {
  it('aborts an in-flight Ollama stream through its AbortSignal', async () => {
    let releaseStream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let signal: AbortSignal | undefined;
    stubFetch((rec) => {
      signal = rec.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            async read() {
              await gate;
              if (signal?.aborted) {
                throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
              }
              return { done: true as const };
            },
            releaseLock() {},
          }),
        },
      };
    });

    const streaming = invoke('ai:stream', {
      provider: 'ollama',
      model: 'm',
      apiKey: '',
      messages: [],
      channelId: 'c1',
    });

    // Wait for the request to actually be in flight before cancelling.
    while (!signal) await Promise.resolve();

    expect(await invoke('ai:cancel', 'c1')).toEqual({ cancelled: true });
    expect(signal?.aborted).toBe(true);

    releaseStream();
    await streaming;

    expect(sent.filter((s) => s.channel === 'ai:stream:done')).toEqual([]);
    expect(String(sent.find((s) => s.channel === 'ai:stream:error')?.payload.error)).toMatch(/abort/i);
  });

  it('reports no live stream when nothing is running', async () => {
    expect(await invoke('ai:cancel', 'never-started')).toEqual({ cancelled: false });
  });
});

// ── Tool-calling rounds ─────────────────────────────────────────────────────

const TOOLS: ModelTool[] = [
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: 'List files in a directory.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

describe('callAIWithTools — OpenAI shape', () => {
  it('sends the tool schema and parses a structured tool call', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'file_list', arguments: '{"path":"/tmp"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 8 },
      })
    );
    const result = await callAIWithTools({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'list /tmp' }],
      modelTools: TOOLS,
    });
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'file_list', arguments: { path: '/tmp' } }]);

    const body = JSON.parse(recorded[0].body!);
    expect(body.tools).toEqual(TOOLS);
    expect(body.tool_choice).toBe('auto');
  });

  it('round-trips the assistant tool-call turn and the tool result back to the model', async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: 'done' } }] }));
    await callAIWithTools({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'k',
      messages: [
        { role: 'user', content: 'list /tmp' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'file_list', arguments: { path: '/tmp' } }] },
        { role: 'tool', name: 'file_list', toolCallId: 'call_1', content: 'a.txt\nb.txt' },
      ],
      modelTools: TOOLS,
    });
    const body = JSON.parse(recorded[0].body!);
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_list', arguments: '{"path":"/tmp"}' } }],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' });
  });

  it('recovers a tool call written into content instead of tool_calls', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: '{"name":"file_list","arguments":{"path":"/tmp"}}' } }],
      })
    );
    const result = await callAIWithTools({
      provider: 'openai',
      model: 'local-ish',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'list /tmp' }],
      modelTools: TOOLS,
    });
    expect(result.toolCalls).toEqual([{ id: result.toolCalls[0].id, name: 'file_list', arguments: { path: '/tmp' } }]);
    expect(result.content).toBe('');
  });

  it('never sends a relay conversation to api.openai.com', async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: '' } }] }));
    let outcome: 'relay' | 'refused' = 'refused';
    try {
      await callAIWithTools({
        provider: 'relay',
        model: 'm',
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
        modelTools: TOOLS,
      });
      outcome = 'relay';
    } catch {
      outcome = 'refused';
    }
    // Either the configured relay answered, or the round was refused. What
    // must never happen is the message reaching OpenAI with the relay's key.
    expect(recorded.map((r) => r.url)).not.toContain('https://api.openai.com/v1/chat/completions');
    expect(['relay', 'refused']).toContain(outcome);
  });
});

describe('callAIWithTools — Anthropic shape', () => {
  it('translates the tool schema to input_schema and parses tool_use blocks', async () => {
    stubFetch(() =>
      jsonResponse({
        content: [
          { type: 'text', text: 'Listing now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'file_list', input: { path: '/tmp' } },
        ],
        usage: { input_tokens: 50, output_tokens: 4 },
      })
    );
    const result = await callAIWithTools({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'list /tmp' }],
      modelTools: TOOLS,
    });
    expect(result.content).toBe('Listing now.');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'file_list', arguments: { path: '/tmp' } }]);
    const body = JSON.parse(recorded[0].body!);
    expect(body.tools).toEqual([
      { name: 'file_list', description: 'List files in a directory.', input_schema: TOOLS[0].function.parameters },
    ]);
  });

  it('merges parallel tool results, which Anthropic rejects as two turns of the same role', async () => {
    stubFetch(() => jsonResponse({ content: [] }));
    await callAIWithTools({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      messages: [
        { role: 'user', content: 'list both' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'file_list', arguments: { path: '/a' } },
            { id: 't2', name: 'file_list', arguments: { path: '/b' } },
          ],
        },
        { role: 'tool', name: 'file_list', toolCallId: 't1', content: 'a.txt' },
        { role: 'tool', name: 'file_list', toolCallId: 't2', content: 'b.txt' },
      ],
      modelTools: TOOLS,
    });
    const body = JSON.parse(recorded[0].body!);
    const roles = body.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[2].content).toHaveLength(2);
    expect(body.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(['t1', 't2']);
  });

  it('keeps every system turn instead of only the last', async () => {
    stubFetch(() => jsonResponse({ content: [] }));
    await callAIWithTools({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      messages: [
        { role: 'system', content: 'Persona A.' },
        { role: 'system', content: 'Persona B.' },
        { role: 'user', content: 'hi' },
      ],
      modelTools: TOOLS,
    });
    const body = JSON.parse(recorded[0].body!);
    expect(body.system).toContain('Persona A.');
    expect(body.system).toContain('Persona B.');
  });
});

describe('callAIWithTools — Ollama routing', () => {
  it('sends the tool schema to /api/chat and parses the native tool_calls shape', async () => {
    stubFetch(() =>
      jsonResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_w', function: { name: 'file_list', arguments: { path: '/tmp' } } }],
        },
        prompt_eval_count: 168,
        eval_count: 13,
      })
    );
    const result = await callAIWithTools({
      provider: 'ollama',
      model: 'llama3.2:3b',
      apiKey: '',
      apiUrl: 'http://127.0.0.1:11434',
      messages: [{ role: 'user', content: 'list /tmp' }],
      modelTools: TOOLS,
    });
    expect(result.toolCalls).toEqual([{ id: 'call_w', name: 'file_list', arguments: { path: '/tmp' } }]);
    expect(recorded[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(recorded[0].body!).tools).toEqual(TOOLS);
  });

  it('recovers the raw-text tool call a model writes into content', async () => {
    stubFetch(() =>
      jsonResponse({
        message: { role: 'assistant', content: '{"name":"file_list","parameters":{"path":"/tmp"}}' },
        prompt_eval_count: 10,
        eval_count: 5,
      })
    );
    const result = await callAIWithTools({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiKey: '',
      messages: [{ role: 'user', content: 'list /tmp' }],
      modelTools: TOOLS,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'file_list', arguments: { path: '/tmp' } });
  });
});

// ── Non-streaming adapters ──────────────────────────────────────────────────

describe('callAI', () => {
  it('concatenates every Anthropic text block instead of only the first', async () => {
    stubFetch(() =>
      jsonResponse({
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
        usage: { input_tokens: 7, output_tokens: 9 },
      })
    );
    const result = await callAI({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.content).toBe('Part one. Part two.');
    expect(result.usage).toEqual({ input: 7, output: 9 });
  });

  it('sends a Google system prompt as text even when content is parts', async () => {
    stubFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
    await callAI({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'k',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are Henry.' }] },
        { role: 'user', content: 'hi' },
      ],
    });
    const body = JSON.parse(recorded[0].body!);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are Henry.' }] });
  });

  it('rejects an unknown provider before making a request', async () => {
    stubFetch(() => jsonResponse({}));
    await expect(
      callAI({ provider: 'nope', model: 'm', apiKey: '', messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toThrow(/Unknown provider/);
    expect(recorded).toHaveLength(0);
  });

  it('computes a cost only for a model with pricing', () => {
    expect(calculateCost('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.7875, 6);
    expect(calculateCost('llama3.2:3b', 1_000_000, 1_000_000)).toBe(0);
    expect(calculateCost('unknown-model', 1000, 1000)).toBe(0);
  });
});