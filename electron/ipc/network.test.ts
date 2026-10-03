/**
 * The topology that produced the bug is a test, not something to rediscover.
 *
 * Reported on this Windows machine: the ordinary Ethernet adapter is
 * disconnected, a Hyper-V "vEthernet (Default Switch)" is up at 172.18.96.1,
 * and the real connection is "Wi-Fi 2" at 192.168.1.110 with a default
 * gateway. Enumeration order put vEthernet first, so Henry advertised
 * 172.18.96.1 to the phone.
 */
import { describe, it, expect } from 'vitest';
import {
  selectLanAddress,
  looksVirtual,
  detectDefaultRouteSource,
  type CandidateIface,
} from './network';

/** One interface record, not a map entry — the map is built explicitly below. */
const iface = (
  name: string,
  address: string,
  extra: Partial<CandidateIface> = {}
): CandidateIface => ({
  name,
  address,
  family: 'IPv4',
  internal: false,
  mac: '00:1a:2b:3c:4d:5e',
  netmask: '255.255.255.0',
  cidr: `${address}/24`,
  ...extra,
});

const reportedTopology = (): Record<string, CandidateIface[]> => ({
  // Object key order is what os.networkInterfaces() returned — virtual first.
  'vEthernet (Default Switch)': [
    iface('vEthernet (Default Switch)', '172.18.96.1', { netmask: '255.255.240.0' }),
  ],
  Ethernet: [iface('Ethernet', '169.254.12.34', { mac: '00:1a:2b:3c:4d:5f' })],
  'Wi-Fi 2': [iface('Wi-Fi 2', '192.168.1.110')],
});

describe('the reported machine', () => {
  it('picks the Wi-Fi default-route address, not the vEthernet switch', () => {
    const picked = selectLanAddress(reportedTopology(), {
      defaultRouteSource: '192.168.1.110',
    });
    expect(picked).toBe('192.168.1.110');
  });

  it('does the same WITHOUT the route hint, by demoting the virtual adapter', () => {
    // Even if route detection fails, vEthernet must not win on order alone.
    expect(selectLanAddress(reportedTopology(), { defaultRouteSource: null })).toBe(
      '192.168.1.110'
    );
  });

  it('still avoids the self-assigned 169.254 Ethernet fallback', () => {
    const picked = selectLanAddress(reportedTopology(), { defaultRouteSource: null });
    expect(picked).not.toBe('169.254.12.34');
  });
});

describe('other legitimate machines', () => {
  it('a wired-only machine with a default route picks Ethernet', () => {
    const ifaces = {
      'vEthernet (Default Switch)': [iface('vEthernet (Default Switch)', '172.18.96.1')],
      Ethernet: [iface('Ethernet', '192.168.0.50')],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: '192.168.0.50' })).toBe('192.168.0.50');
  });

  it('a machine whose only link is a virtual adapter still gets an answer', () => {
    // Demoted, never excluded: no usable alternative must not mean no answer.
    const ifaces = {
      'vEthernet (WSL)': [iface('vEthernet (WSL)', '172.24.0.1')],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: null })).toBe('172.24.0.1');
  });

  it('a Docker bridge does not beat the real LAN', () => {
    const ifaces = {
      'Docker Desktop': [iface('Docker Desktop', '192.168.65.1')],
      en0: [iface('en0', '10.0.0.42')],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: '10.0.0.42' })).toBe('10.0.0.42');
    expect(selectLanAddress(ifaces, { defaultRouteSource: null })).toBe('10.0.0.42');
  });

  it('a VPN adapter does not beat the physical LAN', () => {
    const ifaces = {
      'Tailscale Tunnel': [iface('Tailscale Tunnel', '100.64.0.1')],
      'Wi-Fi': [iface('Wi-Fi', '192.168.1.50')],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: '192.168.1.50' })).toBe('192.168.1.50');
  });

  it('honours the default route even when it is not a private range', () => {
    const ifaces = {
      'vEthernet': [iface('vEthernet', '172.18.96.1')],
      ppp0: [iface('ppp0', '203.0.113.7')],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('returns null when there is genuinely nothing usable', () => {
    const ifaces = {
      lo: [
        {
          name: 'lo',
          address: '127.0.0.1',
          family: 'IPv4',
          internal: true,
          mac: '00:00:00:00:00:00',
          netmask: '255.0.0.0',
          cidr: '127.0.0.1/8',
        } as CandidateIface,
      ],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: null })).toBeNull();
    expect(selectLanAddress({}, { defaultRouteSource: null })).toBeNull();
  });

  it('ignores IPv6 and unspecified addresses', () => {
    const ifaces = {
      eth0: [{ ...iface('eth0', '192.168.1.9'), family: 'IPv6', address: 'fe80::1' }],
    } as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: null })).toBeNull();
  });

  it('accepts family as the numeric 4 some Node versions report', () => {
    const ifaces = {
      eth0: [{ ...iface('eth0', '192.168.1.11'), family: 4 as unknown as string }],
    } as unknown as Record<string, CandidateIface[]>;
    expect(selectLanAddress(ifaces, { defaultRouteSource: null })).toBe('192.168.1.11');
  });
});

describe('virtual interface identification', () => {
  it('recognises the families that caused this', () => {
    for (const n of [
      'vEthernet (Default Switch)',
      'Hyper-V Virtual Ethernet Adapter',
      'Docker Desktop',
      'veth1234',
      'Tailscale Tunnel',
      'WireGuard Tunnel',
      'Loopback Pseudo-Interface 1',
      'Bluetooth Network Connection',
      'Bluetooth Device (Personal Area Network)',
      'isatap.{6A4B4520-...}',
      'Local Area Connection*2',
    ]) {
      expect(looksVirtual(n), n).toBe(true);
    }
  });

  it('does not misclassify real adapters', () => {
    for (const n of ['Wi-Fi', 'Wi-Fi 2', 'Ethernet', 'Local Area Connection', 'en0']) {
      expect(looksVirtual(n), n).toBe(false);
    }
  });
});

describe('default route detection', () => {
  it('returns null rather than throwing when no route tool is available', async () => {
    await expect(detectDefaultRouteSource()).resolves.toSatisfy((v: unknown) => v === null || typeof v === 'string');
  });
});