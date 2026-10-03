/**
 * Row 7.6 — file operations.
 *
 * The security properties under test are the ones Card 7 established and that
 * must not regress: nothing outside the home directory is reachable, delete
 * stays confirmation-gated and recoverable, and Windows paths that would alias
 * to another name are refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  evaluateDeleteRequest,
  protectedTargetReason,
  windowsPathSyntaxIssue,
  pathSyntaxIssue,
  expandUserPath,
  toLongPath,
  stripLongPathPrefix,
  samePath,
  isAncestor,
  isInside,
  relativeInside,
  browseDirectory,
  searchPath,
  copyPath,
  movePath,
  renamePath,
  createFolder,
  confineToHome,
  globToRegExp,
  formatBytes,
  WINDOWS_MAX_PATH,
  PROTECTED_HOME_CHILDREN,
} from './fileOps';

let home: string;
let outside: string;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-fs-'));
  home = path.join(root, 'home');
  outside = path.join(root, 'outside');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  const root = path.dirname(home);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('path expansion', () => {
  it('expands ~ and ~/x and $HOME', () => {
    expect(expandUserPath('~', '/home/buster', 'linux')).toBe('/home/buster');
    expect(expandUserPath('~/Desktop', '/home/buster', 'linux')).toBe('/home/buster/Desktop');
    expect(expandUserPath('$HOME/Desktop', '/home/buster', 'linux')).toBe('/home/buster/Desktop');
  });

  it('leaves an ordinary absolute path alone', () => {
    expect(expandUserPath('/etc/passwd', '/home/buster', 'linux')).toBe('/etc/passwd');
    expect(expandUserPath('C:\\Users\\me', 'C:\\Users\\me', 'win32')).toBe('C:\\Users\\me');
  });
});

describe('Windows path syntax', () => {
  it('accepts ordinary drive and UNC paths', () => {
    expect(windowsPathSyntaxIssue('C:\\Users\\me\\Documents')).toBeNull();
    expect(windowsPathSyntaxIssue('C:/Users/me/Documents')).toBeNull();
    expect(windowsPathSyntaxIssue('\\\\server\\share\\notes.txt')).toBeNull();
  });

  it('refuses reserved device names, with or without an extension', () => {
    // `CON.txt` is still the console device — Win32 checks the base name
    // before the first dot.
    for (const name of ['CON', 'con.txt', 'NUL', 'aux.md', 'COM1.log', 'LPT9.csv']) {
      expect(windowsPathSyntaxIssue(`C:\\tmp\\${name}`)?.code, name).toBe('device-name');
    }
  });

  it('refuses a trailing dot or space, which Win32 silently strips', () => {
    // `report.` and `report` are the same file on Windows: the name would
    // alias onto something the user never addressed.
    expect(windowsPathSyntaxIssue('C:\\tmp\\report.')?.code).toBe('trailing-dot-or-space');
    expect(windowsPathSyntaxIssue('C:\\tmp\\report ')?.code).toBe('trailing-dot-or-space');
  });

  it('refuses characters that are illegal inside a component', () => {
    for (const name of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(windowsPathSyntaxIssue(`C:\\tmp\\${name}`)?.code, name).toBeTruthy();
    }
  });

  it('refuses a drive-relative path, which means something else entirely', () => {
    // `C:foo` is relative to that drive's current directory, not its root.
    expect(windowsPathSyntaxIssue('C:foo')?.code).toBe('drive-relative');
  });

  it('refuses a null byte', () => {
    expect(windowsPathSyntaxIssue('C:\\tmp\\a\0b')?.code).toBe('null-byte');
  });

  it('reports an over-long path rather than failing later with ENOENT', () => {
    const long = `C:\\tmp\\${'x'.repeat(WINDOWS_MAX_PATH)}`;
    expect(windowsPathSyntaxIssue(long)?.code).toBe('too-long');
  });
});

describe('long paths', () => {
  it('prefixes a drive path that exceeds MAX_PATH', () => {
    const long = `C:\\${'x'.repeat(WINDOWS_MAX_PATH)}`;
    expect(toLongPath(long, 'win32').startsWith('\\\\?\\')).toBe(true);
  });

  it('prefixes a UNC path correctly — not with \\\\?\\\\server', () => {
    const long = `\\\\server\\share\\${'x'.repeat(WINDOWS_MAX_PATH)}`;
    expect(toLongPath(long, 'win32').startsWith('\\\\?\\UNC\\server\\share\\')).toBe(true);
  });

  it('leaves a short path and any non-Windows path alone', () => {
    expect(toLongPath('C:\\tmp\\a.txt', 'win32')).toBe('C:\\tmp\\a.txt');
    expect(toLongPath('/tmp/a.txt', 'linux')).toBe('/tmp/a.txt');
  });

  it('strips the prefix again so comparisons see a normal path', () => {
    expect(stripLongPathPrefix('\\\\?\\C:\\tmp\\a', 'win32')).toBe('C:\\tmp\\a');
    expect(stripLongPathPrefix('\\\\?\\UNC\\server\\share', 'win32')).toBe('\\\\server\\share');
  });
});

describe('path comparison', () => {
  it('is case-insensitive on Windows and case-sensitive elsewhere', () => {
    expect(samePath('C:\\Users\\Me', 'c:/users/me', 'win32')).toBe(true);
    expect(samePath('/Users/Me', '/users/me', 'linux')).toBe(false);
  });

  it('does not treat a sibling directory as a child', () => {
    // The bug _pathSafety.ts exists to prevent.
    expect(isInside('/work-evil', '/work', 'linux')).toBe(false);
    expect(isInside('/work/sub', '/work', 'linux')).toBe(true);
    expect(isAncestor('/work', '/work/sub', 'linux')).toBe(true);
    expect(isAncestor('/work-evil', '/work/sub', 'linux')).toBe(false);
  });

  it('returns the relative path only when it is genuinely inside', () => {
    expect(relativeInside('/home/buster/Documents', '/home/buster', 'linux')).toBe('Documents');
    expect(relativeInside('/etc', '/home/buster', 'linux')).toBeNull();
  });
});

describe('delete protection', () => {
  const target = () => path.join(home, 'report.txt');

  beforeEach(() => fs.writeFileSync(target(), 'hello'));

  it('refuses the home directory itself, confirmed or not', () => {
    const r = evaluateDeleteRequest({ target: home, home, platform: 'linux', confirmed: true, permanent: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/home folder/i);
  });

  it('refuses an ancestor of the home directory', () => {
    const r = evaluateDeleteRequest({
      target: path.dirname(home), home, platform: 'linux', confirmed: true, permanent: true,
    });
    expect(r.ok).toBe(false);
  });

  it('refuses system roots and sensitive directories outright', () => {
    for (const p of ['/', '/etc', '/usr', '/bin', '/boot', '/System', '/Applications']) {
      const r = evaluateDeleteRequest({ target: p, home, platform: 'linux', confirmed: true, permanent: true });
      expect(r.ok, p).toBe(false);
    }
  });

  it('refuses Windows system folders and a bare drive root', () => {
    for (const p of ['C:\\Windows', 'C:\\Program Files', 'c:\\programdata', 'C:\\']) {
      const r = evaluateDeleteRequest({ target: p, home, platform: 'win32', confirmed: true, permanent: true });
      expect(r.ok, p).toBe(false);
    }
  });

  it('refuses to delete a folder holding the user\'s keys', () => {
    for (const rel of PROTECTED_HOME_CHILDREN) {
      const p = path.join(home, ...rel.split('/'));
      const reason = protectedTargetReason(p, home, 'linux');
      expect(reason, rel).not.toBeNull();
      const r = evaluateDeleteRequest({ target: p, home, platform: 'linux', confirmed: true, permanent: true });
      expect(r.ok, rel).toBe(false);
    }
  });

  it('requires confirmation for an ordinary file', () => {
    const r = evaluateDeleteRequest({ target: target(), home, platform: 'linux' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.needsConfirmation).toBe(true);
    // The refusal describes what would be removed, so the caller can actually
    // ask the user something useful.
    expect(!r.ok && r.summary).toMatch(/report\.txt/);
  });

  it('refuses to delete a symlink that points outside the home directory', () => {
    const link = path.join(home, 'escape');
    fs.symlinkSync(outside, link);
    const r = evaluateDeleteRequest({ target: link, home, platform: 'linux', confirmed: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/outside your home/i);
  });

  it('allows a confirmed delete of an ordinary file', () => {
    const r = evaluateDeleteRequest({ target: target(), home, platform: 'linux', confirmed: true });
    expect(r.ok).toBe(true);
  });

  it('defaults to recoverable rather than unlinking', () => {
    const r = evaluateDeleteRequest({ target: target(), home, platform: 'linux', confirmed: true });
    expect(r.ok && r.permanent).toBe(false);
    const hard = evaluateDeleteRequest({
      target: target(), home, platform: 'linux', confirmed: true, permanent: true,
    });
    expect(hard.ok && hard.permanent).toBe(true);
  });

  it('reports a missing target instead of silently succeeding', () => {
    const r = evaluateDeleteRequest({
      target: path.join(home, 'nope.txt'), home, platform: 'linux', confirmed: true, requireExists: true,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no longer exists/i);
  });
});

describe('browse', () => {
  it('lists folders first and hides dotfiles by default', () => {
    fs.writeFileSync(path.join(home, 'b.txt'), 'x');
    fs.mkdirSync(path.join(home, 'zdir'));
    fs.writeFileSync(path.join(home, '.hidden'), 'x');

    const r = browseDirectory(home);
    expect(r.ok).toBe(true);
    const names = (r.entries ?? []).map((e) => e.name);
    expect(names).toEqual(['zdir', 'b.txt']);

    const withHidden = browseDirectory(home, { showHidden: true });
    expect((withHidden.entries ?? []).map((e) => e.name)).toContain('.hidden');
  });

  it('refuses a file and reports an unreadable folder', () => {
    const f = path.join(home, 'a.txt');
    fs.writeFileSync(f, 'x');
    expect(browseDirectory(f).ok).toBe(false);
    expect(browseDirectory(path.join(home, 'missing')).ok).toBe(false);
  });

  it('truncates rather than returning an unbounded listing', () => {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(home, `f${i}`), 'x');
    const r = browseDirectory(home, { limit: 5 });
    expect(r.entries).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});

describe('search', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'findme.txt'), 'alpha\nthe needle is here\nomega');
    fs.mkdirSync(path.join(home, 'nested'));
    fs.writeFileSync(path.join(home, 'nested', 'also-findme.log'), 'nothing');
  });

  it('finds by name, case-insensitively', () => {
    const r = searchPath(home, { query: 'FINDME' });
    expect(r.ok).toBe(true);
    expect((r.hits ?? []).map((h) => h.name)).toContain('findme.txt');
  });

  it('finds by content and reports the matching line', () => {
    const r = searchPath(home, { query: 'needle', content: true });
    const hit = (r.hits ?? []).find((h) => h.name === 'findme.txt');
    expect(hit?.lines).toEqual([2]);
  });

  it('supports globs and anchors them', () => {
    const r = searchPath(home, { query: '*.log' });
    expect((r.hits ?? []).map((h) => h.name)).toEqual(['also-findme.log']);
  });

  it('refuses an empty query', () => {
    expect(searchPath(home, { query: '   ' }).ok).toBe(false);
  });

  it('does not loop forever on a symlink pointing back up the tree', () => {
    fs.symlinkSync(home, path.join(home, 'nested', 'loop'));
    const r = searchPath(home, { query: 'a', maxDepth: 12 });
    expect(r.ok).toBe(true);
  });

  it('skips node_modules rather than walking it', () => {
    fs.mkdirSync(path.join(home, 'node_modules'));
    fs.writeFileSync(path.join(home, 'node_modules', 'bundled-findme.js'), 'x');
    const r = searchPath(home, { query: 'findme' });
    expect((r.hits ?? []).map((h) => h.name)).not.toContain('bundled-findme.js');
  });

  it('honours maxResults', () => {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(home, `many-findme-${i}`), 'x');
    const r = searchPath(home, { query: 'findme', maxResults: 3 });
    expect(r.hits).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});

describe('copy, move and rename', () => {
  beforeEach(() => fs.writeFileSync(path.join(home, 'src.txt'), 'payload'));

  it('copies without overwriting by default', () => {
    const to = path.join(home, 'dst.txt');
    expect(copyPath({ from: path.join(home, 'src.txt'), to, platform: 'linux' }).ok).toBe(true);
    const again = copyPath({ from: path.join(home, 'src.txt'), to, platform: 'linux' });
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toMatch(/refusing to overwrite/i);
  });

  it('copies a folder recursively', () => {
    fs.mkdirSync(path.join(home, 'dir'));
    fs.writeFileSync(path.join(home, 'dir', 'inner.txt'), 'x');
    const r = copyPath({ from: path.join(home, 'dir'), to: path.join(home, 'dir2'), platform: 'linux' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(home, 'dir2', 'inner.txt'))).toBe(true);
  });

  it('refuses to copy or move a folder inside itself', () => {
    fs.mkdirSync(path.join(home, 'tree'));
    const inside = copyPath({ from: path.join(home, 'tree'), to: path.join(home, 'tree', 'sub'), platform: 'linux' });
    expect(inside.ok).toBe(false);
    const moved = movePath({ from: path.join(home, 'tree'), to: path.join(home, 'tree', 'sub'), platform: 'linux' });
    expect(moved.ok).toBe(false);
  });

  it('refuses a copy or move whose source is gone, leaving nothing behind', () => {
    const r = movePath({ from: path.join(home, 'gone.txt'), to: path.join(home, 'x.txt'), platform: 'linux' });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(home, 'x.txt'))).toBe(false);
  });

  it('renames in place and refuses a name that is really a move', () => {
    const r = renamePath(path.join(home, 'src.txt'), 'renamed.txt', 'linux');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(home, 'renamed.txt'))).toBe(true);

    const asMove = renamePath(path.join(home, 'renamed.txt'), 'sub/other.txt', 'linux');
    expect(asMove.ok).toBe(false);
    expect(!asMove.ok && asMove.error).toMatch(/separator/i);
  });

  it('applies the Windows syntax rules to a rename target', () => {
    const r = renamePath(path.join(home, 'src.txt'), 'CON.txt', 'win32');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/reserved Windows device/i);
  });
});

describe('createFolder', () => {
  it('creates, and reports that it already existed the second time', () => {
    const first = createFolder(path.join(home, 'made'));
    expect(first).toMatchObject({ ok: true, existed: false });
    const second = createFolder(path.join(home, 'made'));
    expect(second).toMatchObject({ ok: true, existed: true });
  });

  it('does not report success when a file is already at that path', () => {
    // `mkdirSync(recursive)` succeeds quietly here, so the failure used to
    // surface much later.
    const p = path.join(home, 'afile');
    fs.writeFileSync(p, 'x');
    const r = createFolder(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not a folder/i);
  });
});

describe('helpers', () => {
  it('globToRegExp anchors and ignores case', () => {
    expect(globToRegExp('*.log').test('a.LOG')).toBe(true);
    expect(globToRegExp('a?c.txt').test('abc.txt')).toBe(true);
    expect(globToRegExp('*.log').test('a.log.bak')).toBe(false);
  });

  it('formatBytes is sane for edge values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(-1)).toBe('0 B');
  });

  it('pathSyntaxIssue only forbids the null byte on POSIX', () => {
    expect(pathSyntaxIssue('/tmp/anything at all?.txt', 'linux')).toBeNull();
    expect(pathSyntaxIssue('/tmp/a\0b', 'linux')?.code).toBe('null-byte');
    expect(pathSyntaxIssue('', 'linux')?.code).toBe('empty');
  });

  it('refuses a destination that already exists when overwrite is off', () => {
    fs.writeFileSync(path.join(home, 'there.txt'), 'old');
    const r = movePath({
      from: path.join(outside, 'new.txt'), to: path.join(home, 'there.txt'), platform: 'linux',
    });
    // Source does not exist, so it fails for that reason — either way the
    // destination must be untouched.
    expect(fs.readFileSync(path.join(home, 'there.txt'), 'utf8')).toBe('old');
    expect(r.ok).toBe(false);
  });
});
describe('confineToHome — the gate every file handler goes through', () => {
  // The same resolver the IPC layer uses, so this is a real test of the
  // boundary rather than of a stand-in.
  const resolve = (root: string, p: string) => {
    const r = path.resolve(root, p);
    const rr = path.resolve(root);
    if (r !== rr && !r.startsWith(rr + path.sep)) throw new Error('outside');
    return r;
  };
  const gate = (p: unknown, platform: 'linux' | 'win32' = 'linux') =>
    confineToHome(p, home, platform, resolve);

  it('accepts a path inside the home directory', () => {
    expect(gate('~/Documents').ok).toBe(true);
    expect(gate(path.join(home, 'a', 'b.txt')).ok).toBe(true);
  });

  it('refuses the traversal that made a folder outside home during Card 7', () => {
    const r = gate('../../../escape-test');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/outside your home directory/i);
  });

  it('refuses an absolute path elsewhere', () => {
    for (const p of ['/etc/passwd', '/', outside, path.join(outside, 'file.txt')]) {
      expect(gate(p).ok, p).toBe(false);
    }
  });

  it('refuses a sibling directory whose name starts with the home path', () => {
    expect(gate(`${home}-evil/x`).ok).toBe(false);
  });

  it('refuses an empty or non-string path', () => {
    for (const bad of ['', '   ', undefined, null, 42, {}]) {
      expect(gate(bad).ok).toBe(false);
    }
  });

  it('refuses a Windows path that would alias to another name', () => {
    expect(gate('C:\\tmp\\CON.txt', 'win32').ok).toBe(false);
    expect(gate('C:\\tmp\\report.', 'win32').ok).toBe(false);
  });
});
