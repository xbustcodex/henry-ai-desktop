/**
 * The parser tests use the RAW responses captured from Ollama 0.34.4 on this
 * machine for the same prompt and the same tool schema, so they encode what
 * the models actually send rather than what the documentation promises.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOpenAIToolCalls,
  parseAnthropicContent,
  parseInlineToolCalls,
  parseToolArguments,
} from './toolCalls';

describe('parseToolArguments', () => {
  it('accepts an object (Ollama /api/chat shape)', () => {
    expect(parseToolArguments({ city: 'Paris' })).toEqual({ city: 'Paris' });
  });

  it('accepts a JSON string (OpenAI shape)', () => {
    expect(parseToolArguments('{"city":"Paris"}')).toEqual({ city: 'Paris' });
  });

  it('returns an empty object for malformed JSON rather than throwing', () => {
    expect(parseToolArguments('{"city":')).toEqual({});
    expect(parseToolArguments('[1,2]')).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });
});

describe('parseOpenAIToolCalls', () => {
  it('parses the OpenAI /v1 shape with arguments as a JSON string', () => {
    // Raw: POST 127.0.0.1:11434/v1/chat/completions, model llama3.2:3b
    const raw = [
      {
        id: 'call_qmokcqqk',
        index: 0,
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ];
    expect(parseOpenAIToolCalls(raw)).toEqual([
      { id: 'call_qmokcqqk', name: 'get_weather', arguments: { city: 'Paris' } },
    ]);
  });

  it('parses the Ollama native shape with arguments as an object', () => {
    // Raw: POST 127.0.0.1:11434/api/chat, model llama3.2:3b
    const raw = [{ id: 'call_wjvsxomp', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } }];
    expect(parseOpenAIToolCalls(raw)).toEqual([
      { id: 'call_wjvsxomp', name: 'get_weather', arguments: { city: 'Paris' } },
    ]);
  });

  it('synthesises an id when the provider omits one', () => {
    const [call] = parseOpenAIToolCalls([{ function: { name: 'file_list', arguments: {} } }]);
    expect(call.id).toBeTruthy();
    expect(call.name).toBe('file_list');
  });

  it('skips entries with no name instead of emitting a broken call', () => {
    expect(parseOpenAIToolCalls([{ function: { arguments: '{}' } }, null, 'nope'])).toEqual([]);
  });

  it('returns nothing for a missing field', () => {
    expect(parseOpenAIToolCalls(undefined)).toEqual([]);
  });
});

describe('parseAnthropicContent', () => {
  it('concatenates every text block', () => {
    // Anthropic splits one answer across blocks; reading only the first
    // truncated the reply.
    const raw = [
      { type: 'text', text: 'Checking ' },
      { type: 'text', text: 'two cities.' },
    ];
    expect(parseAnthropicContent(raw).content).toBe('Checking two cities.');
  });

  it('lifts tool_use blocks and keeps the text', () => {
    const raw = [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } },
    ];
    expect(parseAnthropicContent(raw)).toEqual({
      content: 'Let me look.',
      toolCalls: [{ id: 'toolu_01', name: 'get_weather', arguments: { city: 'Paris' } }],
    });
  });

  it('handles several tool_use blocks in one response', () => {
    const raw = [
      { type: 'tool_use', id: 'a', name: 'x', input: {} },
      { type: 'tool_use', id: 'b', name: 'y', input: { n: 1 } },
    ];
    expect(parseAnthropicContent(raw).toolCalls).toHaveLength(2);
  });

  it('returns empty for a missing content field', () => {
    expect(parseAnthropicContent(undefined)).toEqual({ content: '', toolCalls: [] });
  });
});

describe('parseInlineToolCalls', () => {
  it('recovers the qwen2.5-coder:7b shape — a call written as raw text', () => {
    // Raw: POST /v1/chat/completions and /api/chat, model qwen2.5-coder:7b.
    // finish_reason "stop", no tool_calls field, the call is the content:
    const raw = '{"name": "get_weather", "arguments": {"city": "Paris"}}';
    const { content, toolCalls } = parseInlineToolCalls(raw);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('get_weather');
    expect(toolCalls[0].arguments).toEqual({ city: 'Paris' });
    expect(content).toBe('');
  });

  it('recovers the "parameters" spelling qwen used against all 52 tools', () => {
    const raw = '{"name":"file_list","parameters":{"path":"~/Projects"}}';
    const { toolCalls } = parseInlineToolCalls(raw);
    expect(toolCalls).toEqual([
      { id: toolCalls[0].id, name: 'file_list', arguments: { path: '~/Projects' } },
    ]);
  });

  it('lifts a call out of surrounding prose and keeps the prose', () => {
    const raw = 'I will check now. {"name":"file_list","arguments":{"path":"/tmp"}} Done.';
    const { content, toolCalls } = parseInlineToolCalls(raw);
    expect(toolCalls[0].name).toBe('file_list');
    expect(content).toContain('I will check now.');
    expect(content).toContain('Done.');
    expect(content).not.toContain('file_list');
  });

  it('lifts a call out of a fenced json block', () => {
    const raw = '```json\n{"name":"file_list","arguments":{"path":"/tmp"}}\n```';
    const { content, toolCalls } = parseInlineToolCalls(raw);
    expect(toolCalls).toHaveLength(1);
    expect(content).toBe('');
  });

  it('reports one call, not two, when the whole message is one JSON object', () => {
    // The object is found both as the whole message and by the brace scan.
    const raw = '{"name": "get_weather", "arguments": {"city": "Paris"}}';
    expect(parseInlineToolCalls(raw).toolCalls).toHaveLength(1);
  });

  it('lifts several calls from one array', () => {
    const raw = '[{"name":"a","arguments":{}},{"name":"b","arguments":{"n":1}}]';
    expect(parseInlineToolCalls(raw).toolCalls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('leaves ordinary prose untouched', () => {
    const raw = 'Here is a JSON example: {"note":"this is data, not a call"} — hope that helps.';
    const { content, toolCalls } = parseInlineToolCalls(raw);
    expect(toolCalls).toEqual([]);
    expect(content).toBe(raw);
  });

  it('leaves ordinary JSON data untouched when it carries no tool name', () => {
    const raw = '{"temperature":18,"sky":"clear"}';
    expect(parseInlineToolCalls(raw).toolCalls).toEqual([]);
  });

  it('gives each lifted call a distinct id', () => {
    const a = parseInlineToolCalls('{"name":"a","arguments":{}}').toolCalls[0].id;
    const b = parseInlineToolCalls('{"name":"a","arguments":{}}').toolCalls[0].id;
    expect(a).not.toBe(b);
  });

  it('returns the text unchanged when it has no braces', () => {
    expect(parseInlineToolCalls('just words')).toEqual({ content: 'just words', toolCalls: [] });
  });
});