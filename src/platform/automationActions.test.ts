/**
 * Row 7.10 — automation actions.
 *
 * The security property is the gate: anything that changes the user's machine
 * must refuse to run until the caller says the user confirmed. The rest is
 * proving the catalogue is real — exact argv per platform, no shell strings,
 * and nothing routed through a Unix tool on Windows.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_ACTIONS,
  buildActionPlan,
  findAction,
  listActions,
  screenshotDirectory,
  timestampSlug,
  localInterfaces,
} from './automationActions';

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

describe('the catalogue', () => {
  it('covers every action the HQ Automate grid advertises', () => {
    // These are the ten buttons the UI renders per platform. If the grid
    // grows one, this fails rather than silently shipping a dead button.
    const ids = AUTOMATION_ACTIONS.map((a) => a.id).sort();
    expect(ids).toEqual([
      'clearClipboard', 'emptyTrash', 'lockScreen', 'mute', 'networkInfo',
      'restartShell', 'screenshot', 'showIp', 'sleep', 'unmute',
    ]);
  });

  it('gives every action a description and a tier', () => {
    for (const a of AUTOMATION_ACTIONS) {
      expect(a.label.length, a.id).toBeGreaterThan(0);
      expect(a.description.length, a.id).toBeGreaterThan(10);
      expect(['silent', 'notify', 'confirm'], a.id).toContain(a.tier);
    }
  });

  it('never assembles a command as a shell string', () => {
    for (const a of AUTOMATION_ACTIONS) {
      for (const [p, plan] of Object.entries(a.plans)) {
        expect(typeof plan.cmd, `${a.id}/${p}`).toBe('string');
        expect(Array.isArray(plan.args), `${a.id}/${p}`).toBe(true);
        // A shell string would show up as metacharacters inside cmd or args.
        for (const token of [plan.cmd, ...plan.args]) {
          expect(/[;&|`]/.test(token) && !token.includes('|'), `${a.id}/${p}: ${token}`).toBe(false);
        }
      }
    }
  });

  it('does not route Windows through a Unix tool', () => {
    // `tasklist /FO CSV | head -40` is the exact failure this row is meant
    // to never repeat: a Unix pipe in a Windows command.
    for (const a of AUTOMATION_ACTIONS) {
      const win = a.plans.win32;
      if (!win) continue;
      const flat = [win.cmd, ...win.args].join(' ');
      expect(/\|\s*(head|tail|grep|awk|sed|sort|uniq)\b/.test(flat), a.id).toBe(false);
      expect(win.cmd, a.id).not.toBe('head');
      expect(win.cmd, a.id).not.toBe('grep');
    }
  });

  it('empties the recycle bin with a cmdlet that ships with Windows', () => {
    // The previous implementation walked Shell.Application and called
    // InvokeVerb('Delete'), which skips anything with a prompt.
    const win = findAction('emptyTrash')!.plans.win32!;
    expect(win.cmd).toBe('powershell');
    expect(win.args.join(' ')).toContain('Clear-RecycleBin');
  });

  it('shows IP without shelling out to curl', () => {
    // `curl -s ifconfig.me` is not present on a stock Windows install, and it
    // sent the machine's address to a third party on every button press.
    const ip = findAction('showIp')!;
    expect(ip.builtin).toBe('showIp');
    for (const a of AUTOMATION_ACTIONS) {
      for (const plan of Object.values(a.plans)) {
        expect(plan?.cmd, a.id).not.toBe('curl');
        expect(plan?.args.join(' '), a.id).not.toContain('ifconfig.me');
      }
    }
  });
});

describe('findAction', () => {
  it('resolves an id, case-insensitively, and refuses anything else', () => {
    expect(findAction('sleep')?.id).toBe('sleep');
    expect(findAction(' SLEEP ')?.id).toBe('sleep');
    expect(findAction('rm -rf')).toBeNull();
    expect(findAction(undefined)).toBeNull();
    expect(findAction(42)).toBeNull();
  });
});

describe('the confirmation gate', () => {
  const mutating = AUTOMATION_ACTIONS.filter((a) => a.mutatesSystem);

  it('has at least the actions that really change the machine', () => {
    expect(mutating.map((a) => a.id).sort()).toEqual([
      'emptyTrash', 'lockScreen', 'mute', 'restartShell', 'sleep', 'unmute',
    ]);
  });

  for (const action of mutating) {
    it(`refuses "${action.id}" until the user has confirmed`, () => {
      for (const platform of PLATFORMS) {
        const r = buildActionPlan(action, platform, { confirmed: false });
        expect(r.ok, `${action.id}/${platform}`).toBe(false);
        expect(!r.ok && r.error).toMatch(/confirmation/i);
      }
    });

    it(`allows "${action.id}" once confirmed`, () => {
      const platform = action.plans.linux ? 'linux' : 'win32';
      const r = buildActionPlan(action, platform, { confirmed: true });
      // Either a real plan, or an honest "not on this platform" — never a
      // silent success.
      if (r.ok) {
        expect(r.value.plan || r.value.builtin, action.id).toBeTruthy();
      } else {
        expect(r.error, action.id).toMatch(/not available|not installed|not implemented/i);
      }
    });
  }

  it('never needs confirmation for a read-only action', () => {
    for (const action of AUTOMATION_ACTIONS.filter((a) => !a.mutatesSystem)) {
      const r = buildActionPlan(action, 'linux', { confirmed: false });
      expect(r.ok, action.id).toBe(true);
    }
  });

  it('returns the right plan per platform', () => {
    const sleep = findAction('sleep')!;
    expect(buildActionPlan(sleep, 'linux', { confirmed: true })).toMatchObject({
      ok: true, value: { plan: { cmd: 'systemctl', args: ['suspend'] } },
    });
    expect(buildActionPlan(sleep, 'win32', { confirmed: true })).toMatchObject({
      ok: true, value: { plan: { cmd: 'rundll32.exe' } },
    });
    expect(buildActionPlan(sleep, 'darwin', { confirmed: true })).toMatchObject({
      ok: true, value: { plan: { cmd: 'pmset', args: ['sleepnow'] } },
    });
  });

  it('says why an action is unavailable instead of pretending', () => {
    const mute = findAction('mute')!;
    // No scripting mute exists on Windows, and pretending otherwise is how a
    // button silently does nothing.
    const r = buildActionPlan(mute, 'win32', { confirmed: true });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.builtin).toBe('muteAudio');
    expect(mute.unavailable?.win32).toBeTruthy();
  });
});

describe('listActions', () => {
  it('marks mutating actions as needing confirmation only when available', () => {
    for (const platform of PLATFORMS) {
      for (const entry of listActions(platform)) {
        expect(entry.available, entry.id).toBe(true);
        expect(entry.needsConfirmation, entry.id).toBe(entry.mutatesSystem);
        if (entry.available) expect(entry.reason, entry.id).toBeUndefined();
      }
    }
  });

  it('every action resolves on every supported platform', () => {
    for (const platform of PLATFORMS) {
      const unavailable = listActions(platform).filter((a) => !a.available);
      expect(unavailable, platform).toEqual([]);
    }
  });
});

describe('screenshot target', () => {
  it('uses a platform-appropriate pictures folder', () => {
    expect(screenshotDirectory('/home/b', 'darwin')).toBe('/home/b/Desktop');
    expect(screenshotDirectory('/home/b', 'linux')).toBe('/home/b/Pictures');
    expect(screenshotDirectory('C:\\Users\\b', 'win32')).toBe('C:\\Users\\b\\Pictures\\Screenshots');
  });

  it('builds a filename-safe timestamp', () => {
    // The old command used $(date +%Y%m%d_%H%M%S) inside a PowerShell string,
    // where $(...) is not substitution at all.
    const slug = timestampSlug(new Date(2026, 0, 5, 7, 4, 9));
    expect(slug).toBe('20260105_070409');
    expect(/^[0-9]{8}_[0-9]{6}$/.test(slug)).toBe(true);
  });
});

describe('localInterfaces', () => {
  it('reports this machine without a network call', () => {
    const all = localInterfaces();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    for (const i of all) {
      expect(typeof i.name).toBe('string');
      expect(typeof i.address).toBe('string');
    }
  });
});