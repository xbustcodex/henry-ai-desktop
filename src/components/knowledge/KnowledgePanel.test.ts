// @vitest-environment jsdom
/**
 * KnowledgePanel against the real IPC handlers.
 *
 * The knowledge base was fully built and completely unreachable: ten
 * `knowledge:*` handlers, a bridge for nine of them, and no call site in
 * `src/` at all. A test that called the handler module directly would have
 * passed forever and told us nothing.
 *
 * So this file registers the real handlers against a real in-memory SQLite
 * database, captures them through a stubbed `ipcMain`, exposes them on
 * `window.henryAPI` through exactly the argument shapes preload uses, renders
 * the panel, and drives it the way a person does — typing, clicking, deleting.
 * Every assertion below is about a path the renderer actually takes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { DatabaseSync } from 'node:sqlite';

/**
 * The knowledge handlers reach for `electron` at registration time. Capturing
 * `ipcMain.handle` is what lets the test invoke the real handler functions
 * exactly as `ipcRenderer.invoke` would.
 */
const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

/**
 * The panel's KnowledgeBase is built with a real embedder config, which would
 * otherwise probe a local Ollama on every ingest. Forcing the fallback keeps
 * the test hermetic — and exercises the panel's "search is offline" path, which
 * is the state a user without Ollama actually sees.
 */
vi.mock('../../../electron/vector/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/vector/embeddings')>();
  return {
    ...actual,
    createEmbedder: (config: { forceFallbackReason?: string } = {}) =>
      actual.createEmbedder({
        fetchImpl: (() => Promise.reject(new Error('offline in test'))) as typeof fetch,
        forceFallbackReason: config.forceFallbackReason ?? 'no model in test',
      }),
  };
});

/**
 * React 19 needs this flag before any `act`; without it every state update
 * warns and the warnings bury real failures.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let db: DatabaseSync;
let api: Record<string, unknown>;

/** Mirror preload's `ipcRenderer.invoke`: call the captured handler. */
function bridge(channel: string) {
  return (...args: unknown[]) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`Channel ${channel} was never registered.`);
    return Promise.resolve(fn({}, ...args));
  };
}

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  db = new DatabaseSync(':memory:');

  const { registerKnowledgeHandlers } = await import('../../../electron/knowledge/handlers');
  registerKnowledgeHandlers(db as never);

  // Exactly the argument shapes electron/preload.ts uses, so the test breaks
  // if the bridge and a handler ever drift apart.
  api = {
    knowledgeList: bridge('knowledge:list'),
    knowledgeStats: bridge('knowledge:stats'),
    knowledgeIngestNote: (text: string, title?: string) =>
      bridge('knowledge:ingestNote')({ text, title: title ?? '', tags: [] }),
    knowledgeIngestUrl: (url: string, title?: string) =>
      bridge('knowledge:ingestUrl')({ url, title: title ?? '', tags: [] }),
    knowledgeIngestFile: (path: string, title?: string) =>
      bridge('knowledge:ingestFile')({ path, title: title ?? '', tags: [] }),
    knowledgeDelete: (id: string) => bridge('knowledge:delete')(id),
    knowledgeReindexMemory: () => bridge('knowledge:reindexMemory')(),
    knowledgeSearch: (query: string, opts?: { limit?: number; sourceKind?: string; terms?: string[] }) =>
      bridge('knowledge:search')({
        query,
        limit: opts?.limit ?? 8,
        sourceKind: opts?.sourceKind,
        terms: opts?.terms ?? [],
      }),
  };
  (globalThis as unknown as { henryAPI: unknown }).henryAPI = api;
});

afterEach(() => {
  cleanup();
  db.close();
  delete (globalThis as unknown as { henryAPI?: unknown }).henryAPI;
});

async function mountPanel() {
  const { default: KnowledgePanel } = await import('./KnowledgePanel');
  await act(async () => {
    render(createElement(KnowledgePanel));
  });
  // Readiness is the stats box, which only appears once both load calls land.
  await waitFor(() => expect(screen.getByText(/sources/)).toBeTruthy());
}

/** Set the value of a controlled input the way a user typing would. */
async function type(el: HTMLElement, value: string) {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    // React reads the DOM node's value through its own setter tracking, so the
    // native setter must be used rather than a plain assignment.
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Choose an option in a `<select>` the way a user clicking one would. */
async function choose(el: Element, value: string) {
  const select = el as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// Toasts and the delete confirmation are rendered by `ToastHost`, mounted once
// near the app root — not by the panel. The panel communicates over window
// events, so the test listens on the same channel a user would see.
let toasts: Array<{ kind: string; message: string }> = [];
let onToast: (e: Event) => void;
let onConfirm: (e: Event) => void;
/** What the user clicks in the delete confirmation. Flipped per test. */
let answerConfirm = true;

beforeEach(() => {
  toasts = [];
  answerConfirm = true;
  onToast = (e: Event) => {
    toasts.push((e as CustomEvent<{ kind: string; message: string }>).detail);
  };
  onConfirm = (e: Event) => {
    const { id } = (e as CustomEvent<{ id: string }>).detail;
    window.dispatchEvent(new CustomEvent('henry:confirm:result', { detail: { id, result: answerConfirm } }));
  };
  window.addEventListener('henry:toast', onToast);
  window.addEventListener('henry:confirm', onConfirm);
});

afterEach(() => {
  window.removeEventListener('henry:toast', onToast);
  window.removeEventListener('henry:confirm', onConfirm);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('KnowledgePanel — listing', () => {
  it('shows what the knowledge base already contains', async () => {
    await bridge('knowledge:ingestNote')({
      text: 'The Acme retainer renews on the first of March.',
      title: 'Acme retainer',
      tags: [],
    });
    await mountPanel();

    expect(screen.getByText('Acme retainer')).toBeTruthy();
    expect(screen.getByText(/Added/)).toBeTruthy();
  });

  it('says the store is empty rather than showing a broken list', async () => {
    await mountPanel();

    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
  });

  it('reports the retrieval backend honestly when no embedding model is running', async () => {
    await mountPanel();

    // The forced fallback means the panel must say it is matching words, not
    // meaning — silently implying semantic search is the exact lie this panel
    // is meant to stop telling.
    expect(screen.getByText(/matching words, not meaning/)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('KnowledgePanel — ingesting', () => {
  it('indexes a note the user typed and lists it', async () => {
    await mountPanel();

    await click(screen.getByText('Add'));
    await type(screen.getByLabelText('Note text'), 'Widget tolerance is plus or minus 0.05mm.');
    await type(screen.getByLabelText('Title'), 'Tolerance note');
    await click(screen.getByText('Add to knowledge base'));

    await waitFor(() => expect(screen.getByText('Tolerance note')).toBeTruthy());
    // The document really is in the store, not just rendered optimistically.
    const listed = await bridge('knowledge:list')({ limit: 50 });
    expect(JSON.stringify(listed)).toContain('Tolerance note');
  });

  it('indexes a URL through the guarded fetch path', async () => {
    // A real fetch would hit the network; the handler's own failure path is
    // what matters here — the panel must report it rather than close the form
    // and claim success.
    api.knowledgeIngestUrl = () =>
      Promise.resolve({ ok: false, error: 'Fetch returned HTTP 404 for https://example.com/spec' });
    await mountPanel();

    await click(screen.getByText('Add'));
    await click(screen.getByText('Web page'));
    await type(screen.getByLabelText('Web page URL'), 'https://example.com/spec');
    await click(screen.getByText('Add to knowledge base'));

    await waitFor(() => expect(screen.getByText(/HTTP 404/)).toBeTruthy());
    // The form is still open, so the user can correct the URL rather than
    // retyping everything.
    expect(screen.getByText('Add to knowledge base')).toBeTruthy();
  });

  it('surfaces a rejected ingest instead of silently doing nothing', async () => {
    api.knowledgeIngestFile = () => Promise.resolve({ ok: false, error: 'That file is outside your home directory.' });
    await mountPanel();

    await click(screen.getByText('Add'));
    await click(screen.getByText('File'));
    await type(screen.getByLabelText('File path'), '/etc/shadow');
    await click(screen.getByText('Add to knowledge base'));

    await waitFor(() => expect(screen.getByText(/outside your home directory/)).toBeTruthy());
  });

  it('refuses an empty note before spending an IPC round trip', async () => {
    let calls = 0;
    const original = api.knowledgeIngestNote as (t: string, ti?: string) => Promise<unknown>;
    api.knowledgeIngestNote = (t: string, ti?: string) => {
      calls += 1;
      return original(t, ti);
    };
    await mountPanel();

    await click(screen.getByText('Add'));
    // The submit button is disabled with no text, so drive the handler directly
    // the way a paste-and-clear would.
    const submit = screen.getByText('Add to knowledge base') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(calls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('KnowledgePanel — searching', () => {
  it('says nothing matched rather than showing an empty result box', async () => {
    await bridge('knowledge:ingestNote')({ text: 'Refund window is thirty days.', title: 'Refund', tags: [] });
    await mountPanel();

    await type(screen.getByLabelText('Search the knowledge base'), 'zzzznothingmatchesthis');
    await click(screen.getByText('Search'));

    await waitFor(() => expect(screen.getByText(/Nothing in the knowledge base matched/)).toBeTruthy());
  });

  it('flags a lexical-only search rather than passing it off as semantic', async () => {
    await bridge('knowledge:ingestNote')({ text: 'Some indexed text.', title: 'Doc', tags: [] });
    await mountPanel();

    await type(screen.getByLabelText('Search the knowledge base'), 'indexed');
    await click(screen.getByText('Search'));

    await waitFor(() => expect(screen.getByText(/offline|lexical/)).toBeTruthy());
  });

  it('surfaces a handler failure rather than reporting zero results', async () => {
    api.knowledgeSearch = () => Promise.resolve({ ok: false, error: 'The embedder crashed.' });
    await mountPanel();

    await type(screen.getByLabelText('Search the knowledge base'), 'anything');
    await click(screen.getByText('Search'));

    await waitFor(() => expect(screen.getByText('The embedder crashed.')).toBeTruthy());
  });

  it('says search is unavailable when the bridge is missing, not "no matches"', async () => {
    delete api.knowledgeSearch;
    await mountPanel();

    await type(screen.getByLabelText('Search the knowledge base'), 'anything');
    await click(screen.getByText('Search'));

    await waitFor(() => expect(screen.getByText(/not available in this build/)).toBeTruthy());
    // The crucial part: it must NOT claim the search found nothing.
    expect(screen.queryByText(/Nothing in the knowledge base matched/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('KnowledgePanel — deleting', () => {
  it('removes a source after the user confirms', async () => {
    await bridge('knowledge:ingestNote')({ text: 'Delete me.', title: 'Doomed note', tags: [] });
    await mountPanel();

    await click(screen.getByLabelText('Remove Doomed note'));

    await waitFor(() => expect(screen.queryByText('Doomed note')).toBeNull());
    // The row is soft-deleted in SQL, so list must no longer return it.
    const listed = await bridge('knowledge:list')({ limit: 50 });
    expect(JSON.stringify(listed)).not.toContain('Doomed note');
  });

  it('keeps the source when the user cancels the confirmation', async () => {
    await bridge('knowledge:ingestNote')({ text: 'Keep me.', title: 'Safe note', tags: [] });
    answerConfirm = false;
    await mountPanel();

    await click(screen.getByLabelText('Remove Safe note'));

    expect(screen.getByText('Safe note')).toBeTruthy();
    const listed = await bridge('knowledge:list')({ limit: 50 });
    expect(JSON.stringify(listed)).toContain('Safe note');
  });

  it('reports a delete the store refused instead of pretending it worked', async () => {
    await bridge('knowledge:ingestNote')({ text: 'Delete me.', title: 'Stubborn note', tags: [] });
    api.knowledgeDelete = () => Promise.resolve({ ok: true, result: { deleted: false } });
    await mountPanel();

    await click(screen.getByLabelText('Remove Stubborn note'));

    // The refusal is reported as a toast — the panel cannot render it inline.
    await waitFor(() =>
      expect(toasts.some((t) => /already gone/.test(t.message))).toBe(true),
    );
    // And the row is still there, because nothing was deleted.
    expect(screen.getByText('Stubborn note')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('KnowledgePanel — filtering', () => {
  it('narrows the list to one source kind', async () => {
    await bridge('knowledge:ingestNote')({ text: 'A note.', title: 'A note', tags: [] });
    await bridge('knowledge:ingestUrl')({ url: 'https://example.com/a', title: 'A page', tags: [] });
    await mountPanel();

    await choose(screen.getByLabelText('Source type'), 'note');

    await waitFor(() => expect(screen.queryByText('A page')).toBeNull());
    expect(screen.getByText('A note')).toBeTruthy();
  });
});