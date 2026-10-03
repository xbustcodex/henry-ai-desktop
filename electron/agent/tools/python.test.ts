/**
 * `python_run` is a thin adapter over the proven jail in
 * `electron/ipc/pythonRunner.ts`. The thing worth testing is therefore not
 * "does Python work" but the adapter's two obligations: it must not swallow
 * the jail's refusal (a refused snippet must never come back looking like a
 * successful run), and it must clamp the knobs the model supplies.
 *
 * The jail is wrapped with `vi.mock(..., importOriginal)` so the real source
 * screening and the real spawn still run — only the call becomes observable,
 * which is how we assert the clamping without waiting 120s or exporting
 * internals for the test's benefit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PythonRunOptions } from '../../ipc/pythonRunner';
import type { AgentContext } from '../types';

vi.mock('../../ipc/pythonRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ipc/pythonRunner')>();
  return { ...actual, runPython: vi.fn(actual.runPython) };
});

import { runPython, findPython } from '../../ipc/pythonRunner';
import { pythonTools } from './python';

const runPythonMock = vi.mocked(runPython);
const ctx: AgentContext = { db: {} as AgentContext['db'], getWindow: () => null };

const tool = pythonTools().find((t) => t.name === 'python_run')!;
const exec = (params: Record<string, unknown>) => tool.execute(params, ctx);

/** Options the adapter handed the jail on its most recent call. */
function lastOpts(): PythonRunOptions {
  const call = runPythonMock.mock.calls.at(-1);
  return (call && call[1]) || {};
}

beforeEach(() => {
  runPythonMock.mockClear();
});

describe('python_run — tool surface', () => {
  it('is exactly one system tool, not gated behind approval', () => {
    const tools = pythonTools();
    expect(tools.map((t) => t.name)).toEqual(['python_run']);
    expect(tool.category).toBe('system');
    // notify, not silent: a read changes nothing, a spawned process does.
    // confirm would be wrong: the jail cannot egress, write user data, or spawn.
    expect(tool.safetyLevel).toBe('notify');
    expect(tool.confirmPrompt).toBeUndefined();
  });

  it('requires only `code`', () => {
    expect(tool.inputSchema.required).toEqual(['code']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });
});

describe('python_run — refusal propagates', () => {
  it('surfaces the jail refusal as a failure with empty output', async () => {
    const r = await exec({ code: 'import os\nos.system("echo pwned")' });
    expect(r.ok).toBe(false);
    const data = r.data as { refused?: string; stdout: string; stderr: string; exitCode: number | null };
    expect(data.refused).toBe('os.system');
    // The jail refused before executing: there is genuinely nothing to report,
    // and the adapter must not dress the refusal up as a run.
    expect(data.stdout).toBe('');
    expect(data.stderr).not.toContain('pwned');
    expect(data.exitCode).toBeNull();
    expect(r.error).toMatch(/os\.system/);
    expect(r.error).toMatch(/not executed/i);
  });

  it('refuses subprocess imports the same way', async () => {
    const r = await exec({ code: 'import subprocess\nsubprocess.run(["echo", "pwned"])' });
    expect(r.ok).toBe(false);
    const data = r.data as { refused?: string; stdout: string };
    expect(data.refused).toBe('subprocess');
    expect(data.stdout).toBe('');
  });

  it('does not fabricate output for a refused snippet', async () => {
    const r = await exec({ code: 'import socket\ns = socket.socket()' });
    expect(r.ok).toBe(false);
    const data = r.data as Record<string, unknown>;
    expect(data.stdout).toBe('');
    expect(data.timedOut).toBe(false);
    expect(data.durationMs).toBe(0);
  });
});

describe('python_run — parameter clamping', () => {
  it('clamps an absurd timeout down to the ceiling', async () => {
    await exec({ code: 'print(1)', timeoutMs: 10_000_000 });
    expect(lastOpts().timeoutMs).toBe(120_000);
  });

  it('clamps a sub-millisecond timeout up to the floor', async () => {
    await exec({ code: 'print(1)', timeoutMs: 1 });
    expect(lastOpts().timeoutMs).toBe(1000);
  });

  it('clamps output bytes in both directions', async () => {
    await exec({ code: 'print(1)', maxOutputBytes: 50_000_000 });
    expect(lastOpts().maxOutputBytes).toBe(262_144);
    runPythonMock.mockClear();
    await exec({ code: 'print(1)', maxOutputBytes: 10 });
    expect(lastOpts().maxOutputBytes).toBe(1024);
  });

  it('leaves the knobs off the jail call entirely when unset', async () => {
    await exec({ code: 'print(1)' });
    expect(lastOpts()).toEqual({});
  });

  it('passes in-range values straight through', async () => {
    await exec({ code: 'print(1)', timeoutMs: 8000, maxOutputBytes: 4096 });
    expect(lastOpts()).toEqual({ timeoutMs: 8000, maxOutputBytes: 4096 });
  });

  it('refuses a non-numeric timeout rather than silently running with a different one', async () => {
    const r = await exec({ code: 'print(1)', timeoutMs: 'soon' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeoutMs must be a number/);
  });
});

describe('python_run — input validation', () => {
  it('fails clearly when `code` is missing', async () => {
    const r = await exec({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/`code`/);
    expect(r.data).toBeUndefined();
  });

  it('fails on blank code and on a non-string code', async () => {
    expect((await exec({ code: '   \n ' })).ok).toBe(false);
    expect((await exec({ code: 42 })).ok).toBe(false);
    expect((await exec({ code: '' })).ok).toBe(false);
  });

  it('rejects an oversized snippet instead of staging it', async () => {
    const r = await exec({ code: 'x = 1\n'.repeat(40_000) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too long/i);
  });

  it('never reaches the jail with an invalid request', async () => {
    await exec({});
    expect(runPythonMock).not.toHaveBeenCalled();
  });
});

describe('python_run — real execution (skipped when no interpreter exists)', () => {
  it('returns stdout from a real run', async () => {
    if (!(await findPython())) {
      console.warn('[python tool] no interpreter on this machine — execution test skipped');
      return;
    }
    const r = await exec({ code: 'total = sum(range(11))\nprint("total", total)' });
    expect(r.ok).toBe(true);
    const data = r.data as { stdout: string; exitCode: number; timedOut: boolean; durationMs: number };
    expect(data.stdout).toContain('total 55');
    expect(data.exitCode).toBe(0);
    expect(data.timedOut).toBe(false);
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a script error as a failure that still carries the traceback', async () => {
    if (!(await findPython())) return;
    const r = await exec({ code: 'print(1/0)' });
    expect(r.ok).toBe(false);
    const data = r.data as { stderr: string };
    expect(data.stderr).toMatch(/ZeroDivisionError/);
    expect(r.error).toMatch(/ZeroDivisionError/);
  });
});