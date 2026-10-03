/**
 * Row 7.8 — terminal access.
 *
 * Two halves.
 *
 * 1. Regression safety net: the classifier must still refuse the fork bomb and
 * the Windows forced system delete, and a wrong-typed payload must still be
 * refused with a message rather than a TypeError thrown across IPC.
 *
 * 2. The Windows behaviour this row was PARTIAL on: real shell selection and
 * cancellation that actually stops the command instead of just the wrapper.
 */
import { describe, it, expect } from 'vitest';
import { classifyCommand, isDangerousCommand } from './_commandSafety';
import { isInsideRoot } from './_pathSafety';
import { validateExecParams, resolveShell, resolveCwd, SHELL_ALIASES } from './terminal';
import path from 'path';
import os from 'os';

describe('the classifier still refuses what it refused before', () => {
  it('refuses a fork bomb', () => {
    expect(classifyCommand(':(){ :|:& };:').blocked).toBe(true);
    expect(classifyCommand(': () { : | : & }; :').blocked).toBe(true);
  });

  it('refuses a forced delete of a Windows system path', () => {
    // This ran on the installed build before Card 7 and was only stopped by
    // the filesystem ACL, which is luck rather than a boundary.
    const r = classifyCommand('del /f /q C:\\Windows\\System32\\drivers\\etc\\hosts');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/forced delete/i);
  });

  it('refuses a recursive Windows system delete in both dialects', () => {
    expect(classifyCommand('rd /s /q C:\\Windows\\Temp').blocked).toBe(true);
    expect(classifyCommand('Remove-Item -Recurse "C:\\Program Files\\Thing"').blocked).toBe(true);
  });

  it('refuses disk and boot destruction', () => {
    expect(classifyCommand('diskpart').blocked).toBe(true);
    expect(classifyCommand('bcdedit /set testsigning on').blocked).toBe(true);
    expect(classifyCommand('format c:').blocked).toBe(true);
  });

  it('refuses wiping free space and deleting shadow copies', () => {
    expect(classifyCommand('cipher /w:C').blocked).toBe(true);
    expect(classifyCommand('vssadmin delete shadows /all /quiet').blocked).toBe(true);
  });

  it('refuses disabling the firewall or Defender', () => {
    expect(classifyCommand('netsh advfirewall set allprofiles state off').blocked).toBe(true);
    expect(classifyCommand('Set-MpPreference -DisableRealtimeMonitoring $true').blocked).toBe(true);
  });

  it('refuses the Unix root deletes it always refused', () => {
    expect(classifyCommand('rm -rf /').blocked).toBe(true);
    expect(classifyCommand('rm -rf ~').blocked).toBe(true);
    expect(classifyCommand('rm -rf /usr').blocked).toBe(true);
    expect(classifyCommand('mkfs.ext4 /dev/sda1').blocked).toBe(true);
  });

  it('still allows ordinary work', () => {
    for (const ok of ['npm test', 'git status', 'rm -rf node_modules', 'del build\\app.exe', 'ls -la']) {
      expect(isDangerousCommand(ok), ok).toBe(false);
    }
  });
});

describe('exec payload validation', () => {
  it('accepts the ordinary shape', () => {
    const r = validateExecParams({ command: 'echo hi', timeout: 5000 });
    expect(r).toMatchObject({ ok: true, command: 'echo hi', timeout: 5000 });
  });

  it('refuses a wrong-typed command with a message, not a TypeError', () => {
    // `params.command` used to go straight into spawn, so an object threw a
    // raw TypeError back across IPC.
    for (const bad of [undefined, null, {}, 123, ['echo'], true]) {
      const r = validateExecParams(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && typeof r.error).toBe('string');
    }
    expect(validateExecParams({ command: '   ' }).ok).toBe(false);
  });

  it('bounds the command length', () => {
    expect(validateExecParams({ command: 'x'.repeat(32_000) }).ok).toBe(true);
    expect(validateExecParams({ command: 'x'.repeat(32_001) }).ok).toBe(false);
  });

  it('bounds the timeout instead of forwarding it', () => {
    expect(validateExecParams({ command: 'x', timeout: -1 }).ok).toBe(false);
    expect(validateExecParams({ command: 'x', timeout: 1e12 }).ok).toBe(false);
    expect(validateExecParams({ command: 'x', timeout: 'soon' }).ok).toBe(false);
  });

  it('bounds the channel id used for streaming', () => {
    expect(validateExecParams({ command: 'x', channelId: '' }).ok).toBe(false);
    expect(validateExecParams({ command: 'x', channelId: 'c'.repeat(200) }).ok).toBe(false);
    expect(validateExecParams({ command: 'x', channelId: 'chat-1' })).toMatchObject({ ok: true, channelId: 'chat-1' });
  });
});

describe('shell selection', () => {
  it('picks the platform default', () => {
    const win = resolveShell(undefined, 'win32');
    expect(win.ok && win.shell.requested).toBe('cmd');
    const posix = resolveShell('default', 'linux');
    expect(posix.ok && posix.shell.requested).toBe('sh');
  });

  it('lets a caller ask for powershell on Windows', () => {
    // Every command used to go through `cmd /c` whatever the user meant, so a
    // PowerShell command could not be run at all.
    const r = resolveShell('powershell', 'win32');
    if (r.ok) {
      expect(r.shell.requested).toBe('powershell');
      expect(r.shell.kind).toBe('windows');
      expect(r.shell.prefix).toEqual(['-c']);
    } else {
      // Honest on a Linux box with no PowerShell: say so, do not pretend.
      expect(r.error).toMatch(/not installed/i);
    }
  });

  it('skips AutoRun registry commands when using cmd.exe', () => {
    const r = resolveShell('cmd', 'win32');
    // On Linux there is no cmd.exe, so this must report absence rather than
    // hand back a shell that does not exist.
    if (r.ok) {
      expect(r.shell.prefix).toEqual(['/d', '/s', '/c']);
    } else {
      expect(r.error).toMatch(/not installed/i);
    }
  });

  it('refuses a shell that is not on the allow-list', () => {
    // An arbitrary `shell` value would let a caller choose any executable on
    // the machine and hand it a full command string.
    for (const bad of ['python', '/bin/sh', 'bash -c whatever', 'pwsh.exe; whoami', 42]) {
      const r = resolveShell(bad, 'win32');
      expect(r.ok, String(bad)).toBe(false);
      expect(!r.ok && r.error).toMatch(/unknown shell/i);
    }
  });

  it('resolves the shell that does exist on this machine', () => {
    const r = resolveShell('sh', 'linux');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shell.bin).toContain('sh');
    expect(r.shell.kind).toBe('posix');
    expect(r.shell.prefix).toEqual(['-c']);
  });

  it('tries the .exe name first on Windows and never passes a path or argument', () => {
    // An alias must be a bare binary name. A value containing a separator or
    // an argument would turn shell selection into arbitrary execution.
    for (const [key, aliases] of Object.entries(SHELL_ALIASES)) {
      expect(aliases.length, key).toBeGreaterThan(0);
      for (const alias of aliases) {
        expect(alias, key).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(alias, key).not.toMatch(/[/\\]/);
      }
    }
    for (const key of ['cmd', 'powershell', 'pwsh']) {
      expect(SHELL_ALIASES[key][0], key).toBe(`${key}.exe`);
    }
  });
});

describe('working directory', () => {
  const workspace = path.join(os.tmpdir(), 'henry-ws');
  const home = os.homedir();

  it('uses the workspace when nothing is asked for', () => {
    expect(resolveCwd(undefined, workspace)).toEqual({ cwd: path.resolve(workspace), relocated: false });
  });

  it('allows the workspace and the home directory', () => {
    expect(resolveCwd(workspace, workspace).relocated).toBe(false);
    expect(resolveCwd(path.join(home, 'Documents'), workspace).relocated).toBe(false);
  });

  it('relocates a cwd outside both roots — and says so', () => {
    // The old code silently substituted the workspace, so a build could write
    // to the wrong place with nothing in the response to say so.
    const r = resolveCwd('/etc', workspace);
    expect(r.cwd).toBe(path.resolve(workspace));
    expect(r.relocated).toBe(true);
    expect(r.reason).toMatch(/outside the workspace/i);
  });

  it('relocates a wrong-typed cwd rather than throwing', () => {
    for (const bad of [42, {}, [], true]) {
      const r = resolveCwd(bad, workspace);
      expect(r.relocated, JSON.stringify(bad)).toBe(true);
      expect(r.cwd).toBe(path.resolve(workspace));
    }
  });

  it('does not treat a sibling directory as inside the root', () => {
    // The sibling-prefix bug this module shares with _pathSafety.
    expect(isInsideRoot('/work-evil', '/work')).toBe(false);
    expect(resolveCwd('/work-evil', '/work').relocated).toBe(true);
  });
});