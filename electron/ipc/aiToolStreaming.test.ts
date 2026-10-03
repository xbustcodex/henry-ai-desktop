/**
 * The last link in the chain, proven together: the ToolRunner supplies an
 * `onDelta`, `callAIWithTools` must route a live Ollama tool round through the
 * STREAMING adapter, and the tool must still execute exactly once.
 *
 * AgentsTools' `toolStream.test.ts` covers the runner half with a scripted
 * `complete`, and `aiProviders.test.ts` covers `callAIWithTools` in isolation.
 * Neither drives the real runner against the real adapter, which is precisely
 * where a signature mismatch or a dropped wiring would hide.
 *
 * Hermetic: `fetch` is stubbed, so no Ollama and no credentials. The live wire
 * is proven separately against a real local Ollama.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle() {} }, BrowserWindow: class {} }));
vi.mock('./database', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }) }) }));

import { ToolRegistry } from '../agent/toolRegistry';
import type { ToolDefinition } from '../agent/types';
import { runToolConversation, type CompleteHandlers, type RunnerMessage } from '../agent/toolRunner';
import { callAIWithTools } from './ai';

const enc = (s: string) => new TextEncoder().encode(s);

let recorded: Array<{ url: string; body: string }> = [];

function ndjsonFetch(recordsPerCall: unknown[][]): (url: string, init?: { body?: string }) => Promise<Response> {
  let call = 0;
  return async (url: string, init?: { body?: string }) => {
    recorded.push({ url: String(url), body: String(init?.body ?? '') });
    const records = recordsPerCall[call++] ?? [];
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (i >= records.length) return { done: true as const };
            const r = records[i++];
            return { done: false as const, value: enc((typeof r === 'string' ? r : JSON.stringify(r)) + '\n') };
          },
          releaseLock() {},
        }),
      },
    } as Response;
  };
}

/**
 * The shape measured live from llama3.2:3b and qwen2.5-coder:7b over a stream:
 * the tool call arrives as text split mid-token, with no `message.tool_calls`
 * field at all. Reproducing that here means the test fails if the accumulated
 * recovery is ever dropped.
 */
// Sliced from ONE blob at real offsets so the pieces reassemble exactly. A
// hand-written split that doubles a quote produces malformed JSON that is
// correctly not parsed — which is a test bug, not an adapter bug.
const CALL_BLOB = '{"name":"get_weather","parameters":{"city":"Paris"}}';
const STREAMED_CALL_AS_TEXT = [
  { message: { content: 'Sure, ' } },
  { message: { content: CALL_BLOB.slice(0, 20) } },
  { message: { content: CALL_BLOB.slice(20, 45) } },
  { message: { content: CALL_BLOB.slice(45) } },
  { done: true, prompt_eval_count: 30, eval_count: 8 },
];

const STRUCTURED_CALL = [
  {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
    },
  },
  { done: true, prompt_eval_count: 30, eval_count: 5 },
];

const FINAL_ANSWER = [
  { message: { content: 'It is clear and 18C ' } },
  { message: { content: 'in Paris.' } },
  { done: true, prompt_eval_count: 40, eval_count: 9 },
];

function registryWithSpy(onExecute: (args: Record<string, unknown>) => void): ToolRegistry {
  const registry = new ToolRegistry();
  const tool: ToolDefinition = {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    category: 'memory',
    safetyLevel: 'silent',
    async execute(args: Record<string, unknown>) {
      onExecute(args);
      return { ok: true, data: { temp_c: 18, sky: 'clear' } };
    },
  };
  registry.register(tool);
  return registry;
}

const context = {
  db: {} as never,
  getWindow: () => null,
};

beforeEach(() => {
  recorded = [];
});

describe('runner → callAIWithTools → streaming Ollama tool round', () => {
  it('executes the tool exactly once and streams the final answer', async () => {
    globalThis.fetch = ndjsonFetch([
      STREAMED_CALL_AS_TEXT,
      FINAL_ANSWER,
    ]) as unknown as typeof globalThis.fetch;

    const executed: Record<string, unknown>[] = [];
    const deltas: string[] = [];
    const registry = registryWithSpy((args) => executed.push(args));

    // Exactly the shape the runner calls it with: third argument optional.
    const complete = (
      messages: RunnerMessage[],
      modelTools: Parameters<typeof callAIWithTools>[0]['modelTools'],
      handlers?: CompleteHandlers
    ) =>
      callAIWithTools({
        provider: 'ollama',
        model: 'llama3.2:3b',
        apiKey: '',
        apiUrl: 'http://127.0.0.1:11434',
        messages,
        modelTools,
        onDelta: handlers?.onDelta
          ? (t) => { deltas.push(t); handlers.onDelta?.(t); }
          : undefined,
      });

    const result = await runToolConversation({
      registry,
      context,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      complete,
    });

    // The tool ran once, with the arguments recovered from streamed text.
    expect(executed).toEqual([{ city: 'Paris' }]);
    // Deltas arrived, in order, across both rounds.
    expect(deltas).toEqual([
      'Sure, ',
      CALL_BLOB.slice(0, 20),
      CALL_BLOB.slice(20, 45),
      CALL_BLOB.slice(45),
      'It is clear and 18C ',
      'in Paris.',
    ]);
    // The final answer is the authoritative content, free of the raw call.
    expect(result.content).toBe('It is clear and 18C in Paris.');
    expect(result.content).not.toContain('get_weather');
  });

  it('puts stream:true AND tools on the wire for every round of a streamed turn', async () => {
    globalThis.fetch = ndjsonFetch([STREAMED_CALL_AS_TEXT, FINAL_ANSWER]) as unknown as typeof globalThis.fetch;
    const registry = registryWithSpy(() => {});

    await runToolConversation({
      registry,
      context,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      complete: (messages, modelTools, handlers) =>
        callAIWithTools({
          provider: 'ollama', model: 'llama3.2:3b', apiKey: '',
          messages, modelTools, onDelta: handlers?.onDelta,
        }),
    });

    expect(recorded).toHaveLength(2);
    for (const rec of recorded) {
      const body = JSON.parse(rec.body) as { stream?: boolean; tools?: unknown[] };
      expect(body.stream).toBe(true);
      expect(body.tools).toHaveLength(1);
    }
  });

  it('captures a structured tool call in a stream just as reliably', async () => {
    globalThis.fetch = ndjsonFetch([STRUCTURED_CALL, FINAL_ANSWER]) as unknown as typeof globalThis.fetch;
    const executed: Record<string, unknown>[] = [];
    const deltas: string[] = [];

    const result = await runToolConversation({
      registry: registryWithSpy((a) => executed.push(a)),
      context,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      complete: (messages, modelTools, handlers) =>
        callAIWithTools({
          provider: 'ollama', model: 'llama3.2:3b', apiKey: '',
          messages, modelTools,
          onDelta: handlers?.onDelta ? (t) => { deltas.push(t); handlers.onDelta?.(t); } : undefined,
        }),
    });

    expect(executed).toEqual([{ city: 'Paris' }]);
    expect(result.content).toBe('It is clear and 18C in Paris.');
    // A tool-calling round that is silent emits no deltas at all, so there is
    // nothing provisional on screen for the closing event to replace.
    expect(deltas).toEqual(['It is clear and 18C ', 'in Paris.']);
  });

  it('never leaks the tool result back into a mined tool call', async () => {
    globalThis.fetch = ndjsonFetch([STREAMED_CALL_AS_TEXT, FINAL_ANSWER]) as unknown as typeof globalThis.fetch;
    const registry = registryWithSpy(() => {});

    await runToolConversation({
      registry,
      context,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      complete: (messages, modelTools, handlers) =>
        callAIWithTools({
          provider: 'ollama', model: 'llama3.2:3b', apiKey: '',
          messages, modelTools, onDelta: handlers?.onDelta,
        }),
    });

    // The tool result travelled to the provider as a `tool` role message, and
    // no request body contains a mined call derived from it.
    const second = JSON.parse(recorded[1].body) as { messages: Array<{ role: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('behaves identically when the runner supplies no delta channel', async () => {
    // A provider that never streams must not change the loop's behaviour.
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      recorded.push({ url: String(url), body: String(init?.body ?? '') });
      const isFirst = recorded.length === 1;
      const payload = isFirst
        ? {
            message: { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'get_weather', arguments: { city: 'Paris' } } }] },
            prompt_eval_count: 1, eval_count: 1,
          }
        : { message: { role: 'assistant', content: 'Clear and 18C.' }, prompt_eval_count: 1, eval_count: 1 };
      return { ok: true, status: 200, json: async () => payload } as Response;
    }) as unknown as typeof globalThis.fetch;

    const executed: Record<string, unknown>[] = [];
    const result = await runToolConversation({
      registry: registryWithSpy((a) => executed.push(a)),
      context,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      // No third argument at all — the pre-existing two-arg contract.
      complete: (messages, modelTools) =>
        callAIWithTools({
          provider: 'ollama', model: 'llama3.2:3b', apiKey: '', messages, modelTools,
        }),
    });

    expect(executed).toEqual([{ city: 'Paris' }]);
    expect(result.content).toBe('Clear and 18C.');
    const bodies = recorded.map((r) => JSON.parse(r.body) as { stream?: boolean; tools?: unknown[] });
    expect(bodies.every((b) => b.stream === false)).toBe(true);
  });
});