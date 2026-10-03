/**
 * The storage-root confinement `media:delete` and `media:get` rely on.
 *
 * ## What the real risk is, and why "assert userData is X" is not the test
 *
 * Both channels resolve a database-supplied `stored_name` to a path under
 * `app.getPath('userData')/<sub>` and then read or unlink it. The confinement is
 * therefore entirely `resolveStoredPath`'s, and asserting that
 * `app.getPath('userData')` returns a particular string would pin nothing that
 * can break: nobody can change that string by accident at runtime.
 *
 * The thing that CAN break is whether `stored_name` can escape the storage root,
 * and there is a genuine sharp edge there. The allow-list regex
 * `/^[A-Za-z0-9._-]+$/` **matches `..`** — dots are inside the character class —
 * so the separate `storedName.includes('..')` check is the ONLY thing stopping
 * `..` from resolving to the parent of the media directory. `/` is not in the
 * class, which limits the damage to a single level, but one level is enough to
 * unlink a sibling of the storage root. Delete that clause and `media:delete`
 * unlinks whatever sits beside `media/`.
 *
 * So this file drives the real handlers with hostile `stored_name` values. The
 * refusal tests only mean something because the last test proves that a
 * legitimate name really is unlinked — without it, every assertion above would
 * also pass against a handler that never deleted anything at all.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Stands in for `app.getPath('userData')`. */
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-userdata-'));
const MEDIA_DIR = path.join(USER_DATA, 'media');
/** The sibling an escaped `..` would reach. */
const SIBLING = path.join(USER_DATA, 'sibling-secret.txt');

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, fn: Handler) => { handlers.set(c, fn); } },
  app: { getPath: () => USER_DATA },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const { registerMediaLibraryHandlers } = await import('./mediaLibrary');

/** One row, whose `stored_name` each test chooses. */
let row: { stored_name: string } | undefined;

const fakeDb = {
  exec: () => undefined,
  prepare: () => ({
    get: () => row,
    run: () => ({ changes: 1 }),
    all: () => [],
  }),
};

function call(channel: string, id: string): Promise<Record<string, unknown>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  return Promise.resolve(fn({}, id) as Record<string, unknown>);
}

beforeEach(() => {
  handlers.clear();
  row = undefined;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(SIBLING, 'this must survive');
  registerMediaLibraryHandlers(fakeDb as never, () => null);
});

afterAll(() => {
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── The proof that deletion really happens ───────────────────────────────────

describe('a legitimate stored_name is really deleted', () => {
  it('unlinks the file from inside the media directory', async () => {
    const file = path.join(MEDIA_DIR, 'item-1.png');
    fs.writeFileSync(file, 'png');
    row = { stored_name: 'item-1.png' };

    const r = await call('media:delete', 'item-1');

    // Without this, every refusal test below would also pass against a handler
    // that never unlinks anything — including one that had been broken into
    // refusing everything.
    expect(r.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // And it really was the file inside media/, not the whole directory.
    expect(fs.existsSync(MEDIA_DIR)).toBe(true);
    expect(fs.existsSync(SIBLING)).toBe(true);
  });
});

// ── The confinement ─────────────────────────────────────────────────────────

describe('a stored_name cannot escape the media directory', () => {
  const HOSTILE = [
    ['the parent directory', '..'],
    ['the current directory', '.'],
    ['a separator', '../sibling-secret.txt'],
    ['an absolute path', '/etc/hosts'],
    ['a nested escape', '..\\..\\etc'],
    ['a leading-dot name that is not traversal', '..hidden.png'],
  ] as Array<[string, string]>;

  for (const [label, storedName] of HOSTILE) {
    it(`refuses ${label} (${JSON.stringify(storedName)}) on delete`, async () => {
      row = { stored_name: storedName };
      const r = await call('media:delete', 'item-1');

      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
      // The sibling is what an escape would reach. It must still be there.
      expect(fs.existsSync(SIBLING)).toBe(true);
      expect(fs.existsSync(USER_DATA)).toBe(true);
    });
  }

  it('refuses the parent directory on read as well as delete', async () => {
    // `media:get` resolves the same name and READS it, so the same escape would
    // hand back the contents of a file outside the library.
    row = { stored_name: '..' };
    const r = await call('media:get', 'item-1');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('refuses a separator on read too', async () => {
    row = { stored_name: '../sibling-secret.txt' };
    const r = await call('media:get', 'item-1');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('does not delete anything when the row is already gone', async () => {
    // No row means no `stored_name` to resolve, so there is nothing to unlink —
    // and a missing library entry is not a reason to touch the filesystem.
    row = undefined;
    const r = await call('media:delete', 'item-1');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(SIBLING)).toBe(true);
  });
});

// ── The clause this whole file exists to pin ────────────────────────────────

describe('the `..` clause is load-bearing, not redundant', () => {
  it('the allow-list regex on its own would admit `..`', () => {
    // This is the trap: `.` is inside `[A-Za-z0-9._-]`, so the regex alone does
    // NOT reject `..`. Stated as an assertion about the regex so that deleting
    // the `includes('..')` clause from mediaLibrary.ts cannot be justified by
    // "the pattern already covers it".
    expect(/^[A-Za-z0-9._-]+$/.test('..')).toBe(true);
    expect(/^[A-Za-z0-9._-]+$/.test('.')).toBe(true);
    // What the regex genuinely does block is anything with a separator, which
    // is why the damage from a missing `..` check is limited to one level.
    expect(/^[A-Za-z0-9._-]+$/.test('../x')).toBe(false);
    expect(/^[A-Za-z0-9._-]+$/.test('a/b')).toBe(false);
  });

  it('so `..` is refused by the separate clause, not by the pattern', async () => {
    row = { stored_name: '..' };
    const r = await call('media:delete', 'item-1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid media reference/i);
    expect(fs.existsSync(USER_DATA)).toBe(true);
  });
});