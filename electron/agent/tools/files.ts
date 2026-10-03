/**
 * General file tools.
 *
 * Paid 1.7.0 ships ten filesystem tools (tool-registry.ts:151-289). Ours had
 * repo-scoped read/edit only, which is deliberately narrower and approval-
 * gated — so this is an *addition*, not a replacement. `repo_read` and
 * `repo_edit` stay exactly as they are.
 *
 * Two of these are the ones that actually change what the model can do:
 *   - `file_load` puts an image or document into the model turn, which is the
 *     multimodal path we had no equivalent of at all.
 *   - `file_publish` attaches a produced file to the response, which is why we
 *     could never hand a generated file back in the transcript.
 *
 * Safety: reads and writes both go through `resolveUserPath`, which confines
 * everything to the user's home directory and rejects traversal, and writes are
 * create-only by default. Destroys still require approval.
 */
import { promises as fsp, realpathSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import os from 'os';
import type { ToolDefinition, ToolResult } from '../types';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;      // 2 MiB before we call it binary
const MAX_WRITE_BYTES = 20 * 1024 * 1024;     // 20 MiB
const MAX_LIST_ENTRIES = 5000;
const MAX_SEARCH_HITS = 100;

/**
 * Resolve `p` to its real location, tolerating components that do not exist yet.
 *
 * A write target may legitimately not exist, but `realpathSync` throws on a
 * missing path, so walk up to the nearest ancestor that does exist, resolve
 * that, then re-attach the segments that were not there. The result still
 * carries every symlink hop in the existing prefix, which is the part that
 * matters for confinement.
 */
function realpathNearestExisting(p: string): string {
  const tail: string[] = [];
  let probe = p;
  for (;;) {
    try {
      return path.join(realpathSync(probe), ...tail);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return p; // reached the filesystem root; nothing to resolve
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolve a user-supplied path inside their home directory.
 *
 * Relative paths are treated as home-relative so the model can say
 * `Documents/notes.md` rather than guessing an absolute path. Anything that
 * escapes home — via `..`, a symlink, or an absolute path elsewhere — is
 * refused rather than clamped.
 *
 * Symlink escape is enforced by resolving the REAL path and re-checking it
 * against the real home directory, not by string prefix alone. A purely
 * lexical check passes `~/link` even when that symlink points at `/etc/shadow`,
 * which is exactly the case this now refuses.
 */
export function resolveUserPath(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'A path string is required.' };
  }
  const raw = input.trim();
  const home = os.homedir();

  // A Windows drive path is absolute even when we are running on Linux, where
  // path.isAbsolute('C:\\...') is false and the string would otherwise be
  // treated as a relative filename and quietly created inside the home folder.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
    return { ok: false, error: `Refused: ${raw} is an absolute path outside your home directory.` };
  }
  const expanded = raw.startsWith('~')
    ? path.join(home, raw.slice(1).replace(/^[\\/]/, ''))
    : path.isAbsolute(raw)
      ? raw
      : path.join(home, raw);

  const resolved = path.resolve(expanded);
  const root = path.resolve(home);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, error: `Refused: ${raw} is outside your home directory.` };
  }
  // Lexical containment passed; now re-check after following symlinks. The
  // home directory itself may be a symlink (a relocated or network home), so
  // both sides have to be real paths for the comparison to mean anything.
  const realRoot = realpathNearestExisting(root);
  const real = realpathNearestExisting(resolved);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return {
      ok: false,
      error: `Refused: ${raw} resolves outside your home directory through a link.`,
    };
  }
  return { ok: true, path: resolved };
}

function ok(summary: string, data?: unknown): ToolResult {
  return { ok: true, summary, data } as ToolResult;
}
function fail(error: string): ToolResult {
  return { ok: false, summary: '', error } as ToolResult;
}

async function statSafe(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** Cheap binary sniff: a NUL byte in the first 8 KiB is the classic tell. */
async function looksBinary(p: string): Promise<boolean> {
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);

export const fileTools: ToolDefinition[] = [
  {
    name: 'file_list',
    description:
      'List the files and folders at a path. Use to explore before reading. Paths are relative to the home directory unless absolute.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to list. Defaults to the home directory.' } },
    },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const r = resolveUserPath(params.path ?? os.homedir());
      if (!r.ok) return fail(r.error);
      const st = await statSafe(r.path);
      if (!st) return fail(`No such path: ${r.path}`);
      if (!st.isDirectory()) return fail(`Not a directory: ${r.path}`);
      const names = await fsp.readdir(r.path);
      const entries = [];
      for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
        const s = await statSafe(path.join(r.path, name));
        entries.push({ name, kind: s?.isDirectory() ? 'dir' : 'file', size: s?.isFile() ? s.size : undefined });
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
      return ok(`${entries.length} entries in ${r.path}`, entries);
    },
  },

  {
    name: 'file_search',
    description:
      'Search for files by name and, optionally, for text inside them. Slower than file_list — use it when you know what you are looking for but not where.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match in file names, and in contents when content is true.' },
        root: { type: 'string', description: 'Directory to search under. Defaults to the home directory.' },
        content: { type: 'boolean', description: 'Also match inside text files. Defaults to false.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 50.' },
      },
      required: ['query'],
    },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const q = str(params.query).toLowerCase();
      if (!q) return fail('A query is required.');
      const r = resolveUserPath(params.root ?? os.homedir());
      if (!r.ok) return fail(r.error);
      const wantContent = bool(params.content, false);
      const limit = Math.min(num(params.limit, 50), MAX_SEARCH_HITS);
      const hits: { path: string; nameMatch: boolean; line?: number; text?: string }[] = [];
      const skip = new Set(['node_modules', '.git', 'Library', 'AppData', '.cache', '.npm', '.Trash']);

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (hits.length >= limit || depth > 6) return;
        let names: string[];
        try {
          names = await fsp.readdir(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (hits.length >= limit) return;
          if (skip.has(name) || name.startsWith('.')) continue;
          const full = path.join(dir, name);
          const st = await statSafe(full);
          if (!st) continue;
          if (st.isDirectory()) {
            await walk(full, depth + 1);
            continue;
          }
          const nameMatch = name.toLowerCase().includes(q);
          if (nameMatch) {
            hits.push({ path: full, nameMatch: true });
            continue;
          }
          if (wantContent && st.size < MAX_TEXT_BYTES) {
            if (await looksBinary(full)) continue;
            let text = '';
            try {
              text = await fsp.readFile(full, 'utf8');
            } catch {
              continue;
            }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(q)) {
                hits.push({ path: full, nameMatch: false, line: i + 1, text: lines[i].trim().slice(0, 200) });
                break;
              }
            }
          }
        }
      };
      await walk(r.path, 0);
      return ok(`${hits.length} matches for "${q}"`, hits);
    },
  },

  {
    name: 'file_inspect',
    description:
      'Get a file’s size, type and SHA-256 without reading its contents. Use to check what something is before committing to reading it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const r = resolveUserPath(params.path);
      if (!r.ok) return fail(r.error);
      const st = await statSafe(r.path);
      if (!st) return fail(`No such file: ${r.path}`);
      if (st.isDirectory()) return fail(`${r.path} is a directory.`);
      const binary = st.size <= MAX_TEXT_BYTES ? await looksBinary(r.path) : true;
      const hash = createHash('sha256');
      await new Promise<void>((resolve) => {
        const rs = require('fs').createReadStream(r.path);
        rs.on('data', (d: Buffer) => hash.update(d));
        rs.on('end', () => resolve());
        rs.on('error', () => resolve());
      });
      return ok(`${path.basename(r.path)} — ${st.size} bytes, ${binary ? 'binary' : 'text'}`, {
        path: r.path,
        size: st.size,
        modified: st.mtimeMs,
        binary,
        sha256: hash.digest('hex'),
      });
    },
  },

  {
    name: 'file_read',
    description:
      'Read a text file. Optionally a line range — prefer it for large files instead of reading the whole thing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number', description: '1-based first line.' },
        endLine: { type: 'number', description: '1-based last line, inclusive.' },
      },
      required: ['path'],
    },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const r = resolveUserPath(params.path);
      if (!r.ok) return fail(r.error);
      const st = await statSafe(r.path);
      if (!st) return fail(`No such file: ${r.path}`);
      if (st.size > MAX_TEXT_BYTES) {
        return fail(`${r.path} is ${st.size} bytes — too large to read as text. Use file_inspect, or read a line range.`);
      }
      if (await looksBinary(r.path)) return fail(`${r.path} looks binary. Use file_load to put it in the turn.`);
      const text = await fsp.readFile(r.path, 'utf8');
      const lines = text.split('\n');
      const from = Math.max(1, num(params.startLine, 1));
      const to = Math.min(lines.length, num(params.endLine, Math.min(lines.length, from + 1999)));
      const slice = lines.slice(from - 1, to).join('\n');
      return ok(`${path.basename(r.path)} lines ${from}-${to} of ${lines.length}`, { path: r.path, from, to, total: lines.length, text: slice });
    },
  },

  {
    name: 'file_load',
    description:
      'Put an image, PDF or document into the conversation so you can actually look at it. Use this whenever you need to read something that is not plain text — a screenshot, a PDF, a spreadsheet.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, maxBytes: { type: 'number' } },
      required: ['path'],
    },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const r = resolveUserPath(params.path);
      if (!r.ok) return fail(r.error);
      const st = await statSafe(r.path);
      if (!st) return fail(`No such file: ${r.path}`);
      const cap = Math.min(num(params.maxBytes, 8 * 1024 * 1024), 20 * 1024 * 1024);
      if (st.size > cap) return fail(`${r.path} is ${st.size} bytes — over the ${cap} byte limit.`);
      const ext = path.extname(r.path).toLowerCase();
      const buf = await fsp.readFile(r.path);
      const images = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      if (images.includes(ext)) {
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        return ok(`Loaded image ${path.basename(r.path)} (${st.size} bytes) into the turn`, {
          path: r.path, kind: 'image', mime, base64: buf.toString('base64'),
        });
      }
      if (ext === '.pdf') {
        // Extract the text layer without a dependency: PDFs usually carry a
        // FlateDecode stream, and zlib is built into Node.
        try {
          const zlib = require('zlib') as typeof import('zlib');
          const raw = buf.toString('latin1');
          const chunks: string[] = [];
          const re = /stream\r?\n([\s\S]*?)endstream/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(raw)) !== null) {
            try {
              chunks.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('utf8'));
            } catch {
              /* not every stream is flate; skip it */
            }
          }
          const text = chunks
            .join('\n')
            .replace(/\((?:[^()\\]|\\.)*\)/g, ' ')
            .replace(/\\[0-7]{3}/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text.length > 40) {
            return ok(`Loaded ${path.basename(r.path)} — extracted ${text.length} characters of text`, {
              path: r.path, kind: 'pdf', text: text.slice(0, 200_000),
            });
          }
        } catch {
          /* fall through to the note below */
        }
        return fail(`${r.path} has no extractable text layer (it may be a scan). Henry can open it, but cannot read it.`);
      }
      const text = await fsp.readFile(r.path, 'utf8');
      return ok(`Loaded ${path.basename(r.path)} (${text.length} characters)`, {
        path: r.path, kind: 'text', text: text.slice(0, 200_000),
      });
    },
  },

  {
    name: 'file_write',
    description:
      'Create a new file. Fails if something is already there — use file_replace to change an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', description: '"utf8" (default) or "base64".' },
      },
      required: ['path', 'content'],
    },
    category: 'system',
    safetyLevel: 'confirm',
    confirmPrompt: (p) => `Create ${String(p.path)}`,
    execute: async (params) => {
      const r = resolveUserPath(params.path);
      if (!r.ok) return fail(r.error);
      const content = str(params.content);
      const buf = str(params.encoding, 'utf8') === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      if (buf.byteLength > MAX_WRITE_BYTES) return fail(`${buf.byteLength} bytes is over the ${MAX_WRITE_BYTES} byte limit.`);
      // 'wx' fails when the file exists, so this can never clobber by accident.
      try {
        await fsp.writeFile(r.path, buf, { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          return fail(`${r.path} already exists. Use file_replace to change it.`);
        }
        return fail(`Could not write ${r.path}: ${(e as Error).message}`);
      }
      return ok(`Created ${r.path} (${buf.byteLength} bytes)`);
    },
  },

  {
    name: 'file_replace',
    description: 'Replace the entire contents of an existing file. Writes atomically.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    category: 'system',
    safetyLevel: 'confirm',
    confirmPrompt: (p) => `Replace the contents of ${String(p.path)}`,
    execute: async (params) => {
      const r = resolveUserPath(params.path);
      if (!r.ok) return fail(r.error);
      const st = await statSafe(r.path);
      if (!st) return fail(`No such file: ${r.path}. Use file_write to create it.`);
      const content = str(params.content);
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return fail('Content is over the write limit.');
      // Write beside the target and rename, so a crash mid-write cannot leave a
      // half-written file where a working one used to be.
      const tmp = `${r.path}.henry-tmp-${Date.now()}`;
      try {
        await fsp.writeFile(tmp, content, 'utf8');
        await fsp.rename(tmp, r.path);
      } catch (e) {
        try { await fsp.unlink(tmp); } catch { /* nothing to clean */ }
        return fail(`Could not replace ${r.path}: ${(e as Error).message}`);
      }
      return ok(`Replaced ${r.path}`);
    },
  },

  {
    name: 'file_move',
    description: 'Move or rename a file or folder.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    category: 'system',
    safetyLevel: 'confirm',
    confirmPrompt: (p) => `Move ${String(p.from)} to ${String(p.to)}`,
    execute: async (params) => {
      const from = resolveUserPath(params.from);
      if (!from.ok) return fail(from.error);
      const to = resolveUserPath(params.to);
      if (!to.ok) return fail(to.error);
      if (!(await statSafe(from.path))) return fail(`No such path: ${from.path}`);
      if (await statSafe(to.path)) return fail(`${to.path} already exists.`);
      await fsp.mkdir(path.dirname(to.path), { recursive: true });
      await fsp.rename(from.path, to.path);
      return ok(`Moved to ${to.path}`);
    },
  },

  {
    name: 'file_copy',
    description: 'Copy a file or folder. Never overwrites.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const from = resolveUserPath(params.from);
      if (!from.ok) return fail(from.error);
      const to = resolveUserPath(params.to);
      if (!to.ok) return fail(to.error);
      if (!(await statSafe(from.path))) return fail(`No such path: ${from.path}`);
      if (await statSafe(to.path)) return fail(`${to.path} already exists — refusing to overwrite.`);
      await fsp.mkdir(path.dirname(to.path), { recursive: true });
      // COPYFILE_EXCL so a race cannot turn this into a clobber.
      await fsp.cp(from.path, to.path, { recursive: true, force: false, errorOnExist: true });
      return ok(`Copied to ${to.path}`);
    },
  },

  {
    name: 'file_publish',
    description:
      'Attach a file you produced to your answer, so the user can open or save it. Use this at the end of any task that created a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } }, required: ['path'] },
    category: 'system',
    safetyLevel: 'silent',
    execute: async (params) => {
      const r = resolveUserPath(params.path);
      if (!r.ok) return fail(r.error);
      const st = await statSafe(r.path);
      if (!st) return fail(`No such file: ${r.path}`);
      if (!st.isFile()) return fail(`${r.path} is not a file.`);
      return ok(`Published ${path.basename(r.path)} (${st.size} bytes)`, {
        path: r.path, fileName: path.basename(r.path), size: st.size, modified: st.mtimeMs, note: str(params.note),
      });
    },
  },
];