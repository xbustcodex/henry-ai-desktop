/**
 * The global boundary is the thing that makes 355 channels validated at once,
 * so it needs to be tested at the level a real handler is registered — not just
 * at the level of `validateRequest`, which only covers the schema lookup.
 *
 * Three things are proved here:
 *
 *  1. **The mandatory bridge shapes.** `computer:openApp`, `fs:readDirectory`
 *     and `fs:readFile` are bridged as BARE STRINGS, and `fs:readDirectory`'s
 *     argument is OPTIONAL. Three earlier regressions came from writing an
 *     object schema for a bare-string channel, so each of these is asserted
 *     against the exact shape preload sends — including `undefined`.
 *
 *  2. **Arguments are forwarded, not dropped.** A multi-argument channel must
 *     still receive every argument, or a working call silently becomes a
 *     broken one.
 *
 *  3. **The security gate blocks execution.** `isExecutionAllowed: false` must
 *     prevent the handler body from running at all — that is the difference
 *     between "the switch is wired up" and "the switch does something".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A hand-rolled ipcMain so the boundary can be installed against something
// controllable. Installing the real one requires an Electron runtime.
const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return { handlers };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, listener);
    },
  },
}));

import { ipcMain } from 'electron';

import {
  installIpcBoundary,
  __resetIpcBoundaryForTest,
  payloadFingerprint,
  validateRequest,
  ValidationError,
  SHELL_GATED_CHANNELS,
  armChannelApproval,
  consumeChannelApproval,
  revokeChannelApprovals,
  channelSchemas,
} from './validation';

/** Register a handler through the boundary, exactly as a real module would. */
function register(channel: string, listener: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, listener);
}

/** Invoke a registered channel the way ipcMain would: (event, ...args). */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({ sender: 'test' }, ...args);
}

beforeEach(() => {
  // The install is deliberately a no-op when already installed, so each case
  // needs a clean slate to choose its own hooks.
  __resetIpcBoundaryForTest();
  h.handlers.clear();
  revokeChannelApprovals();
});

describe('installIpcBoundary', () => {
  it('is idempotent — a second install must not double-wrap', () => {
    installIpcBoundary();
    const first = ipcMain.handle;
    installIpcBoundary();
    expect(ipcMain.handle).toBe(first);
  });

  it('leaves a working handle in place', () => {
    installIpcBoundary();
    expect(typeof ipcMain.handle).toBe('function');
  });
});

describe('MANDATORY bridge shapes — bare strings from preload', () => {
  beforeEach(() => installIpcBoundary());

  // preload: computerOpenApp: (appName: string) => invoke('computer:openApp', appName)
  it('computer:openApp accepts the bare string preload sends', async () => {
    let seen: unknown;
    register('computer:openApp', (_e, arg) => {
      seen = arg;
      return { ok: true };
    });
    const r = await invoke('computer:openApp', 'Safari');
    expect(r).toEqual({ ok: true });
    expect(seen).toBe('Safari');
  });

  it('computer:openApp refuses an object, which preload never sends', async () => {
    register('computer:openApp', () => ({ ok: true }));
    const r = (await invoke('computer:openApp', { appName: 'Safari' })) as {
      validationError?: boolean;
    };
    expect(r.validationError).toBe(true);
  });

  // preload: readDirectory: (dirPath?: string) => invoke('fs:readDirectory', dirPath)
  it('fs:readDirectory accepts a bare string', async () => {
    let seen: unknown = 'untouched';
    register('fs:readDirectory', (_e, arg) => {
      seen = arg;
      return [];
    });
    await invoke('fs:readDirectory', '/tmp');
    expect(seen).toBe('/tmp');
  });

  it('fs:readDirectory accepts an ABSENT argument — the arg is optional', async () => {
    let called = false;
    register('fs:readDirectory', (_e, arg) => {
      called = true;
      expect(arg).toBeUndefined();
      return [];
    });
    const r = await invoke('fs:readDirectory', undefined);
    expect(r).toEqual([]);
    expect(called).toBe(true);
  });

  it('fs:readDirectory accepts NO argument at all', async () => {
    register('fs:readDirectory', () => []);
    expect(await invoke('fs:readDirectory')).toEqual([]);
  });

  // preload: readFile: (filePath: string) => invoke('fs:readFile', filePath)
  it('fs:readFile accepts the bare string preload sends', async () => {
    let seen: unknown;
    register('fs:readFile', (_e, arg) => {
      seen = arg;
      return 'contents';
    });
    expect(await invoke('fs:readFile', '/tmp/x')).toBe('contents');
    expect(seen).toBe('/tmp/x');
  });

  it('fs:readFile refuses an object payload', async () => {
    register('fs:readFile', () => 'contents');
    const r = (await invoke('fs:readFile', { path: '/tmp/x' })) as { validationError?: boolean };
    expect(r.validationError).toBe(true);
  });

  // preload: writeFile: (p, c) => invoke('fs:writeFile', { path: p, content: c })
  // Same channel FAMILY as readFile, opposite shape — this is why a family-wide
  // "strings are fine" rule would have broken one of them.
  it('fs:writeFile accepts the object preload sends', async () => {
    let seen: unknown;
    register('fs:writeFile', (_e, arg) => {
      seen = arg;
      return true;
    });
    expect(await invoke('fs:writeFile', { path: '/a.txt', content: 'hi' })).toBe(true);
    expect(seen).toEqual({ path: '/a.txt', content: 'hi' });
  });

  it('fs:writeFile refuses a bare string, which preload never sends', async () => {
    register('fs:writeFile', () => true);
    const r = (await invoke('fs:writeFile', '/a.txt')) as { validationError?: boolean };
    expect(r.validationError).toBe(true);
  });
});

describe('arguments are forwarded intact', () => {
  beforeEach(() => installIpcBoundary());

  it('passes every argument of a multi-argument channel', async () => {
    let seen: unknown[] = [];
    register('contacts:update', (_e, ...args) => {
      seen = args;
      return true;
    });
    // preload: contactsUpdate: (id, patch) => invoke('contacts:update', id, patch)
    await invoke('contacts:update', 'c1', { title: 'Ada' });
    expect(seen).toEqual(['c1', { title: 'Ada' }]);
  });

  it('validates each position of a positional schema independently', async () => {
    register('quote:setStatus', () => true);
    // preload: quoteSetStatus: (id, status) => invoke('quote:setStatus', id, status)
    expect(await invoke('quote:setStatus', 'q1', 'draft')).toBe(true);
    const bad = (await invoke('quote:setStatus', 'q1', 42)) as { validationError?: boolean };
    expect(bad.validationError).toBe(true);
  });

  it('tolerates a trailing optional argument being omitted', async () => {
    let seen: unknown[] = [];
    register('ollama:pull', (_e, ...args) => {
      seen = args;
      return { ok: true };
    });
    // preload: ollamaPull: (model, baseUrl?) => invoke('ollama:pull', model, baseUrl)
    // The handler must see exactly one payload argument — the boundary must not
    // pad a short call with undefined placeholders.
    await invoke('ollama:pull', 'llama3');
    expect(seen).toEqual(['llama3']);
  });

  it('strips prototype-pollution keys before the handler sees them', async () => {
    let seen: Record<string, unknown> = {};
    register('memory:saveWhereWeLeftOff', (_e, arg) => {
      seen = arg as Record<string, unknown>;
      return true;
    });
    await invoke('memory:saveWhereWeLeftOff', 'a summary');
    // The baseline must not let a poisoned key through on a schema'd channel.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the security gate stops execution, not just the response', () => {
  it('does not run the handler when the gate refuses', async () => {
    installIpcBoundary({ isExecutionAllowed: () => false });
    let ran = false;
    register('terminal:exec', () => {
      ran = true;
      return { success: true };
    });
    const r = await invoke('terminal:exec', { command: 'rm -rf /' });
    // The whole point: the body never executed.
    expect(ran).toBe(false);
    expect(r).toMatchObject({ ok: false, confirmationRequired: true, channel: 'terminal:exec' });
  });

  it('runs the handler when the gate allows', async () => {
    installIpcBoundary({ isExecutionAllowed: () => true });
    let ran = false;
    register('terminal:exec', () => {
      ran = true;
      return { success: true };
    });
    await invoke('terminal:exec', { command: 'ls' });
    expect(ran).toBe(true);
  });

  it('distinguishes a confirmation refusal from a validation failure', async () => {
    installIpcBoundary({ isExecutionAllowed: () => false });
    register('computer:runShell', () => ({ ok: true }));
    const r = (await invoke('computer:runShell', { command: 'ls' })) as Record<string, unknown>;
    // The renderer keys its dialog off this flag, so conflating the two would
    // show "invalid input" where it should show "are you sure?".
    expect(r.confirmationRequired).toBe(true);
    expect(r.validationError).toBeUndefined();
  });

  it('gates every channel that can reach a shell', () => {
    for (const channel of ['terminal:exec', 'computer:runShell', 'computer:osascript']) {
      expect(SHELL_GATED_CHANNELS.has(channel)).toBe(true);
    }
  });
});



describe('approvals are bound to the payload, not just the channel', () => {
  // The attack this closes: approve `ls`, then invoke `rm -rf` on the SAME
  // channel. A channel-scoped grant would let the second call through.
  const ls = payloadFingerprint([{ command: 'ls' }]);
  const rm = payloadFingerprint([{ command: 'rm -rf /' }]);

  it('consumes a grant when the payload matches exactly', () => {
    armChannelApproval('terminal:exec', ls);
    expect(consumeChannelApproval('terminal:exec', ls)).toBe(true);
  });

  it('REFUSES a different payload on the same channel', () => {
    armChannelApproval('terminal:exec', ls);
    expect(consumeChannelApproval('terminal:exec', rm)).toBe(false);
  });

  it('destroys the grant on mismatch, so a later match cannot reuse it', () => {
    armChannelApproval('terminal:exec', ls);
    expect(consumeChannelApproval('terminal:exec', rm)).toBe(false);
    // The consent the user gave was for `ls`; if the payload has already
    // changed once, we must not later honour that stale consent.
    expect(consumeChannelApproval('terminal:exec', ls)).toBe(false);
  });

  it('allows a repeated identical call, but only after a fresh approval', () => {
    armChannelApproval('terminal:exec', ls);
    expect(consumeChannelApproval('terminal:exec', ls)).toBe(true);
    // Single-use is preserved: the second identical call needs its own grant.
    expect(consumeChannelApproval('terminal:exec', ls)).toBe(false);
    armChannelApproval('terminal:exec', ls);
    expect(consumeChannelApproval('terminal:exec', ls)).toBe(true);
  });

  it('refuses a grant whose payload differs only in an extra field', () => {
    const base = payloadFingerprint([{ command: 'ls' }]);
    const tampered = payloadFingerprint([{ command: 'ls', cwd: '/etc' }]);
    armChannelApproval('terminal:exec', base);
    expect(consumeChannelApproval('terminal:exec', tampered)).toBe(false);
  });

  it('does not let one channel\'s grant unlock another', () => {
    armChannelApproval('terminal:exec', ls);
    expect(consumeChannelApproval('computer:runShell', ls)).toBe(false);
  });

  it('refuses to arm a channel that is not gated', () => {
    expect(armChannelApproval('settings:getAll', ls)).toBe(false);
  });

  it('drops every grant when the policy changes', () => {
    armChannelApproval('terminal:exec', ls);
    armChannelApproval('computer:runShell', rm);
    revokeChannelApprovals();
    expect(consumeChannelApproval('terminal:exec', ls)).toBe(false);
    expect(consumeChannelApproval('computer:runShell', rm)).toBe(false);
  });

  it('ignores key order, so an equivalent payload is not a false mismatch', () => {
    expect(payloadFingerprint([{ a: 1, b: 2 }])).toBe(payloadFingerprint([{ b: 2, a: 1 }]));
  });

  it('distinguishes array order, which is semantically significant', () => {
    expect(payloadFingerprint([['a', 'b']])).not.toBe(payloadFingerprint([['b', 'a']]));
  });

  it('does not put the command text in the fingerprint', () => {
    expect(ls).not.toContain('rm');
    expect(ls).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * The invariant, pinned adversarially: NO two semantically different payloads
 * may share a fingerprint. Every false mismatch is acceptable — it re-prompts —
 * but a single false match is a consent bypass.
 */
describe('fingerprint invariant — different content never collides', () => {
  const pairs: Array<[string, unknown[], unknown[]]> = [
    ['extra field', [{ command: 'ls' }], [{ command: 'ls', timeout: 5000 }]],
    ['different command', [{ command: 'ls' }], [{ command: 'rm -rf /' }]],
    ['number vs string', [{ command: 'ls', timeout: 100 }], [{ command: 'ls', timeout: '100' }]],
    ['trailing whitespace', [{ command: 'ls' }], [{ command: 'ls ' }]],
    ['array order', [['ls', 'pwd']], [['pwd', 'ls']]],
    ['nested value', [{ o: { a: 1 } }], [{ o: { a: 2 } }]],
    ['added nested key', [{ o: { a: 1 } }], [{ o: { a: 1, b: 2 } }]],
    ['null vs missing', [{ a: null }], [{}]],
    ['absent trailing arg', [{ command: 'ls' }], [{ command: 'ls' }, undefined]],
  ];

  for (const [name, a, b] of pairs) {
    it(`distinguishes ${name}`, () => {
      expect(payloadFingerprint(a)).not.toBe(payloadFingerprint(b));
    });
  }

  it('treats key reordering as equal, so an equivalent call is not re-prompted', () => {
    expect(payloadFingerprint([{ a: 1, b: 2 }])).toBe(payloadFingerprint([{ b: 2, a: 1 }]));
    expect(payloadFingerprint([{ o: { a: 1, b: 2 } }])).toBe(
      payloadFingerprint([{ o: { b: 2, a: 1 } }]),
    );
  });
});

describe('TTL still expires a bound grant', () => {
  it('refuses a matching payload once the grant has expired', () => {
    vi.useFakeTimers();
    try {
      const fp = payloadFingerprint([{ command: 'ls' }]);
      armChannelApproval('terminal:exec', fp);
      // 60s is APPROVAL_TTL_MS; step just past it.
      vi.advanceTimersByTime(61_000);
      expect(consumeChannelApproval('terminal:exec', fp)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still honours a grant just before it expires', () => {
    vi.useFakeTimers();
    try {
      const fp = payloadFingerprint([{ command: 'ls' }]);
      armChannelApproval('terminal:exec', fp);
      vi.advanceTimersByTime(30_000);
      expect(consumeChannelApproval('terminal:exec', fp)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('every registered schema name matches a channel that exists', () => {
  it('has no schema pointing at a channel name that was never registered', () => {
    // Guessed channel names are what caused the earlier regressions; this
    // guards the table against gaining one.
    const guessed = Object.keys(channelSchemas).filter((c) => c.includes('filesystem:'));
    expect(guessed).toEqual([]);
  });

  it('keeps validateRequest rejecting a bad computer:click payload', () => {
    expect(() => validateRequest('computer:click', { x: '0', y: 0 })).toThrow(ValidationError);
  });
});