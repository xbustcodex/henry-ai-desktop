#!/usr/bin/env node
/**
 * Verify that a built package actually contains the current source.
 *
 * WHY THIS EXISTS
 * ---------------
 * During the completion run, `npx electron-builder` was invoked directly
 * instead of through `npm run build`. Because electron-builder packages
 * `dist-electron/` and `dist/` rather than `electron/` and `src/`, it produced
 * a correctly-timestamped .exe and .asar containing NONE of the work done that
 * day. Every acceptance result taken against that build was meaningless, and
 * the only reason it was caught was that the asar was grepped by hand.
 *
 * The failure is silent by construction: the artifact looks freshly built, the
 * installer runs, the app boots and responds. Only its CONTENT is stale. So the
 * guard compares the shipped artifact against the source tree.
 *
 * USAGE
 *   node scripts/verify-package.mjs <path-to-app.asar> [more asars...]
 *   node scripts/verify-package.mjs --release2        # checks release2/win-unpacked
 *
 * Exit 0 when every probe symbol is present, 1 otherwise.
 *
 * PROBES
 *   Each probe is a literal string that must appear somewhere in the packaged
 *   JavaScript. They are deliberately chosen from things that are easy to forget
 *   and hard to notice missing: a new IPC channel name, a new preload method, a
 *   distinctive identifier. They are NOT chosen as whole function names, because
 *   bundling and minification legitimately rename or inline those.
 *
 * When adding a feature that must not silently vanish from a build, add a probe
 * here. A guard nobody extends is a guard that stops guarding.
 */

import { readFileSync, existsSync } from 'node:fs';

/** [label, literal that must appear in the packaged output] */
const PROBES = [
  // Preload surface added this run — each is a channel a UI depends on.
  ['preload: securityGet', 'securityGet'],
  ['preload: logsQuery', 'logsQuery'],
  ['preload: quitApp', 'quitApp'],
  ['preload: knowledgeIngestFile', 'knowledgeIngestFile'],
  ['preload: integrationList', 'integrationList'],
  ['preload: onAgentToolStreamDelta', 'onAgentToolStreamDelta'],
  ['preload: voiceTtsLocalStatus', 'voiceTtsLocalStatus'],
  // Main-process surface added this run. Note the choice of literals: the
  // first version of this guard probed `channelSchemas` and
  // `installConsoleCapture` by function name and reported them MISSING against
  // a build that demonstrably contained them, because bundling renames and
  // inlines local functions. A guard with false positives gets ignored, so
  // every probe below is a string literal or an IPC channel name, which
  // survive bundling unchanged.
  ['main: security policy storage prefix', 'security_policy_'],
  ['main: shell-gated channel', 'computer:openApp'],
  ['main: ollama chat channel', 'ollama:chat'],
  ['main: knowledge channel', 'knowledge:ingestFile'],

  // Agent tooling — the registry grew from 69 to 93 tools.
  ['agent: knowledge tool', 'knowledge_search'],
  ['agent: plan tool', 'plan_'],
  ['agent: lesson tool', 'lesson_'],

  // Provider layer — Ollama streaming and the tool round. Probed by their
  // wire-level literals, not by function name.
  ['provider: ollama chat endpoint', '/api/chat'],
  ['provider: ollama num_predict', 'num_predict'],
  ['provider: tool-call fence source tag', 'model-output'],
  ['provider: bridge tools refusal type', 'bridge_tools_unsupported'],
];

/** Symbols that were deliberately REMOVED. Their presence means a stale build. */
const FORBIDDEN = [
  ['removed: safeParseArgs', 'safeParseArgs'],
];

function resolveTargets(argv) {
  if (argv.includes('--release2')) {
    return ['release2/win-unpacked/resources/app.asar'];
  }
  return argv.filter((a) => !a.startsWith('--'));
}

const targets = resolveTargets(process.argv.slice(2));
if (targets.length === 0) {
  console.error('usage: verify-package.mjs <app.asar> [...] | --release2');
  process.exit(2);
}

let failed = false;

for (const target of targets) {
  if (!existsSync(target)) {
    console.error(`FAIL  ${target}: not found`);
    failed = true;
    continue;
  }
  // asar contents are stored uncompressed, so a binary scan is sufficient and
  // avoids needing an asar reader as a dependency.
  const buf = readFileSync(target);
  const text = buf.toString('latin1');

  const missing = PROBES.filter(([, needle]) => !text.includes(needle));
  const present = FORBIDDEN.filter(([, needle]) => text.includes(needle));

  console.log(`\n${target}  (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  for (const [label] of PROBES) {
    const hit = PROBES.find(([l]) => l === label);
    const ok = text.includes(hit[1]);
    console.log(`  ${ok ? 'ok  ' : 'MISS'}  ${label}`);
  }
  for (const [label, needle] of present) {
    console.log(`  STALE  ${label} — "${needle}" should have been removed but is present`);
  }

  if (missing.length) {
    console.error(
      `\n  ${missing.length} probe(s) missing. This artifact does NOT contain the current source.\n` +
      '  Almost always caused by running electron-builder without running the Vite build first.\n' +
      '  Fix: `npm run build -- --win nsis portable --x64` (the npm script runs vite build && electron-builder).\n' +
      '  Never accept acceptance evidence from an artifact this check fails.',
    );
    failed = true;
  } else {
    console.log('  all probes present');
  }
}

process.exit(failed ? 1 : 0);
