// @vitest-environment jsdom
/**
 * `MediaLibraryPanel.remove` discarded the result of `mediaDelete`.
 *
 * ## Why this is a component test and not a helper test
 *
 * `media:delete` RESOLVES with `{ok:false, error}` on a malformed id, a file
 * that is already gone, or a permissions error — it does not throw. The panel
 * awaited it and reloaded regardless, so a failed delete re-rendered the shelf
 * with the item still listed and said nothing at all. The user sees their file
 * still there and concludes Henry deleted it and put it back.
 *
 * A helper-level test cannot catch that: an extracted `shouldReport(res)`
 * would pass whether or not `remove` ever consults it, and whether or not the
 * panel reloads. This file therefore renders the real component, clicks the
 * real button, and asserts on what the user actually gets — the toast and
 * whether the list is refetched. The fix was verified by reverting it and
 * watching this file fail; see the mutation note in each block.
 *
 * ## Environment
 *
 * The repo's vitest config is `environment: 'node'` and `include` is
 * `*.test.ts`, so neither the runner nor a `.tsx` filename is needed: this file
 * is `.ts`, builds its element tree with `React.createElement`, and overrides
 * the environment per-file with the `@vitest-environment` docblock above.
 * Requires `jsdom`, `@testing-library/react` and `@testing-library/dom` as
 * devDependencies — reported to Main rather than added here, since dependency
 * and install decisions are central.
 *
 * `toast` is the imperative window-event API (`henry:toast`), so the toast is
 * observed on `window` directly. Nothing needs `<ToastHost />` mounted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { MediaItem } from '../../types';

const ITEM: MediaItem = {
  id: 'item-1',
  kind: 'image',
  file_name: 'holiday.png',
  stored_name: 'item-1.png',
  mime_type: 'image/png',
  byte_size: 2048,
  created_at: '2026-01-01 00:00:00',
};

interface DeleteResult { ok: boolean; error?: string }

interface Harness {
  toasts: Array<{ kind: string; message: string }>;
  listCalls: () => number;
  deleteCalls: () => number;
}

let api: Record<string, unknown>;
let harness: Harness;

/**
 * `react-dom`'s `act` environment flag. Without it React 19 warns on every
 * state update and the warnings drown out real failures.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let onToast: (e: Event) => void;
let setDeleteResultRef: (r: DeleteResult) => void;

beforeEach(() => {
  vi.resetModules();
  const list = [ITEM];
  let listCalls = 0;
  let deleteCalls = 0;
  let deleteResult: DeleteResult = { ok: true };

  api = {
    mediaList: vi.fn(() => { listCalls += 1; return Promise.resolve(list); }),
    mediaCounts: vi.fn(() => Promise.resolve({ image: 1, audio: 0, document: 0 })),
    mediaDelete: vi.fn(() => { deleteCalls += 1; return Promise.resolve(deleteResult); }),
    mediaReveal: vi.fn(() => undefined),
    mediaGet: vi.fn(() => Promise.resolve({ ok: true, mimeType: 'image/png', fileName: 'x', dataUrl: 'data:' })),
    mediaOpen: vi.fn(() => Promise.resolve({ ok: true })),
    mediaImport: vi.fn(() => Promise.resolve({ ok: true, imported: [], skipped: [] })),
  };
  (globalThis as unknown as { henryAPI: unknown }).henryAPI = api;

  const toasts: Array<{ kind: string; message: string }> = [];
  onToast = (e: Event) => {
    toasts.push((e as CustomEvent<{ kind: string; message: string }>).detail);
  };
  window.addEventListener('henry:toast', onToast);

  harness = { toasts, listCalls: () => listCalls, deleteCalls: () => deleteCalls };
  setDeleteResultRef = (r: DeleteResult) => { deleteResult = r; };
});

// `cleanup()` is a TOP-LEVEL hook. Registered inside `beforeEach` it ran too
// late to matter, and every test after the first saw the previous test's DOM —
// which surfaced as "Found multiple elements", a failure that looks like a bug in
// the panel rather than in the test. `@testing-library/react`'s own auto-cleanup
// does not cover us either: it registers against a global `afterEach`, and this
// vitest config does not enable `globals`.
afterEach(() => {
  window.removeEventListener('henry:toast', onToast);
  cleanup();
  delete (globalThis as unknown as { henryAPI?: unknown }).henryAPI;
});

async function mountPanel() {
  const { default: MediaLibraryPanel } = await import('./MediaLibraryPanel');
  await act(async () => {
    render(createElement(MediaLibraryPanel));
  });
  // Readiness is signalled by the remove button, one per item — a test that
  // silently clicks nothing is worse than no test at all.
  await waitFor(() => expect(screen.getByTitle('Remove from library')).toBeTruthy());
}

function setDeleteResult(result: DeleteResult): void {
  setDeleteResultRef(result);
}

async function clickRemove() {
  const button = screen.getByTitle('Remove from library');
  await act(async () => {
    button.click();
  });
}

describe('MediaLibraryPanel — removing an item', () => {
  it('reloads the shelf after a successful delete', async () => {
    await mountPanel();
    expect(harness.listCalls()).toBe(1);

    await clickRemove();

    expect(harness.deleteCalls()).toBe(1);
    await waitFor(() => expect(harness.listCalls()).toBe(2));
    expect(harness.toasts.filter((t) => t.kind === 'error')).toHaveLength(0);
  });

  it('surfaces the failure and does NOT pretend the delete worked', async () => {
    // THE regression. `media:delete` resolves `{ok:false}`; the old code
    // discarded that, reloaded, and re-rendered the item still on the shelf
    // with no message. Reverting the fix makes both assertions below fail.
    setDeleteResult({ ok: false, error: 'File not found: holiday.png' });
    await mountPanel();

    await clickRemove();

    await waitFor(() => {
      const errors = harness.toasts.filter((t) => t.kind === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('File not found: holiday.png');
    });
    // No refetch: the shelf is unchanged, and pretending otherwise is what made
    // a failed delete look like it had been applied.
    expect(harness.listCalls()).toBe(1);
  });

  it('falls back to a readable message when the failure carries no error text', async () => {
    setDeleteResult({ ok: false });
    await mountPanel();

    await clickRemove();

    await waitFor(() => {
      const errors = harness.toasts.filter((t) => t.kind === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Could not delete that item.');
    });
    expect(harness.listCalls()).toBe(1);
  });

  it('treats a missing mediaDelete bridge as a failure rather than a success', async () => {
    // `mediaDelete` is optional on the API surface. If it is absent the old code
    // awaited `undefined`, reloaded, and reported nothing.
    delete api.mediaDelete;
    await mountPanel();

    await clickRemove();

    await waitFor(() => {
      expect(harness.toasts.filter((t) => t.kind === 'error')).toHaveLength(1);
    });
    expect(harness.listCalls()).toBe(1);
  });
});