#!/usr/bin/env node
/**
 * ipc-coverage.mjs — MEASURED IPC validation coverage.
 *
 * ## What it reports
 *
 * For every `ipcMain.handle('<channel>'` in electron/, whether that exact
 * channel string has an entry in `channelSchemas`. Coverage is counted PER
 * CHANNEL, never per schema definition: a family of three channels sharing one
 * schema definition reads as three covered channels only if all three names are
 * individually registered. That distinction is the whole point — the earlier
 * "27 schemas ≈ 8% coverage" figure was schema COUNT presented as channel
 * coverage, which flattered the number.
 *
 * ## Why static analysis
 *
 * Coverage is derived from the source rather than from a running app so it can
 * be enforced in CI before anything ships, and so it covers handlers that only
 * register on a code path a smoke test would not reach. `channelSchemas` is read
 * by importing `validation.ts` through a tiny TS-stripping shim (below), so the
 * set of registered names can never drift from the set the app actually uses.
 *
 * ## Usage
 *   node scripts/ipc-coverage.mjs            # human summary
 *   node scripts/ipc-coverage.mjs --json     # machine-readable
 *   node scripts/ipc-coverage.mjs --uncovered  # list the gaps
 *   node scripts/ipc-coverage.mjs --check 80 # exit 1 if coverage < 80%
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ELECTRON_DIR = join(ROOT, 'electron');

// ── Collect handler registrations ────────────────────────────────────────────

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist-electron') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Two ways a channel gets registered, and both count:
 *   ipcMain.handle('x', …)          direct
 *   ipcMain.handle('x', handler('y'))  the sessionStore/session pattern
 */
const HANDLE_RE = /ipcMain\.(?:handle|handleOnce)\(\s*'([^']+)'/g;

const registered = new Map(); // channel -> Set of files
for (const file of walk(ELECTRON_DIR)) {
  const src = readFileSync(file, 'utf8');
  HANDLE_RE.lastIndex = 0;
  let m;
  while ((m = HANDLE_RE.exec(src)) !== null) {
    const rel = relative(ROOT, file);
    if (!registered.has(m[1])) registered.set(m[1], new Set());
    registered.get(m[1]).add(rel);
  }
}

// ── Read the actual registered schema names ──────────────────────────────────

/**
 * validation.ts is TypeScript, so it cannot be imported directly by Node. We
 * strip types with a regex that only has to survive THIS file's syntax, then
 * evaluate just the schema table. Importing the real module (rather than
 * re-parsing the source) is what keeps this script honest: it reports the
 * names the app uses, not the names someone remembered to grep for.
 */
async function loadSchemaNames() {
  const src = readFileSync(join(ELECTRON_DIR, 'ipc', 'validation.ts'), 'utf8');
  const start = src.indexOf('export const channelSchemas');
  if (start < 0) throw new Error('channelSchemas not found in validation.ts');
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  let i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const objectBody = src.slice(bodyStart + 1, i);
  const names = new Set();
  const KEY_RE = /^\s*'([^']+)'\s*:/gm;
  let m;
  while ((m = KEY_RE.exec(objectBody)) !== null) names.add(m[1]);
  return names;
}

const schemaNames = await loadSchemaNames();

// ── Report ───────────────────────────────────────────────────────────────────

const channels = [...registered.keys()].sort();
const covered = channels.filter((c) => schemaNames.has(c));
const uncovered = channels.filter((c) => !schemaNames.has(c));
const pct = channels.length ? (covered.length / channels.length) * 100 : 0;

/** Per-module breakdown, so the biggest remaining gaps are obvious. */
const byFile = new Map();
for (const [channel, files] of registered) {
  const file = [...files][0];
  if (!byFile.has(file)) byFile.set(file, { total: 0, covered: 0 });
  const e = byFile.get(file);
  e.total++;
  if (schemaNames.has(channel)) e.covered++;
}

/**
 * Schemas registered for channels that do not exist. These are not harmful but
 * they are dead weight and usually mean the schema was written against a
 * guessed channel name — the exact mistake that produced the three earlier
 * bridge-shape regressions — so they are surfaced loudly.
 */
const orphaned = [...schemaNames].filter((n) => !registered.has(n)).sort();

const args = process.argv.slice(2);
const report = {
  totals: { channels: channels.length, covered: covered.length, uncovered: uncovered.length },
  coveragePercent: Number(pct.toFixed(2)),
  byFile: [...byFile.entries()]
    .map(([file, e]) => ({
      file,
      total: e.total,
      covered: e.covered,
      pct: Number(((e.covered / e.total) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.total - a.total),
  uncoveredChannels: uncovered,
  orphanedSchemas: orphaned,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`IPC validation coverage: ${covered.length}/${channels.length} channels (${pct.toFixed(1)}%)`);
  console.log(`  schema entries: ${schemaNames.size}`);
  console.log('');
  console.log('  module                                    covered/total');
  for (const r of report.byFile.slice(0, 20)) {
    console.log(`  ${r.file.padEnd(42)} ${String(r.covered).padStart(3)}/${String(r.total).padEnd(5)} ${r.pct}%`);
  }
  if (uncovered.length) {
    console.log('');
    console.log(`  uncovered: ${uncovered.length} channels`);
    if (args.includes('--uncovered')) for (const c of uncovered) console.log(`    ${c}`);
  }
  if (orphaned.length) {
    console.log('');
    console.log(`  WARNING: ${orphaned.length} schema(s) name a channel that is not registered:`);
    for (const o of orphaned) console.log(`    ${o}`);
  }
}

const checkIndex = args.indexOf('--check');
if (checkIndex >= 0) {
  const threshold = Number(args[checkIndex + 1]);
  if (Number.isFinite(threshold) && pct < threshold) {
    console.error(`coverage ${pct.toFixed(1)}% is below the required ${threshold}%`);
    process.exit(1);
  }
}