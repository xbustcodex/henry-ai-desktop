/**
 * The OpenCode bridge and the user-configured relay were the last two
 * providers still falling into the buffered `default` branch of `ai:stream`.
 *
 * The bridge is stubbed here so these run with no CLI, no server and no
 * network: they prove Henry's request/response handling, not that opencode
 * works. The bridge's own streaming and refusal are covered in
 * opencodeBridge.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const BRIDGE_TOKEN = 'bridge-token-for-tests';
const BRIDGE_BASE = 'http://127.0.0.1:11540/v1';

vi.mock('./opencodeBridge', () => ({
  ensureOpencodeBridge: async () => ({ running: true, port: 11540, baseUrl: 'http://127.0.0.1:11540/v1', modelCount: 400 }),
  opencodeBridgeToken: () => BRIDGE_TOKEN,
}));

import { registerAIHandlers, callAIWithTools } from './ai';
import { registry } from '../agent/toolRegistry';
import type { ModelTool, ToolDefinition } from '../agent/types';

// The agent path attaches whatever the live registry holds. With no tools
// there is nothing for the bridge to refuse and the degradation is never
// reached, so one real definition is registered for these tests. The full
// 52-tool set is registered in the app, not here.
registry.register({
  name: 'file_list',
  description: 'List files in a directory.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  category: 'system',
  safetyLevel: 'silent',
  execute: async () => ({ ok: true, data: [] }),
} satisfies ToolDefinition);

const enc = (s: string) => new TextEncoder().encode(s);

interface Recorded {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

let recorded: Recorded[] = [];
let sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
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

function sse(events: unknown[]) {
  const reads = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  let i = 0;
  return {
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
  };
}

function stubFetch(handler: (rec: Recorded) => unknown): void {
  const impl = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const rec: Recorded = { url: String(url), headers: init?.headers, body: init?.body };
    recorded.push(rec);
    return handler(rec) as Response;
  });
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

const chunksFor = (channelId: string) =>
  sent.filter((s) => s.channel === 'ai:stream:chunk' && s.payload.channelId === channelId).map((s) => s.payload.chunk as string);

beforeEach(() => {
  recorded = [];
  sent = [];
});

describe('ai:stream — OpenCode bridge', () => {
  it('streams the bridge response as individual chunks', async () => {
    stubFetch(() =>
      sse([
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { content: 'from opencode' } }] },
        { choices: [{ delta: {} }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
        '[DONE]',
      ])
    );
    await invoke('ai:stream', {
      provider: 'opencode',
      model: 'opencode/space-bunny-free',
      apiKey: '',
      messages: [{ role: 'user', content: 'hi' }],
      channelId: 'c1',
    });
    expect(chunksFor('c1')).toEqual(['Hello ', 'from opencode']);
    expect(sent.find((s) => s.channel === 'ai:stream:done')?.payload.fullText).toBe('Hello from opencode');
  });

  it('authenticates with the loopback bridge token, not the provider key', async () => {
    stubFetch(() => sse(['[DONE]']));
    await invoke('ai:stream', {
      provider: 'opencode',
      model: 'opencode/space-bunny-free',
      apiKey: 'not-used-here',
      messages: [],
      channelId: 'c1',
    });
    expect(recorded[0].url).toBe(`${BRIDGE_BASE}/chat/completions`);
    expect(recorded[0].headers?.Authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);
    expect(JSON.parse(recorded[0].body!).stream).toBe(true);
  });

  it('streams opencode-zen through the same bridge', async () => {
    stubFetch(() => sse([{ choices: [{ delta: { content: 'zen' } }] }, '[DONE]']));
    await invoke('ai:stream', {
      provider: 'opencode-zen',
      model: 'zen/model',
      apiKey: 'zen-key',
      messages: [],
      channelId: 'c1',
    });
    expect(chunksFor('c1')).toEqual(['zen']);
    expect(recorded[0].headers?.Authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);
  });

  it('surfaces a bridge error event instead of ending as a short success', async () => {
    stubFetch(() => sse([{ choices: [{ delta: { content: 'partial' } }] }, { error: { message: 'model is overloaded' } }]));
    await invoke('ai:stream', { provider: 'opencode', model: 'm', apiKey: '', messages: [], channelId: 'c1' });
    expect(sent.find((s) => s.channel === 'ai:stream:error')?.payload.error).toBe('model is overloaded');
    expect(sent.filter((s) => s.channel === 'ai:stream:done')).toEqual([]);
  });
});

describe('ai:stream — relay', () => {
  it('explains that the relay is unconfigured instead of silently buffering', async () => {
    stubFetch(() => sse(['[DONE]']));
    await invoke('ai:stream', { provider: 'relay', model: 'm', apiKey: '', messages: [], channelId: 'c1' });
    const err = sent.find((s) => s.channel === 'ai:stream:error');
    expect(String(err?.payload.error)).toMatch(/relay is not configured/i);
    expect(recorded).toHaveLength(0);
  });

  it('streams against a relay URL supplied on the request', async () => {
    stubFetch(() => sse([{ choices: [{ delta: { content: 'via relay' } }] }, '[DONE]']));
    await invoke('ai:stream', {
      provider: 'relay',
      model: 'm',
      apiKey: 'relay-key',
      relayUrl: 'https://gateway.example.com/v1',
      messages: [{ role: 'user', content: 'hi' }],
      channelId: 'c1',
    });
    expect(recorded[0].url).toBe('https://gateway.example.com/v1/chat/completions');
    expect(chunksFor('c1')).toEqual(['via relay']);
  });

  it('refuses a relay URL that is not http(s)', async () => {
    stubFetch(() => sse(['[DONE]']));
    await invoke('ai:stream', {
      provider: 'relay',
      model: 'm',
      apiKey: '',
      relayUrl: 'file:///etc/passwd',
      messages: [],
      channelId: 'c1',
    });
    expect(String(sent.find((s) => s.channel === 'ai:stream:error')?.payload.error)).toMatch(/http:\/\/ or https:\/\//);
    expect(recorded).toHaveLength(0);
  });
});

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

const REFUSAL = {
  error: {
    message:
      "The OpenCode bridge cannot execute Henry's tools. `opencode run` takes a single prompt and runs its own built-in tools; it cannot be given Henry's tool schema. For agent turns use Ollama, OpenAI, Groq or Anthropic.",
    type: 'bridge_tools_unsupported',
  },
};

describe('callAIWithTools — OpenCode bridge degrades instead of failing', () => {
  /**
   * An agent turn used to complete with `toolCalls: []`. Refusing loudly is
   * better than that, but failing the whole turn is a regression on a path
   * that worked: the user asked a question and must still get an answer.
   */
  it('returns an answer AND a notice rather than throwing', async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      // First round: the bridge refuses the tool-bearing request.
      if (call === 1) return { ok: false, status: 400, json: async () => REFUSAL };
      // Degraded round: a plain text answer.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Here is the answer without tools.' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
      };
    });

    const notices: string[] = [];
    const result = await callAIWithTools({
      provider: 'opencode',
      model: 'opencode/space-bunny-free',
      apiKey: '',
      messages: [{ role: 'user', content: 'what is 2+2?' }],
      modelTools: TOOLS,
      onToolsUnavailable: (n) => notices.push(n),
    });

    expect(result.content).toBe('Here is the answer without tools.');
    expect(result.toolCalls).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('cannot execute Henry\'s tools');
    // The notice names the providers that DO work, so it is actionable.
    expect(notices[0]).toMatch(/Ollama/);
  });

  it('retries the round with no tools attached', async () => {
    stubFetch(() => ({ ok: false, status: 400, json: async () => REFUSAL }));
    await callAIWithTools({
      provider: 'opencode',
      model: 'opencode/space-bunny-free',
      apiKey: '',
      messages: [{ role: 'user', content: 'hi' }],
      modelTools: TOOLS,
    }).catch(() => undefined);
    const retry = JSON.parse(recorded[1].body!);
    expect(retry.tools).toEqual([]);
  });

  it('degrades for opencode-zen on the same bridge', async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      if (call === 1) return { ok: false, status: 400, json: async () => REFUSAL };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'zen answer' } }] }) };
    });
    const notices: string[] = [];
    const result = await callAIWithTools({
      provider: 'opencode-zen',
      model: 'zen/model',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      modelTools: TOOLS,
      onToolsUnavailable: (n) => notices.push(n),
    });
    expect(result.content).toBe('zen answer');
    expect(notices).toHaveLength(1);
  });

  it('still propagates a genuine bridge failure instead of degrading', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({ error: { message: 'opencode crashed' } }) }));
    const notices: string[] = [];
    await expect(
      callAIWithTools({
        provider: 'opencode',
        model: 'm',
        apiKey: '',
        messages: [],
        modelTools: TOOLS,
        onToolsUnavailable: (n) => notices.push(n),
      })
    ).rejects.toThrow('opencode crashed');
    expect(notices).toEqual([]);
  });

  it('sends the tool schema on the first attempt, so the refusal is about tools', async () => {
    stubFetch(() => ({ ok: false, status: 400, json: async () => REFUSAL }));
    await callAIWithTools({
      provider: 'opencode',
      model: 'opencode/space-bunny-free',
      apiKey: '',
      messages: [{ role: 'user', content: 'list files' }],
      modelTools: TOOLS,
    }).catch(() => undefined);
    expect(JSON.parse(recorded[0].body!).tools).toEqual(TOOLS);
    expect(recorded[0].headers?.Authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);
  });

  it('works with no callback supplied — the answer still comes back', async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      if (call === 1) return { ok: false, status: 400, json: async () => REFUSAL };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    });
    const result = await callAIWithTools({
      provider: 'opencode',
      model: 'm',
      apiKey: '',
      messages: [],
      modelTools: TOOLS,
    });
    expect(result.content).toBe('ok');
  });
});
describe('ai:stream agent turn against the bridge — degrades, does not fail', () => {
  /**
   * End-to-end through the real dispatcher and the real ToolRunner: an agent
   * turn with tools enabled on a provider that cannot run them must still
   * produce an answer, carrying the reason.
   */
  it('returns an answer with the reason attached, and no error event', async () => {
    // The bridge refuses only a tool-bearing request, exactly as it does live.
    stubFetch((rec) => {
      const body = JSON.parse(rec.body ?? '{}') as { tools?: unknown[] };
      if ((body.tools ?? []).length > 0) return { ok: false, status: 400, json: async () => REFUSAL };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Blue is a colour.' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
      };
    });

    await invoke('ai:stream', {
      provider: 'opencode',
      model: 'opencode/space-bunny-free',
      apiKey: '',
      messages: [{ role: 'user', content: 'what colour is the sky?' }],
      tools: [{ name: 'henry-agent' }],
      sessionId: 's1',
      channelId: 'c9',
    });

    expect(recorded.length).toBeGreaterThanOrEqual(2);
    expect(sent.filter((s) => s.channel === 'ai:stream:error')).toEqual([]);
    const done = sent.find((s) => s.channel === 'ai:stream:done');
    expect(String(done?.payload.fullText)).toContain('Blue is a colour.');
    expect(String(done?.payload.fullText)).toContain("cannot execute Henry's tools");
    // The chunk and the final text agree, so the notice cannot be dropped by
    // a renderer that replaces the bubble with fullText.
    expect(chunksFor('c9').join('')).toBe(done?.payload.fullText);
  });
});
