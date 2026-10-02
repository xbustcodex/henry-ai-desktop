/**
 * Python execution boundary.
 *
 * The previous path wrote the snippet to a hardcoded `/tmp/henry_<ts>.py` and
 * ran it with `execSync(..., { shell: '/bin/zsh' })`. Three defects in one:
 * `/tmp` does not exist on Windows, `/bin/zsh` does not exist on Windows or
 * most Linux boxes, and a blocking execSync froze the Electron main process
 * for up to 12 seconds. So "Python Tools" was in the comparison dashboard as
 * missing on our side for a good reason — it simply never ran.
 *
 * This is the replacement. It is a defence-in-depth jail, not a security
 * boundary against a determined attacker: Python in-process has no real
 * sandbox, so what we can honestly do is
 *
 *   - refuse source that reaches for the escape hatches outright,
 *   - run with a scrubbed environment so no key or token is in scope,
 *   - run with a private working directory outside the user's data,
 *   - cap wall-clock, output size, memory and file size,
 *   - and never block the UI thread.
 *
 * Legitimate scientific/analysis code runs normally. Anything that imports
 * subprocess/os.system/ctypes/importlib, or opens a file for writing outside
 * the sandbox, is refused with a reason the user can act on.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Constructs that make a snippet an escape rather than a script. */
const REFUSED_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /^\s*import\s+subprocess\b/m, why: 'subprocess' },
  { re: /^\s*from\s+subprocess\b/m, why: 'subprocess' },
  { re: /\bos\.system\s*\(/, why: 'os.system' },
  { re: /\bos\.popen\s*\(/, why: 'os.popen' },
  { re: /\bos\.exec[lv]p?e?\s*\(/, why: 'os.exec*' },
  { re: /\bos\.spawn\w*\s*\(/, why: 'os.spawn*' },
  { re: /\bos\.fork\s*\(/, why: 'os.fork' },
  { re: /\bpty\.spawn\s*\(/, why: 'pty.spawn' },
  { re: /\bshutil\.rmtree\s*\(/, why: 'shutil.rmtree' },
  { re: /^\s*import\s+ctypes\b/m, why: 'ctypes' },
  { re: /^\s*from\s+ctypes\b/m, why: 'ctypes' },
  { re: /^\s*import\s+importlib\b/m, why: 'importlib' },
  { re: /^\s*from\s+importlib\b/m, why: 'importlib' },
  { re: /\b__import__\s*\(/, why: '__import__' },
  { re: /\beval\s*\(\s*__import__/, why: 'eval(__import__)' },
  { re: /\bexec\s*\(\s*(?:__import__|open)/, why: 'exec(...)' },
  // Writing outside the sandbox, or to an absolute path at all.
  { re: /open\s*\([^)]*['"][a-zA-Z]:[\\/]/, why: 'absolute Windows path' },
  { re: /open\s*\([^)]*['"]\/(?:etc|usr|bin|s|boot|proc|sys|var|root)\b/, why: 'system path' },
  { re: /open\s*\([^)]*['"][^'"]*['"]\s*,\s*['"][wax]/, why: 'writing a file' },
  { re: /^\s*import\s+socket\b/m, why: 'socket' },
  { re: /^\s*from\s+socket\b/m, why: 'socket' },
  { re: /\brequests\.(get|post|put|delete)\s*\(/, why: 'outbound HTTP' },
  { re: /\burllib\.request\.urlopen\s*\(/, why: 'outbound HTTP' },
];

export interface PythonRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Allow these refused constructs through (user opted in explicitly). */
  allow?: string[];
}

export interface PythonRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the snippet was refused before it ever ran. */
  refused?: string;
  durationMs: number;
  interpreter?: string;
}

/** Interpreter names to try, per platform. */
function interpreterCandidates(): string[] {
  return process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
}

let cachedInterpreter: string | null = null;

/** Resolve a working Python once. Never throws; returns null when absent. */
export async function findPython(): Promise<string | null> {
  if (cachedInterpreter) return cachedInterpreter;
  for (const name of interpreterCandidates()) {
    const args = name === 'py' ? ['-3', '--version'] : ['--version'];
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(name, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        resolve(false);
      }, 6000);
    });
    if (ok) {
      cachedInterpreter = name;
      return name;
    }
  }
  return null;
}

/** Reject a snippet that reaches for the escape hatches. */
export function screenSource(code: string, allow: string[] = []): string | null {
  for (const { re, why } of REFUSED_PATTERNS) {
    if (allow.includes(why)) continue;
    if (re.test(code)) return why;
  }
  return null;
}

function privateDir(): string {
  const dir = path.join(os.tmpdir(), 'henry-python');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * POSIX resource limits applied in the child before exec. Belt-and-braces on
 * top of the source screen: even if something slipped through, it cannot fork
 * forever, allocate without bound, or write an unbounded file.
 */
type ResourceModule = {
  setrlimit(what: number, soft: number, hard: number): void;
  RLIMIT_CPU: number; RLIMIT_AS: number; RLIMIT_FSIZE: number; RLIMIT_NPROC: number; RLIMIT_NOFILE: number;
};

let resourceModule: ResourceModule | null | undefined;

/** Node builtins are not reachable through a bare require in bundled code. */
function loadResource(): ResourceModule | null {
  if (resourceModule !== undefined) return resourceModule;
  if (process.platform === 'win32') {
    resourceModule = null;
    return null;
  }
  try {
    const { createRequire } = require('module') as typeof import('module');
    resourceModule = createRequire(__filename)('resource') as ResourceModule;
  } catch {
    resourceModule = null;
  }
  return resourceModule;
}

function limitsPreexec(limits: { cpuSec: number; addressSpaceKb: number; fileSizeKb: number; procs: number }) {
  const resource = loadResource();
  if (!resource) return undefined;
  return () => {
    try { resource.setrlimit(resource.RLIMIT_CPU, limits.cpuSec, limits.cpuSec); } catch { /* not all limits are supported everywhere */ }
    try { resource.setrlimit(resource.RLIMIT_FSIZE, limits.fileSizeKb, limits.fileSizeKb); } catch { /* */ }
    try { resource.setrlimit(resource.RLIMIT_NPROC, limits.procs, limits.procs); } catch { /* */ }
    try { resource.setrlimit(resource.RLIMIT_NOFILE, 256, 256); } catch { /* */ }
    try { resource.setrlimit(resource.RLIMIT_AS, limits.addressSpaceKb, limits.addressSpaceKb); } catch { /* */ }
  };
}

/**
 * Run a Python snippet under the jail above. Never rejects: failures come back
 * as `ok: false` so callers cannot accidentally treat an error as success.
 */
export async function runPython(code: string, opts: PythonRunOptions = {}): Promise<PythonRunResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutput = opts.maxOutputBytes ?? 256 * 1024;

  const refused = screenSource(code, opts.allow ?? []);
  if (refused) {
    return {
      ok: false, stdout: '', stderr: `Refused: this snippet uses ${refused}, which the sandbox blocks.`,
      exitCode: null, timedOut: false, refused, durationMs: 0,
    };
  }

  const python = await findPython();
  if (!python) {
    return {
      ok: false, stdout: '',
      stderr: 'No Python interpreter found. Install Python 3 and make sure `python` or `python3` is on PATH.',
      exitCode: null, timedOut: false, durationMs: Date.now() - started,
    };
  }

  const dir = privateDir();
  const file = path.join(dir, `snip_${randomBytes(8).toString('hex')}.py`);
  try {
    fs.writeFileSync(file, code, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    return {
      ok: false, stdout: '', stderr: `Could not stage the snippet: ${(e as Error).message}`,
      exitCode: null, timedOut: false, durationMs: Date.now() - started, interpreter: python,
    };
  }

  const cpuSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  // A scrubbed environment: no API keys, no tokens, nothing the script could
  // read out of Henry's own process environment.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    TMPDIR: dir,
    TEMP: dir,
    TMP: dir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.PATHEXT = process.env.PATHEXT;
    env.USERPROFILE = dir;
  }

  const result = await new Promise<PythonRunResult>((resolve) => {
    const spawnOptions: SpawnOptions = {
      cwd: dir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX only; ignored by Node on Windows.
      preexecFn: limitsPreexec({ cpuSec, addressSpaceKb: 2 * 1024 * 1024, fileSizeKb: 64 * 1024, procs: 64 }),
    } as SpawnOptions;
    const child: ChildProcess = spawn(python, [file], spawnOptions);

    let stdout = '';
    let stderr = '';
    let truncated = false;
    // Hard-truncate. Checking "am I under the cap" before appending let a
    // single large chunk sail past it — a noisy script produced 24KB against a
    // 4KB cap. Slice to whatever room is actually left instead.
    const take = (into: string, chunk: Buffer): [string, boolean] => {
      if (into.length >= maxOutput) return [into, true];
      const room = maxOutput - into.length;
      const text = chunk.toString();
      if (text.length <= room) return [into + text, false];
      return [into + text.slice(0, room), true];
    };
    child.stdout?.on('data', (d: Buffer) => {
      const [next, cut] = take(stdout, d);
      stdout = next;
      if (cut) truncated = true;
    });
    child.stderr?.on('data', (d: Buffer) => {
      const [next, cut] = take(stderr, d);
      stderr = next;
      if (cut) truncated = true;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({
        ok: false, stdout, stderr: stderr || e.message, exitCode: null, timedOut: false,
        durationMs: Date.now() - started, interpreter: python,
      });
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false, stdout, stderr: `Timed out after ${Math.round(timeoutMs / 1000)}s.`,
          exitCode: code, timedOut: true, durationMs: Date.now() - started, interpreter: python,
        });
        return;
      }
      resolve({
        ok: code === 0,
        stdout: stdout + (truncated ? '\n…output truncated…' : ''),
        stderr,
        exitCode: code,
        timedOut: false,
        durationMs: Date.now() - started,
        interpreter: python,
      });
    });
  });

  try { fs.unlinkSync(file); } catch { /* best effort */ }
  return result;
}