import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Dependency probing for every platform.
 *
 * Two things this exists to get right, both of which were wrong on Windows:
 *
 * 1. No shell redirections. The old probe ran `<cmd> --version 2>/dev/null`
 *    through execSync. On Windows execSync uses cmd.exe, which has no
 *    /dev/null — the command failed with "The system cannot find the path
 *    specified", the throw was swallowed, and a perfectly healthy Node.js and
 *    Git were reported as "not installed" with an offer to install them.
 *    stderr is discarded with stdio here instead, which is portable.
 *
 * 2. Nothing blocks. execSync/execFileSync freeze the Electron main process
 *    for up to the timeout, which is what made the installed app report
 *    "Not Responding" while a diagnostic ran. Everything below is async.
 *
 * A probe also refuses to collapse "I could not check" into "you do not have
 * it", because those two produce opposite advice for the user.
 */

export type ProbeState =
  /** Found, and ran. We know what it is and which version. */
  | 'installed'
  /** Genuinely absent: nothing on PATH, no registry entry, no known location. */
  | 'missing'
  /** Present, but we could not pin down where. Do not tell the user to install. */
  | 'unresolved'
  /** The probe itself failed (spawn error, timeout, permission). NOT the same as missing. */
  | 'probe-failed';

export interface ToolProbe {
  state: ProbeState;
  version?: string;
  path?: string;
  /** Why the state is unresolved/probe-failed. Safe to show the user. */
  reason?: string;
}

const IS_WIN = process.platform === 'win32';
const LOOKUP = IS_WIN ? 'where' : 'which';

/** Directories Windows installers actually use, derived from env — never hardcoded. */
function windowsSearchDirs(exe: string): string[] {
  if (!IS_WIN) return [];
  const bases = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.ProgramData,
  ].filter(Boolean) as string[];
  const rels = [
    ['', ''],
    ['Programs', ''],
    ['bin', ''],
    ['cmd', ''],
  ];
  const out: string[] = [];
  for (const b of bases) for (const [a] of rels) out.push(path.join(b, a));
  // Common nested layouts, e.g. Programs\nodejs, Git\cmd, ...
  return out.map((d) => path.join(d, exe)).filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** Ask the Windows registry where an executable lives, honouring App Paths. */
async function registryAppPath(exe: string): Promise<string | null> {
  if (!IS_WIN) return null;
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const k of keys) {
    const found = await run('reg', ['query', k, '/ve'], 4000).catch(() => null);
    if (found && found.code === 0) {
      const m = /REG_SZ\s+(.+)/i.exec(found.stdout);
      if (m) {
        const p = m[1].trim().replace(/^"|"$/g, '');
        if (p && fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function run(cmd: string, args: string[], timeout: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          // ENOENT and friends: the binary itself is not runnable here.
          reject(err);
          return;
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

/** Resolve a bare command name to an absolute path, or null. Never throws. */
export async function resolveBin(cmd: string): Promise<string | null> {
  const bare = cmd.replace(/^["']|["']$/g, '');
  try {
    const r = await run(LOOKUP, [bare], 4000);
    if (r.code === 0) {
      const first = r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)[0];
      if (first) return first;
    }
  } catch {
    /* not on PATH — fall through to the other resolvers */
  }
  if (!IS_WIN) return null;
  const reg = await registryAppPath(path.basename(bare));
  if (reg) return reg;
  const exe = /\.[a-z0-9]+$/i.test(bare) ? path.basename(bare) : `${path.basename(bare)}.exe`;
  const dirs = windowsSearchDirs(exe);
  return dirs[0] ?? null;
}

/**
 * Locate a dependency and read its version, reporting honestly which of the
 * four states it landed in.
 */
export async function probeTool(
  cmd: string,
  opts: { versionFlag?: string; pathHint?: string } = {}
): Promise<ToolProbe> {
  const versionFlag = opts.versionFlag ?? '--version';
  let resolved: string | null = opts.pathHint ?? null;

  if (!resolved) {
    try {
      resolved = await resolveBin(cmd);
    } catch (e) {
      return { state: 'probe-failed', reason: `could not search for ${cmd}: ${(e as Error).message}` };
    }
  }

  if (!resolved) return { state: 'missing' };

  let exists = false;
  try {
    exists = fs.existsSync(resolved);
  } catch {
    exists = false;
  }
  if (!exists) {
    // `where` matched something that is not there. We cannot honestly call
    // this "missing" — we only know the pointer did not resolve.
    return { state: 'unresolved', path: resolved, reason: `found ${resolved} but that path does not exist` };
  }

  let version: string;
  try {
    const r = await run(resolved, [versionFlag], 6000);
    version = (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] ?? '';
    if (r.code !== 0 && !version) {
      return {
        state: 'probe-failed',
        path: resolved,
        reason: `${path.basename(resolved)} ran but returned no version (exit ${r.code})`,
      };
    }
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? `${resolved} disappeared before it could run`
      : `${path.basename(resolved)} could not be executed: ${(e as Error).message}`;
    return { state: 'probe-failed', path: resolved, reason: msg };
  }

  if (!version) {
    return { state: 'unresolved', path: resolved, reason: `${path.basename(resolved)} ran but printed no version` };
  }
  return { state: 'installed', version, path: resolved };
}

/** One-line, user-facing summary of a probe. */
export function describeProbe(probe: ToolProbe, label: string): string {
  switch (probe.state) {
    case 'installed':
      return probe.version ?? `${label} installed`;
    case 'missing':
      return `${label} not installed`;
    case 'unresolved':
      return `${label} present but location unresolved${probe.reason ? ` (${probe.reason})` : ''}`;
    case 'probe-failed':
      return `${label} could not be verified${probe.reason ? ` — ${probe.reason}` : ''}. This does not mean it is missing.`;
  }
}

/** True only when we actually know it is absent. */
export function isGenuinelyMissing(probe: ToolProbe): boolean {
  return probe.state === 'missing';
}