#!/usr/bin/env node
/**
 * Audit the installed Henry for leftover acceptance-test state.
 *
 * The completion run creates real state: pairing tokens, linked devices,
 * scheduled tasks, routines, goals, memories, knowledge bases and settings
 * overrides. Every one of those must be removed before the run is called
 * clean. This script inspects the live installed app over CDP and reports
 * anything matching known test patterns, so the finding is evidence rather
 * than an assertion.
 *
 *   node scripts/acceptance/cleanup-audit.mjs
 *
 * Exit code 0 when clean, 1 when residue is found (so it can gate CI).
 *
 * Add legitimate new patterns to RESIDUE_PATTERNS as acceptance testing grows;
 * a residue check that nobody extends silently becomes a check that passes.
 */

import { spawnSync } from 'node:child_process';
import net from 'node:net';

const CDP_PORT = 9600;

/** Substrings that only ever appear in acceptance-test fixtures. */
const RESIDUE_PATTERNS = [
  'parity-probe',
  'acceptance-probe',
  'zorblax',
  'acceptance-test',
  'acceptance_test',
  '__acceptance__',
  'e2e-probe',
  'do-not-use',
];

/** Settings the campaign is known to override. Reported so they can be reset. */
const WATCHED_SETTINGS = [
  'sync_allow_lan',
  'brand_name',
  'voice_endpointing',
  'voice_tts_engine',
  'voice_replies',
  'voice_greeting',
  'ollama_base_url',
];

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).catch(() => null);
  if (!res || !res.ok) return [];
  return res.json().catch(() => []);
}

function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
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

async function evaluate(wsUrl, expression) {
  const u = new URL(wsUrl);
  const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');
  return new Promise((resolve) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    const drain = () => {
      for (;;) {
        const f = wsParse(buffer);
        if (!f) break;
        buffer = f.rest;
        if (f.opcode === 0x8) { socket.end(); return; }
        if (f.opcode !== 0x1) continue;
        let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      }
    };
    socket.on('data', (c) => { buffer = Buffer.concat([buffer, c]); drain(); });
    const req = (id, method, params) => new Promise((res) => {
      pending.set(id, res);
      socket.write(wsFrame(JSON.stringify({ id, method, params })));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: 'timeout' } }); } }, 120_000);
    });
    (async () => {
      await req(1, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      const r = await req(2, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      socket.end();
      if (r.error) return resolve(`DRIVER-ERROR: ${r.error.message}`);
      const res = r.result ?? {};
      if (res.exceptionDetails) return resolve(`EXCEPTION: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
      const v = res.result?.value;
      resolve(typeof v === 'string' ? v : JSON.stringify(v));
    })();
  });
}

const probe = `(async () => {
  const a = window.henryAPI;
  const out = { collections: {}, watched: {}, errors: [] };
  const grab = async (name, fn) => {
    try { out.collections[name] = await fn(); }
    catch (e) { out.errors.push(name + ': ' + String((e && e.message) || e).slice(0, 80)); }
  };
  await grab('settings', () => a.getSettings());
  await grab('tasks', () => a.getTasks());
  await grab('goals', () => a.getGoals());
  await grab('scheduled', () => a.computerListScheduled());
  await grab('syncState', () => a.syncGetState());
  await grab('attachments', () => a.listAttachments());
  await grab('toolCalls', () => a.listToolCalls());
  await grab('quotes', () => a.quoteList ? a.quoteList() : null);
  await grab('personality', () => a.companionPersonality ? a.companionPersonality() : null);
  await grab('knowledge', () => a.knowledgeList ? a.knowledgeList() : null);
  await grab('plans', () => a.listPlans ? a.listPlans() : null);
  await grab('security', () => a.getSecuritySettings ? a.getSecuritySettings() : null);
  await grab('privacy', () => a.getPrivacySettings ? a.getPrivacySettings() : null);
  return JSON.stringify(out);
})()`;

const targets = await cdpTargets();
const target = targets.find((t) => t.type === 'page' && t.title === 'Henry AI') ?? targets.find((t) => t.type === 'page');
if (!target) {
  console.error('AUDIT UNAVAILABLE: no running Henry target. Start it with: node scripts/acceptance/drive.mjs launch');
  process.exit(1);
}

const raw = String(await evaluate(target.webSocketDebuggerUrl, probe));
const start = raw.indexOf('{');
if (start === -1) {
  console.error(`AUDIT FAILED: unexpected driver output: ${raw.slice(0, 300)}`);
  process.exit(1);
}
const report = JSON.parse(raw.slice(start));

const findings = [];
for (const [name, value] of Object.entries(report.collections)) {
  if (value === null || value === undefined) continue;
  const text = JSON.stringify(value);
  for (const pattern of RESIDUE_PATTERNS) {
    if (text.toLowerCase().includes(pattern.toLowerCase())) findings.push({ collection: name, pattern, sample: text.slice(0, 160) });
  }
}

const syncState = report.collections.syncState ?? {};
const state = syncState.state ?? syncState;
const linked = state?.linkedDevices ?? [];
if (Array.isArray(linked) && linked.length) findings.push({ collection: 'syncState', pattern: 'linkedDevices', sample: JSON.stringify(linked).slice(0, 200) });
if (state?.pairToken) findings.push({ collection: 'syncState', pattern: 'live pairToken', sample: '(token present)' });

const settings = report.collections.settings ?? {};
for (const key of WATCHED_SETTINGS) {
  if (settings[key] !== undefined) report.watched[key] = settings[key];
}
if (settings.sync_allow_lan === 'true' || settings.sync_allow_lan === true) {
  findings.push({ collection: 'settings', pattern: 'sync_allow_lan enabled', sample: String(settings.sync_allow_lan) });
}

console.log(JSON.stringify({
  residueFound: findings.length > 0,
  findings,
  watchedSettings: report.watched,
  probeErrors: report.errors,
}, null, 2));

process.exit(findings.length ? 1 : 0);
