/**
 * Embedder failure handling — the acceptance test for F3.
 *
 * The defect this guards against: a single transient error (one 500, one
 * timeout) latching the embedder into the offline fallback for the life of the
 * process. That silently changes the embedding space from 768 real dimensions
 * to 256 hashed ones, persists hashed vectors beside genuine ones, and makes
 * recall compare fallback-vs-fallback — which looks like a working feature and
 * is close to meaningless.
 *
 * So: transient failures must recover. Only genuinely permanent conditions
 * (model not pulled, port closed) may latch.
 */

import { describe, it, expect, vi } from 'vitest';
import { createEmbedder, hashedEmbedding, parseOllamaEmbedding, FALLBACK_DIMENSIONS, DEFAULT_EMBED_MODEL } from './embeddings';

/** A stand-in for a real 768-dimension embedding model. */
const REAL_DIM = 768;
const realVector = Array.from({ length: REAL_DIM }, (_, i) => Math.sin(i) * 0.1);

function ollamaOk(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embedding: realVector }),
    headers: new Headers(),
  } as unknown as Response;
}

function ollamaStatus(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    headers: new Headers(),
  } as unknown as Response;
}

describe('embedder — a transient 500 must NOT permanently downgrade', () => {
  it('recovers on the very next call after one HTTP 500', async () => {
    // `embed()` tries /api/embed then falls through to /api/embeddings, so
    // BOTH must fail for this call to be genuinely degraded.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ollamaStatus(500))
      .mockResolvedValueOnce(ollamaStatus(500))
      .mockResolvedValue(ollamaOk());

    // cooldownMs: 0 — recovery must happen on the next call, not after 30s.
    const embedder = createEmbedder({ fetchImpl, model: 'nomic-embed-text', cooldownMs: 0 });

    // First call: the server is having a moment, so we get a fallback vector.
    const degraded = await embedder.embed('archived projects are purged after ninety days');
    expect(degraded.length).toBe(FALLBACK_DIMENSIONS);
    expect(embedder.status().backend).toBe('hashed-fallback');
    expect(embedder.status().reason).toMatch(/500/);

    // The server recovers. The next call MUST get a real embedding — this is
    // the assertion that fails when a transient failure latches permanently.
    const recovered = await embedder.embed('archived projects are purged after ninety days');
    expect(recovered.length).toBe(REAL_DIM);
    expect(embedder.status().backend).toBe('ollama');
  });

  it('does not silently mix dimensions across a recovery', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ollamaStatus(503))
      .mockResolvedValueOnce(ollamaStatus(503))
      .mockResolvedValue(ollamaOk());

    const embedder = createEmbedder({ fetchImpl, cooldownMs: 0 });
    const first = await embedder.embed('a document about retention policy');
    const second = await embedder.embed('a document about retention policy');

    // Same text, two different spaces — exactly the corruption this guards.
    expect(first.length).not.toBe(second.length);
    expect(second.length).toBe(REAL_DIM);
  });
});

describe('embedder — a timeout must NOT permanently downgrade', () => {
  it('recovers after a timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockResolvedValue(ollamaOk());

    const embedder = createEmbedder({ fetchImpl, timeoutMs: 50, cooldownMs: 0 });
    expect((await embedder.embed('first')).length).toBe(FALLBACK_DIMENSIONS);
    expect(embedder.status().backend).toBe('hashed-fallback');

    const recovered = await embedder.embed('second');
    expect(recovered.length).toBe(REAL_DIM);
    expect(embedder.status().backend).toBe('ollama');
  });
});

describe('embedder — permanent conditions DO latch', () => {
  it('stops probing after a 404, because the model is not pulled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ollamaStatus(404));
    const embedder = createEmbedder({ fetchImpl });

    await embedder.embed('anything');
    const callsAfterFirst = fetchImpl.mock.calls.length;
    await embedder.embed('anything else');

    // No further network attempts: retrying a missing model cannot help.
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    expect(embedder.status().reason).toMatch(/404/);
  });

  it('stops probing once the connection is refused', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(refused);
    const embedder = createEmbedder({ fetchImpl });

    await embedder.embed('anything');
    const callsAfterFirst = fetchImpl.mock.calls.length;
    await embedder.embed('again');

    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('embedder — provenance is always reported', () => {
  it('reports the fallback for an empty input rather than claiming ollama', async () => {
    // `embed('')` returns a hashed vector. If status still said `ollama`, a
    // caller could not tell real vectors from fallback ones.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ollamaOk());
    const embedder = createEmbedder({ fetchImpl });

    const empty = await embedder.embed('   ');
    expect(empty.length).toBe(FALLBACK_DIMENSIONS);
    expect(embedder.status().backend).toBe('hashed-fallback');
  });

  it('reports the live backend and model', async () => {
    const embedder = createEmbedder({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(ollamaOk()),
      model: 'mxbai-embed-large',
    });
    await embedder.embed('some text');
    expect(embedder.status().backend).toBe('ollama');
    expect(embedder.status().model).toBe('mxbai-embed-large');
    expect(embedder.status().dimensions).toBe(REAL_DIM);
  });
});

describe('embedder — model is configurable and defaults sanely', () => {
  it('uses the configured model in the request body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ollamaOk());
    await createEmbedder({ fetchImpl, model: 'nomic-embed-text' }).embed('hello');
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as { model: string };
    expect(body.model).toBe('nomic-embed-text');
  });

  it('defaults to a known embedding model', () => {
    expect(DEFAULT_EMBED_MODEL).toBe('nomic-embed-text');
  });

  it('tries /api/embed before the legacy endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ollamaOk());
    await createEmbedder({ fetchImpl }).embed('hello');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/embed');
  });

  it('falls back to /api/embeddings for an older Ollama', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ollamaStatus(404)) // modern endpoint absent
      .mockResolvedValue(ollamaOk());
    const vector = await createEmbedder({ fetchImpl }).embed('hello');
    expect(vector.length).toBe(REAL_DIM);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toContain('http://127.0.0.1:11434/api/embeddings');
  });
});

describe('parseOllamaEmbedding — response shapes', () => {
  it('reads the batch shape', () => {
    expect(parseOllamaEmbedding({ embeddings: [realVector] })?.length).toBe(REAL_DIM);
  });
  it('reads the single shape', () => {
    expect(parseOllamaEmbedding({ embedding: realVector })?.length).toBe(REAL_DIM);
  });
  it('returns null for junk rather than a partial vector', () => {
    expect(parseOllamaEmbedding(null)).toBeNull();
    expect(parseOllamaEmbedding({})).toBeNull();
    expect(parseOllamaEmbedding({ embedding: [] })).toBeNull();
    expect(parseOllamaEmbedding({ embedding: [1, 'x', 3] })).toBeNull();
  });
});

describe('hashedEmbedding — determinism and normalisation', () => {
  it('is deterministic across calls, so persisted vectors stay comparable', () => {
    const a = hashedEmbedding('the vendor sla promises four hour response');
    const b = hashedEmbedding('the vendor sla promises four hour response');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('is unit length, so cosine is a dot product', () => {
    const v = hashedEmbedding('archived projects purged after ninety days');
    let sum = 0;
    for (const n of v) sum += n * n;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 5);
  });

  it('scores identical text at 1 and unrelated text below it', () => {
    const a = hashedEmbedding('archived projects purged after ninety days');
    const same = hashedEmbedding('archived projects purged after ninety days');
    const other = hashedEmbedding('sourdough starter hydration schedule');
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * same[i];
    expect(dot).toBeCloseTo(1, 5);

    let cross = 0;
    for (let i = 0; i < a.length; i++) cross += a[i] * other[i];
    expect(cross).toBeLessThan(dot);
  });

  it('still produces a usable vector when every word is a stopword', () => {
    // Deliberate: an all-stopword input falls back to the UNFILTERED tokens
    // rather than embedding to all zeros, because a zero vector matches
    // nothing and would silently make such a chunk unretrievable.
    const v = hashedEmbedding('the of and to');
    expect(v.some((n) => n !== 0)).toBe(true);
  });

  it('returns zeros only for genuinely empty input', () => {
    expect(hashedEmbedding('').every((n) => n === 0)).toBe(true);
    expect(hashedEmbedding('   ').every((n) => n === 0)).toBe(true);
  });
});
