import { describe, it, expect } from 'vitest';
import { messagesToPrompt, extractTextFromEventLines } from './opencodeBridge';

/**
 * The two pure translators in the bridge: the OpenAI-shaped chat request into
 * the single prompt `opencode run` accepts, and the CLI's NDJSON stream back
 * into assistant text. Both run inside the HTTP request path, so a silent
 * mistake shows up as an empty chat bubble rather than a crash.
 */
describe('messagesToPrompt — role labels survive multi-turn context', () => {
  it('labels system and assistant but leaves the user turn bare', () => {
    const prompt = messagesToPrompt([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'again' },
    ]);
    expect(prompt).toBe('[SYSTEM]\nYou are terse.\n\nping\n\n[ASSISTANT]\npong\n\nagain');
  });

  it('treats a message with no role as the user', () => {
    expect(messagesToPrompt([{ content: 'no role here' }])).toBe('no role here');
  });

  it('still produces a prompt from a system-only message list', () => {
    // A system-only turn is legal and must not collapse to an empty prompt,
    // which the CLI would answer with nothing at all.
    const prompt = messagesToPrompt([{ role: 'system', content: 'Answer only in haiku.' }]);
    expect(prompt).toBe('[SYSTEM]\nAnswer only in haiku.');
  });
});

describe('messagesToPrompt — OpenAI content parts', () => {
  it('flattens text parts and drops non-text parts', () => {
    const prompt = messagesToPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this picture?' },
          { type: 'image_url', image_url: { url: 'file:///tmp/a.png' } },
          { type: 'text', text: 'be brief' },
        ],
      },
    ]);
    expect(prompt).toBe('what is in this picture?\nbe brief');
  });

  it('skips a content array whose only parts carry no text', () => {
    expect(messagesToPrompt([{ role: 'user', content: [{ type: 'reasoning' }] }])).toBe('');
  });

  it('skips a non-array, non-string content object', () => {
    // Malformed payloads must not stringify to "[object Object]" in the prompt.
    const bad = { role: 'user', content: { text: 'hi' } } as unknown as { role?: string; content?: unknown };
    expect(messagesToPrompt([bad])).toBe('');
  });
});

describe('messagesToPrompt — empty turns are dropped', () => {
  it('drops absent, empty and whitespace-only content', () => {
    const messages = [
      { role: 'user' as const, content: undefined },
      { role: 'assistant' as const, content: '' },
      { role: 'user' as const, content: '   \n  ' },
      { role: 'user' as const, content: 'real question' },
    ];
    expect(messagesToPrompt(messages)).toBe('real question');
  });

  it('returns an empty string for an empty list', () => {
    expect(messagesToPrompt([])).toBe('');
  });
});

/**
 * Real `opencode run --format json` payloads. The CLI writes human-readable
 * banners alongside the NDJSON, so a line that is not a JSON object is
 * ordinary and must be ignored rather than abort the parse.
 */
describe('extractTextFromEventLines — real opencode events', () => {
  const stdout = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello' } }),
    JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'bash', state: { title: 'Run ls', status: 'completed' } } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: ' world' } }),
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_abc',
      cost: 0,
      part: { type: 'step-finish', reason: 'stop', tokens: { input: 8121, output: 2 } },
    }),
  ].join('\n');

  it('concatenates the text parts and ignores every other part type', () => {
    expect(extractTextFromEventLines(stdout)).toBe('Hello world');
  });

  it('reads a CRLF stream', () => {
    expect(extractTextFromEventLines(stdout.replace(/\n/g, '\r\n'))).toBe('Hello world');
  });
});

describe('extractTextFromEventLines — ignores noise around the NDJSON', () => {
  it('skips blank lines and non-JSON banners', () => {
    const mixed = [
      'loading plugins...',
      '',
      '   ',
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }),
      'WARN rate limit approaching',
      '|  rendered 3 lines  |',
    ].join('\n');
    expect(extractTextFromEventLines(mixed)).toBe('ok');
  });

  it('skips a truncated final line', () => {
    // A killed process leaves half an object on the last line; the text
    // already received must survive it.
    const partial = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'complete answer' } }),
      '{"type":"text","part":{"type":"tex',
    ].join('\n');
    expect(extractTextFromEventLines(partial)).toBe('complete answer');
  });

  it('returns an empty string when there is nothing to read', () => {
    expect(extractTextFromEventLines('')).toBe('');
    expect(extractTextFromEventLines('\n\n  \n')).toBe('');
    expect(extractTextFromEventLines('{"type":"text","part":{"type":"tex')).toBe('');
  });

  it('ignores a JSON line with no part', () => {
    expect(extractTextFromEventLines('{"type":"text"}')).toBe('');
  });
});

describe('extractTextFromEventLines — errors', () => {
  it('throws on an error part carrying a message', () => {
    const stream = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'partial' } }),
      JSON.stringify({ part: { type: 'error', error: { message: 'model not found' } } }),
    ].join('\n');
    expect(() => extractTextFromEventLines(stream)).toThrow('model not found');
  });

  it('throws on a top-level error event and unwraps the nested message', () => {
    // Real failed run: the human-readable text is two levels down AND is
    // itself a JSON string.
    const stream = JSON.stringify({
      type: 'error',
      error: {
        name: 'UnknownError',
        data: {
          message:
            '{"message":"Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded"}',
        },
      },
    });
    expect(() => extractTextFromEventLines(stream)).toThrow(
      'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded',
    );
  });

  it('throws a generic message on an error part with no payload', () => {
    expect(() => extractTextFromEventLines(JSON.stringify({ part: { type: 'error' } }))).toThrow(
      'opencode reported an error',
    );
  });

  it('does not treat an error-shaped line as text', () => {
    // The whole point of throwing: an empty answer must not read as success.
    expect(() => extractTextFromEventLines(JSON.stringify({ error: 'quota exceeded' }))).toThrow(
      'quota exceeded',
    );
  });
});
