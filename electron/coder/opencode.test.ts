import { describe, it, expect } from 'vitest';
import { parseOpencodeEventLine } from './opencode';

/**
 * Real `--format json` payloads captured from opencode 1.18.31. These lock the
 * translation into the shared CoderStreamEvent vocabulary, because a silent
 * mismatch would show up as a coder run that "succeeds" with no output.
 */
describe('parseOpencodeEventLine — real opencode events', () => {
  it('emits init from step_start', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { type: 'step-start' } }),
    );
    expect(out).toEqual([{ kind: 'init', sessionId: 'ses_abc' }]);
  });

  it('emits text from a text part', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'PONG' } }),
    );
    expect(out).toEqual([{ kind: 'text', text: 'PONG' }]);
  });

  it('emits a result with cost and session from step_finish', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_abc',
        cost: 0,
        part: { type: 'step-finish', reason: 'stop', tokens: { input: 8121, output: 2 } },
      }),
    );
    expect(out).toEqual([{ kind: 'result', ok: true, sessionId: 'ses_abc', costUsd: 0 }]);
  });

  it('marks a non-stop finish as not ok', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({ part: { type: 'step-finish', reason: 'error' } }),
    );
    expect(out[0]).toMatchObject({ kind: 'result', ok: false });
  });
});

describe('parseOpencodeEventLine — tool activity', () => {
  it('summarises a tool part from its title', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({
        part: { type: 'tool', tool: 'bash', state: { title: 'Run npm test', status: 'completed' } },
      }),
    );
    expect(out).toEqual([{ kind: 'tool', name: 'bash', summary: 'Run npm test' }]);
  });

  it('falls back to the tool input when there is no title', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({
        part: { type: 'tool', tool: 'edit', state: { input: { file_path: '/tmp/a.ts' } } },
      }),
    );
    expect(out[0].kind).toBe('tool');
    expect((out[0] as { summary: string }).summary).toContain('/tmp/a.ts');
  });
});

describe('parseOpencodeEventLine — ignores noise', () => {
  it('returns nothing for blank lines and non-JSON chatter', () => {
    // opencode writes human-readable banners to stderr alongside the NDJSON.
    expect(parseOpencodeEventLine('')).toEqual([]);
    expect(parseOpencodeEventLine('   ')).toEqual([]);
    expect(parseOpencodeEventLine('loading plugins...')).toEqual([]);
    expect(parseOpencodeEventLine('WARN something happened')).toEqual([]);
  });

  it('returns nothing for a truncated JSON object', () => {
    expect(parseOpencodeEventLine('{"type":"text","part":{"type":"tex')).toEqual([]);
  });

  it('returns nothing for an unrecognised part type', () => {
    expect(parseOpencodeEventLine(JSON.stringify({ part: { type: 'reasoning' } }))).toEqual([]);
  });

  it('does not emit a text event for an empty text part', () => {
    expect(parseOpencodeEventLine(JSON.stringify({ part: { type: 'text', text: '' } }))).toEqual([]);
  });
});

describe('parseOpencodeEventLine — errors', () => {
  it('surfaces an error part as a coder error', () => {
    const out = parseOpencodeEventLine(
      JSON.stringify({ part: { type: 'error', error: { message: 'model not found' } } }),
    );
    expect(out).toEqual([{ kind: 'error', message: 'model not found' }]);
  });
});
