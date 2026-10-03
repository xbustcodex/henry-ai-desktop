#!/usr/bin/env node
/**
 * Security regression probe for the installed Henry package.
 *
 * Every probe here is an ATTACK. All of them must be refused by the installed
 * build. This file records the boundaries established during the parity
 * burn-down so they can be re-proved after each integration batch — a security
 * control that is never re-tested is a control that quietly stopped existing.
 *
 *   node scripts/acceptance/security-regression.mjs
 *
 * Exit 0 when every probe is refused, 1 otherwise.
 *
 * Baselines (installed 3.0.7, captured before the completion run):
 *   fs:readDirectory '../../../../etc'                      -> Access denied
 *   fs:readDirectory 'C:\Windows\System32\config'           -> Access denied
 *   fs:readFile 'C:\Windows\System32\config\SAM'            -> Access denied
 *   fs:readFile '/etc/shadow'                               -> Access denied
 *   computer:openApp '../../../../bin/sh'                   -> refused, not found
 *   computer:killProcess 4 (Windows System)                 -> refused by the OS
 */

import { execFileSync } from 'node:child_process';

const CDP_PORT = 9600;

/** [label, expression, mustBeRefused] */
const PROBES = [
  ['fs:readDirectory traversal', `a.readDirectory('../../../../etc')`, true],
  ['fs:readDirectory outside home', `a.readDirectory('C:\\\\Windows\\\\System32\\\\config')`, true],
  ['fs:readFile SAM', `a.readFile('C:\\\\Windows\\\\System32\\\\config\\\\SAM')`, true],
  ['fs:readFile /etc/shadow', `a.readFile('/etc/shadow')`, true],
  ['computer:openApp traversal', `a.computerOpenApp('../../../../bin/sh')`, true],
  ['computer:killProcess System', `a.computerKillProcess(4)`, true],
];

async function findTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).catch(() => null);
  if (!res || !res.ok) return null;
  const targets = await res.json().catch(() => []);
  return targets.find((t) => t.type === 'page' && t.title === 'Henry AI')
    ?? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    ?? null;
}

const target = await findTarget();
if (!target) {
  console.error('UNAVAILABLE: no running Henry target — node scripts/acceptance/drive.mjs launch');
  process.exit(1);
}

// Reuse the driver's websocket implementation rather than duplicating it.
const evalIn = async (expression) => {
  const out = execFileSync('node', ['scripts/acceptance/drive.mjs', 'eval', expression], { encoding: 'utf8', timeout: 600_000 });
  return out.trim();
};

// Refusal is decided INSIDE the renderer, against the full value, and only a
// short verdict is shipped back. Deciding it out here meant parsing a truncated
// envelope, which silently turned a correct refusal into a reported failure.
const body = `(async () => {
  const a = window.henryAPI; const out = {};
  const performed = (v) => !(v && typeof v === 'object' && (v.success === false || v.ok === false));
  const t = async (n, f) => {
    try {
      const v = await f();
      out[n] = { threw: false, performed: performed(v), detail: String(JSON.stringify(v)).slice(0, 120) };
    } catch (e) {
      out[n] = { threw: true, performed: false, detail: String((e && e.message) || e).slice(0, 120) };
    }
  };
${PROBES.map(([label, expr]) => `  await t(${JSON.stringify(label)}, () => ${expr});`).join('\n')}
  return JSON.stringify(out);
})()`;

let raw;
try {
  raw = await evalIn(body);
} catch (e) {
  console.error(`DRIVER FAILED: ${e.message}`);
  process.exit(1);
}

const start = raw.indexOf('{');
if (start === -1) {
  console.error(`UNPARSEABLE: ${raw.slice(0, 300)}`);
  process.exit(1);
}
const results = JSON.parse(raw.slice(start));

// Refusal has two shapes in Henry, and treating only one of them as "refused"
// produces false failures that train people to ignore this script:
//   1. the IPC call throws (e.g. fs:* confinement raises Access denied)
//   2. the IPC call resolves with a failure envelope ({success:false} / {ok:false})
// A probe counts as refused only when the operation demonstrably did not happen.
// The renderer computes that verdict against the full, untruncated value and
// ships back a short record, so nothing here has to re-parse a clipped envelope.
const evaluateRefusal = (record) => {
  if (!record || typeof record !== 'object') return false;
  if (record.threw === true) return true;
  return record.performed === false;
};

const failures = [];
for (const [label, , mustBeRefused] of PROBES) {
  const record = results[label] ?? null;
  const refused = evaluateRefusal(record);
  const detail = record ? (record.threw ? `threw: ${record.detail}` : record.detail) : '(no result)';
  if (mustBeRefused && !refused) failures.push({ label, detail });
  console.log(`${refused === mustBeRefused ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}`);
}

console.log(`\n${failures.length === 0 ? 'ALL PROBES REFUSED' : `${failures.length} PROBE(S) NOT REFUSED`}`);
process.exit(failures.length ? 1 : 0);
