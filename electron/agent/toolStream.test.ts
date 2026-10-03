/**
 * The agent loop's streaming channel.
 *
 * The whole point of this file is the constraint Main set: when a model streams
 * a round that ends in a tool call, the tool must STILL EXECUTE, and the text
 * must still arrive. A streaming path that quietly swallows tool calls is worse
 * than no streaming at all, because it looks like it works.
 *
 * The measured reason this matters (from ChatStreaming, live on Ollama): in the
 * streaming tool path BOTH llama3.2:3b and qwen2.5-coder:7b emit the raw tool
 * call as ordinary text deltas. So a streamed round legitimately contains
 * `{"name":"get_weather",...}` in its delta stream. Those deltas are therefore
 * PROVISIONAL: they are forwarded for display and never persisted, and the
 * round's final `content` always wins.
 */

import { describe, it, expect, vi } from 'vitest';
import { runToolConversation } from './toolRunner';
import { ToolRegistry } from './toolRegistry';
import type { CompleteFn, ModelCompletion, RunnerMessage } from './toolRunner';
import type { AgentContext, ToolDefinition, ToolResult } from './types';

vi.mock('../ipc/sessionStore', () => ({
  recordSessionMessage: vi.fn(async () => undefined),
  toolCallBlocks: vi.fn(() => []),
  createSessionRecord: vi.fn(async () => 'sess'),
}));
vi.mock('../ipc/securityPolicy', () => ({ policyFlag: () => false }));

function ctx() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  };
  // The window is a structural stand-in; `unknown` is the honest bridge since
  // a real BrowserWindow has ~170 members this test does not care about.
  return {
    context: { db: {}, getWindow: () => win } as unknown as AgentContext,
    sent,
  };
}

/** A ToolDefinition whose execute is a spy, typed to the real contract. */
function echoTool(data: unknown = '18C'): {
  tool: ToolDefinition;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(
    async (_params: Record<string, unknown>, _context: AgentContext): Promise<ToolResult> => ({
      ok: true,
      data,
    }),
  );
  const tool: ToolDefinition = {
    name: 'get_weather',
    description: 'weather',
    inputSchema: { type: 'object', properties: {} },
    category: 'external',
    safetyLevel: 'silent',
    execute: spy,
  };
  return { tool, spy };
}

const deltasOf = (sent: Array<{ channel: string; payload: unknown }>) =>
  sent.filter((s) => s.channel === 'agent:tool-stream-delta').map((s) => (s.payload as { text: string }).text);

const finalsOf = (sent: Array<{ channel: string; payload: unknown }>) =>
  sent.filter((s) => s.channel === 'agent:tool-stream-final');

describe('streaming channel — text and tools in the same round', () => {
  // The headline case. Round 1 streams prose PLUS a raw tool call as text, then
  // reports the call structurally. Both must survive.
  it('forwards deltas AND still executes the tool', async () => {
    const { tool, spy } = echoTool('18C');
    const reg = new ToolRegistry();
    reg.register(tool);

    const { context, sent } = ctx();
    let round = 0;
    const complete: CompleteFn = vi.fn(async (_m, _t, handlers) => {
      round++;
      if (round === 1) {
        // A real model streams the call as text, split mid-token.
        handlers?.onDelta?.('Sure, ');
        handlers?.onDelta?.('{"name":"get_weather","parameters":{"city":"Paris"}}');
        const c: ModelCompletion = {
          content: 'Sure,',
          toolCalls: [{ id: 't1', name: 'get_weather', arguments: { city: 'Paris' } }],
        };
        return c;
      }
      return { content: 'It is 18C in Paris.', toolCalls: [] };
    });

    const out = await runToolConversation({ registry: reg, context, messages: [], complete });

    // The tool ran — streaming must not cost us the action.
    expect(spy).toHaveBeenCalledTimes(1);
    // The text arrived.
    expect(deltasOf(sent)).toEqual(['Sure, ', '{"name":"get_weather","parameters":{"city":"Paris"}}']);
    // And the final answer is the authoritative one, not the provisional text.
    expect(out.content).toBe('It is 18C in Paris.');
  });

  // The provisional bubble must be CLOSED with the real content on the
  // tool-calling round too, otherwise the raw tool-call JSON stays on screen.
  it('closes the provisional stream with authoritative content on every streamed round', async () => {
    const { tool, spy } = echoTool();
    const reg = new ToolRegistry();
    reg.register(tool);
    const { context, sent } = ctx();
    let round = 0;
    const complete: CompleteFn = vi.fn(async (_m, _t, handlers) => {
      round++;
      handlers?.onDelta?.('chunk ');
      if (round === 1) {
        return { content: 'Let me check.', toolCalls: [{ id: 't1', name: 'get_weather', arguments: {} }] };
      }
      return { content: 'Done.', toolCalls: [] };
    });

    await runToolConversation({ registry: reg, context, messages: [], complete });

    const finals = finalsOf(sent);
    // Two streamed rounds -> two closures, the first carrying "Let me check."
    // (which REPLACES the raw tool JSON the user watched go by).
    expect(finals.length).toBe(2);
    expect((finals[0].payload as { content: string }).content).toBe('Let me check.');
    expect((finals[1].payload as { content: string }).content).toBe('Done.');
  });

  it('sends no stream-final when a round never streamed', async () => {
    const reg = new ToolRegistry();
    const { context, sent } = ctx();
    const complete: CompleteFn = vi.fn(async () => ({ content: 'no deltas here', toolCalls: [] }));
    await runToolConversation({ registry: reg, context, messages: [], complete });
    expect(deltasOf(sent)).toEqual([]);
    expect(finalsOf(sent)).toEqual([]);
  });

  // Deltas are display-only. They must never enter the persisted transcript,
  // or the raw tool-call JSON becomes part of the assistant's message history.
  it('never writes deltas into the message transcript', async () => {
    const { tool, spy } = echoTool();
    const reg = new ToolRegistry();
    reg.register(tool);
    const { context } = ctx();
    let round = 0;
    const seen: RunnerMessage[] = [];
    const complete: CompleteFn = vi.fn(async (messages, _t, handlers) => {
      seen.push(...messages);
      round++;
      handlers?.onDelta?.('RAW_TOOL_CALL_JSON');
      if (round === 1) {
        return { content: 'ok', toolCalls: [{ id: 't1', name: 'get_weather', arguments: {} }] };
      }
      return { content: 'final', toolCalls: [] };
    });

    await runToolConversation({ registry: reg, context, messages: [], complete });
    const transcript = JSON.stringify(seen);
    expect(transcript).not.toContain('RAW_TOOL_CALL_JSON');
  });

  // A caller that passes no handler must behave exactly as before — this is
  // what keeps scheduler.ts and any existing ai.ts call site unchanged.
  it('works unchanged when the provider never calls onDelta', async () => {
    const { tool, spy } = echoTool('x');
    const reg = new ToolRegistry();
    reg.register(tool);
    const { context, sent } = ctx();
    const complete = vi.fn(async () => ({
      content: 'plain',
      toolCalls: [{ id: 't1', name: 'get_weather', arguments: {} }],
    })) as CompleteFn;

    const out = await runToolConversation({ registry: reg, context, messages: [], complete });
    // The loop keeps calling (this fake always requests a tool) and so ends at
    // maxRounds — what matters is that no delta channel fired at all.
    expect(out.rounds).toBe(10);
    expect(sent.map((s) => s.channel)).not.toContain('agent:tool-stream-delta');
  });
});
