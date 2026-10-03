/**
 * Choosing the machine's real LAN address.
 *
 * The original took the first non-internal IPv4 out of
 * `os.networkInterfaces()`. On Windows that is enumeration order, so a
 * Hyper-V "vEthernet (Default Switch)" at 172.18.96.1 won over the machine's
 * actual Wi-Fi at 192.168.1.110 — and Henry handed a phone a QR pointing at an
 * address that is not on the real network.
 *
 * Selection is now driven by evidence rather than order:
 *
 *   1. the source address of the ACTIVE DEFAULT ROUTE — the single strongest
 *      signal, and it works for Ethernet, Wi-Fi or anything else that is really
 *      carrying traffic;
 *   2. interfaces that look like virtual/internal adapters (Hyper-V, WSL,
 *      Docker, VPN, loopback bridges) are demoted, as *additional* evidence —
 *      never the only thing consulted, so a machine whose only connection is a
 *      virtual adapter still gets a usable answer;
 *   3. private RFC1918 / link-local addresses beat link-local 169.254 stubs;
 *   4. anything else with a real unicast IPv4 is still usable.
 *
 * The scoring is a pure function over an injected interface list and an injected
 * default-route source, so the exact topology that broke is a unit test rather
 * than something to rediscover on a laptop.
 */
import os from 'os';
import { execFile } from 'child_process';

export interface CandidateIface {
  name: string;
  address: string;
  family: string;
  internal: boolean;
  mac: string;
  netmask: string;
  cidr: string;
}

export interface RouteHint {
  /** Source address of the active default route, e.g. 192.168.1.110. */
  defaultRouteSource: string | null;
}

/** Interface families that are virtual, container or tunnel plumbing. */
const VIRTUAL_PATTERNS: RegExp[] = [
  /vethernet/i,          // Hyper-V / Windows default switch
  /hyper-v/i,
  /loopback pseudo-interface/i,
  /bluetooth/i,
  /docker/i,
  /veth/i,
  /virbr/i,
  /vmnet/i,
  /virtualbox/i,
  /vmware/i,
  /vpn|virtual tunnel|tap-windows|wintun|tailscale|zerotier|wireguard|openvpn/i,
  /wsl|loopback/i,
  /\*\d+$/,                  // Windows Network Bridge, "Local Area Connection*2"
  /isatap|teredo/i,
  /apipa/i,
];

export function looksVirtual(name: string): boolean {
  return VIRTUAL_PATTERNS.some((re) => re.test(name));
}

/** 169.254.x.x is a self-assigned fallback, never a real LAN. */
function isLinkLocal(addr: string): boolean {
  return addr.startsWith('169.254.');
}

function isPrivateLan(addr: string): boolean {
  return (
    /^10\./.test(addr) ||
    /^192\.168\./.test(addr) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
  );
}

/**
 * Pick the best LAN address. Higher score wins.
 * Returns null when nothing usable exists.
 */
export function selectLanAddress(
  ifaces: Record<string, CandidateIface[] | undefined>,
  route: RouteHint = { defaultRouteSource: null }
): string | null {
  const scored: { addr: string; score: number; name: string }[] = [];

  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      // Node reports family as 'IPv4' or 4 depending on version.
      const isV4 = i.family === 'IPv4' || (i.family as unknown as number) === 4;
      if (!isV4) continue;
      if (i.internal) continue;
      const addr = i.address;
      if (!addr || addr === '0.0.0.0' || addr === '127.0.0.1') continue;

      let score = 10;

      // 1. Carrying the default route is decisive.
      if (route.defaultRouteSource && addr === route.defaultRouteSource) score += 1000;

      // 2. Virtual/container/tunnel plumbing is demoted, not excluded.
      if (looksVirtual(name)) score -= 200;

      // 3. Real LAN ranges beat link-local self-assignment.
      if (isPrivateLan(addr)) score += 40;
      if (isLinkLocal(addr)) score -= 60;

      // 4. A hardware MAC suggests a physical NIC.
      if (i.mac && i.mac !== '00:00:00:00:00:00') score += 5;

      scored.push({ addr, score, name });
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.addr.localeCompare(b.addr));
  return scored[0].addr;
}

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (_e, stdout) =>
        resolve(String(stdout || ''))
      );
    } catch {
      resolve('');
    }
  });
}

/**
 * Find the source address of the active default route.
 *
 * Windows: `route print -4` lists "0.0.0.0  0.0.0.0  <gateway>  <ifIndex>" and a
 * separate "Active Routes" table carrying the interface IP. Linux/macOS:
 * `netstat -rn` shows the destination column as 0.0.0.0 / default with the
 * source address alongside.
 */
export async function detectDefaultRouteSource(): Promise<string | null> {
  if (process.platform === 'win32') {
    const out = await run('cmd', ['/c', 'route', 'print', '-4']);
    if (!out) return null;
    // Active Routes table: "<ifIndex>  <dest>  <mask>  <gateway>  <ip>  <metric>".
    // Find the block whose gateway column is 0.0.0.0 (the on-link/default row)
    // and take the interface IP from that row.
    const lines = out.split(/\r?\n/);
    let inActive = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^Active Routes/i.test(line)) { inActive = true; continue; }
      if (!inActive) continue;
      const m = /^(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/.exec(line);
      if (m && m[4] === '0.0.0.0') return m[5];
    }
    // Fall back: the Persistent Routes table maps gateway -> interface IP.
    let inPersistent = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^Persistent Routes/i.test(line)) { inPersistent = true; continue; }
      if (inPersistent && !line) break;
      const m = /^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
      if (m && m[2] === '0.0.0.0') return m[3];
    }
    return null;
  }

  const out = await run('netstat', ['-rn']);
  if (!out) return null;
  for (const raw of out.split(/\n/)) {
    if (!/(^|\s)(0\.0\.0\.0|default)(\/0)?\s/.test(raw)) continue;
    const cols = raw.trim().split(/\s+/);
    // Linux: dest gateway genmask flags mtu metric iface src
    // macOS: dest gateway flags netif exif metric
    const src = cols[cols.length - 1];
    if (src && /^\d+\.\d+\.\d+\.\d+$/.test(src) && src !== '0.0.0.0') return src;
  }
  return null;
}

let cached: { addr: string | null; at: number } | null = null;

/**
 * The machine's real LAN address, cached briefly because interface enumeration
 * is not free and the answer only changes when the network does.
 */
export async function getLanAddress(maxAgeMs = 15_000): Promise<string | null> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.addr;
  const route = { defaultRouteSource: await detectDefaultRouteSource() };
  const addr = selectLanAddress(os.networkInterfaces() as unknown as Record<string, CandidateIface[]>, route);
  cached = { addr, at: Date.now() };
  return addr;
}

/** Synchronous best-effort, for call sites that cannot await. */
export function getLanAddressSync(): string | null {
  if (cached) return cached.addr;
  const ifaces = os.networkInterfaces() as unknown as Record<string, CandidateIface[]>;
  // No route hint synchronously; fall back to scoring alone, which still demotes
  // the virtual adapters even when the default route is unknown.
  return selectLanAddress(ifaces, { defaultRouteSource: null });
}

export function clearLanAddressCache(): void {
  cached = null;
}