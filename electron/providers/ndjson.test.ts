/**
 * The NDJSON reader exists because a per-read `split('\n')` silently dropped
 * tokens. These tests pin the two properties the streaming path depends on:
 * a record split across reads is delivered whole, and a caller never sees a
 * record before its line has actually arrived.
 */
import { describe, it, expect } from 'vitest';
import { readNdjsonStream, parseNdjsonLine, type ByteReader } from './ndjson';

const enc = (s: string) => new TextEncoder().encode(s);

/** A reader over a fixed list of byte chunks, released one read at a time. */
function readerOf(chunks: Uint8Array[]): ByteReader & { released: boolean } {
  let i = 0;
  const r = {
    released: false,
    async read() {
      if (i >= chunks.length) return { done: true as const };
      return { done: false as const, value: chunks[i++] };
    },
    releaseLock() {
      r.released = true;
    },
  };
  return r;
}

async function collect(chunks: Uint8Array[]): Promise<{ records: unknown[]; released: boolean }> {
  const reader = readerOf(chunks);
  const records: unknown[] = [];
  await readNdjsonStream({ body: { getReader: () => reader } }, (r) => records.push(r));
  return { records, released: reader.released };
}

describe('parseNdjsonLine', () => {
  it('parses a record and ignores blank lines', () => {
    expect(parseNdjsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseNdjsonLine('   ')).toBeUndefined();
  });

  it('drops a line that is not valid JSON', () => {
    expect(parseNdjsonLine('{"a":')).toBeUndefined();
  });
});

describe('readNdjsonStream', () => {
  it('delivers every record when each line arrives in its own read', async () => {
    const { records } = await collect([
      enc('{"message":{"content":"He"}}\n'),
      enc('{"message":{"content":"llo"}}\n'),
      enc('{"done":true,"eval_count":2}'),
    ]);
    expect(records).toEqual([
      { message: { content: 'He' } },
      { message: { content: 'llo' } },
      { done: true, eval_count: 2 },
    ]);
  });

  it('reassembles a record split across two reads', async () => {
    // This is the failure the old ollama:chat handler had: both halves fail
    // JSON.parse on their own and both were discarded.
    const { records } = await collect([
      enc('{"message":{"content":"wor'),
      enc('ld"}}\n{"done":true}\n'),
    ]);
    expect(records).toEqual([
      { message: { content: 'world' } },
      { done: true },
    ]);
  });

  it('reassembles a record split mid multi-byte character', async () => {
    const bytes = enc('{"message":{"content":"café"}}\n');
    const { records } = await collect([bytes.slice(0, 20), bytes.slice(20)]);
    expect(records).toEqual([{ message: { content: 'café' } }]);
  });

  it('delivers several records from a single read', async () => {
    const { records } = await collect([enc('{"i":1}\n{"i":2}\n{"i":3}\n')]);
    expect(records).toHaveLength(3);
  });

  it('flushes a final record that has no trailing newline', async () => {
    const { records } = await collect([enc('{"done":true,"eval_count":7}')]);
    expect(records).toEqual([{ done: true, eval_count: 7 }]);
  });

  it('ends cleanly on an empty stream', async () => {
    const { records } = await collect([]);
    expect(records).toEqual([]);
  });

  it('drops only the truncated tail of a stream cut mid-record', async () => {
    const { records } = await collect([enc('{"ok":1}\n{"ok":2'), enc('')]);
    expect(records).toEqual([{ ok: 1 }]);
  });

  it('releases the reader lock even when the handler throws', async () => {
    const reader = readerOf([enc('{"a":1}\n')]);
    await expect(
      readNdjsonStream({ body: { getReader: () => reader } }, () => {
        throw new Error('mid-stream failure');
      })
    ).rejects.toThrow('mid-stream failure');
    expect(reader.released).toBe(true);
  });

  it('throws when the response has no body', async () => {
    await expect(readNdjsonStream({ body: null }, () => {})).rejects.toThrow('No response body');
  });
});