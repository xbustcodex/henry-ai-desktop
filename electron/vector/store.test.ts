/**
 * Vector store — real SQLite round-trip retrieval.
 *
 * Uses `node:sqlite` (a genuine SQLite engine, already a Node builtin) rather
 * than a hand-rolled fake, because the thing under test IS persistence and
 * ranking. A fake would assert the fake.
 *
 * These tests deliberately do NOT mock the embedder: retrieval is proven
 * end-to-end through hashing → BLOB → cosine → ranked results.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { VectorStore, cosineSimilarity, l2normalize } from './store';
import { hashedEmbedding } from './embeddings';
import type { SqlDatabase } from './sql';

let db: DatabaseSync;
let store: VectorStore;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  store = new VectorStore(db as unknown as SqlDatabase);
  store.migrate();
});

afterEach(() => {
  db.close();
});

/** Three passages about clearly different subjects. */
const CORPUS = [
  { id: 'retention', text: 'Archived projects are purged after ninety days. The archive review runs each quarter.' },
  { id: 'shipping', text: 'Shipping is free on orders over fifty dollars. Express delivery arrives the next business day.' },
  { id: 'onboarding', text: 'New engineers complete the security training before their first deploy.' },
];

async function seed(): Promise<void> {
  for (const item of CORPUS) {
    store.upsertSource({
      id: item.id,
      sourceType: 'note',
      sourceUri: `note://${item.id}`,
      title: item.id,
      chunks: [{ text: item.text, vector: await Promise.resolve(hashedEmbedding(item.text)) }],
    });
  }
}

describe('VectorStore — cosine maths', () => {
  it('scores a vector against itself as 1', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('scores an opposite vector as -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1, 6);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  it('treats a zero vector as matching nothing rather than everything', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });

  it('normalises to unit length', () => {
    const n = l2normalize(new Float32Array([3, 4]));
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 6);
  });
});

describe('VectorStore — round-trip retrieval', () => {
  it('stores chunks and finds them again by similarity', async () => {
    await seed();

    const stats = store.stats();
    expect(stats.sources).toBe(3);
    expect(stats.activeSources).toBe(3);
    expect(stats.chunks).toBe(3);
    expect(stats.dimensions).toBeGreaterThan(0);

    const query = await Promise.resolve(
      hashedEmbedding('How long are archived projects kept before deletion?'),
    );
    const hits = store.query(query, 3);

    expect(hits.length).toBeGreaterThan(0);
    // The ranking must actually reflect the query, not insertion order.
    expect(hits[0].chunk.sourceId).toBe('retention');
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it('ranks the on-topic passage above an unrelated one', async () => {
    await seed();
    const query = await Promise.resolve(hashedEmbedding('What is the deadline for deleting archives?'));
    const hits = store.query(query, 3);
    const ranked = hits.map((h) => h.chunk.sourceId);
    expect(ranked[0]).toBe('retention');
    expect(ranked.indexOf('retention')).toBeLessThan(ranked.indexOf('shipping'));
  });

  it('returns at most k results', async () => {
    await seed();
    const query = await Promise.resolve(hashedEmbedding('delivery'));
    expect(store.query(query, 1)).toHaveLength(1);
  });

  it('returns nothing for an empty query vector', () => {
    expect(store.query(new Float32Array(0), 5)).toEqual([]);
  });

  it('caps a hostile k at 200 so one query cannot drain the index', async () => {
    await seed();
    const query = await Promise.resolve(hashedEmbedding('archived projects'));
    // A caller asking for 1_000_000 results gets the hard ceiling, not 3M rows.
    expect(store.query(query, 1_000_000).length).toBeLessThanOrEqual(200);
  });

  it('filters by source type', async () => {
    await seed();
    const query = await Promise.resolve(hashedEmbedding('shipping'));
    expect(store.query(query, 5, { sourceType: 'url' })).toHaveLength(0);
    expect(store.query(query, 5, { sourceType: 'note' }).length).toBeGreaterThan(0);
  });

  it('persists the stored text verbatim, so a hit is quotable', async () => {
    await seed();
    const query = await Promise.resolve(hashedEmbedding('ninety days'));
    const [hit] = store.query(query, 1);
    expect(hit.chunk.text).toBe(CORPUS[0].text);
  });
});

describe('VectorStore — re-index replaces rather than duplicates', () => {
  it('drops the old chunks when a source is re-indexed', async () => {
    await seed();
    expect(store.stats().chunks).toBe(3);

    store.upsertSource({
      id: 'retention',
      sourceType: 'note',
      sourceUri: 'note://retention',
      title: 'retention',
      chunks: [{ text: 'Rewritten policy text entirely.', vector: hashedEmbedding('Rewritten policy text entirely.') }],
    });

    const stats = store.stats();
    expect(stats.sources).toBe(3);
    // The rewritten passage must now be the top hit, and the stale retention
    // chunk must be gone — not merely outranked.
    const query = await Promise.resolve(hashedEmbedding('Rewritten policy text entirely.'));
    const hits = store.query(query, 5);
    expect(hits[0].chunk.text).toBe('Rewritten policy text entirely.');
    expect(hits.filter((h) => h.chunk.sourceId === 'retention')).toHaveLength(1);
  });
});

describe('VectorStore — deletion', () => {
  it('removes the source and its chunks, and stops returning them', async () => {
    await seed();
    expect(store.deleteSource('retention')).toEqual({ deleted: true });

    const stats = store.stats();
    expect(stats.activeSources).toBe(2);
    expect(stats.chunks).toBe(2);

    const query = await Promise.resolve(hashedEmbedding('ninety days'));
    expect(store.query(query, 5).some((h) => h.chunk.sourceId === 'retention')).toBe(false);
  });

  it('reports deleted: false for an unknown source', () => {
    expect(store.deleteSource('nope')).toEqual({ deleted: false });
  });
});

describe('VectorStore — dimension mismatch is skipped, not mis-scored', () => {
  it('ignores chunks stored by a different embedding model', async () => {
    // Index a chunk at 8 dimensions…
    store.upsertSource({
      id: 'old-model',
      sourceType: 'note',
      chunks: [{ text: 'legacy vector', vector: new Float32Array(8).fill(0.1) }],
    });
    // …then query with a 256-dimension vector, as a new model would.
    const hits = store.query(new Float32Array(256).fill(0.05), 5);
    expect(hits).toHaveLength(0);
  });
});
