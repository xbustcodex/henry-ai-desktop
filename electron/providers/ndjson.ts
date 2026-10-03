/**
 * Incremental NDJSON reader.
 *
 * Ollama's `/api/chat` streams newline-delimited JSON: one JSON object per
 * line, one line per generated token. Two things make a naive reader wrong:
 *
 *  1. TCP reads do not align with line boundaries. A single `reader.read()`
 *     can return half a JSON object, or three and a half of them. Splitting
 *     each read on `\n` and `JSON.parse`-ing the pieces drops every partial
 *     line — which silently loses tokens (the `ollama:chat` handler in
 *     electron/ipc/ollama.ts did exactly this).
 *  2. `TextDecoder` is stateful. A multi-byte character split across two reads
 *     decodes to replacement characters unless `{ stream: true }` is used.
 *
 * This reader carries a leftover buffer between reads and flushes the tail
 * when the stream ends, so a caller only ever sees whole records.
 */

/** Minimal shape of a `fetch` Response body reader, so tests can supply one. */
export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?(): void;
}

export interface NdjsonResponse {
  body: { getReader(): ByteReader } | null;
}


/**
 * Parse one line into a record. Returns `undefined` for blank lines and for
 * malformed JSON — a stream that is cut mid-line ends with a partial record,
 * and dropping it is correct; failing the whole answer would not be.
 */
export function parseNdjsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read `response.body` to completion, invoking `onRecord` once per complete
 * NDJSON line in arrival order.
 */
export async function readNdjsonStream(
  response: NdjsonResponse,
  onRecord: (record: unknown, raw: string) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  const drain = (flush: boolean) => {
    const lines = buffer.split('\n');
    // Mid-read, the last element is the tail of a line that has not finished
    // arriving, so it goes back in the buffer. On flush there is no more data
    // coming and the last element is a complete record.
    const complete = flush ? lines : lines.slice(0, -1);
    if (!flush) buffer = lines[lines.length - 1] ?? '';
    for (const line of complete) {
      const record = parseNdjsonLine(line);
      if (record !== undefined) onRecord(record, line);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        drain(true);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
  } finally {
    reader.releaseLock?.();
  }
}