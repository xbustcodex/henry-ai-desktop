/**
 * User-facing file operations — browse, search, copy, move, rename, delete.
 *
 * Parity row 7.6. The only directory operation that reached the main process
 * was `computer:newFolder`, which resolved whatever path it was handed; there
 * was no IPC channel at all for copy, move, rename, delete or search.
 *
 * This module is the *mechanics*. Whether a caller is even allowed to reach it
 * — path confinement, the protected-target list, and the delete confirmation
 * — is decided by `evaluateDeleteRequest` and by the caller in computer.ts,
 * which runs every path through the shared `safeResolve` first.
 *
 * WINDOWS
 * -------
 * Two hard-won lessons are encoded here rather than rediscovered later:
 *
 *  1. Never pipe Windows output through a Unix tool. File listing, searching
 *     and every other operation here use the `fs` API directly. The same
 *     mistake as `tasklist ... | head -40` — which silently produced an empty
 *     process list on Windows — cannot happen when no shell is involved at all.
 *
 *  2. Win32 paths are not POSIX paths. Device names (`CON`, `NUL`, `COM1`…),
 *     characters that are illegal inside a component (`< > : " | ? *`),
 *     trailing dots and spaces (which Win32 silently strips, so `report` and
 *     `report.` are the same file) and drive-relative forms (`C:foo`, which is
 *     relative to that drive's current directory, not to the root) are all
 *     rejected up front. Paths longer than MAX_PATH are prefixed with `\\?\`
 *     so long paths work rather than failing with a bare ENOENT.
 *
 * Paths reach a native tool as *data* — an argv element or an environment
 * variable — never spliced into a command string.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type FilePlatform = 'darwin' | 'linux' | 'win32';

export interface PathOutcome {
  ok: boolean;
  error?: string;
  path?: string;
}

/** Directories under the home folder that must never be deleted wholesale. */
export const PROTECTED_HOME_CHILDREN: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.pki',
  '.gnome2/keyrings',
  'Library/Keychains',
  'Library/Preferences/com.apple.Safari.plist',
];

/** Absolute directories that are never a legal delete target on any platform. */
const NEVER_DELETE_ABSOLUTE: readonly string[] = [
  '/',
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr',
  '/var', '/System', '/Library', '/Applications', '/Users', '/Volumes', '/private',
];

/** Windows directories that are never a legal delete target. */
const NEVER_DELETE_WINDOWS: readonly string[] = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\users',
  'c:\\$recycle.bin',
  'c:\\system volume information',
];

/** Win32 device names. Illegal as a filename on Windows even with an extension. */
const WINDOWS_DEVICE_NAMES: readonly string[] = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

/** MAX_PATH. Beyond this a path needs the `\\?\` prefix to be usable. */
export const WINDOWS_MAX_PATH = 260;

const MAX_PATH_INPUT = 4096;

// ── Path expansion ──────────────────────────────────────────────────────────

/**
 * Turn whatever the caller typed into an absolute path.
 *
 * Handles `~`, `~/x`, `$HOME`, `%USERPROFILE%` and a bare relative path.
 * Returns the input untouched when nothing applies, so the caller can then
 * run it through the confinement check against a known root.
 */
export function expandUserPath(requested: string, home: string, platform: FilePlatform): string {
  let p = requested.trim();
  if (!p) return p;

  if (platform === 'win32') {
    const envHome = process.env.USERPROFILE;
    if (envHome) {
      p = p.replace(/%USERPROFILE%/gi, envHome);
    }
  }
  p = p.replace(/^~(?=$|[\\/])/, home);
  if (p === '~') p = home;
  p = p.replace(/^\$HOME(?=$|[\\/])/, home);
  p = p.replace(/^\$\{HOME\}(?=$|[\\/])/, home);
  return p;
}


/**
 * Resolve a path the way the *target* platform would, not the way the host
 * does.
 *
 * `path.resolve('C:\\Windows')` on Linux treats the string as a filename and
 * prefixes it with the current directory, so a comparison against the Windows
 * system-folder list silently never matched. Anywhere a path is inspected for
 * safety, an already-absolute Windows path must be left alone.
 */
export function resolveForPlatform(p: string, platform: FilePlatform): string {
  if (platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'))) {
    return p.replace(/\//g, '\\');
  }
  return path.resolve(p);
}

/** Strip a `\\?\` prefix so validation and comparison see a normal path. */
export function stripLongPathPrefix(p: string, platform: FilePlatform): string {
  if (platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

export type ConfineOutcome =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * The single gate every user-facing file operation goes through.
 *
 * Expands `~`, rejects Win32 syntax that would alias to another name, hands
 * the traversal/sibling-prefix/symlink decision to the caller's `safeResolve`
 * (passed in rather than imported, so this module stays free of any dependency
 * on the IPC layer), and applies the extended-length prefix for long Windows
 * paths. The return is absolute and safe to open.
 */
export function confineToHome(
  requested: unknown,
  home: string,
  platform: FilePlatform,
  resolve: (root: string, p: string) => string,
): ConfineOutcome {
  if (typeof requested !== 'string' || !requested.trim()) {
    return { ok: false, error: 'A path is required.' };
  }
  const raw = requested.trim();
  const expanded = expandUserPath(raw, home, platform);

  const syntax = pathSyntaxIssue(expanded, platform);
  if (syntax) return { ok: false, error: `Refused: ${syntax.message}` };

  try {
    return { ok: true, path: toLongPath(resolve(home, expanded), platform) };
  } catch {
    return { ok: false, error: `Refused: ${raw} is outside your home directory.` };
  }
}

/**
 * Add the `\\?\` prefix so a path longer than MAX_PATH works.
 *
 * Without it Windows reports a bare ENOENT for a file that plainly exists,
 * which reads as "the file is missing" rather than "the path is too long".
 */
export function toLongPath(p: string, platform: FilePlatform): string {
  if (platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  if (p.length <= WINDOWS_MAX_PATH) return p;
  if (p.startsWith('\\\\')) return `\\\\?\\UNC\\${p.slice(2)}`;
  return `\\\\?\\${p}`;
}

// ── Windows path syntax ─────────────────────────────────────────────────────

export interface PathSyntaxIssue {
  code: 'empty' | 'null-byte' | 'too-long' | 'drive-relative' | 'device-name' |
        'illegal-character' | 'trailing-dot-or-space' | 'empty-component' | 'wildcard';
  message: string;
}

/**
 * Reject Win32 paths that would alias, collide or silently mean something
 * other than they look like.
 *
 * Returns `null` when the path is usable. The checks are the ones that bite:
 * `NUL.txt` is the null device, not a file; `report.` and `report` are the same
 * file; `C:foo` is relative to the drive's current directory; and `*` would
 * be a glob to a shell but is a syntax error to the Win32 API.
 */
export function windowsPathSyntaxIssue(p: string): PathSyntaxIssue | null {
  if (!p || p.trim() === '') return { code: 'empty', message: 'A path is required.' };
  if (p.includes('\0')) return { code: 'null-byte', message: 'A path cannot contain a null byte.' };

  const unc = p.startsWith('\\\\');
  const withoutRoot = unc ? p.slice(2) : p.replace(/^[a-zA-Z]:/, '');
  const components = withoutRoot.split(/[\\/]+/).filter((c) => c !== '');

  if (!unc && /^[a-zA-Z]:[^\\/]/.test(p)) {
    return {
      code: 'drive-relative',
      message: `"${p.slice(0, 40)}" is drive-relative (C:foo). Use an absolute path such as C:\\foo.`,
    };
  }
  if (components.length === 0) {
    return { code: 'empty-component', message: 'That path has no file or folder in it.' };
  }

  for (const component of components) {
    if (/[*?]/.test(component)) {
      return { code: 'wildcard', message: 'Wildcards are not accepted in a path; search or list instead.' };
    }
    const illegal = /[<>:"|]/.exec(component.replace(/^[^:]*:/, ''));
    if (illegal) {
      return {
        code: 'illegal-character',
        message: `"${illegal[0]}" is not allowed in a Windows file or folder name.`,
      };
    }
    if (/[. ]$/.test(component)) {
      return {
        code: 'trailing-dot-or-space',
        message: `"${component.slice(-12)}" ends in a dot or space, which Windows strips — it would collide with another name.`,
      };
    }
    // `CON.txt` is still the console device: the base name before the first dot
    // is what Win32 checks.
    const base = component.split('.')[0].toUpperCase();
    if (WINDOWS_DEVICE_NAMES.includes(base)) {
      return { code: 'device-name', message: `"${component.slice(0, 24)}" is a reserved Windows device name.` };
    }
  }

  if (p.length > WINDOWS_MAX_PATH) {
    return {
      code: 'too-long',
      message: `Path is ${p.length} characters; Windows paths beyond ${WINDOWS_MAX_PATH} need extended-length syntax, which this operation applies automatically.`,
    };
  }
  return null;
}

/**
 * Platform path syntax check. On POSIX only the null byte and length are
 * forbidden, so this returns `null` for a normal path there.
 */
export function pathSyntaxIssue(p: string, platform: FilePlatform): PathSyntaxIssue | null {
  if (platform === 'win32') return windowsPathSyntaxIssue(p);
  if (!p || p.trim() === '') return { code: 'empty', message: 'A path is required.' };
  if (p.includes('\0')) return { code: 'null-byte', message: 'A path cannot contain a null byte.' };
  if (p.length > MAX_PATH_INPUT) {
    return { code: 'too-long', message: `Path is too long (${p.length} characters).` };
  }
  return null;
}

// ── Delete protection ───────────────────────────────────────────────────────

export interface DeleteRequest {
  /** Already-resolved, already-confined absolute path. */
  target: string;
  /** The user's home directory — the confinement root. */
  home: string;
  platform: FilePlatform;
  /** Skip the recycle bin / trash and unlink for real. */
  permanent?: boolean;
  /** The caller has asked the user and the user said yes. */
  confirmed?: boolean;
  /** Treat a directory as recursive. */
  recursive?: boolean;
  /** When true a missing target is an error rather than a no-op. */
  requireExists?: boolean;
}

export type DeleteDecision =
  | { ok: true; target: string; permanent: boolean }
  | { ok: false; error: string; needsConfirmation?: true; summary?: string };

/**
 * Decide whether a delete may proceed.
 *
 * The order matters. Protection comes first and is unconditional: even a
 * confirmed request cannot delete the home folder, an ancestor of it, a system
 * directory, or a folder holding the user's keys. Only after that does the
 * confirmation requirement apply, and only to targets that survived.
 *
 * Delete is recoverable by default — the target goes to the platform's trash
 * or recycle bin, and `permanent` is required to unlink it outright.
 */
export function evaluateDeleteRequest(req: DeleteRequest): DeleteDecision {
  const platform = req.platform;
  const target = stripLongPathPrefix(req.target, platform);
  const home = stripLongPathPrefix(resolveForPlatform(req.home, platform), platform);

  const syntax = pathSyntaxIssue(target, platform);
  if (syntax) return { ok: false, error: syntax.message };

  // Never the home folder itself, and never anything that contains it.
  if (samePath(target, home, platform)) {
    return { ok: false, error: 'Refused: that is your home folder. Deleting it would remove everything.' };
  }
  if (isAncestor(target, home, platform)) {
    return { ok: false, error: 'Refused: that folder contains your home directory.' };
  }

  const blocked = protectedTargetReason(target, home, platform);
  if (blocked) return { ok: false, error: blocked };

  // A symlink whose real location is outside home is an escape hatch, not a
  // file the user means to delete.
  const real = realpathOrSelf(target);
  if (real && !isInside(real, home, platform)) {
    return {
      ok: false,
      error: 'Refused: that path resolves through a link to somewhere outside your home directory.',
    };
  }

  const exists = fs.existsSync(real ?? target);
  if (req.requireExists && !exists) {
    return { ok: false, error: 'That file or folder no longer exists.' };
  }

  if (!req.confirmed) {
    return {
      ok: false,
      needsConfirmation: true,
      summary: describeTarget(target, req.recursive === true),
      error: 'Deleting needs confirmation. Ask the user, then call again with confirmed: true.',
    };
  }

  return { ok: true, target: real ?? target, permanent: req.permanent === true };
}

/**
 * Why a path is off-limits regardless of confirmation, or null when it is
 * an ordinary file in the user's own home folder.
 */
export function protectedTargetReason(
  target: string,
  home: string,
  platform: FilePlatform,
): string | null {
  const normalised = stripLongPathPrefix(resolveForPlatform(target, platform), platform);

  if (platform === 'win32') {
    const lower = normalised.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
    for (const banned of NEVER_DELETE_WINDOWS) {
      if (lower === banned) return `Refused: ${banned} is a Windows system folder.`;
    }
    // A bare drive root — C:\ — takes the whole volume with it.
    if (/^[a-z]:$/.test(lower)) return `Refused: ${normalised} is the root of a drive.`;
  } else {
    for (const banned of NEVER_DELETE_ABSOLUTE) {
      if (normalised === banned || normalised === banned + path.sep) {
        return `Refused: ${banned} is a system folder.`;
      }
    }
  }

  const relative = relativeInside(normalised, home, platform);
  if (relative === null) return null; // outside home — the caller refuses it anyway

  const segments = relative.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  for (const protectedPath of PROTECTED_HOME_CHILDREN) {
    const wanted = protectedPath.toLowerCase().split('/');
    const matches = wanted.every((seg, i) => segments[i] === seg);
    if (matches) {
      return `Refused: ${protectedPath} holds your keys and credentials.`;
    }
  }
  return null;
}

function describeTarget(target: string, recursive: boolean): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return target;
  }
  if (!stat.isDirectory()) return `${target} — file, ${formatBytes(stat.size)}`;
  const count = countEntries(target, 12);
  return `${target} — folder${count ? `, about ${count}${recursive ? '+' : ''} items` : ''}`;
}

/** Bounded entry count so describing a huge folder cannot hang the UI. */
function countEntries(dir: string, limit: number): number {
  let n = 0;
  try {
    for (const _ of fs.readdirSync(dir)) {
      n += 1;
      if (n >= limit) return limit;
    }
  } catch {
    return 0;
  }
  return n;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

// ── Path comparison that is correct on every platform ───────────────────────

/**
 * Compare two paths for equality the way the OS would.
 *
 * On Windows the filesystem is case-insensitive and uses backslashes; on
 * POSIX it is case-sensitive and uses forward slashes. Getting this backwards
 * is how a "delete C:\Users\Me" check ends up protecting `c:\users\me` only.
 */
export function samePath(a: string, b: string, platform: FilePlatform): boolean {
  return canonical(a, platform) === canonical(b, platform);
}

/** True when `maybeAncestor` contains `child`. */
export function isAncestor(maybeAncestor: string, child: string, platform: FilePlatform): boolean {
  const a = canonical(maybeAncestor, platform);
  const c = canonical(child, platform);
  return c === a || c.startsWith(a.endsWith(sepFor(platform)) ? a : a + sepFor(platform));
}

/** True when `target` is `root` itself or sits inside it. */
export function isInside(target: string, root: string, platform: FilePlatform): boolean {
  const t = canonical(target, platform);
  const r = canonical(root, platform);
  return t === r || t.startsWith(r.endsWith(sepFor(platform)) ? r : r + sepFor(platform));
}

/** Path of `target` relative to `root`, or null when it is not inside. */
export function relativeInside(target: string, root: string, platform: FilePlatform): string | null {
  if (!isInside(target, root, platform)) return null;
  const r = canonical(root, platform);
  const t = canonical(target, platform);
  return t === r ? '' : t.slice(r.length).replace(/^[/\\]+/, '');
}

function sepFor(platform: FilePlatform): string {
  return platform === 'win32' ? '\\' : '/';
}

function canonical(p: string, platform: FilePlatform): string {
  const stripped = stripLongPathPrefix(p, platform);
  const unified = platform === 'win32' ? stripped.replace(/\//g, '\\') : stripped;
  const trimmed = unified.length > 1 ? unified.replace(/[\\/]+$/, '') : unified;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function realpathOrSelf(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // Windows frequently refuses realpath on a path it considers too long.
    return null;
  }
}

// ── Browse ──────────────────────────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  size?: number;
  modified?: number;
}

export interface BrowseResult {
  ok: boolean;
  error?: string;
  path?: string;
  parent?: string | null;
  entries?: BrowseEntry[];
  truncated?: boolean;
}

export interface BrowseOptions {
  /** Show dotfiles and hidden/system entries. */
  showHidden?: boolean;
  /** Hard cap on returned entries. */
  limit?: number;
}

const DEFAULT_BROWSE_LIMIT = 2000;

export function browseDirectory(dir: string, opts: BrowseOptions = {}): BrowseResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    return { ok: false, error: `Cannot open that folder: ${errorMessage(e)}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'That path is a file, not a folder.' };

  let raw: fs.Dirent[];
  try {
    raw = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `Cannot read that folder: ${errorMessage(e)}` };
  }

  const limit = Math.max(1, Math.min(DEFAULT_BROWSE_LIMIT, opts.limit ?? DEFAULT_BROWSE_LIMIT));
  const entries: BrowseEntry[] = [];
  for (const dirent of raw) {
    if (!opts.showHidden && dirent.name.startsWith('.')) continue;
    if (entries.length >= limit) {
      return {
        ok: true,
        path: dir,
        parent: parentOf(dir),
        entries: sortEntries(entries),
        truncated: true,
      };
    }
    const full = path.join(dir, dirent.name);
    const entry: BrowseEntry = {
      name: dirent.name,
      path: full,
      kind: dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file',
    };
    // Best effort: an entry we cannot stat is still worth listing by name.
    try {
      const s = fs.statSync(full);
      if (s.isFile()) entry.size = s.size;
      entry.modified = s.mtimeMs;
    } catch {
      /* leave size/modified unset */
    }
    entries.push(entry);
  }

  return {
    ok: true,
    path: dir,
    parent: parentOf(dir),
    entries: sortEntries(entries),
    truncated: false,
  };
}

/** Folders first, then names — the order a file manager shows. */
function sortEntries(entries: BrowseEntry[]): BrowseEntry[] {
  return entries.sort((a, b) => {
    const aDir = a.kind === 'directory' ? 0 : 1;
    const bDir = b.kind === 'directory' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function parentOf(dir: string): string | null {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Case-insensitive substring or `*`/`?` glob over the file name. */
  query: string;
  /** How deep to walk. */
  maxDepth?: number;
  /** Stop after this many matches. */
  maxResults?: number;
  /** Include dotfiles and hidden folders. */
  includeHidden?: boolean;
  /** Also look inside text files for the query. */
  content?: boolean;
  /** Bytes of each file to read when `content` is set. */
  contentBytes?: number;
}

export interface SearchHit {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  /** Line numbers that matched, when `content` was requested. */
  lines?: number[];
}

export interface SearchResult {
  ok: boolean;
  error?: string;
  hits?: SearchHit[];
  truncated?: boolean;
  scanned?: number;
}

const DEFAULT_SEARCH_DEPTH = 8;
const DEFAULT_SEARCH_LIMIT = 200;
const DEFAULT_CONTENT_BYTES = 512 * 1024;

/** Never follow these while walking: huge, irrelevant, or loops. */
const SEARCH_SKIP_DIRS: readonly string[] = [
  'node_modules', '.git', '.hg', '.svn', '.cache', '__pycache__',
  '.venv', 'venv', 'dist', 'build', 'target', '.next', '.gradle',
];

export function searchPath(root: string, opts: SearchOptions): SearchResult {
  const needle = opts.query.trim().toLowerCase();
  if (!needle) return { ok: false, error: 'A search term is required.' };
  const useGlob = needle.includes('*') || needle.includes('?');
  const matcher = useGlob ? globToRegExp(needle) : null;

  const maxDepth = Math.max(0, Math.min(32, opts.maxDepth ?? DEFAULT_SEARCH_DEPTH));
  const maxResults = Math.max(1, Math.min(5000, opts.maxResults ?? DEFAULT_SEARCH_LIMIT));
  const contentBytes = Math.max(0, Math.min(8 * 1024 * 1024, opts.contentBytes ?? DEFAULT_CONTENT_BYTES));

  const hits: SearchHit[] = [];
  let scanned = 0;
  let truncated = false;

  // Every directory is visited at most once by its *real* location, so a
  // symlinked folder pointing back up the tree — or a Windows junction pointing
  // anywhere at all — cannot turn the walk into an infinite loop.
  const visited = new Set<string>([canonicalRealDir(root)]);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable folder — skip it rather than failing the search.
    }
    for (const dirent of entries) {
      if (hits.length >= maxResults) {
        truncated = true;
        break;
      }
      if (!opts.includeHidden && dirent.name.startsWith('.')) continue;

      const full = path.join(dir, dirent.name);
      const isDir = dirent.isDirectory();
      scanned += 1;

      const nameMatches = matcher ? matcher.test(dirent.name.toLowerCase()) : dirent.name.toLowerCase().includes(needle);
      if (nameMatches) {
        hits.push({ path: full, name: dirent.name, kind: isDir ? 'directory' : 'file' });
      }

      if (!isDir && opts.content && !nameMatches && contentBytes > 0) {
        const lines = grepFile(full, needle, contentBytes);
        if (lines.length > 0) hits.push({ path: full, name: dirent.name, kind: 'file', lines });
      }

      if (!isDir || depth >= maxDepth) continue;
      if (SEARCH_SKIP_DIRS.includes(dirent.name.toLowerCase())) continue;

      const real = canonicalRealDir(full);
      if (visited.has(real)) continue;
      visited.add(real);
      queue.push({ dir: full, depth: depth + 1 });
    }
    if (truncated) break;
  }

  return { ok: true, hits, truncated, scanned };
}

/** Translate a `*`/`?` glob into an anchored, case-insensitive regexp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Real location of a directory, normalised for loop detection. */
function canonicalRealDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * Line numbers containing `needle` in a file, reading only the first
 * `maxBytes`. A binary or unreadable file yields no matches rather than
 * throwing — that is the normal case for a content search over a home folder.
 */
function grepFile(file: string, needle: string, maxBytes: number): number[] {
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(fs.fstatSync(fd).size, maxBytes);
      buf = Buffer.alloc(size);
      if (size === 0) return [];
      fs.readSync(fd, buf, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  // Null bytes mean binary; a content search has nothing useful to say.
  const window = buf.subarray(0, Math.min(buf.length, 8000));
  if (window.includes(0)) return [];

  const text = buf.toString('utf8');
  const lines: number[] = [];
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (line.toLowerCase().includes(needle)) {
      lines.push(lineNumber);
      if (lines.length >= 20) break;
    }
  }
  return lines;
}

// ── Copy / move / rename ────────────────────────────────────────────────────

export interface TransferRequest {
  from: string;
  to: string;
  /** Allow replacing an existing destination. Off by default. */
  overwrite?: boolean;
  platform: FilePlatform;
}

export type TransferResult =
  | { ok: true; from: string; to: string; kind: 'file' | 'directory' }
  | { ok: false; error: string };

/**
 * Copy a file or folder.
 *
 * Refuses to overwrite by default. That is deliberate: an agent asked to
 * "save this report" must not silently destroy the previous one.
 */
export function copyPath(req: TransferRequest): TransferResult {
  const { from, to, overwrite, platform } = req;
  for (const [label, p] of [['source', from], ['destination', to]] as const) {
    const issue = pathSyntaxIssue(p, platform);
    if (issue) return { ok: false, error: `Bad ${label}: ${issue.message}` };
  }
  if (!fs.existsSync(from)) return { ok: false, error: 'The source no longer exists.' };

  const kind = statKind(from);
  if (kind === null) return { ok: false, error: 'Cannot read the source.' };
  if (samePath(from, to, platform)) return { ok: false, error: 'Source and destination are the same place.' };

  if (isAncestor(to, from, platform) && kind === 'directory') {
    return { ok: false, error: 'Refused: a folder cannot be copied inside itself.' };
  }
  if (exists(to) && !overwrite) {
    return { ok: false, error: 'Something is already there — refusing to overwrite it.' };
  }
  if (kind === 'directory' && exists(to)) {
    // cp into an existing folder nests; remove it first so `overwrite` means
    // "replace", matching what the caller asked for.
    try {
      fs.rmSync(to, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: `Cannot replace the destination: ${errorMessage(e)}` };
    }
  }

  try {
    fs.cpSync(from, to, { recursive: kind === 'directory', force: overwrite === true, errorOnExist: !overwrite });
    return { ok: true, from, to, kind };
  } catch (e) {
    return { ok: false, error: `Copy failed: ${errorMessage(e)}` };
  }
}

/**
 * Move or rename.
 *
 * `rename` is atomic within a volume and fails with EXDEV across one, so that
 * case falls back to copy-then-remove rather than reporting a failure the user
 * cannot act on.
 */
export function movePath(req: TransferRequest): TransferResult {
  const { from, to, overwrite, platform } = req;
  for (const [label, p] of [['source', from], ['destination', to]] as const) {
    const issue = pathSyntaxIssue(p, platform);
    if (issue) return { ok: false, error: `Bad ${label}: ${issue.message}` };
  }
  if (!fs.existsSync(from)) return { ok: false, error: 'The source no longer exists.' };

  const kind = statKind(from);
  if (kind === null) return { ok: false, error: 'Cannot read the source.' };
  if (samePath(from, to, platform)) return { ok: false, error: 'Source and destination are the same place.' };
  if (isAncestor(to, from, platform) && kind === 'directory') {
    return { ok: false, error: 'Refused: a folder cannot be moved inside itself.' };
  }
  if (exists(to) && !overwrite) {
    return { ok: false, error: 'Something is already there — refusing to overwrite it.' };
  }

  try {
    fs.renameSync(from, to);
    return { ok: true, from, to, kind };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM') {
      return { ok: false, error: `Move failed: ${errorMessage(e)}` };
    }
  }

  // Cross-volume: copy then remove, so the user keeps their data either way.
  const copied = copyPath({ from, to, overwrite: true, platform });
  if (!copied.ok) return copied;
  try {
    fs.rmSync(from, { recursive: kind === 'directory', force: false });
  } catch (e) {
    return {
      ok: false,
      error: `Copied to the new place but could not remove the original: ${errorMessage(e)}`,
    };
  }
  return { ok: true, from, to, kind };
}

/**
 * Rename in place.
 *
 * Separated from move because it is the one filesystem action a user reaches
 * for constantly and the one where a surprising result is most annoying: the
 * destination is always the same folder as the source, so it can never
 * escape anywhere the caller did not already intend.
 */
export function renamePath(target: string, newName: string, platform: FilePlatform): TransferResult {
  const issue = pathSyntaxIssue(newName, platform);
  if (issue) return { ok: false, error: `Bad name: ${issue.message}` };
  if (newName !== newName.trim()) return { ok: false, error: 'A name cannot start or end with a space.' };
  if (newName.includes('/') || newName.includes('\\')) {
    return { ok: false, error: 'A new name cannot contain a path separator — that is a move, not a rename.' };
  }
  if (!fs.existsSync(target)) return { ok: false, error: 'That file or folder no longer exists.' };
  return movePath({
    from: target,
    to: path.join(path.dirname(target), newName),
    overwrite: false,
    platform,
  });
}

// ── Delete ──────────────────────────────────────────────────────────────────

export interface DeleteExecution {
  ok: boolean;
  error?: string;
  /** `true` when the item went to the trash/recycle bin, `false` when unlinked. */
  recoverable?: boolean;
  path?: string;
}

/**
 * Perform a delete that `evaluateDeleteRequest` has already approved.
 *
 * Recoverable by default. The trash backend per platform:
 *   darwin  Finder via AppleScript
 *   linux   `gio trash`, falling back to `trash-put`
 *   win32   `Microsoft.VisualBasic.FileIO` Recycle Bin
 *
 * Every path is handed to those tools as data — an argv element or an
 * environment variable — so a folder called `a"; rm -rf ~; "` cannot turn
 * into a command.
 */
export async function executeDelete(
  decision: { target: string; permanent: boolean },
  platform: FilePlatform,
): Promise<DeleteExecution> {
  const target = decision.target;

  if (!decision.permanent) {
    const trashed = await moveToTrash(target, platform);
    if (trashed.ok) return { ok: true, recoverable: true, path: target };
    // No trash backend here: report it rather than silently unlinking.
    return {
      ok: false,
      error: `No trash is available on this system, so nothing was deleted: ${trashed.error ?? 'unknown reason'}`,
    };
  }

  const isDir = (() => {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  })();
  try {
    fs.rmSync(target, { recursive: isDir, force: false });
    return { ok: true, recoverable: false, path: target };
  } catch (e) {
    return { ok: false, error: `Delete failed: ${errorMessage(e)}` };
  }
}

async function moveToTrash(target: string, platform: FilePlatform): Promise<{ ok: boolean; error?: string }> {
  if (platform === 'win32') {
    // The path arrives through the environment, never inside the script text.
    const r = await runCapture(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName Microsoft.VisualBasic; '
          + '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('
          + '$env:HENRY_TRASH_PATH, '
          + "'OnlyErrorDialogs', 'SendToRecycleBin')",
      ],
      { HENRY_TRASH_PATH: target },
    );
    return r;
  }
  if (platform === 'darwin') {
    const literal = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return runCapture('osascript', ['-e', `tell application "Finder" to delete POSIX file "${literal}"`]);
  }
  const gio = await runCapture('gio', ['trash', '--', target]);
  if (gio.ok) return gio;
  return runCapture('trash-put', ['--', target]);
}

function runCapture(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
    child.on('close', (code: number | null) =>
      resolve({ ok: code === 0, error: code === 0 ? undefined : stderr.trim() || `exit ${code}` }),
    );
  });
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export type CreateFolderResult =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; error: string };

/**
 * Create a folder, refusing to treat an existing file as a success.
 *
 * `mkdirSync(recursive)` returns the created path (or undefined) without
 * complaining when the directory exists, so a file sitting at that path used to
 * read as "folder created" and the failure only surfaced much later.
 */
export function createFolder(target: string): CreateFolderResult {
  if (exists(target)) {
    try {
      if (fs.statSync(target).isDirectory()) return { ok: true, path: target, existed: true };
    } catch {
      /* fall through to the error below */
    }
    return { ok: false, error: 'Something that is not a folder already has that name.' };
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target, existed: false };
  } catch (e) {
    return { ok: false, error: `Could not create that folder: ${errorMessage(e)}` };
  }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function statKind(p: string): 'file' | 'directory' | null {
  try {
    const s = fs.statSync(p);
    if (s.isDirectory()) return 'directory';
    if (s.isFile()) return 'file';
    return null;
  } catch {
    return null;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** The home directory this module confines everything to. */
export function homeDir(): string {
  return os.homedir();
}