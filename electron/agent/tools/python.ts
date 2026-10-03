/**
 * `python_run` — Henry's compute sandbox (parity row 4.8, "Python Tools").
 *
 * The jail itself already exists and is proven: `electron/ipc/pythonRunner.ts`
 * screens the source for escape classes, runs the snippet in a child process
 * with a scrubbed environment and a private cwd, and caps wall-clock time,
 * output size, memory, file size and process count. That file is NOT modified
 * and must never be wrapped around or bypassed — this module is a thin,
 * honest adapter that calls `runPython(code, opts)` and surfaces the result.
 * The jail is the only execution path.
 *
 * What was actually missing from row 4.8 was not the jail but a call site:
 * nothing in the agent architecture invoked it, so the capability existed and
 * was unreachable. This tool is that call site.
 *
 * Safety tier: `notify`.
 *
 *   - NOT `confirm`. Under the existing convention `confirm` means the action
 *     can affect the real world or leave the machine — sending a message,
 *     running a shell command, writing a user's file (`messages_send`,
 *     `run_shell`, `repo_edit`). A jailed snippet cannot do any of those: the
 *     jail refuses `subprocess`/`os.system`/`ctypes`/`importlib`, blocks raw
 *     sockets and outbound HTTP, refuses writes to absolute and system paths,
 *     and hands the child an env with none of Henry's keys in it, in a private
 *     temp cwd. There is no egress and no write to user data, so pausing for
 *     approval on every `sum(range(10**7))` would be pure friction.
 *   - NOT `silent`. `silent` is reserved for reads (`memory_search`,
 *     `repo_status`, `web_search`): things that observe and change nothing.
 *     This spawns a process, consumes CPU for up to the timeout and stages a
 *     temp file on the user's disk, and its side effects are only bounded, not
 *     absent. A toast after the fact ("Henry ran a Python snippet") is the
 *     honest amount of visibility, and `notify` is exactly the tier the runner
 *     fires a non-blocking `agent:tool-notify` for.
 *
 * Honesty rules this adapter enforces, because a wrong result here would make
 * the model state something false to the user:
 *   - A refusal is a FAILURE. `refused` means the jail rejected the snippet
 *     before running a single line, so there is no output to report and the
 *     result is `ok: false` — never presented as a successful run.
 *   - A non-zero exit is a failure too, with stdout/stderr preserved in `data`
 *     so the model can read the traceback and fix the snippet.
 *   - Nothing here ever throws; every failure comes back as `ok: false`.
 */

import { runPython, type PythonRunOptions } from '../../ipc/pythonRunner';
import type { ToolDefinition, ToolResult } from '../types';

/** Wall-clock ceiling. The jail defaults to 30s; a model may ask for more, never for all day. */
const MAX_TIMEOUT_MS = 120_000;
/** Nothing useful here; below this the child dies during interpreter startup. */
const MIN_TIMEOUT_MS = 1_000;
/**
 * Matches the jail's own hard output cap (256KB). Passing a larger value would
 * be the only way to raise the ceiling on the child's output, so it is clamped
 * rather than honoured.
 */
const MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_OUTPUT_BYTES = 1_024;
/** Bound what the model can hand the jail in one call. */
const MAX_CODE_CHARS = 200_000;
/** Keep failure text short — it is injected into the model's context and the session log. */
const MAX_ERROR_EXCERPT = 2_000;

/** The payload `python_run` hands back, successful or not. */
export interface PythonRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Set when the jail refused the snippet before running it. Never accompanied by output. */
  refused?: string;
  /** Which interpreter the jail used, when it got that far. */
  interpreter?: string;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

function excerpt(s: string): string {
  const text = (s ?? '').trim();
  return text.length > MAX_ERROR_EXCERPT ? `${text.slice(0, MAX_ERROR_EXCERPT)}\n…(truncated)` : text;
}

/**
 * Coerce a model-supplied number into `[min, max]`. A non-numeric value is a
 * caller error we report rather than silently ignore — quietly running with a
 * different timeout than the one asked for would be dishonest.
 */
function clampNumber(raw: unknown, label: string, min: number, max: number): number | { error: string } {
  if (raw === undefined || raw === null) return NaN; // signal "not provided"
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { error: `${label} must be a number (got ${JSON.stringify(raw)}).` };
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function pythonTools(): ToolDefinition[] {
  return [
    {
      name: 'python_run',
      description:
        'Run a short Python snippet in a locked-down sandbox and get back its stdout, ' +
        'stderr and exit code. Use this for real computation the chat model should not ' +
        'do in its head: arithmetic over large ranges, statistics (mean/median/stdev), ' +
        'dates and durations, string and list processing, simulations, formatting and ' +
        'pretty-printing tabular results, quick numeric estimates.\n\n' +
        'The sandbox is a compute box, not a computer: the snippet CANNOT open a network ' +
        'connection, spawn a process, read Henry\'s files, or write outside its own temp ' +
        'directory. Code that tries (subprocess, os.system, ctypes, importlib, socket, ' +
        'requests, writing to an absolute path) is refused before it runs, with the ' +
        'reason returned. For those jobs use run_shell or the repo/file tools instead.\n\n' +
        'Requires a Python 3 interpreter on PATH; if none exists the call fails with a ' +
        'clear message rather than pretending to have run anything.',
      category: 'system',
      safetyLevel: 'notify',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'The Python source to run. Standard library is available (math, statistics, ' +
              'json, datetime, itertools, re, …) except the blocked escape hatches. ' +
              'Anything the snippet wants to say must be printed — only stdout is returned ' +
              'as the answer. E.g. "vals=[3,1,4,1,5]\\nprint(sum(vals)/len(vals))".',
          },
          timeoutMs: {
            type: 'number',
            description:
              'Optional wall-clock limit in milliseconds, clamped to 1000–120000. ' +
              'Defaults to 30000. Raise it for a long computation; a snippet that exceeds ' +
              'it is killed and the call fails.',
          },
          maxOutputBytes: {
            type: 'number',
            description:
              'Optional cap on captured stdout/stderr in bytes, clamped to 1024–262144. ' +
              'Defaults to 262144. Output past the cap is truncated.',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      async execute(params): Promise<ToolResult> {
        const code = typeof params.code === 'string' ? params.code : '';
        if (!code.trim()) {
          return fail('python_run needs a `code` parameter containing the Python source to run.');
        }
        if (code.length > MAX_CODE_CHARS) {
          return fail(`Snippet is too long: ${code.length} characters (max ${MAX_CODE_CHARS}). Split it into smaller calls.`);
        }

        const timeoutMs = clampNumber(params.timeoutMs, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        if (typeof timeoutMs !== 'number') return fail(timeoutMs.error);

        const maxOutputBytes = clampNumber(params.maxOutputBytes, 'maxOutputBytes', MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
        if (typeof maxOutputBytes !== 'number') return fail(maxOutputBytes.error);

        const opts: PythonRunOptions = {};
        // NaN is our "not provided" marker — leave the key off entirely so the
        // jail applies its own defaults rather than a bogus value.
        if (!Number.isNaN(timeoutMs)) opts.timeoutMs = timeoutMs;
        if (!Number.isNaN(maxOutputBytes)) opts.maxOutputBytes = maxOutputBytes;

        let result;
        try {
          result = await runPython(code, opts);
        } catch (e) {
          // The jail documents that it never rejects; if that ever changes we
          // still must not throw out of a tool call.
          return fail(`The Python sandbox failed to run: ${excerpt(e instanceof Error ? e.message : String(e))}`);
        }

        const payload: PythonRunOutput = {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.exitCode ?? null,
          timedOut: result.timedOut === true,
          durationMs: result.durationMs ?? 0,
        };
        if (result.refused) payload.refused = result.refused;
        if (result.interpreter) payload.interpreter = result.interpreter;

        // Refused: the jail rejected the snippet before executing anything.
        // There is no output to report — say so and fail.
        if (result.refused) {
          return {
            ok: false,
            error:
              `Refused by the Python sandbox: this snippet uses ${result.refused}, which the ` +
              'sandbox blocks. It was not executed. Rewrite it without that construct — ' +
              'the sandbox has no network and cannot touch files or spawn processes.',
            data: payload,
            retryable: false,
          };
        }

        if (result.timedOut) {
          return {
            ok: false,
            error: `The snippet timed out after ${opts.timeoutMs ?? 30_000}ms and was killed. Make it cheaper or raise timeoutMs (max ${MAX_TIMEOUT_MS}ms).`,
            data: payload,
            retryable: false,
          };
        }

        if (!result.ok) {
          const detail = excerpt(result.stderr || result.stdout);
          return {
            ok: false,
            error:
              `The snippet exited with code ${result.exitCode ?? 'unknown'}.` +
              (detail ? `\n${detail}` : ''),
            data: payload,
            retryable: false,
          };
        }

        return ok(payload);
      },
    },
  ];
}