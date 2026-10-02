/**
 * opencode coder engine.
 *
 * Drives the `opencode` CLI non-interactively (`opencode run --format json`)
 * and maps its event stream onto the same CoderStreamEvent vocabulary the
 * Claude Code engine emits, so the renderer needs no per-engine knowledge.
 *
 * Runtime resolution matters: opencode is commonly installed by a version
 * manager (nvm/fnm/volta/bun) into a per-user directory that a packaged GUI
 * app's minimal PATH does not include, and it needs a `node` on PATH to run.
 * `buildCoderChildEnv()` therefore assembles the real install locations and
 * uses `path.delimiter` rather than a hardcoded ':'.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  type CoderStreamEvent,
  createLineBuffer,
  summarizeToolInput,
} from './streamJson';

/** Default working directory when the caller does not supply one. */
export const CODER_WORKSPACE_DIR = path.join(os.homedir(), 'HenryAI', 'coder-projects');

const execFileP = promisify(execFile);

export interface OpencodeCliInfo {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

let cached: OpencodeCliInfo | undefined;

/**
 * Environment for detecting and running an external coder CLI.
 *
 * A packaged Electron app on Linux/macOS inherits a very small PATH, so the
 * user-level install directories have to be added explicitly. node version
 * managers are enumerated from disk because their directory names vary.
 */
export function buildCoderChildEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never let a parent session make a headless run think it is interactive.
  //
  // Only session/state markers are stripped. A blanket `OPENCODE_*` delete also
  // removed OPENCODE_API_KEY — the documented bearer credential for opencode's
  // zen gateway — which silently reduced the model catalogue from 395 entries
  // to the unauthenticated subset. Credentials must pass through.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  for (const key of ['OPENCODE_SESSION', 'OPENCODE_CLIENT', 'OPENCODE_SERVER']) {
    if (key in env && !/KEY|TOKEN|AUTH|SECRET|PASSWORD/.test(key)) delete env[key];
  }
  env.HOME = env.HOME || home;

  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.deno', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];

  // nvm: ~/.nvm/versions/node/<version>/bin
  try {
    const nvmRoot = process.env.NVM_DIR || path.join(home, '.nvm');
    const versions = path.join(nvmRoot, 'versions', 'node');
    if (fs.existsSync(versions)) {
      for (const v of fs.readdirSync(versions).sort().reverse()) {
        dirs.push(path.join(versions, v, 'bin'));
      }
    }
  } catch {
    /* enumeration is best effort */
  }
  // fnm: ~/.local/share/fnm/node-versions/<version>/installation/bin
  try {
    const fnmRoot = path.join(home, '.local', 'share', 'fnm', 'node-versions');
    if (fs.existsSync(fnmRoot)) {
      for (const v of fs.readdirSync(fnmRoot).sort().reverse()) {
        dirs.push(path.join(fnmRoot, v, 'installation', 'bin'));
      }
    }
  } catch {
    /* best effort */
  }

  // path.delimiter, not ':' — a hardcoded colon silently produced one
  // malformed PATH entry on Windows.
  env.PATH = [...new Set(dirs), env.PATH || ''].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * Binary names this CLI ships under.
 *
 * The same OpenCode CLI installs as `opencode` on most systems and as `omp`
 * in others — the vendor's own bundle puts omp.exe in %LOCALAPPDATA%\omp and
 * puts that folder on PATH. Probing only the literal name `opencode` made a
 * perfectly working install (105 Zen models available) report itself as
 * absent from the packaged app.
 */
const CLI_NAMES = ['opencode', 'omp'] as const;

/** Every place the CLI realistically lives, under any of its binary names. */
function candidateBinaries(): string[] {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out: string[] = [];
  for (const name of CLI_NAMES) {
    // bare name first: resolved against the extended PATH, so an install in
    // any PATH folder is found without this code knowing where that is
    out.push(name);
    out.push(path.join(home, '.opencode', 'bin', name));
    out.push(path.join(home, '.omp', 'bin', name));
    out.push(path.join(home, '.local', 'bin', name));
    out.push(path.join(home, '.bun', 'bin', name));
    out.push(path.join(home, '.volta', 'bin', name));
    if (isWin) {
      out.push(path.join(appData, 'npm', `${name}.cmd`));
      out.push(path.join(localAppData, name, `${name}.exe`));
    } else {
      out.push('/opt/homebrew/bin/' + name);
      out.push('/usr/local/bin/' + name);
      out.push('/usr/bin/' + name);
    }
  }
  return out;
}

export async function detectOpencodeCli(refresh = false): Promise<OpencodeCliInfo> {
  if (!refresh && cached) return cached;
  const env = buildCoderChildEnv();
  for (const bin of candidateBinaries()) {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { env, timeout: 8_000 });
      cached = { available: true, path: bin, version: stdout.trim().split('\n')[0] || undefined };
      return cached;
    } catch {
      /* try the next candidate */
    }
  }
  cached = {
    available: false,
    error:
      `OpenCode CLI not found. Tried: ${CLI_NAMES.join(', ')}. Install it (https://opencode.ai), ` +
      'or make sure its folder is on PATH for the Henry window — a shell alias or version-manager ' +
      'shim that only exists inside your terminal will not be visible here.',
  };
  return cached;
}

interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  cost?: number;
  /** opencode reports run failures as a TOP-LEVEL error, not a part. */
  error?: { name?: string; message?: string; data?: { message?: string; [k: string]: unknown } };
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    state?: { input?: unknown; status?: string; title?: string };
    tokens?: { input?: number; output?: number };
  };
}

/** Translate one opencode JSON event into the shared coder vocabulary. */
export function parseOpencodeEventLine(line: string): CoderStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];

  let ev: OpencodeEvent;
  try {
    ev = JSON.parse(trimmed) as OpencodeEvent;
  } catch {
    return [];
  }

  // A top-level error means the run itself failed. It arrives with no part, so
  // the switch below would never see it and the run would look like an empty
  // success.
  if (ev.error) {
    return [{ kind: 'error', message: readOpencodeError(ev.error) }];
  }

  const part = ev.part ?? {};
  switch (part.type) {
    case 'text': {
      const text = part.text;
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'tool': {
      const summary = part.state?.title || summarizeToolInput(part.state?.input);
      return [{ kind: 'tool', name: part.tool || 'tool', summary }];
    }
    case 'step-start':
    case 'step_start': {
      const out: CoderStreamEvent[] = [];
      if (ev.sessionID) out.push({ kind: 'init', sessionId: ev.sessionID });
      return out;
    }
    case 'step-finish':
    case 'step_finish': {
      return [
        {
          kind: 'result',
          ok: (part as { reason?: string }).reason !== 'error',
          sessionId: ev.sessionID,
          costUsd: typeof ev.cost === 'number' ? ev.cost : undefined,
        },
      ];
    }
    case 'error':
      return [{ kind: 'error', message: readOpencodeError(part as unknown as Record<string, unknown>) }];
    default:
      return [];
  }
}

/**
 * Pull a usable message out of opencode's several error shapes.
 *
 * Observed from a real failed run:
 *   {"type":"error","error":{"name":"UnknownError","data":{"message":"{\"message\":\"Streaming
 *    response failed: [503] Upstream error from Nvidia: Service temporarily overloaded\"}"}}}
 * — so the human-readable text can be nested two levels down AND itself be a
 * JSON string. Without unwrapping, a failed run looked like an empty success.
 */
export function readOpencodeError(raw: unknown): string {
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    for (const key of ['message', 'data', 'error']) {
      const got = pick(o[key]);
      if (got) return got;
    }
    return null;
  };
  const text = pick(raw);
  if (!text) return 'opencode reported an error';
  // The nested payload is often a JSON string; unwrap it to the inner message.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const inner = JSON.parse(trimmed) as unknown;
      const better = pick(inner);
      if (better && better !== trimmed) return better;
    } catch { /* not JSON after all — use the raw text */ }
  }
  return text;
}

export interface OpencodeRunOptions {
  prompt: string;
  cwd: string;
  cliPath: string;
  sessionId?: string;
  model?: string;
  agent?: string;
  onEvent: (event: CoderStreamEvent) => void;
}

export function runOpencode(opts: OpencodeRunOptions): ChildProcess {
  const args = ['run', '--format', 'json', '--dir', opts.cwd, opts.prompt];
  if (opts.model) args.push('--model', opts.model);
  if (opts.agent) args.push('--agent', opts.agent);
  if (opts.sessionId) args.push('--session', opts.sessionId);

  const child = spawn(opts.cliPath, args, {
    cwd: opts.cwd || CODER_WORKSPACE_DIR,
    env: buildCoderChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let terminalSent = false;
  const emit = (event: CoderStreamEvent) => {
    if (terminalSent) return;
    if (event.kind === 'result' || event.kind === 'error') terminalSent = true;
    try {
      opts.onEvent(event);
    } catch {
      /* renderer gone — nothing to do */
    }
  };

  const buffer = createLineBuffer((line) => {
    for (const event of parseOpencodeEventLine(line)) emit(event);
  });

  child.stdout?.on('data', (d: Buffer) => buffer.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => buffer.push(d.toString()));

  child.on('error', (err: Error) => {
    buffer.flush?.();
    emit({ kind: 'error', message: `opencode failed to start: ${err.message}` });
  });

  child.on('close', (code: number | null) => {
    buffer.flush?.();
    if (terminalSent) return;
    if (code === 0) emit({ kind: 'result', ok: true, sessionId: opts.sessionId });
    else emit({ kind: 'error', message: `opencode exited with code ${code}` });
  });

  return child;
}

export interface OpencodeModel {
  /** `provider/model`, exactly as passed to --model. */
  id: string;
  provider: string;
  name: string;
  /** True for opencode's own hosted ("zen") models. */
  isZen: boolean;
  /** True when the id ends in -free. */
  isFree: boolean;
  /** Provider group the id was listed under, e.g. "opencode-zen". */
  group: string;
}

/**
 * Parse `opencode models` / `omp models` output into real model identifiers.
 *
 * The CLI prints a grouped table, for example:
 *
 *   opencode-zen (105)
 *   | ~anthropic/claude-fable-latest        |    1M |  128K | low,high | yes |
 *   |  anthropic/claude-fable-5            |    1M |  128K | low,high | yes |
 *
 * This used to keep every line containing "/" as the model id, so all 559 ids
 * came back as the entire table row — box-drawing borders, context windows and
 * reasoning-effort lists included — and none of them could be sent to the
 * bridge. A "~" marks the group's highlighted entry and is not part of the id.
 *
 * Older builds printed one bare id per line, so plain lines are still accepted.
 */
function parseModelList(stdout: string): OpencodeModel[] {
  const out: OpencodeModel[] = [];
  const seen = new Set<string>();
  let group = '';
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // Group header: a provider name followed by a model count, e.g. "opencode-zen (105)"
    const header = /^([A-Za-z0-9_.-]+)\s*\((\d+)\)\s*$/.exec(line);
    if (header) {
      group = header[1];
      continue;
    }
    // Box drawing: table rules and borders carry no model.
    if (/^[┌├└─═\s|\u2502]+$/.test(line)) continue;

    // Table row: the model is the first column. Borders are box-drawing
    // U+2502 as well as ASCII '|', so both have to be accepted.
    const cells = line.split(/[|\u2502]/).map((c) => c.trim()).filter(Boolean);
    const first = cells[0];
    if (!first) continue;
    // The column heading row, e.g. "| model | context | ...".
    if (/^models?$/i.test(first)) continue;

    const id = first.replace(/^~/, '').trim();
    if (!id || /[│|]/.test(id)) continue;
    const key = `${group}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(classifyModel(id, group || undefined));
  }
  return out;
}

function classifyModel(id: string, group?: string): OpencodeModel {
  const slash = id.indexOf('/');
  const provider = slash > 0 ? id.slice(0, slash) : 'unknown';
  const name = slash > 0 ? id.slice(slash + 1) : id;
  // "opencode-zen (105)" is the group heading for the Zen catalogue; ids inside
  // it are namespaced by their upstream provider, so the provider has to come
  // from the group or every Zen model looks like a third-party one.
  const bucket = (group || provider).toLowerCase();
  return {
    id,
    provider,
    name,
    group: group || provider,
    isZen: bucket.includes('zen') || provider === 'opencode',
    isFree: /-free$/.test(name),
  };
}

/**
 * Ask opencode which models it can reach, so Henry offers the real list
 * instead of a hardcoded one. This is what lets every provider opencode is
 * configured for — its own zen models, OpenRouter, or anything added later —
 * work through the same engine without a code change here.
 *
 * The timeout is generous on purpose: `opencode models` probes the configured
 * providers and took ~25s here, and a 20s cap silently truncated the list to
 * 139 of 395 entries.
 */
export async function listOpencodeModels(timeoutMs = 90_000): Promise<{
  ok: boolean;
  models: OpencodeModel[];
  error?: string;
}> {
  const cli = await detectOpencodeCli();
  if (!cli.available || !cli.path) {
    return { ok: false, models: [], error: cli.error ?? 'opencode is not installed.' };
  }
  try {
    const { stdout } = await execFileP(cli.path, ['models'], {
      env: buildCoderChildEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const models = parseModelList(stdout)
      .sort((a, b) => {
        // zen first, then free, then alphabetical
        if (a.isZen !== b.isZen) return a.isZen ? -1 : 1;
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
    return { ok: true, models };
  } catch (e: unknown) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}
