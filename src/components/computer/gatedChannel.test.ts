// @vitest-environment node
/**
 * `gatedChannel` — the consumer the shell-confirmation gate never had.
 *
 * ## What these tests are for
 *
 * `consumeChannelApproval` returning false when nothing is armed passed forever
 * while no user action could ever arm anything: the gate was correct and
 * completely unusable, and every test that exercised it called
 * `armChannelApproval` / `consumeChannelApproval` directly. A consumer can be
 * absent and that suite stays green.
 *
 * So every test here goes through the path a user actually takes:
 *
 *     invoke → boundary refuses → user reads the prompt → approves
 *            → securityApproveChannel → invoke again → handler runs
 *
 * The `invoke` and `approve` doubles below are NOT stubs of the gate. They are
 * a faithful re-implementation of the two real main-process sites —
 * `installIpcBoundary` (electron/ipc/validation.ts:1056) and
 * `security:approve-channel` (electron/main.ts:1200) — calling the REAL
 * `channelSchemas`, `sanitizePayload`, `payloadFingerprint`,
 * `armChannelApproval`, `consumeChannelApproval` and `confirmationRequired`
 * from the main process. Change the fingerprinting and this file fails; that is
 * the whole point of not hand-rolling the boundary.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  channelSchemas,
  confirmationRequired,
  consumeChannelApproval,
  payloadFingerprint,
  revokeChannelApprovals,
  sanitizePayload,
  armChannelApproval,
  SHELL_GATED_CHANNELS,
} from '../../../electron/ipc/validation';
import {
  describeGatedCall,
  GATED_CHANNELS,
  isConfirmationRequired,
  normaliseGatedArgs,
  runGatedChannel,
  type GatedDeps,
} from './gatedChannel';

// ── The real boundary, reproduced ───────────────────────────────────────────

/** Mirrors the cleanup path in `installIpcBoundary` for a given channel. */
function cleanArgs(channel: string, args: readonly unknown[]): unknown[] {
  const schema = channelSchemas[channel];
  if (Array.isArray(schema)) {
    return args.map((value, i) => {
      const s = schema[i];
      return s ? s.parse(value) : sanitizePayload(value);
    });
  }
  if (schema) {
    return args.map((value, i) => (i === 0 ? schema.parse(value) : sanitizePayload(value)));
  }
  return args.map((value) => sanitizePayload(value));
}

interface Boundary {
  /** What the gated handler returns when it is allowed to run. */
  run: (channel: string, args: unknown[]) => unknown;
  /** Calls actually made to the handler — what a user would see happen. */
  executed: Array<{ channel: string; args: unknown[] }>;
  approvals: Array<{ channel: string; args: unknown[] }>;
}

interface BoundaryOptions {
  /** `confirmShell` off means no gate at all. */
  confirmShell?: boolean;
  /** The app lock refuses everything not on LOCK_EXEMPT_CHANNELS. */
  locked?: boolean;
  /** Force a refusal even when a valid grant exists — models a mid-flight change. */
  refuseEvenWhenArmed?: boolean;
  /** Refuse the approve channel too, exactly as the app lock does. */
}

const LOCK_EXEMPT_CHANNELS = new Set([
  'security:get',
  'security:unlock',
  'security:setPin',
  'security:clearPin',
  'security:approve-channel',
]);

function installBoundary(options: BoundaryOptions = {}): Boundary {
  const { confirmShell = true, locked = false, refuseEvenWhenArmed = false } = options;
  const executed: Array<{ channel: string; args: unknown[] }> = [];
  const approvals: Array<{ channel: string; args: unknown[] }> = [];

  return {
    executed,
    approvals,
    run: (channel, args) => {
      const cleaned = cleanArgs(channel, args);
      const fingerprint = payloadFingerprint(cleaned);

      if (locked && !LOCK_EXEMPT_CHANNELS.has(channel)) return confirmationRequired(channel);
      if (confirmShell && SHELL_GATED_CHANNELS.has(channel)) {
        // The grant is still SPENT on every attempt, exactly as the real
        // `consumeChannelApproval` does — a mismatch destroys it rather than
        // leaving it for a later matching call.
        const armed = consumeChannelApproval(channel, fingerprint);
        if (!armed || refuseEvenWhenArmed) return confirmationRequired(channel);
      }
      executed.push({ channel, args: cleaned });
      return { success: true, output: 'ran: ' + JSON.stringify(cleaned) };
    },
  };
}

interface DepOptions {
  /** What the user does at the prompt. */
  answer: (summary: string) => Promise<boolean> | boolean;
  /**
   * `true` when `security:approve-channel` is itself refused.
   *
   * That channel is NOT on `LOCK_EXEMPT_CHANNELS`, so a locked app refuses
   * the grant the renderer just asked for — which is how the renderer can tell
   * "you said yes" from "the app is locked and said yes was never reachable".
   */
  approveRefused?: boolean;
}

/** Mirrors `security:approve-channel` in electron/main.ts:1200. */
function makeDeps(boundary: Boundary, options: DepOptions): GatedDeps {
  return {
    invoke: async (channel, args) => boundary.run(channel, [...args]),
    approve: async (channel, args) => {
      if (options.approveRefused === true) {
        return { ok: false, channel, error: 'locked' };
      }
      const normalised = [...args].map((a) => sanitizePayload(a));
      const ok = armChannelApproval(channel, payloadFingerprint(normalised));
      boundary.approvals.push({ channel, args: normalised });
      return { ok, channel };
    },
    ask: async (description) => options.answer(description.summary),
  };
}

// Grants live in a module-level map with a 60s TTL. Without this reset a grant
// armed by one test would still be spendable by the next, so a test asserting
// "this was refused" could pass or fail on the order the tests happened to run.
beforeEach(() => {
  revokeChannelApprovals();
});

// ── Normalisation: the property that prevents an infinite re-prompt ─────────

describe('normaliseGatedArgs — the payload must fingerprint the same on both sides', () => {
  const payloads: Array<[string, unknown[]]> = [
    ['computer:runShell', [{ command: '  ls -la  ', timeout: 5000 }]],
    ['computer:runShell', [{ command: 'ls' }]],
    // The undefined-optional-key case: zod KEEPS the key, sanitizePayload drops
    // it. Un-normalised this is the silent infinite re-prompt.
    ['computer:runShell', [{ command: 'ls', timeout: undefined }]],
    ['computer:runShell', [{ command: 'ls', cwd: '/tmp', extra: { deep: undefined, keep: 1 } }]],
    ['terminal:exec', [{ command: ' npm test ', cwd: '/repo', timeout: 1000 }]],
    ['terminal:exec', [{ command: 'echo hi', channelId: 'c1' }]],
    ['computer:osascript', ['  tell application "System Events" to key code 49  ']],
    ['printer:sendGcode', ['M115']],
    ['printer:sendGcode', ['G28\nG1 X10 Y10 F3000\n']],
    ['printer:printGcode', ['M104 S200\nM140 S60\n']],
  ];

  for (const [channel, args] of payloads) {
    it(`agrees with the boundary for ${channel} ${JSON.stringify(args).slice(0, 60)}`, () => {
      const normalised = normaliseGatedArgs(channel, args);

      // The boundary side: schema-parsed.
      const boundaryFingerprint = payloadFingerprint(cleanArgs(channel, normalised));
      // The approve side: sanitised only. main.ts:1207.
      const approveFingerprint = payloadFingerprint(normalised.map((a) => sanitizePayload(a)));

      expect(approveFingerprint).toBe(boundaryFingerprint);
    });
  }

  it('does NOT agree without normalisation — the bug this guards against is real', () => {
    const raw: unknown[] = [{ command: '  ls  ', timeout: undefined }];
    const boundaryFingerprint = payloadFingerprint(cleanArgs('computer:runShell', raw));
    const approveFingerprint = payloadFingerprint(raw.map((a) => sanitizePayload(a)));
    expect(approveFingerprint).not.toBe(boundaryFingerprint);
  });

  it('strips prototype-pollution keys rather than passing them across', () => {
    const normalised = normaliseGatedArgs('computer:runShell', [
      { command: 'ls', __proto__: { polluted: true }, constructor: 'x' },
    ]) as Array<Record<string, unknown>>;
    expect(Object.prototype.hasOwnProperty.call(normalised[0], '__proto__')).toBe(false);
    expect(Object.keys(normalised[0])).toEqual(['command']);
  });

  it('does not trim G-code, which is whitespace-significant', () => {
    expect(normaliseGatedArgs('printer:sendGcode', ['\nG28\n'])[0]).toBe('\nG28\n');
  });
});

describe('GATED_CHANNELS must match the main process', () => {
  it('names exactly the channels the boundary gates', () => {
    expect([...GATED_CHANNELS].sort()).toEqual([...SHELL_GATED_CHANNELS].sort());
  });
});

// ── The flow ────────────────────────────────────────────────────────────────

describe('runGatedChannel — the real approve-then-retry path', () => {
  it('invokes, is refused, asks, arms, and re-invokes until the command runs', async () => {
    const boundary = installBoundary();
    const seen: string[] = [];
    const outcome = await runGatedChannel<{ success: boolean }>(
      makeDeps(boundary, {
      answer: (summary) => {
        seen.push(summary);
        return true;
      } }),
      { channel: 'computer:runShell', args: [{ command: 'echo hello', timeout: 5000 }] },
    );

    // The handler saw the command exactly once.
    expect(boundary.executed).toHaveLength(1);
    expect(boundary.executed[0].channel).toBe('computer:runShell');
    // And the user saw the actual command, not "are you sure?".
    expect(seen).toEqual(['echo hello']);
    // The grant was armed for the payload that was actually refused.
    expect(boundary.approvals).toHaveLength(1);
    expect(outcome.status).toBe('ran');
  });

  it('still runs when the caller hands over a payload the boundary would transform', async () => {
    // This is the payload shape that produces an infinite re-prompt: zod trims
    // `command` and KEEPS the explicitly-undefined `timeout` key, while
    // `sanitizePayload` drops it. Approving the raw payload therefore arms a
    // grant the retry cannot spend, forever.
    const boundary = installBoundary();
    let prompts = 0;
    const outcome = await runGatedChannel(
      makeDeps(boundary, {
        answer: () => {
          prompts += 1;
          return true;
        },
      }),
      { channel: 'computer:runShell', args: [{ command: '  sudo rm -rf /  ', timeout: undefined }] },
    );

    // One prompt, not an unbounded loop of them.
    expect(prompts).toBe(1);
    expect(outcome.status).toBe('ran');
    expect(boundary.executed).toHaveLength(1);
    // And what ran is what the user was shown — trimmed, matching the schema.
    expect(boundary.executed[0].args[0]).toEqual({ command: 'sudo rm -rf /' });
  });

  it('approving payload A does not allow payload B', async () => {
    const boundary = installBoundary();
    let answer = true;
    const deps = makeDeps(boundary, { answer: () => answer });

    // Approve `rm -rf /tmp/x`.
    await runGatedChannel(deps, { channel: 'computer:runShell', args: [{ command: 'rm -rf /tmp/x' }] });
    expect(boundary.executed).toHaveLength(1);

    // Now the very next call on the SAME channel with a different command must
    // be refused again and re-prompted. A grant that outlived its payload is
    // the "consent for `ls` also authorises `rm -rf`" failure.
    answer = true;
    const second = await runGatedChannel(deps, { channel: 'computer:runShell', args: [{ command: 'rm -rf /' }] });
    expect(second.status).toBe('ran');
    expect(boundary.executed).toHaveLength(2);
    expect(boundary.executed[1].args[0]).toEqual({ command: 'rm -rf /' });

    // And with the user saying no, the escalation stops dead.
    answer = false;
    const third = await runGatedChannel(deps, { channel: 'computer:runShell', args: [{ command: 'rm -rf /home' }] });
    expect(third.status).toBe('declined');
    expect(boundary.executed).toHaveLength(2);
  });

  it('rejects without invoking or arming anything further', async () => {
    const boundary = installBoundary();
    const outcome = await runGatedChannel(
      makeDeps(boundary, { answer: () => false }),
      { channel: 'printer:sendGcode', args: ['M115'] },
    );

    expect(outcome.status).toBe('declined');
    expect(boundary.executed).toHaveLength(0);
    expect(boundary.approvals).toHaveLength(0);
  });

  it('does not re-arm after a second refusal — no approval-harvesting loop', async () => {
    const boundary = installBoundary({ refuseEvenWhenArmed: true });
    let prompts = 0;
    const outcome = await runGatedChannel(
      makeDeps(boundary, {
        answer: () => {
        prompts += 1;
        return true;
      } }),
      { channel: 'computer:runShell', args: [{ command: 'echo loop' }] },
    );

    expect(prompts).toBe(1);
    expect(boundary.approvals).toHaveLength(1);
    expect(boundary.executed).toHaveLength(0);
    expect(outcome.status).toBe('blocked');
  });

  it('runs straight through when the gate is off, with no prompt at all', async () => {
    const boundary = installBoundary({ confirmShell: false });
    let prompts = 0;
    const outcome = await runGatedChannel(
      makeDeps(boundary, {
        answer: () => {
        prompts += 1;
        return true;
      } }),
      { channel: 'computer:runShell', args: [{ command: 'ls' }] },
    );

    expect(prompts).toBe(0);
    expect(boundary.approvals).toHaveLength(0);
    expect(boundary.executed).toHaveLength(1);
    expect(outcome.status).toBe('ran');
  });

  it('reports "blocked" and runs nothing when the app lock refuses the approval', async () => {
    // `security:approve-channel` is NOT on LOCK_EXEMPT_CHANNELS, so a locked
    // app refuses the grant itself. The flow must stop rather than retry blind.
    const boundary = installBoundary({ locked: true });
    const outcome = await runGatedChannel(
      makeDeps(boundary, { answer: () => true, approveRefused: true }),
      { channel: 'computer:runShell', args: [{ command: 'ls' }] },
    );

    expect(outcome.status).toBe('blocked');
    expect(boundary.executed).toHaveLength(0);
    expect(boundary.approvals).toHaveLength(0);
  });

  it('refuses to act on a channel that is not gated', async () => {
    const boundary = installBoundary();
    const outcome = await runGatedChannel(
      makeDeps(boundary, { answer: () => true }),
      { channel: 'computer:screenshot', args: [{}] },
    );
    expect(outcome.status).toBe('blocked');
    expect(boundary.approvals).toHaveLength(0);
    expect(boundary.executed).toHaveLength(0);
  });

  it('reports a real handler failure as a run, not as a refusal', async () => {
    // The handler returning {success:false} is not a confirmationRequired shape,
    // so it must pass straight through rather than trigger a prompt.
    const boundary = installBoundary({ confirmShell: false });
    const failing: GatedDeps = {
      ...makeDeps(boundary, { answer: () => true }),
      invoke: async () => ({ success: false, error: 'command not found' }),
    };
    const outcome = await runGatedChannel<{ success: boolean; error?: string }>(failing, {
      channel: 'computer:runShell',
      args: [{ command: 'nope' }],
    });
    expect(outcome.status).toBe('ran');
    if (outcome.status === 'ran') expect(outcome.response.error).toBe('command not found');
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe('cancelling mid-flow', () => {
  it('a throw from the prompt leaves no armed grant', async () => {
    const boundary = installBoundary();
    const deps = makeDeps(boundary, {
      answer: () => {
        throw new Error('panel unmounted');
      },
    });

    // A throwing prompt is a crash path a user can actually hit (navigating
    // away mid-decision). It must not be mistaken for approval.
    await expect(
      runGatedChannel(deps, { channel: 'computer:runShell', args: [{ command: 'rm -rf /' }] }),
    ).rejects.toThrow('panel unmounted');

    expect(boundary.approvals).toHaveLength(0);
    expect(boundary.executed).toHaveLength(0);
    // And nothing is armed: a subsequent call is refused, not silently allowed.
    const later = await runGatedChannel(
      makeDeps(boundary, { answer: () => false }),
      { channel: 'computer:runShell', args: [{ command: 'rm -rf /' }] },
    );
    expect(later.status).toBe('declined');
  });
});

// ── Refusal detection ───────────────────────────────────────────────────────

describe('isConfirmationRequired', () => {
  it('matches only the boundary refusal shape', () => {
    expect(isConfirmationRequired(confirmationRequired('computer:runShell'))).toBe(true);
    expect(isConfirmationRequired({ success: true })).toBe(false);
    expect(isConfirmationRequired({ confirmationRequired: false })).toBe(false);
    expect(isConfirmationRequired({ confirmationRequired: true })).toBe(false);
    expect(isConfirmationRequired(null)).toBe(false);
    expect(isConfirmationRequired('nope')).toBe(false);
  });
});

describe('describeGatedCall — the prompt must show what will actually run', () => {
  it('leads with the command text', () => {
    const d = describeGatedCall('computer:runShell', [{ command: 'sudo rm -rf /', timeout: 500 }]);
    expect(d.summary).toBe('sudo rm -rf /');
    expect(d.detail).toContain('timeout');
  });

  it('shows the raw payload for a G-code channel', () => {
    expect(describeGatedCall('printer:sendGcode', ['M115']).summary).toBe('M115');
  });

  it('truncates a huge payload rather than rendering it whole', () => {
    const huge = 'G1 X1\n'.repeat(5_000);
    const d = describeGatedCall('printer:printGcode', [huge]);
    expect(d.summary.length).toBeLessThan(huge.length);
    expect(d.summary).toContain('more characters not shown');
  });
});