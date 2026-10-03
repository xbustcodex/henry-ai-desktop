/**
 * File tools: the capability has to work, and the boundary has to hold.
 *
 * The boundary is the part that matters — these tools reach the whole home
 * directory, so traversal, symlink escape and accidental clobbering are all
 * tested explicitly rather than assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { fileTools, resolveUserPath } from './files';

const byName = (n: string) => {
  const t = fileTools.find((x) => x.name === n);
  if (!t) throw new Error(`missing tool ${n}`);
  return t;
};
const run = async (n: string, params: Record<string, unknown>) =>
  byName(n).execute(params, {} as never);

let dir = '';

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.homedir(), '.henry-filetest-'));
});
afterAll(async () => {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('path resolution', () => {
  it('treats a relative path as home-relative', () => {
    const r = resolveUserPath('Documents/x.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.startsWith(os.homedir())).toBe(true);
  });

  it('expands ~', () => {
    const r = resolveUserPath('~/notes.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(os.homedir(), 'notes.md'));
  });

  it('refuses traversal out of the home directory', () => {
    expect(resolveUserPath('../../../../etc/passwd').ok).toBe(false);
    expect(resolveUserPath('Documents/../../../../etc/passwd').ok).toBe(false);
  });

  it('refuses an absolute path outside home', () => {
    expect(resolveUserPath('/etc/passwd').ok).toBe(false);
    expect(resolveUserPath('C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts').ok).toBe(false);
  });

  it('accepts the home directory itself', () => {
    expect(resolveUserPath(os.homedir()).ok).toBe(true);
  });

  // The bug this guards: the confinement check used `path.resolve` only, so a
  // symlink INSIDE the home directory pointing outside it passed the prefix
  // test and then read through to the target. Lexically this path looks fine;
  // only resolving it reveals the escape.
  it('refuses a symlink inside home that points outside it', async () => {
    const link = path.join(os.homedir(), '.henry-symlink-escape-test');
    await fsp.rm(link, { force: true });
    // /etc/passwd exists on every platform this suite runs on (POSIX); skip
    // cleanly rather than failing on a box that lacks it.
    if (!(await fsp.stat('/etc/passwd').catch(() => null))) return;
    await fsp.symlink('/etc/passwd', link);
    try {
      const r = resolveUserPath(link);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/link|outside/i);
    } finally {
      await fsp.rm(link, { force: true });
    }
  });

  it('refuses a symlinked directory that leads outside home', async () => {
    const link = path.join(os.homedir(), '.henry-symlink-dir-test');
    await fsp.rm(link, { force: true, recursive: true });
    if (!(await fsp.stat('/etc').catch(() => null))) return;
    await fsp.symlink('/etc', link, 'dir');
    try {
      // Both the link itself and a file reached through it must be refused.
      expect(resolveUserPath(link).ok).toBe(false);
      expect(resolveUserPath(`${link}/passwd`).ok).toBe(false);
    } finally {
      await fsp.rm(link, { force: true, recursive: true });
    }
  });

  // The fix must not break ordinary writes, where the target does not exist
  // yet — realpathNearestExisting has to tolerate the missing tail.
  it('still accepts a path whose target does not exist yet', () => {
    const r = resolveUserPath('.henry-not-created-yet/deeper/still-new.md');
    expect(r.ok).toBe(true);
  });

  // A symlink that stays INSIDE home is legitimate and must keep working.
  it('allows a symlink that resolves within the home directory', async () => {
    const dirLink = path.join(dir, 'inside-link');
    const realDir = path.join(dir, 'real');
    await fsp.mkdir(realDir, { recursive: true });
    await fsp.writeFile(path.join(realDir, 'ok.txt'), 'fine');
    await fsp.rm(dirLink, { force: true, recursive: true });
    await fsp.symlink(realDir, dirLink, 'dir');
    try {
      expect(resolveUserPath(path.join(dirLink, 'ok.txt')).ok).toBe(true);
    } finally {
      await fsp.rm(dirLink, { force: true, recursive: true });
    }
  });

  it('rejects a non-string path', () => {
    expect(resolveUserPath(42).ok).toBe(false);
    expect(resolveUserPath('').ok).toBe(false);
  });
});

describe('file tools — capability', () => {
  it('lists a directory', async () => {
    await fsp.writeFile(path.join(dir, 'a.txt'), 'one');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'two');
    const r = await run('file_list', { path: dir });
    expect(r.ok).toBe(true);
    const names = (r.data as { name: string }[]).map((x) => x.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('b.txt');
  });

  it('searches by file name', async () => {
    await fsp.writeFile(path.join(dir, 'findme.txt'), 'x');
    const r = await run('file_search', { query: 'findme', root: dir });
    expect(r.ok).toBe(true);
    expect((r.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('searches inside file contents when asked', async () => {
    await fsp.writeFile(path.join(dir, 'hay.txt'), 'alpha\nthe needle is here\nomega');
    const r = await run('file_search', { query: 'needle', root: dir, content: true });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.data)).toContain('needle');
  });

  it('inspects without reading the contents, and reports a hash', async () => {
    await fsp.writeFile(path.join(dir, 'h.txt'), 'hello');
    const r = await run('file_inspect', { path: path.join(dir, 'h.txt') });
    expect(r.ok).toBe(true);
    const d = r.data as { sha256: string; binary: boolean; size: number };
    expect(d.binary).toBe(false);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.size).toBe(5);
  });

  it('reads a line range', async () => {
    await fsp.writeFile(path.join(dir, 'lines.txt'), 'l1\nl2\nl3\nl4\nl5');
    const r = await run('file_read', { path: path.join(dir, 'lines.txt'), startLine: 2, endLine: 3 });
    expect(r.ok).toBe(true);
    expect((r.data as { text: string }).text).toBe('l2\nl3');
  });

  it('creates a new file, and refuses to clobber an existing one', async () => {
    const target = path.join(dir, 'new.txt');
    const first = await run('file_write', { path: target, content: 'v1' });
    expect(first.ok).toBe(true);
    const second = await run('file_write', { path: target, content: 'v2' });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain('already exists');
    // and the original is untouched
    expect(await fsp.readFile(target, 'utf8')).toBe('v1');
  });

  it('replaces atomically and leaves no temp file behind', async () => {
    const target = path.join(dir, 'replace.txt');
    await fsp.writeFile(target, 'old');
    const r = await run('file_replace', { path: target, content: 'new' });
    expect(r.ok).toBe(true);
    expect(await fsp.readFile(target, 'utf8')).toBe('new');
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('henry-tmp'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to replace a file that does not exist', async () => {
    const r = await run('file_replace', { path: path.join(dir, 'nope.txt'), content: 'x' });
    expect(r.ok).toBe(false);
  });

  it('moves and copies, refusing to overwrite', async () => {
    const src = path.join(dir, 'src.txt');
    await fsp.writeFile(src, 'data');
    const moved = path.join(dir, 'moved.txt');
    const r1 = await run('file_move', { from: src, to: moved });
    expect(r1.ok).toBe(true);

    const copied = path.join(dir, 'copied.txt');
    const r2 = await run('file_copy', { from: moved, to: copied });
    expect(r2.ok).toBe(true);

    const r3 = await run('file_copy', { from: moved, to: copied });
    expect(r3.ok).toBe(false);
    expect(String(r3.error)).toContain('refusing to overwrite');
  });

  it('loads an image into the turn as base64', async () => {
    // 1x1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const p = path.join(dir, 'px.png');
    await fsp.writeFile(p, png);
    const r = await run('file_load', { path: p });
    expect(r.ok).toBe(true);
    const d = r.data as { kind: string; mime: string; base64: string };
    expect(d.kind).toBe('image');
    expect(d.mime).toBe('image/png');
    expect(d.base64).toBe(png.toString('base64'));
  });

  it('publishes an existing file with its metadata', async () => {
    const p = path.join(dir, 'report.txt');
    await fsp.writeFile(p, 'report body');
    const r = await run('file_publish', { path: p, note: 'the report' });
    expect(r.ok).toBe(true);
    const d = r.data as { fileName: string; size: number };
    expect(d.fileName).toBe('report.txt');
    expect(d.size).toBe(11);
  });

  it('publish fails for a file that is not there', async () => {
    const r = await run('file_publish', { path: path.join(dir, 'ghost.txt') });
    expect(r.ok).toBe(false);
  });
});

describe('file tools — containment', () => {
  it('refuses to read outside home through the tool, not just the resolver', async () => {
    const r = await run('file_read', { path: '../../../../etc/passwd' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('outside your home directory');
  });

  it('refuses to write outside home', async () => {
    const r = await run('file_write', { path: '../escaped.txt', content: 'x' });
    expect(r.ok).toBe(false);
  });

  it('refuses to move a file out of home', async () => {
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'x');
    const r = await run('file_move', { from: path.join(dir, 'secret.txt'), to: '../../escaped.txt' });
    expect(r.ok).toBe(false);
    // the source must still be there
    expect(await fsp.readFile(path.join(dir, 'secret.txt'), 'utf8')).toBe('x');
  });

  it('declares writes and moves as needing confirmation', () => {
    expect(byName('file_write').safetyLevel).toBe('confirm');
    expect(byName('file_replace').safetyLevel).toBe('confirm');
    expect(byName('file_move').safetyLevel).toBe('confirm');
    // reads and copies do not need a prompt
    expect(byName('file_read').safetyLevel).toBe('silent');
    expect(byName('file_copy').safetyLevel).toBe('silent');
  });

  it('every destructive tool has a confirm prompt for the user', () => {
    for (const t of fileTools) {
      if (t.safetyLevel === 'confirm') {
        expect(typeof t.confirmPrompt, `${t.name} needs a confirmPrompt`).toBe('function');
      }
    }
  });
});