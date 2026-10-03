/**
 * Knowledge base — ingestion produces a retrievable result.
 *
 * Real `node:sqlite` again, so "ingest then retrieve" is proven against an
 * actual database rather than a stub. Filesystem and network are injected so the
 * tests never touch the disk outside a temp dir or make a request.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { KnowledgeBase, htmlToPlainText, type KnowledgeIo } from './core';
import { createEmbedder } from '../vector/embeddings';
import type { SqlDatabase } from '../vector/sql';

/** Never reaches the network — always in the offline fallback. */
const offlineEmbedder = () =>
  createEmbedder({ fetchImpl: (() => Promise.reject(new Error('offline in tests'))) as typeof fetch });

let db: DatabaseSync;
let kb: KnowledgeBase;
let home: string;
let fetched: string[];

const io = (overrides: Partial<KnowledgeIo> = {}): KnowledgeIo => ({
  readFile: async (filePath) => {
    const { readFile } = await import('fs/promises');
    return readFile(filePath, 'utf8');
  },
  fetchUrl: async (url) => {
    fetched.push(url);
    return {
      text: 'Standard refund window is thirty days from delivery. Refunds return to the original payment method.',
      contentType: 'text/html',
    };
  },
  ...overrides,
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  fetched = [];
  home = mkdtempSync(path.join(tmpdir(), 'henry-kb-'));
  // Point the confinement check at the temp dir by running with it as HOME.
  process.env.HOME = home;
  kb = new KnowledgeBase(db as unknown as SqlDatabase, offlineEmbedder(), io());
  kb.migrate();
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('htmlToPlainText', () => {
  it('strips markup and keeps paragraph breaks', () => {
    const out = htmlToPlainText('<p>First para.</p><script>evil()</script><p>Second para.</p>');
    expect(out).toContain('First para.');
    expect(out).toContain('Second para.');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('<p>');
  });

  it('decodes the common entities', () => {
    expect(htmlToPlainText('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"');
  });
});

describe('KnowledgeBase — note ingestion produces a retrievable result', () => {
  it('indexes a note and returns it for a related query', async () => {
    const result = await kb.ingestNote(
      'The vendor SLA guarantees a four-hour response for P1 incidents, with automatic service credits when breached.',
      { title: 'Vendor SLA', tags: ['vendor', 'sla'] },
    );

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.unchanged).toBe(false);
    expect(result.document.sourceKind).toBe('note');
    expect(result.document.tags).toEqual(['vendor', 'sla']);

    const found = await kb.search('How quickly does the vendor respond to P1 incidents?');
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits[0].text).toContain('four-hour response');
    expect(found.hits[0].documentId).toBe(result.document.id);
  });

  it('reports the fallback backend honestly rather than claiming semantics', async () => {
    await kb.ingestNote('Something worth keeping.');
    const found = await kb.search('worth keeping');
    expect(found.backend).toBe('hashed-fallback');
    expect(found.note).toMatch(/lexical/i);
  });

  it('re-ingesting identical text is a no-op', async () => {
    const text = 'A stable note that should not be duplicated.';
    const first = await kb.ingestNote(text, { title: 'Stable' });
    const second = await kb.ingestNote(text, { title: 'Stable' });

    expect(second.unchanged).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(kb.stats().documents).toBe(1);
  });

  it('rejects an empty note', async () => {
    await expect(kb.ingestNote('   ')).rejects.toThrow(/needs some text/i);
  });
});

describe('KnowledgeBase — URL ingestion', () => {
  it('fetches through the injected path and makes the page searchable', async () => {
    const result = await kb.ingestUrl('https://shop.example.com/returns');
    expect(fetched).toEqual(['https://shop.example.com/returns']);
    expect(result.document.sourceKind).toBe('url');
    expect(result.document.uri).toBe('https://shop.example.com/returns');

    const found = await kb.search('What is the refund window?');
    expect(found.hits.some((h) => h.uri === 'https://shop.example.com/returns')).toBe(true);
  });

  it('refuses a non-http scheme before any fetch happens', async () => {
    await expect(kb.ingestUrl('file:///etc/passwd')).rejects.toThrow(/http/i);
    expect(fetched).toHaveLength(0);
  });
});

describe('KnowledgeBase — file ingestion respects home confinement', () => {
  it('refuses a path outside the home directory', async () => {
    await expect(kb.ingestFile('/etc/passwd')).rejects.toThrow(/outside your home directory|absolute path/i);
  });

  it('refuses a traversal out of the home directory', async () => {
    await expect(kb.ingestFile('../../etc/passwd')).rejects.toThrow(/outside your home directory/i);
  });

  it('ingests a file inside the home directory and retrieves it', async () => {
    const notesDir = path.join(home, 'Documents');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      path.join(notesDir, 'deploy.md'),
      'Deployments go out on Thursday mornings. Rollback is a single command when a release regresses.',
      'utf8',
    );

    // Home-relative, exactly as an agent would phrase it.
    const result = await kb.ingestFile('Documents/deploy.md');
    expect(result.document.sourceKind).toBe('file');
    expect(result.document.title).toBe('deploy.md');

    const found = await kb.search('When do deployments happen?');
    expect(found.hits[0].text).toContain('Thursday');
  });

  it('strips markup when ingesting an HTML file', async () => {
    writeFileSync(
      path.join(home, 'page.html'),
      '<html><body><h1>Warehouse</h1><p>Pick and pack runs at 340 lines per shift.</p></body></html>',
      'utf8',
    );
    await kb.ingestFile(path.join(home, 'page.html'));
    const found = await kb.search('How many lines per shift does the warehouse handle?');
    expect(found.hits[0].text).toContain('340 lines');
    expect(found.hits[0].text).not.toContain('<p>');
  });
});

describe('KnowledgeBase — listing and deletion', () => {
  it('lists only active documents', async () => {
    const a = await kb.ingestNote('First note about deployments.', { title: 'Deploys' });
    await kb.ingestNote('Second note about shipping.', { title: 'Shipping' });

    expect(kb.listDocuments()).toHaveLength(2);
    expect(kb.listDocuments({ sourceKind: 'note' })).toHaveLength(2);

    expect(kb.deleteDocument(a.document.id)).toEqual({ deleted: true });
    expect(kb.listDocuments()).toHaveLength(1);
  });

  it('removes the vectors too, so a deleted document cannot resurface', async () => {
    const doc = await kb.ingestNote('Confidential acquisition plans for the northern depot.', {
      title: 'Acquisition',
    });
    kb.deleteDocument(doc.document.id);
    const found = await kb.search('acquisition plans northern depot');
    expect(found.hits).toHaveLength(0);
  });

  it('reports stats that agree with the listing', async () => {
    await kb.ingestNote('A note that creates one chunk.');
    const stats = kb.stats();
    expect(stats.documents).toBe(1);
    expect(stats.chunks).toBe(1);
    expect(stats.dimensions).toBeGreaterThan(0);
  });
});

describe('KnowledgeBase — lexical term filter', () => {
  it('keeps only chunks containing the supplied term', async () => {
    await kb.ingestNote('Warehouse pick and pack throughput is 340 lines per shift.');
    await kb.ingestNote('Vendor response time for P1 incidents is four hours.');

    const found = await kb.search('SKU-4471 warehouse', { terms: ['340'] });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0].text).toContain('340');
  });
});

describe('KnowledgeBase — empty query', () => {
  it('returns no hits rather than matching everything', async () => {
    await kb.ingestNote('Some indexed content.');
    expect((await kb.search('   ')).hits).toEqual([]);
  });
});
