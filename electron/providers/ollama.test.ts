/**
 * The regression these tests exist for: `ai:stream` had no Ollama case, so a
 * 626-character reply arrived as ONE chunk after 20.7 s of silence
 * (`firstChunkMs == lastChunkMs`). A test that only asserts the final text
 * would pass against that broken code, so these assert *when* the chunks
 * arrive — the reader below gates each read, which makes "the answer was
 * buffered and released at the end" observable rather than invisible.
 */
import { describe, it, expect } from 'vitest';
import {
  streamOllamaChat,
  callOllamaToolsRound,
  toOllamaToolMessages,
  resolveOllamaBaseUrl,
  ollamaNotRunningError,
  type OllamaFetch,
  type OllamaHttpResponse,
} from './ollama';
import type { RunnerMessage } from '../agent/toolRunner';
import type { ModelTool } from '../agent/types';

const enc = (s: string) => new TextEncoder().encode(s);

/** Wires the adapter handlers into a trace so timing can be asserted. */
function runStream(trace: Trace): { handlers: { onChunk: (t: string) => void; onDone: (f: string, u?: { input: number; output: number }) => void; onError: (e: string) => void }; ended: () => boolean } {
  let ended = false;
  const handlers = {
    onChunk: (t: string) => {
      if (!ended) trace.chunksBeforeEnd++;
      trace.chunkCount++;
      trace.fullText += t;
    },
    onDone: (f: string, u?: { input: number; output: number }) => {
      ended = true;
      trace.streamEnded = true;
      trace.doneText = f;
      trace.usage = u;
    },
    onError: (e: string) => {
      ended = true;
      trace.streamEnded = true;
      trace.errors.push(e);
    },
  };
  return { handlers, ended: () => ended };
}

describe('resolveOllamaBaseUrl', () => {
  it('uses the configured URL and strips trailing slashes', () => {
    expect(resolveOllamaBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
  });

  it('falls back to the local default', () => {
    expect(resolveOllamaBaseUrl(undefined)).toBe('http://localhost:11434');
  });
});

describe('streamOllamaChat — genuine incremental delivery', () => {
  it('emits a chunk per NDJSON record, before the stream ends', async () => {
    const trace: Trace = {
      chunksBeforeEnd: 0,
      chunkCount: 0,
      fullText: '',
      errors: [],
      streamEnded: false,
    };
    // One record per line, exactly as Ollama emits them.
    const lines = [
      '{"message":{"content":"The"}}\n',
      '{"message":{"content":" quick"}}\n',
      '{"message":{"content":" brown"}}\n',
      '{"message":{"content":" fox"}}\n',
      '{"done":true,"prompt_eval_count":12,"eval_count":4}\n',
    ];
    let i = 0;
    const fetchImpl: OllamaFetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (i >= lines.length) return { done: true as const };
            return { done: false as const, value: enc(lines[i++]) };
          },
          releaseLock() {},
        }),
      },
    });

    const { handlers } = runStream(trace);
    await streamOllamaChat(
      { model: 'llama3.2:3b', messages: [{ role: 'user', content: 'hi' }], fetchImpl },
      handlers
    );

    expect(trace.chunkCount).toBe(4);
    expect(trace.fullText).toBe('The quick brown fox');
    expect(trace.doneText).toBe('The quick brown fox');
    expect(trace.usage).toEqual({ input: 12, output: 4 });
    expect(trace.errors).toEqual([]);
  });

  it('reports chunks while the response is still open, not only at the end', async () => {
    const seenWhileOpen: string[] = [];
    let streamOpen = true;
    let i = 0;
    const lines = [
      '{"message":{"content":"alpha"}}\n',
      '{"message":{"content":"beta"}}\n',
      '{"message":{"content":"gamma"}}\n',
      '{"done":true,"prompt_eval_count":3,"eval_count":3}\n',
    ];
    const fetchImpl: OllamaFetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (i >= lines.length) {
              streamOpen = false;
              return { done: true as const };
            }
            return { done: false as const, value: enc(lines[i++]) };
          },
          releaseLock() {},
        }),
      },
    });

    await streamOllamaChat(
      { model: 'llama3.2:3b', messages: [], fetchImpl },
      {
        onChunk: (t) => {
          if (streamOpen) seenWhileOpen.push(t);
        },
        onDone: () => {
          if (streamOpen) throw new Error('onDone fired before the stream ended');
        },
        onError: (e) => {
          throw new Error(e);
        },
      }
    );

    // All three deltas were delivered while the provider stream was still open.
    expect(seenWhileOpen).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('splits deltas correctly when a record straddles two socket reads', async () => {
    const trace: Trace = { chunksBeforeEnd: 0, chunkCount: 0, fullText: '', errors: [], streamEnded: false };
    const reads = ['{"message":{"content":"Hel', 'lo there"}}\n{"done":true,"eval_count":2}\n'];
    let i = 0;
    const fetchImpl: OllamaFetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (i >= reads.length) return { done: true as const };
            return { done: false as const, value: enc(reads[i++]) };
          },
          releaseLock() {},
        }),
      },
    });
    const { handlers } = runStream(trace);
    await streamOllamaChat({ model: 'm', messages: [], fetchImpl }, handlers);
    expect(trace.fullText).toBe('Hello there');
    expect(trace.chunkCount).toBe(1);
  });

  it('completes an empty stream instead of hanging', async () => {
    const trace: Trace = { chunksBeforeEnd: 0, chunkCount: 0, fullText: '', errors: [], streamEnded: false };
    const fetchImpl: OllamaFetch = async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({ async read() { return { done: true as const }; }, releaseLock() {} }) },
    });
    const { handlers } = runStream(trace);
    await streamOllamaChat({ model: 'm', messages: [], fetchImpl }, handlers);
    expect(trace.streamEnded).toBe(true);
    expect(trace.doneText).toBe('');
    expect(trace.usage).toBeUndefined();
    expect(trace.errors).toEqual([]);
  });

  it('surfaces an error record delivered mid-stream', async () => {
    const trace: Trace = { chunksBeforeEnd: 0, chunkCount: 0, fullText: '', errors: [], streamEnded: false };
    const lines = ['{"message":{"content":"partial"}}\n', '{"error":"model requires more system memory"}\n'];
    let i = 0;
    const fetchImpl: OllamaFetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (i >= lines.length) return { done: true as const };
            return { done: false as const, value: enc(lines[i++]) };
          },
          releaseLock() {},
        }),
      },
    });
    const { handlers } = runStream(trace);
    await streamOllamaChat({ model: 'm', messages: [], fetchImpl }, handlers);
    expect(trace.errors).toEqual(['model requires more system memory']);
    expect(trace.fullText).toBe('partial');
  });

  it('names the pull command when the model is not installed', async () => {
    const trace: Trace = { chunksBeforeEnd: 0, chunkCount: 0, fullText: '', errors: [], streamEnded: false };
    const fetchImpl: OllamaFetch = async () => ({
      ok: false,
      status: 404,
      text: async () => 'model "nope" not found',
    });
    const { handlers } = runStream(trace);
    await streamOllamaChat({ model: 'nope', messages: [], fetchImpl }, handlers);
    expect(trace.errors[0]).toContain('ollama pull nope');
  });

  it('tells the user how to start Ollama when the connection is refused', async () => {
    const trace: Trace = { chunksBeforeEnd: 0, chunkCount: 0, fullText: '', errors: [], streamEnded: false };
    const fetchImpl: OllamaFetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const { handlers } = runStream(trace);
    await streamOllamaChat({ model: 'm', messages: [], fetchImpl }, handlers);
    expect(trace.errors).toEqual([ollamaNotRunningError()]);
  });

  it('aborts mid-stream without reporting success', async () => {
    const trace: Trace = { chunksBeforeEnd: 0, chunkCount: 0, fullText: '', errors: [], streamEnded: false };
    const controller = new AbortController();
    let i = 0;
    const fetchImpl: OllamaFetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (i === 0) {
              i++;
              return { done: false as const, value: enc('{"message":{"content":"a"}}\n') };
            }
            controller.abort();
            throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
          },
          releaseLock() {},
        }),
      },
    });
    const { handlers } = runStream(trace);
    await streamOllamaChat(
      { model: 'm', messages: [], fetchImpl, signal: controller.signal },
      handlers
    );
    expect(trace.errors).toHaveLength(1);
    expect(trace.errors[0]).toMatch(/abort/i);
    expect(trace.doneText).toBeUndefined();
  });

  it('sends stream:true and the model/options to /api/chat', async () => {
    let seenBody: Record<string, unknown> = {};
    let seenUrl = '';
    const fetchImpl: OllamaFetch = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, body: { getReader: () => ({ async read() { return { done: true as const }; }, releaseLock() {} }) } };
    };
    await streamOllamaChat(
      { model: 'llama3.2:3b', apiUrl: 'http://127.0.0.1:11434', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, maxTokens: 128, fetchImpl },
      { onChunk: () => {}, onDone: () => {}, onError: () => {} }
    );
    expect(seenUrl).toBe('http://127.0.0.1:11434/api/chat');
    expect(seenBody).toMatchObject({
      model: 'llama3.2:3b',
      stream: true,
      options: { temperature: 0.2, num_predict: 128 },
    });
  });
});

describe('toOllamaToolMessages', () => {
  it('emits the assistant tool-call turn and the tool result turn in order', () => {
    const messages: RunnerMessage[] = [
      { role: 'system', content: 'You are Henry.' },
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }],
      },
      { role: 'tool', name: 'get_weather', toolCallId: 'c1', content: '{"temp_c":18}' },
    ];
    expect(toOllamaToolMessages(messages)).toEqual([
      { role: 'system', content: 'You are Henry.' },
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
      { role: 'tool', name: 'get_weather', content: '{"temp_c":18}' },
    ]);
  });

  it('carries a tool result image as a note, since Ollama tool turns are text only', () => {
    const messages: RunnerMessage[] = [
      {
        role: 'tool',
        name: 'file_load',
        toolCallId: 'c1',
        content: 'loaded',
        images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      },
    ];
    const [turn] = toOllamaToolMessages(messages) as Array<{ content: string }>;
    expect(turn.content).toContain('returned an image');
  });
});

const WEATHER_TOOL: ModelTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

function jsonFetch(payload: unknown, capture?: (body: Record<string, unknown>) => void): OllamaFetch {
  return async (_url, init) => {
    capture?.(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => payload };
  };
}

describe('callOllamaToolsRound', () => {
  it('parses the native tool_calls shape llama3.2:3b returns', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = jsonFetch(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_wjvsxomp', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } }],
        },
        prompt_eval_count: 168,
        eval_count: 13,
      },
      (b) => {
        body = b;
      }
    );
    const result = await callOllamaToolsRound({
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'Weather?' }],
      modelTools: [WEATHER_TOOL],
      fetchImpl,
    });
    expect(result.toolCalls).toEqual([
      { id: 'call_wjvsxomp', name: 'get_weather', arguments: { city: 'Paris' } },
    ]);
    expect(result.usage).toEqual({ input: 168, output: 13 });
    // The tool schema must travel as an OpenAI-shaped function declaration.
    expect(body.tools).toEqual([WEATHER_TOOL]);
    expect(body.stream).toBe(false);
  });

  it('recovers the raw-text tool call qwen2.5-coder:7b returns', async () => {
    const fetchImpl = jsonFetch({
      message: {
        role: 'assistant',
        content: '{"name": "get_weather", "arguments": {"city": "Paris"}}',
      },
      prompt_eval_count: 174,
      eval_count: 17,
    });
    const result = await callOllamaToolsRound({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Weather?' }],
      modelTools: [WEATHER_TOOL],
      fetchImpl,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('get_weather');
    expect(result.toolCalls[0].arguments).toEqual({ city: 'Paris' });
    expect(result.content).toBe('');
  });

  it('returns no tool calls and keeps the text for a plain answer', async () => {
    const fetchImpl = jsonFetch({
      message: { role: 'assistant', content: 'It is sunny in Paris.' },
      prompt_eval_count: 10,
      eval_count: 6,
    });
    const result = await callOllamaToolsRound({
      model: 'm',
      messages: [],
      modelTools: [WEATHER_TOOL],
      fetchImpl,
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe('It is sunny in Paris.');
  });

  it('prefers structured tool_calls over mining the text', async () => {
    const fetchImpl = jsonFetch({
      message: {
        content: 'I will call it. {"name":"other","arguments":{}}',
        tool_calls: [{ id: 'x', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const result = await callOllamaToolsRound({
      model: 'm',
      messages: [],
      modelTools: [WEATHER_TOOL],
      fetchImpl,
    });
    expect(result.toolCalls.map((c) => c.name)).toEqual(['get_weather']);
  });

  it('raises the pull command for an unknown model', async () => {
    const fetchImpl: OllamaFetch = async () => ({ ok: false, status: 404, text: async () => '' });
    await expect(
      callOllamaToolsRound({ model: 'ghost', messages: [], modelTools: [], fetchImpl })
    ).rejects.toThrow(/ollama pull ghost/);
  });

  it('reports a refused connection as "Ollama is not running"', async () => {
    const fetchImpl: OllamaFetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    await expect(
      callOllamaToolsRound({ model: 'm', messages: [], modelTools: [], fetchImpl })
    ).rejects.toThrow(/Ollama isn't running/);
  });
});