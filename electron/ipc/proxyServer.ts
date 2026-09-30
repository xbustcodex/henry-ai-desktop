/**
 * Henry VPN — SOCKS5 + HTTP CONNECT proxy server
 * Pure Node.js, zero external dependencies.
 * Routes a paired phone's traffic through the desktop's internet connection.
 *
 * SECURITY: this proxy is only safe BECAUSE it requires the companion token
 * that pairing already issues. It used to reply "no authentication required"
 * and relay any destination for any LAN client — which meant a stranger could
 * `CONNECT 127.0.0.1:4242` through it and arrive at the companion server as
 * loopback, unlocking the loopback-only routes (including the shell-exec
 * route). The proxy now authenticates with the EXISTING paired-device
 * credential; it does not introduce a second identity system, and the QR/PIN
 * pairing flow plus the host-side remote-control approval are unchanged.
 */

import * as net from 'net';
import * as http from 'http';
import * as https from 'https';

let _proxyServer: net.Server | null = null;
let _proxyPort = 0;
let _proxyRunning = false;

export function getProxyPort(): number { return _proxyPort; }
export function isProxyRunning(): boolean { return _proxyRunning; }

/**
 * Validates a token against Henry's existing paired-device credentials.
 * Supplied by the sync bridge (which owns the token store) to avoid a circular
 * import. Required — the proxy must never run unauthenticated.
 */
export type PairedTokenValidator = (token: string) => boolean;

export interface ProxyOptions {
  /** Returns true when the token belongs to a device paired with this Henry. */
  isPairedToken: PairedTokenValidator;
  /** Optional sink for rejected-attempt logging. */
  onDenied?: (reason: string, remoteAddress: string) => void;
}

// ── SOCKS5 proxy implementation ────────────────────────────────────────────
export function startProxy(port = 1080, opts?: ProxyOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    if (_proxyServer) { resolve(_proxyPort); return; }

    // Refuse to start open. Without a validator there is no safe default, so
    // this is a hard error rather than a silent fallback to "no auth".
    if (!opts?.isPairedToken) {
      reject(new Error('startProxy requires an isPairedToken validator — the proxy must never run unauthenticated.'));
      return;
    }
    const isPairedToken = opts.isPairedToken;
    const onDenied = opts.onDenied ?? (() => { /* ignore */ });

    _proxyServer = net.createServer((client) => {
      handleSocks5(client, isPairedToken, onDenied);
    });

    _proxyServer.on('error', (err) => {
      console.error('[Proxy] Error:', err.message);
      if (!_proxyRunning) reject(err);
    });

    _proxyServer.listen(port, '0.0.0.0', () => {
      _proxyPort = (_proxyServer!.address() as net.AddressInfo).port;
      _proxyRunning = true;
      console.log(`[Proxy] SOCKS5 proxy listening on port ${_proxyPort}`);
      resolve(_proxyPort);
    });
  });
}

export function stopProxy(): void {
  _proxyServer?.close();
  _proxyServer = null;
  _proxyRunning = false;
  _proxyPort = 0;
}

/**
 * SOCKS5 handshake, driven by an explicit buffer rather than `once('data')`.
 *
 * Relying on one `data` event per protocol message is not safe: a client may
 * pipeline the auth and CONNECT requests into a single TCP segment, or a
 * message may be split across reads. Either way the tail was silently dropped
 * and the client hung. This state machine consumes exactly the bytes each
 * stage needs and carries the remainder forward.
 */
function handleSocks5(
  client: net.Socket,
  isPairedToken: PairedTokenValidator,
  onDenied: (reason: string, remoteAddress: string) => void,
): void {
  const peer = client.remoteAddress ?? 'unknown';
  let buf: Buffer = Buffer.alloc(0);
  let stage: 'greeting' | 'auth' | 'connect' = 'greeting';

  const fail = (bytes: number[]) => {
    client.end(Buffer.from(bytes)); // end() flushes; destroy() would discard it
  };

  client.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (stage === 'greeting') {
        // Greeting is VER NMETHODS METHODS... — the methods list must be
        // consumed too, or the auth stage re-reads 0x05 as its version byte.
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) { client.destroy(); return; }
        const greetingLen = 2 + Number(buf[1] ?? 0);
        if (buf.length < greetingLen) return;
        buf = buf.subarray(greetingLen);
        // Only username/password (0x02) is offered. "No authentication
        // required" (0x00) is deliberately NOT advertised, so a client that
        // cannot authenticate never reaches the relay stage.
        client.write(Buffer.from([0x05, 0x01, 0x02]));
        stage = 'auth';
        continue;
      }

      if (stage === 'auth') {
        // RFC 1929: VER ULEN UNAME PLEN PASSWD
        if (buf.length < 2) return;
        if (buf[0] !== 0x01) { onDenied('malformed SOCKS auth request', peer); fail([0x01, 0x01]); return; }
        const userLen = buf[1];
        const need = 2 + userLen + 1 + buf[2 + userLen];
        if (buf.length < need) return;          // wait for the rest
        const user = buf.subarray(2, 2 + userLen).toString('utf8');
        const pass = buf.subarray(3 + userLen, need).toString('utf8');
        buf = buf.subarray(need);

        // The companion token is the paired-device credential — the same one
        // pairing already issues. Accept it as username or password so a
        // client can put it in whichever field its UI prefers.
        if (!isPairedToken(user) && !isPairedToken(pass)) {
          onDenied('unpaired SOCKS5 client', peer);
          fail([0x01, 0x01]);
          return;
        }
        client.write(Buffer.from([0x01, 0x00])); // status 0 = success
        stage = 'connect';
        continue;
      }

      // stage === 'connect'
      if (buf.length < 4) return;
      if (buf[0] !== 0x05 || buf[1] !== 0x01) { fail([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); return; }
      const atyp = buf[3];
      let hostLen = 0;
      if (atyp === 0x01) hostLen = 4;
      else if (atyp === 0x03) { if (buf.length < 5) return; hostLen = 1 + buf[4]; }
      else if (atyp === 0x04) hostLen = 16;
      else { fail([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); return; }

      const total = 4 + hostLen + 2;
      if (buf.length < total) return;
      handleSocks5Connect(client, buf.subarray(0, total));
      return; // socket is now a raw pipe
    }
  });

  client.on('error', () => {});
}

/** Stage 2: the CONNECT request, reached only after a paired token verified. */
function handleSocks5Connect(client: net.Socket, request: Buffer): void {
  const atyp = Number(request[3] ?? 0);
  let host = '';
  let portOffset = 4;

  if (atyp === 0x01) {
    host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
    portOffset = 8;
  } else if (atyp === 0x03) {
    const len = Number(request[4] ?? 0);
    host = request.subarray(5, 5 + len).toString('utf8');
    portOffset = 5 + len;
  } else {
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(request.subarray(4 + i, 6 + i).toString('hex'));
    host = parts.join(':');
    portOffset = 20;
  }

  const port = (Number(request[portOffset] ?? 0) << 8) | Number(request[portOffset + 1] ?? 0);

  // `upstream` is the outbound socket; it is deliberately not named `remote`,
  // which is the peer's address captured during the handshake.
  const upstream = net.createConnection({ host, port }, () => {
    const resp = Buffer.alloc(10);
    resp[0] = 0x05; resp[1] = 0x00; resp[2] = 0x00; resp[3] = 0x01;
    const addr = upstream.localAddress?.split('.').map(Number) || [0, 0, 0, 0];
    resp[4] = addr[0]; resp[5] = addr[1]; resp[6] = addr[2]; resp[7] = addr[3];
    const lport = upstream.localPort || 0;
    resp[8] = (lport >> 8) & 0xff; resp[9] = lport & 0xff;
    client.write(resp);
    upstream.pipe(client);
    client.pipe(upstream);
  });

  upstream.on('error', () => {
    // end(), not destroy(): destroy() drops the unflushed reply and the client
    // (a phone) hangs until it times out instead of seeing "unreachable".
    client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  });
  client.on('error', () => upstream.destroy());
  upstream.on('close', () => client.end());
  client.on('close', () => upstream.destroy());
}
