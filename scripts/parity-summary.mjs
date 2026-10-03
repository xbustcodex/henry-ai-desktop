#!/usr/bin/env node
/**
 * Derive the parity summary from the ledger ROWS.
 *
 * The summary used to be maintained by hand, which is exactly why it drifted:
 * rows got closed and the card totals quietly stopped matching. This reads
 * PARITY_LEDGER.md, normalises every row's status into the agreed vocabulary,
 * and regenerates the summary table plus the list of things that exist in source
 * but have never been verified on an installed package.
 *
 * Nothing here decides whether a row is closed. It only reports what the rows
 * say, so the summary cannot disagree with the checklist.
 *
 *   node scripts/parity-summary.mjs            # print
 *   node scripts/parity-summary.mjs --write    # rewrite the summary block in place
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'PARITY_LEDGER.md');
const START = '<!-- SUMMARY:BEGIN -->';
const END = '<!-- SUMMARY:END -->';

/** The agreed vocabulary, most-final first. */
export const STATUS = {
  CLOSED: 'CLOSED / installed-package verified',
  HARDENED: 'HARDENED / SUPERSET',
  EXCLUDED: 'EXCLUDED BY DESIGN',
  COMMERCIAL: 'COMMERCIAL BOUNDARY',
  UNVERIFIED: 'IMPLEMENTED / NOT LIVE VERIFIED',
  UNREACHABLE: 'IMPLEMENTED BUT UNREACHABLE',
  PARTIAL: 'PARTIAL',
  MISSING: 'MISSING',
};

/**
 * Fold every phrasing anyone has ever typed into the vocabulary.
 *
 * Rows were written over many sessions with inconsistent wording; being liberal
 * here means an old row still lands in a defensible bucket rather than being
 * silently dropped from the totals.
 */
export function normalise(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return STATUS.MISSING;
  if (s.includes('commercial')) return STATUS.COMMERCIAL;
  if (s.includes('excluded by design')) return STATUS.EXCLUDED;
  if (s.includes('hardened')) return STATUS.HARDENED;
  if (s.includes('live-verified') || s.includes('wired + live') || s.includes('closed')) return STATUS.CLOSED;
  if (s.includes('not live') || s.includes('provider-live-unverified') || s.includes('unverified')) return STATUS.UNVERIFIED;
  if (s.includes('unreachable') || s.includes('no consumer')) return STATUS.UNREACHABLE;
  if (s.includes('partial')) return STATUS.PARTIAL;
  if (s.includes('complete')) return STATUS.UNVERIFIED; // complete claimed without installed proof
  return STATUS.MISSING;
}

const CARD_NAMES = {
  1: 'UI & Core',
  2: 'Chat & Models',
  3: 'Creators & Media',
  4: 'Agents & Tools',
  5: 'Automation',
  6: 'Voice & Input',
  7: 'Computer Control',
  8: 'Companion',
  9: 'Files & Memory',
  10: 'Integrations',
  11: 'Settings & System',
};

export function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\.\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const id = cells[0];
    const m = /^(\d+)\.(\d+)$/.exec(id);
    if (!m) continue;
    rows.push({
      id,
      card: Number(m[1]),
      feature: cells[1],
      status: cells[cells.length - 1],
      bucket: normalise(cells[cells.length - 1]),
      raw: line,
    });
  }
  return rows;
}

export function summarise(rows) {
  const byCard = new Map();
  for (const r of rows) {
    if (!byCard.has(r.card)) byCard.set(r.card, []);
    byCard.get(r.card).push(r);
  }
  const cards = [];
  for (const [card, rs] of [...byCard].sort((a, b) => a[0] - b[0])) {
    const counts = {};
    for (const k of Object.values(STATUS)) counts[k] = 0;
    for (const r of rs) counts[r.bucket]++;
    cards.push({ card, name: CARD_NAMES[card] ?? `Card ${card}`, total: rs.length, counts });
  }
  const totals = {};
  for (const k of Object.values(STATUS)) totals[k] = 0;
  for (const c of cards) for (const k of Object.values(STATUS)) totals[k] += c.counts[k];
  return { cards, totals, rowTotal: rows.length };
}

function render({ cards, totals, rowTotal }) {
  const order = [
    STATUS.CLOSED,
    STATUS.HARDENED,
    STATUS.PARTIAL,
    STATUS.MISSING,
    STATUS.UNVERIFIED,
    STATUS.UNREACHABLE,
    STATUS.EXCLUDED,
    STATUS.COMMERCIAL,
  ];
  const head = `| Card | Rows | Closed | Hardened | Partial | Missing | Unverified | Unreachable | Excluded | Commercial |`;
  const sep = `|---|---|---|---|---|---|---|---|---|---|`;
  const body = cards
    .map((c) => {
      const n = (k) => c.counts[k] || 0;
      return `| ${c.card} ${c.name} | ${c.total} | ${n(STATUS.CLOSED)} | ${n(STATUS.HARDENED)} | ${n(STATUS.PARTIAL)} | ${n(STATUS.MISSING)} | ${n(STATUS.UNVERIFIED)} | ${n(STATUS.UNREACHABLE)} | ${n(STATUS.EXCLUDED)} | ${n(STATUS.COMMERCIAL)} |`;
    })
    .join('\n');
  const totalRow = `| **TOTAL** | **${rowTotal}** | ${totals[STATUS.CLOSED]} | ${totals[STATUS.HARDENED]} | ${totals[STATUS.PARTIAL]} | ${totals[STATUS.MISSING]} | ${totals[STATUS.UNVERIFIED]} | ${totals[STATUS.UNREACHABLE]} | ${totals[STATUS.EXCLUDED]} | ${totals[STATUS.COMMERCIAL]} |`;
  return `${head}\n${sep}\n${body}\n${totalRow}\n\n> Generated from the rows by \`scripts/parity-summary.mjs\`. Do not edit these numbers by hand —\n> edit the row status and re-run \`node scripts/parity-summary.mjs --write\`.`;
}

function main() {
  const text = fs.readFileSync(LEDGER, 'utf8');
  const rows = parseRows(text);
  const summary = summarise(rows);
  const block = render(summary);

  if (process.argv.includes('--write')) {
    if (text.includes(START) && text.includes(END)) {
      const out = text.replace(
        new RegExp(`${START}[\\s\\S]*?${END}`),
        `${START}\n\n${block}\n\n${END}`
      );
      fs.writeFileSync(LEDGER, out);
      console.log('summary rewritten from', rows.length, 'rows');
    } else {
      const anchor = text.indexOf('## PROGRESS');
      if (anchor === -1) {
        console.error('no PROGRESS section to write into');
        process.exit(1);
      }
      const insertAt = text.indexOf('\n\n', anchor) + 2;
      const out =
        text.slice(0, insertAt) +
        `\n${START}\n\n${block}\n\n${END}\n` +
        text.slice(insertAt);
      fs.writeFileSync(LEDGER, out);
      console.log('summary block inserted from', rows.length, 'rows');
    }
  } else {
    console.log(block);
    const unverified = rows.filter((r) => r.bucket === STATUS.UNVERIFIED);
    if (unverified.length) {
      console.log(`\nIn source, not verified on an installed package (${unverified.length}):`);
      for (const r of unverified) console.log(`  ${r.id}  ${r.feature}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();