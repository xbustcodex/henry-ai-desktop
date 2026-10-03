#!/usr/bin/env node
/**
 * Henry installed-package acceptance driver.
 *
 * Drives the REAL installed Henry through the Chrome DevTools Protocol so that
 * acceptance evidence comes from the shipped application, not a dev server.
 *
 *   node scripts/acceptance/drive.mjs eval  "<js expression>"
 *   node scripts/acceptance/drive.mjs launch          # (re)launch installed Henry and wait until ready
 *   node scripts/acceptance/drive.mjs restart         # kill + relaunch, for persistence checks
 *   node scripts/acceptance/drive.mjs ready           # exit 0 when the app is responsive
 *   node scripts/acceptance/drive.mjs state           # dump settings + runtime for diffing
 *
 * The renderer window is not foregrounded when driven headlessly. Without focus
 * emulation every timer in the renderer is throttled and await-based probes hang
 * forever, so focus emulation is enabled before any expression runs.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const CDP_PORT = 9600;
const WIN_TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';
const WIN_LAUNCHER = 'C:\\Users\\xkali\\AppData\\Local\\Temp\\run-henry.bat';
const READY_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function win(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  } catch (e) {
    // Windows tools exit non-zero routinely; their stdout is still useful.
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).catch(() => null);
  if (!res || !res.ok) return [];
  return res.json().catch(() => []);
}

async function findAppTarget() {
  const targets = await cdpTargets();
  const page = targets.find((t) => t.type === 'page' && t.title === 'Henry AI')
    ?? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  return page ?? null;
}

function killHenry() {
  win(WIN_TASKKILL, ['/IM', 'Henry AI.exe', '/F']);
}

function launchHenry() {
  // Detached so the launcher outlives this process.
  const child = spawnSync('cmd.exe', ['/c', `start "" "${WIN_LAUNCHER}"`], { stdio: 'ignore' });
  return child.status === 0;
}

async function waitUntilReady(timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await findAppTarget();
    if (target) {
      const out = await evaluateOn(target.webSocketDebuggerUrl, '(typeof window.henryAPI)');
      if (out && !String(out).includes('undefined') && String(out).includes('object')) return target;
    }
    await sleep(2000);
  }
  return null;
}

/* ── minimal websocket client (CDP speaks plain text frames) ───────────── */
function wsConnect(url) {
  const u = new URL(url);
  const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let handshake = Buffer.alloc(0);
    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const head = handshake.subarray(0, end).toString();
      if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(`websocket upgrade failed: ${head.split('\r\n')[0]}`));
      let rest = handshake.subarray(end + 4);
      resolve({ socket, push: (buf) => { if (rest.length) { socket.emit('cdp-data', rest); rest = Buffer.alloc(0); } } });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([header, mask, masked]);
}

function wsParse(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), rest: buf.subarray(offset + len) };
}

async function evaluateOn(wsUrl, expression, timeoutMs = 300_000) {
  const { socket } = await wsConnect(wsUrl);
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    const send = (msg) => socket.write(wsFrame(JSON.stringify(msg)));

    socket.on('cdp-data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });

    const drain = () => {
      for (;;) {
        const frame = wsParse(buffer);
        if (!frame) break;
        buffer = frame.rest;
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode !== 0x1) continue;
        let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    };

    const request = (id, method, params) => new Promise((res) => {
      pending.set(id, res);
      send({ id, method, params });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: `timeout after ${timeoutMs}ms` } }); } }, timeoutMs);
    });

    (async () => {
      // The window is not foregrounded: without this, renderer timers are frozen
      // and every await-based probe hangs.
      await request(1, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      const r = await request(2, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      socket.end();
      if (r.error) return resolve(`DRIVER-ERROR: ${r.error.message}`);
      const res = r.result ?? {};
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        return resolve(`EXCEPTION: ${(d.exception?.description ?? d.text ?? JSON.stringify(d)).slice(0, 900)}`);
      }
      const v = res.result?.value;
      resolve(typeof v === 'string' ? v : JSON.stringify(v));
    })();
  });
}

async function withApp(fn) {
  const target = await findAppTarget();
  if (!target) throw new Error('no Henry target found — run `drive.mjs launch` first');
  return fn(target);
}

/* ── commands ───────────────────────────────────────────────────────────── */
const [, , cmd, ...rest] = process.argv;

try {
  if (cmd === 'launch' || cmd === 'restart') {
    if (cmd === 'restart') killHenry();
    else if (!(await findAppTarget())) launchHenry();
    const target = await waitUntilReady();
    if (!target) { console.error('TIMEOUT: Henry did not become ready'); process.exit(1); }
    console.log(JSON.stringify({ ready: true, title: target.title, url: target.url }));
  } else if (cmd === 'ready') {
    const target = await findAppTarget();
    process.exit(target ? 0 : 1);
  } else if (cmd === 'kill') {
    killHenry();
    console.log('killed');
  } else if (cmd === 'eval') {
    const expr = rest.join(' ');
    const out = await withApp((t) => evaluateOn(t.webSocketDebuggerUrl, expr));
    console.log(out);
  } else if (cmd === 'state') {
    const out = await withApp((t) => evaluateOn(
      t.webSocketDebuggerUrl,
      '(async()=>JSON.stringify({runtime:await window.henryAPI.runtimeGetStatus(),'
      + 'settings:await window.henryAPI.getSettings()}))()',
    ));
    const raw = String(out);
    const start = raw.indexOf('{');
    if (start === -1) { console.log(raw); process.exit(0); }
    fs.writeFileSync('scripts/acceptance/.state.json', raw.slice(start));
    console.log('wrote scripts/acceptance/.state.json');
  } else {
    console.log('usage: drive.mjs <launch|restart|ready|kill|eval|state>');
    process.exit(2);
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
