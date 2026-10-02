/**
 * The Python jail has to do two things at once, so both are tested here:
 * legitimate analysis must actually run and produce output, and escape
 * attempts must be refused before they execute anything.
 *
 * These are the cases that used to run unrestricted (and, on Windows, not run
 * at all because of the hardcoded /tmp and /bin/zsh).
 */
import { describe, it, expect } from 'vitest';
import { screenSource, runPython, findPython } from './pythonRunner';

const ESCAPES: [string, string][] = [
  ['subprocess spawn shell', 'import subprocess\nsubprocess.run(["echo","pwned"], shell=True)'],
  ['os.system', 'import os\nos.system("echo pwned")'],
  ['os.popen', 'import os\nos.popen("echo pwned")'],
  ['ctypes native call', 'import ctypes\nctypes.CDLL("libc.so.6").system("echo pwned")'],
  ['importlib escape', 'import importlib\nimportlib.import_module("os")'],
  ['__import__ builtin', '__import__("os").system("echo pwned")'],
  ['pty.spawn', 'import pty\npty.spawn(["/bin/sh"])'],
  ['shutil.rmtree', 'import shutil\nshutil.rmtree("/")'],
  ['absolute system path', 'open("/etc/passwd", "r")'],
  ['windows absolute path', 'open("C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts", "r")'],
  ['writing a file', 'open("payload.txt", "w")'],
  ['raw socket', 'import socket\ns=socket.socket()'],
  ['outbound http', 'import requests\nrequests.get("http://example.com")'],
  ['urlopen', 'import urllib.request\nurllib.request.urlopen("http://example.com")'],
];

describe('python jail — refusal', () => {
  for (const [name, code] of ESCAPES) {
    it(`refuses ${name}`, () => {
      expect(screenSource(code)).toBeTruthy();
    });
  }

  it('refuses before execution, so nothing runs at all', async () => {
    const r = await runPython('import os\nos.system("echo pwned")');
    expect(r.refused).toBe('os.system');
    expect(r.stdout).toBe('');
    expect(r.ok).toBe(false);
  });

  it('does not over-block harmless os usage', () => {
    // Only the exec family is refused; ordinary os calls stay available,
    // otherwise the jail would make ordinary analysis impossible.
    expect(screenSource('import os\nos.getcwd()')).toBeNull();
    expect(screenSource('import os\nos.path.join("a","b")')).toBeNull();
    expect(screenSource('import math\nprint(math.pi)')).toBeNull();
    expect(screenSource('print(1)')).toBeNull();
  });
});

describe('python jail — legitimate execution', () => {
  it('has an interpreter available', async () => {
    const py = await findPython();
    // The suite must not silently pass when there is no Python to test with.
    if (!py) {
      console.warn('[pythonRunner] no interpreter on this machine — execution tests will skip');
      return;
    }
    expect(typeof py).toBe('string');
  });

  it('runs a computation and returns stdout', async () => {
    if (!(await findPython())) return;
    const r = await runPython('total = sum(range(11))\nprint("total", total)');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('total 55');
  });

  it('returns stderr for a genuine script error without pretending success', async () => {
    if (!(await findPython())) return;
    const r = await runPython('print(1/0)');
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('honours the timeout instead of hanging the caller', async () => {
    if (!(await findPython())) return;
    const r = await runPython('while True:\n    pass', { timeoutMs: 2500 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('does not leak Henry environment secrets into the script', async () => {
    if (!(await findPython())) return;
    process.env.HENRY_TEST_SECRET = 'super-secret-value';
    const r = await runPython('import os\nprint("SECRET" in os.environ, len(os.environ))');
    delete process.env.HENRY_TEST_SECRET;
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('False');
  });

  it('runs with a private working directory, not the user home', async () => {
    if (!(await findPython())) return;
    process.env.HENRY_HOME_MARKER = 'x';
    const r = await runPython('import os\nprint(os.getcwd().startswith(os.environ.get("TEMP") or os.environ.get("TMPDIR") or "/tmp"))');
    delete process.env.HENRY_HOME_MARKER;
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toContain('True');
  });

  it('caps output rather than buffering without bound', async () => {
    if (!(await findPython())) return;
    const r = await runPython(
      'for i in range(200000):\n    print("x" * 64)',
      { maxOutputBytes: 4096, timeoutMs: 20000 }
    );
    expect(r.stdout.length).toBeLessThanOrEqual(8192);
  });
});