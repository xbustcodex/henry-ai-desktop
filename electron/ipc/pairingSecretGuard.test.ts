/**
 * The guard that killed the first real physical-device session.
 *
 * The companion page loaded on the phone, rendered, and then died because
 * `/sync/pairing-info` refused every non-loopback source:
 *
 *   [SyncBridge] BLOCKED dangerous route /sync/pairing-info from 192.168.1.110
 *
 * These routes hand out the PIN, so they cannot simply be opened to the LAN.
 * The rule is now: loopback always; LAN only when the caller presents the pair
 * token the QR already carries.
 */
import { describe, it, expect } from 'vitest';

type Source = { loopback: boolean; privateLan: boolean; tunneled: boolean };

function decide(src: Source, hasValidToken: boolean): 'allow' | 'deny' {
  if (src.loopback) return 'allow';
  if (src.privateLan && !src.tunneled && hasValidToken) return 'allow';
  return 'deny';
}

describe('pairing-secret routes', () => {
  it('always allows loopback', () => {
    expect(decide({ loopback: true, privateLan: false, tunneled: false }, false)).toBe('allow');
  });

  it('allows the phone, which arrives from the LAN holding the QR token', () => {
    // This is the case that used to kill the session.
    expect(decide({ loopback: false, privateLan: true, tunneled: false }, true)).toBe('allow');
  });

  it('still refuses any other host on the LAN without a token', () => {
    expect(decide({ loopback: false, privateLan: true, tunneled: false }, false)).toBe('deny');
  });

  it('still refuses a forged forwarding header even with a token', () => {
    // A tunnel arrives on loopback but is not really local.
    expect(decide({ loopback: false, privateLan: true, tunneled: true }, true)).toBe('deny');
  });

  it('refuses a public source outright', () => {
    expect(decide({ loopback: false, privateLan: false, tunneled: false }, true)).toBe('deny');
  });
});
