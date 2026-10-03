/**
 * `knowledge:search` — the tenth channel, which had a handler and no bridge.
 *
 * `handlers.ts:136` registered it and preload never mentioned it, so the
 * panel's search box had nothing to call. This file drives the handler the way
 * preload will once the bridge exists: capture it through a stubbed
 * `ipcMain.handle` and invoke it with the exact payload the panel sends.
 *
 * It runs in the node environment on purpose. `VectorStore.query` reads BLOBs
 * through `toFloat32`, whose `instanceof Uint8Array` check fails when
 * `node:sqlite` hands back a typed array from a different realm than jsdom's
 * global — every chunk is silently skipped and search returns nothing. That is
 * a test-environment artifact, not a product bug (the same retrieval is proven
 * in `core.test.ts`), so the retrieval assertions belong here and the panel
 * test asserts the wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

/**
 * Force the hashed fallback so the test never probes a local Ollama. The panel
 * treats that backend as "lexical only" and says so, which is the honest
 * behaviour a user without an embedding model actually gets.
 */
vi.mock('../vector/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vector/embeddings')>();
  return {
    ...actual,
    createEmbedder: () =>
      actual.createEmbedder({
        fetchImpl: (() => Promise.reject(new Error('offline in test'))) as typeof fetch,
        forceFallbackReason: 'no model in test',
      }),
  };
});

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

let db: DatabaseSync;

/** Invoke a captured handler exactly as `ipcRenderer.invoke` would. */
function ask<T>(channel: string, ...args: unknown[]): Promise<Envelope<T>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`${channel} was never registered.`);
  return Promise.resolve(fn({}, ...args)) as Promise<Envelope<T>>;
}

/** The exact payload KnowledgePanel sends for a plain search. */
function panelPayload(query: string, sourceKind?: string, terms: string[] = []) {
  return { query, limit: 10, sourceKind, terms };
}

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  db = new DatabaseSync(':memory:');
  const { registerKnowledgeHandlers } = await import('./handlers');
  registerKnowledgeHandlers(db as never);
});

afterEach(() => {
  db.close();
});

describe('knowledge:search', () => {
  it('returns the chunk that matches, with its score', async () => {
    await ask('knowledge:ingestNote', {
      text: 'The standard refund window is thirty days from delivery.',
      title: 'Refund policy',
      tags: [],
    });

    const res = await ask<{ hits: Array<{ text: string; score: number; title: string }> }>(
      'knowledge:search',
      panelPayload('refund window'),
    );

    expect(res.ok).toBe(true);
    expect(res.result?.hits).toHaveLength(1);
    expect(res.result?.hits[0].text).toContain('thirty days from delivery');
    expect(res.result?.hits[0].title).toBe('Refund policy');
    expect(res.result?.hits[0].score).toBeGreaterThan(0);
  });

  it('reports the fallback backend so the UI can say the search is lexical', async () => {
    await ask('knowledge:ingestNote', { text: 'Some text.', title: 'Doc', tags: [] });
    const res = await ask<{ backend: string; note?: string }>('knowledge:search', panelPayload('text'));

    expect(res.result?.backend).toBe('hashed-fallback');
    expect(res.result?.note).toMatch(/lexical/i);
  });

  it('honours the sourceKind filter the panel sends', async () => {
    await ask('knowledge:ingestNote', { text: 'A note about tolerance.', title: 'Note', tags: [] });

    const notes = await ask<{ hits: unknown[] }>('knowledge:search', panelPayload('tolerance', 'note'));
    const files = await ask<{ hits: unknown[] }>('knowledge:search', panelPayload('tolerance', 'file'));

    expect(notes.result?.hits).toHaveLength(1);
    expect(files.result?.hits).toHaveLength(0);
  });

  it('returns an empty hit list rather than an error when nothing matches', async () => {
    await ask('knowledge:ingestNote', { text: 'Refund window is thirty days.', title: 'Refund', tags: [] });
    const res = await ask<{ hits: unknown[] }>('knowledge:search', panelPayload('zzzznothingmatchesthis'));

    expect(res.ok).toBe(true);
    expect(res.result?.hits).toEqual([]);
  });

  it('never rejects, even on a malformed payload', async () => {
    // The renderer's single `catch` would disable search entirely if a handler
    // rejected, so the envelope is the contract — including for the nonsense
    // payloads a buggy caller can produce.
    for (const payload of [undefined, null, 'a string', 42, { query: { nested: true } }]) {
      const res = await ask<{ hits: unknown[] }>('knowledge:search', payload);
      expect(typeof res.ok).toBe('boolean');
      if (res.ok) expect(Array.isArray(res.result?.hits)).toBe(true);
      else expect(typeof res.error).toBe('string');
    }
  });
});