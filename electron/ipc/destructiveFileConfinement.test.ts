/**
 * The confinement guarantee for the destructive file channels.
 *
 * `computer:fileDelete`, `computer:fileMove` and `computer:fileRename` are the
 * only filesystem operations in the app that destroy data at a path the
 * RENDERER names. This suite is the regression net for the property that makes
 * them safe: every one of them refuses any target outside the user's home
 * directory, and no combination of flags — `confirmed`, `permanent`,
 * `recursive` — buys a way around it.
 *
 * ## Why this drives the real handlers
 *
 * These channels are reachable from the renderer only through preload's generic
 * `invoke(channel, ...args)` passthrough, so they have no named bridge and no
 * `src/global.d.ts` entry. That made them easy to treat as dead code, and a
 * helper-level test would have proven nothing about the product: a test that
 * calls a path-comparison function directly passes whether or not the handler
 * ever consults it, and whether or not the handler is wired at all. So this file
 * registers the REAL handlers via `registerComputerHandlers` and invokes them
 * the way preload's passthrough does.
 *
 * `$HOME` is a real temp directory, so confinement, symlink resolution and the
 * actual `unlink` all run against real files. Every refusal asserts the file is
 * STILL THERE afterwards — a refusal that deleted the file would fail on the
 * filesystem check, not merely on the returned envelope.
 *
 * ## There is deliberately no policy switch here
 *
 * A `confirmDeleteOutsideHome` security setting existed for a while and gated
 * nothing. It was removed, not wired, and the reason is recorded on the
 * `computer:fileDelete` handler: `confineToHome` refuses to *produce* an
 * outside-home path, and `evaluateDeleteRequest` independently refuses any
 * target whose real location is outside home — both unconditionally, before
 * `confirmed` is ever consulted. An outside-home delete therefore has exactly
 * one possible answer, and a toggle could only ever have been either a no-op or
 * a licence to delete anywhere. These tests are the invariant that makes the
 * removal correct; if a future change makes one of these refuse differently,
 * they fail.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import nodeOs from 'os';
import path from 'path';

/**
 * A real home directory and a real sibling of it. Two `mkdtemp` calls under
 * `os.tmpdir()` are siblings by construction, which is exactly the
 * "starts with home's name but is not home" shape that gates rot on.
 */
const HOME = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'henry-home-'));
const OUTSIDE = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'henry-outside-'));

// `vi.mock` factories are lazy, so this runs once `./computer` is imported
// below — after HOME exists. Both computer.ts and src/platform/fileOps.ts read
// `os.homedir()`, and overriding it here gives the whole module graph one home.
// `typeof import('os')` is the DECLARED shape of the builtin, which has named
// exports and no `default` — but at runtime Vite's SSR interop hands the module
// a `default` equal to `module.exports`, and that is the object `import os from
// 'os'` actually binds to. So the mock has to patch both, and the patch is typed
// through `Record<string, unknown>` because the declared type cannot describe
// the interop shape. Spreading only the top level would leave `import os from
// 'os'` on the REAL homedir while `os.homedir()` elsewhere saw the fake one.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => HOME,
    default: { ...real, homedir: () => HOME },
  };
});

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => { handlers.set(channel, fn); },
  },
  app: { once: () => {}, on: () => {}, getPath: () => HOME, getAppPath: () => HOME },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class { isDestroyed() { return false; } },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
}));

// Static import is impossible here: vitest hoists the `vi.mock('os', …)` factory
// above the imports, and that factory closes over `HOME`. A static import of
// ./computer would run it while `HOME` is still in its temporal dead zone. This
// is the module-loading boundary the static-import rule carves out, not
// laziness.
const { registerComputerHandlers } = await import('./computer');
const { registerFilesystemHandlers } = await import('./filesystem');

/** Exactly what preload's `invoke(channel, ...args)` reaches. */
function call(channel: string, payload?: unknown): Promise<Record<string, unknown>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`channel not registered: ${channel}`);
  return Promise.resolve(fn({}, payload) as Record<string, unknown>);
}

function makeFile(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'payload');
  return p;
}

beforeEach(() => {
  // Registration is re-run per test because the handler map is cleared below,
  // and a handler captured once at import time would be a copy of the code as it
  // was when this file loaded — not the code under test.
  handlers.clear();
  registerComputerHandlers(() => null);
  registerFilesystemHandlers(path.join(HOME, 'workspace'));
});

afterAll(() => {
  for (const dir of [HOME, OUTSIDE]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── Inside home ─────────────────────────────────────────────────────────────

describe('a delete inside the home directory asks first', () => {
  it('deletes nothing when the user has not agreed', async () => {
    const file = makeFile(HOME, 'Documents/report.pdf');
    const r = await call('computer:fileDelete', { path: file });

    expect(r.ok).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.error).toMatch(/confirmation/i);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('proceeds once the user approves', async () => {
    const file = makeFile(HOME, 'Documents/report.pdf');
    const r = await call('computer:fileDelete', {
      path: file, confirmed: true, permanent: true,
    });

    expect(r).toMatchObject({ ok: true, path: file, recoverable: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('expands ~ rather than treating it as a literal folder', async () => {
    const file = makeFile(HOME, 'Documents/report.pdf');
    const r = await call('computer:fileDelete', {
      path: '~/Documents/report.pdf', confirmed: true, permanent: true,
    });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to delete the home directory itself, confirmed or not', async () => {
    for (const confirmed of [false, true]) {
      const r = await call('computer:fileDelete', {
        path: HOME, confirmed, permanent: true, recursive: true,
      });
      expect(r.ok, `confirmed=${confirmed}`).toBe(false);
      expect(r.error).toMatch(/home folder|contains your home/i);
    }
    expect(fs.existsSync(HOME)).toBe(true);
  });
});

// ── Outside home ────────────────────────────────────────────────────────────

describe('a delete outside the home directory is refused and touches nothing', () => {
  it('refuses an out-of-home target and leaves the file on disk', async () => {
    const file = makeFile(OUTSIDE, 'precious.txt');
    const r = await call('computer:fileDelete', { path: file });

    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('is STILL refused when the renderer claims the user already approved', async () => {
    // The assertion this whole row depends on. If `confirmed: true` could clear
    // an outside-home refusal, home confinement would be decorative and the
    // `confirmed` flag would be a licence to delete anywhere.
    const file = makeFile(OUTSIDE, 'precious.txt');
    for (const extra of [
      { confirmed: true },
      { confirmed: true, permanent: true },
      { confirmed: true, recursive: true, permanent: true },
    ]) {
      const r = await call('computer:fileDelete', { path: file, ...extra });
      expect(r.ok, JSON.stringify(extra)).toBe(false);
      expect(fs.existsSync(file), JSON.stringify(extra)).toBe(true);
    }
  });

  it('refuses a sibling directory whose name merely starts with the home path', async () => {
    // `${HOME}-evil` — the shape a naive `startsWith(root + sep)` check on the
    // wrong side of the comparison would wave through.
    const dir = fs.mkdtempSync(`${HOME}-evil`);
    try {
      const file = makeFile(dir, 'a.txt');
      const r = await call('computer:fileDelete', {
        path: file, confirmed: true, permanent: true,
      });
      expect(r.ok).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the home directory\'s parent, which would take home with it', async () => {
    const r = await call('computer:fileDelete', {
      path: path.dirname(HOME), confirmed: true, recursive: true, permanent: true,
    });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(HOME)).toBe(true);
  });
});

// ── Traversal ───────────────────────────────────────────────────────────────

describe('traversal is refused', () => {
  const ATTACKS = [
    '../../../../etc/passwd',
    '../../etc/shadow',
    'Documents/../../../../../../etc/passwd',
    '..\\..\\Windows\\System32\\config\\SAM',
    '..\\..\\..',
    '/etc/shadow',
    '//etc/shadow',
  ];

  for (const attack of ATTACKS) {
    it(`refuses ${JSON.stringify(attack)}`, async () => {
      const r = await call('computer:fileDelete', {
        path: attack, confirmed: true, permanent: true, recursive: true,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });
  }

  it('leaves a real system file exactly where it was', async () => {
    if (!fs.existsSync('/etc/passwd')) return;
    const before = fs.statSync('/etc/passwd').size;
    const r = await call('computer:fileDelete', {
      path: '/etc/passwd', confirmed: true, permanent: true,
    });
    expect(r.ok).toBe(false);
    expect(fs.statSync('/etc/passwd').size).toBe(before);
  });
});

// ── Symlinks ────────────────────────────────────────────────────────────────

describe('a symlink is judged by where it really points', () => {
  it('refuses a symlink inside home that points outside it', async () => {
    const outsideFile = makeFile(OUTSIDE, 'shadow-link-target.txt');
    const link = path.join(HOME, 'innocent-looking.txt');
    try { fs.unlinkSync(link); } catch { /* not there yet */ }
    fs.symlinkSync(outsideFile, link);

    try {
      const r = await call('computer:fileDelete', {
        path: link, confirmed: true, permanent: true,
      });
      expect(r.ok).toBe(false);
      // Neither the link nor its target was removed.
      expect(fs.lstatSync(link)).toBeTruthy();
      expect(fs.existsSync(outsideFile)).toBe(true);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('refuses a symlinked DIRECTORY inside home that points outside it', async () => {
    const link = path.join(HOME, 'escape-dir');
    try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* not there yet */ }
    fs.symlinkSync(OUTSIDE, link, 'dir');

    try {
      const r = await call('computer:fileDelete', {
        path: link, confirmed: true, recursive: true, permanent: true,
      });
      expect(r.ok).toBe(false);
      expect(fs.lstatSync(link)).toBeTruthy();
      expect(fs.readdirSync(OUTSIDE).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });
});

// ── Windows path forms ──────────────────────────────────────────────────────

describe('Windows path forms are refused on every host', () => {
  const WINDOWS_SHAPES = [
    'C:\\Windows\\System32',
    'C:/Windows/System32',
    'C:\\Windows\\System32\\config\\SAM',
    'C:\\Program Files',
    'c:\\',
    'D:\\secrets.txt',
    '\\\\server\\share\\payload.exe',
    '\\\\?\\C:\\Windows',
    'C:\\Users\\buster-evil\\a.txt',
  ];

  for (const shape of WINDOWS_SHAPES) {
    it(`refuses ${JSON.stringify(shape)}`, async () => {
      const r = await call('computer:fileDelete', {
        path: shape, confirmed: true, recursive: true, permanent: true,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });
  }
});

// ── Malformed input ─────────────────────────────────────────────────────────

describe('malformed payloads are rejected at the boundary', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['object', { path: { toString: () => HOME } }],
    ['array', [HOME]],
    ['boolean', true],
    ['over-length path', `${HOME}/${'a'.repeat(5000)}`],
    ['null byte', `${HOME}/a\u0000b`],
  ];

  for (const [label, payload] of MALFORMED) {
    it(`refuses ${label} BEFORE the handler runs`, async () => {
      const r = await call('computer:fileDelete', payload);
      expect(r.ok).toBe(false);
      // `validationError` is what separates "the boundary rejected this
      // payload" from "the handler looked at it and refused". The handlers carry
      // their own `typeof` guards, so without this field every case above would
      // still pass with the channel schema deleted — proving nothing about the
      // boundary. These channels are reachable through preload's generic
      // `invoke(channel, ...)` passthrough and had NO schema at all before that
      // was fixed, which left the handlers' ad-hoc checks as the entire
      // validation surface.
      expect(r.validationError).toBe(true);
    });
  }

  it('refuses a payload whose shape is wrong even when the path is fine', async () => {
    const file = makeFile(HOME, 'Documents/report.pdf');
    // `path` sent as a number cannot be coerced into a location.
    const r = await call('computer:fileDelete', { path: 12345, confirmed: true, permanent: true });
    expect(r.ok).toBe(false);
    expect(r.validationError).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses a non-boolean `confirmed`/`permanent` rather than coercing it', async () => {
    const file = makeFile(HOME, 'Documents/report.pdf');
    const r = await call('computer:fileDelete', {
      path: file, confirmed: 'yes', permanent: 'no',
    });
    expect(r.ok).toBe(false);
    expect(r.validationError).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('bounds a newName so an oversized "name" never reaches the filesystem', async () => {
    const target = path.join(HOME, 'Documents/report.pdf');
    const r = await call('computer:fileRename', { path: target, newName: 'a'.repeat(400) });
    expect(r.ok).toBe(false);
    expect(r.validationError).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });
});

// ── Move and rename ─────────────────────────────────────────────────────────

describe('move and rename are confined the same way delete is', () => {
  it('refuses to move a file that lives outside home', async () => {
    const outside = makeFile(OUTSIDE, 'a.txt');
    const destination = path.join(HOME, 'a.txt');
    const r = await call('computer:fileMove', { from: outside, to: destination });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('refuses to rename a file outside home', async () => {
    const outside = makeFile(OUTSIDE, 'b.txt');
    const r = await call('computer:fileRename', { path: outside, newName: 'renamed.txt' });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses to move a file INTO home from a traversal path', async () => {
    const stolen = path.join(HOME, 'stolen.txt');
    const r = await call('computer:fileMove', {
      from: '../../../../etc/passwd', to: stolen,
    });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(stolen)).toBe(false);
  });

  it('refuses to rename outside home even when the new name is innocuous', async () => {
    // A rename destroys the source. "It looks harmless" is not a reason to let
    // the source be destroyed from outside the confinement root.
    const outside = makeFile(OUTSIDE, 'c.txt');
    const r = await call('computer:fileRename', { path: outside, newName: 'notes.txt' });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('still moves inside home, because that is what confinement allows', async () => {
    const from = makeFile(HOME, 'Documents/from.txt');
    const to = path.join(HOME, 'Documents/to.txt');
    const r = await call('computer:fileMove', { from, to });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.existsSync(to)).toBe(true);
  });

  it('leaves fileCopy working inside home — copying destroys nothing', async () => {
    const from = makeFile(HOME, 'Documents/src.txt');
    const to = path.join(HOME, 'Documents/dst.txt');
    const r = await call('computer:fileCopy', { from, to });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(to)).toBe(true);
  });
});

// ── The security-regression probes, still refusing ──────────────────────────

/**
 * Four of the six probes in scripts/acceptance/security-regression.mjs, driven
 * against the same handlers the installed build uses. The other two
 * (`computer:openApp`, `computer:killProcess`) are not filesystem channels and
 * are untouched by this work — Main re-runs the full script against the
 * installed package.
 */
describe('the security regression probes still refuse', () => {
  /**
   * Refusal has three shapes on this host, and the acceptance script says
   * plainly that treating only one of them as a refusal produces false failures
   * that train people to ignore the script:
   *   1. the handler throws (`safeResolve` raises "Access denied")
   *   2. it resolves with a failure envelope (`{ok:false}`)
   *   3. it resolves with an EMPTY listing — `fs:readDirectory` has no error
   *      flag, and a Windows path on Linux resolves to a nonexistent file
   *      *inside* the workspace rather than outside it, so the refusal is
   *      "here is nothing", not "no".
   * A probe counts as refused only when the operation demonstrably did not
   * happen: no success flag, and no entries.
   */
  const PROBES: Array<[string, string, unknown]> = [
    ['fs:readDirectory traversal', 'fs:readDirectory', '../../../../etc'],
    ['fs:readDirectory outside home', 'fs:readDirectory', 'C:\\Windows\\System32\\config'],
    ['fs:readFile SAM', 'fs:readFile', 'C:\\Windows\\System32\\config\\SAM'],
    ['fs:readFile /etc/shadow', 'fs:readFile', '/etc/shadow'],
  ];

  for (const [label, channel, arg] of PROBES) {
    it(`${label} refuses`, async () => {
      let value: unknown;
      let threw = false;
      try {
        value = await call(channel, arg);
      } catch {
        threw = true;
      }
      if (threw) return; // shape 1
      const v = value as Record<string, unknown>;
      expect(v.ok, label).not.toBe(true);
      expect(v.success, label).not.toBe(true);
      if (Array.isArray(v.entries)) expect(v.entries, label).toHaveLength(0);
      // Shape 2 for readFile: a successful read returns the file's text.
      expect(typeof v, label).not.toBe('string');
    });
  }

  it('still refuses to read a real file outside the workspace', async () => {
    if (!fs.existsSync('/etc/passwd')) return;
    let threw = false;
    try {
      await call('fs:readFile', '../../../../../../etc/passwd');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});