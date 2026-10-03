/**
 * The security switches are only worth having if they change what the app DOES.
 * A toggle that flips a boolean in the renderer while the main process carries
 * on regardless would be worse than no toggle at all — it would tell the user
 * their shell commands are gated when they are not.
 *
 * These tests therefore assert on the main-process policy store, which is the
 * single thing the IPC boundary, the tool runner, and the sync bridge read.
 *
 * The real better-sqlite3 addon is compiled for Electron's ABI and cannot be
 * loaded by a plain-Node vitest run, so the store runs against the in-memory
 * fake in _fakeDb.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { asDatabase, createFakeDb, type FakeDb } from './_fakeDb';
import {
  DEFAULT_POLICY,
  POLICY_KEYS,
  resolvePolicy,
  initSecurityPolicy,
  getSecurityPolicy,
  setSecurityPolicy,
  policyFlag,
  allowsNetworkShare,
  setPin,
  clearPin,
  hasPin,
  unlock,
  isLocked,
  relock,
  __setPolicyForTest,
} from './securityPolicy';

function freshDb(): FakeDb {
  const fake = createFakeDb();
  initSecurityPolicy(asDatabase(fake));
  return fake;
}

describe('defaults', () => {
  it('requires confirmation for shell work out of the box', () => {
    expect(DEFAULT_POLICY.confirmShell).toBe(true);
    expect(DEFAULT_POLICY.confirmDeleteOutsideHome).toBe(true);
  });

  it('redacts secrets in logs out of the box', () => {
    expect(DEFAULT_POLICY.redactLogs).toBe(true);
  });

  it('keeps every network-sharing surface closed out of the box', () => {
    expect(DEFAULT_POLICY.allowLanSync).toBe(false);
    expect(DEFAULT_POLICY.allowNetworkShare).toBe(false);
  });

  it('collects no analytics until asked', () => {
    expect(DEFAULT_POLICY.persistAnalytics).toBe(false);
  });

  it('leaves the app lock off, because a lock with no PIN cannot be opened', () => {
    expect(DEFAULT_POLICY.appLock).toBe(false);
  });

  /**
   * The one switch that gates pre-existing, deliberately-designed behaviour
   * rather than a new capability. It defaults OFF so an upgrade does not change
   * what existing users experience, and so the silent/confirm tier split keeps
   * carrying information. Main overruled an earlier fail-closed default here;
   * this assertion exists to pin the decision either way.
   */
  it('leaves silent-tier tools unprompted, preserving shipped behaviour', () => {
    expect(DEFAULT_POLICY.confirmSilentTools).toBe(false);
  });

  it('still offers the stricter posture when the user asks for it', () => {
    const restore = __setPolicyForTest({ confirmSilentTools: true });
    expect(policyFlag('confirmSilentTools')).toBe(true);
    restore();
  });
});

describe('resolvePolicy — an unreadable value must never disable a protection', () => {
  it('falls back to the default for absent keys', () => {
    const p = resolvePolicy({});
    expect(p).toEqual(DEFAULT_POLICY);
  });

  it('falls back to the default for a null map', () => {
    expect(resolvePolicy(null)).toEqual(DEFAULT_POLICY);
  });

  it('falls back to the default for garbage', () => {
    const p = resolvePolicy({ security_policy_confirmShell: 'maybe' });
    expect(p.confirmShell).toBe(true);
  });

  it('falls back to the default for an empty string', () => {
    const p = resolvePolicy({ security_policy_confirmShell: '' });
    expect(p.confirmShell).toBe(true);
  });

  /**
   * The fallback rule is "degrade to the DEFAULT", not "degrade to blocking".
   * For every protection-gated switch that default happens to be the safe
   * value; for `confirmSilentTools` it is not, and that is intentional. A
   * corrupt row must therefore resolve to whichever posture the default
   * expresses — this pins that the resolver is not secretly biased.
   */
  it('degrades a corrupt row to the default, not to a fixed safe value', () => {
    const corrupt = { security_policy_confirmShell: 'maybe', security_policy_confirmSilentTools: '???' };
    const p = resolvePolicy(corrupt);
    expect(p.confirmShell).toBe(DEFAULT_POLICY.confirmShell);
    expect(p.confirmSilentTools).toBe(DEFAULT_POLICY.confirmSilentTools);
    // Spelled out, because this is the one place the two diverge.
    expect(p.confirmShell).toBe(true);
    expect(p.confirmSilentTools).toBe(false);
  });

  it('honours an explicit false — the user may turn a protection off', () => {
    const p = resolvePolicy({ security_policy_confirmShell: 'false' });
    expect(p.confirmShell).toBe(false);
  });

  it('honours 1/0 as well as true/false', () => {
    expect(resolvePolicy({ security_policy_confirmShell: '1' }).confirmShell).toBe(true);
    expect(resolvePolicy({ security_policy_confirmShell: '0' }).confirmShell).toBe(false);
  });

  it('ignores keys that are not part of the policy surface', () => {
    const p = resolvePolicy({ security_policy_notARealSwitch: 'true' });
    expect(Object.keys(p).sort()).toEqual([...POLICY_KEYS].sort());
    expect('notARealSwitch' in p).toBe(false);
  });
});

describe('the live store persists and reloads', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('seeds every key so the panel can distinguish default from unset', () => {
    const seeded = Object.keys(db.rows).filter((k) => k.startsWith('security_policy_'));
    expect(seeded).toHaveLength(POLICY_KEYS.length);
  });

  it('makes a change visible to the gate on the next read', () => {
    expect(policyFlag('confirmShell')).toBe(true);
    setSecurityPolicy('confirmShell', false);
    // This is the assertion that matters: the GATE, not just the store.
    expect(policyFlag('confirmShell')).toBe(false);
  });

  it('survives a reload from the database', () => {
    setSecurityPolicy('allowLanSync', true);
    initSecurityPolicy(asDatabase(db));
    expect(getSecurityPolicy().allowLanSync).toBe(true);
  });

  it('refuses an unknown key rather than writing an arbitrary row', () => {
    const before = Object.keys(db.rows).length;
    expect(setSecurityPolicy('notAKey' as never, true)).toBe(false);
    expect(Object.keys(db.rows)).toHaveLength(before);
  });
});

describe('network sharing requires explicit consent', () => {
  it('is closed with both switches off', () => {
    const restore = __setPolicyForTest({ allowLanSync: false, allowNetworkShare: false });
    expect(allowsNetworkShare()).toBe(false);
    restore();
  });

  it('opens for LAN consent alone', () => {
    const restore = __setPolicyForTest({ allowLanSync: true, allowNetworkShare: false });
    expect(allowsNetworkShare()).toBe(true);
    restore();
  });

  it('opens for the broader consent alone', () => {
    const restore = __setPolicyForTest({ allowLanSync: false, allowNetworkShare: true });
    expect(allowsNetworkShare()).toBe(true);
    restore();
  });
});

describe('app lock', () => {
  let db: FakeDb;
  beforeEach(async () => {
    db = freshDb();
    await setPin('4821');
    relock();
  });

  it('stores no plaintext PIN anywhere in settings', async () => {
    for (const value of Object.values(db.rows)) {
      expect(value).not.toContain('4821');
    }
  });

  it('hashes the PIN with a salt, so identical PINs differ across installs', async () => {
    const other = freshDb();
    await setPin('4821');
    expect(db.rows.security_app_pin_hash).not.toBe(other.rows.security_app_pin_hash);
  });

  it('rejects a PIN that is too short to be worth locking', async () => {
    expect(await setPin('12')).toBe(false);
  });

  it('does not report locked until the lock is actually switched on', () => {
    expect(hasPin()).toBe(true);
    expect(isLocked()).toBe(false);
    setSecurityPolicy('appLock', true);
    expect(isLocked()).toBe(true);
  });

  it('fails open when a lock is set with no PIN — an unopenable app is a brick', () => {
    clearPin();
    setSecurityPolicy('appLock', true);
    expect(hasPin()).toBe(false);
    expect(isLocked()).toBe(false);
  });

  it('unlocks with the right PIN', async () => {
    setSecurityPolicy('appLock', true);
    expect(isLocked()).toBe(true);
    expect(await unlock('4821')).toEqual({ ok: true });
    expect(isLocked()).toBe(false);
  });

  it('refuses the wrong PIN and reports how many attempts remain', async () => {
    setSecurityPolicy('appLock', true);
    const r = await unlock('0000');
    expect(r.ok).toBe(false);
    expect(r.attemptsRemaining).toBe(4);
    expect(isLocked()).toBe(true);
  });

  it('locks out after repeated failures so the PIN cannot be brute-forced', async () => {
    setSecurityPolicy('appLock', true);
    for (let i = 0; i < 5; i++) await unlock('0000');
    const r = await unlock('4821');
    expect(r.ok).toBe(false);
    expect(r.lockedOut).toBe(true);
    expect(r.retryInMs).toBeGreaterThan(0);
  });

  it('clears the lock state when the PIN is removed', async () => {
    setSecurityPolicy('appLock', true);
    await unlock('4821');
    clearPin();
    expect(getSecurityPolicy().appLock).toBe(false);
    expect(isLocked()).toBe(false);
  });
});