import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';

/**
 * The manifest parser lives inside registerMarketplaceHandlers, so these tests
 * drive it the way the renderer does: register the handlers against a fake app
 * root, then invoke the captured `marketplace:*` callbacks.
 *
 * Electron is stubbed only for `app.getAppPath()` / `app.getPath()` — the paths
 * the manifest and the fetch cache are read from. The DB handle is a small
 * in-memory stand-in because the real better-sqlite3 addon is compiled for
 * Electron's ABI and cannot be loaded by a plain Node test. The SQL is fixed
 * (it lives in the source), so only the rows matter here.
 */
const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const state = { appRoot: '', downloads: '', userData: '' };
  return { handlers, state };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => h.state.appRoot,
    getPath: (name: string) => (name === 'downloads' ? h.state.downloads : h.state.userData),
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

import { registerMarketplaceHandlers, entryIdFor, type CatalogListing, type CatalogEntryState } from './marketplace';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_MANIFEST = path.join(REPO_ROOT, 'resources', 'marketplace', 'marketplace.json');

interface FetchRow {
  artifact_name: string;
  byte_size: number;
  fetched_at: string;
}

/** Just enough SQL for the one table the marketplace owns. */
class FakeDb {
  readonly rows = new Map<string, FetchRow>();

  exec(): void {
    // CREATE TABLE IF NOT EXISTS — nothing to materialise in memory.
  }

  prepare(_sql: string) {
    return {
      get: (entryId: string) => this.rows.get(entryId),
      all: () => [...this.rows.values()],
      run: (entryId: string, artifactName: string, byteSize: number) => {
        this.rows.set(entryId, {
          artifact_name: artifactName,
          byte_size: byteSize,
          fetched_at: new Date().toISOString(),
        });
        return { changes: 1 };
      },
    };
  }
}

let tmp: string;
let db: FakeDb;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-marketplace-'));
  h.state.appRoot = tmp;
  h.state.downloads = path.join(tmp, 'Downloads');
  h.state.userData = path.join(tmp, 'userData');
  db = new FakeDb();
  h.handlers.clear();
  registerMarketplaceHandlers(db as unknown as Database.Database, () => null);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(contents: string): void {
  const dir = path.join(tmp, 'resources', 'marketplace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marketplace.json'), contents);
}

function call<T>(channel: string): T {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`handler "${channel}" was never registered`);
  return fn(null, undefined) as T;
}

const list = (): CatalogListing => call<CatalogListing>('marketplace:list');
const states = (): Record<string, CatalogEntryState> => call<Record<string, CatalogEntryState>>('marketplace:states');

function manifest(items: unknown): string {
  return JSON.stringify({ manifest: 'test-manifest', version: 3, items });
}

const GOOD = { id: 'good', name: 'Good App', install: { type: 'apk-download' } };

describe('marketplace:list — the shipped catalogue', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, 'resources', 'marketplace'), { recursive: true });
    fs.copyFileSync(SHIPPED_MANIFEST, path.join(tmp, 'resources', 'marketplace', 'marketplace.json'));
  });

  it('parses all six published entries with no complaints', () => {
    const listing = list();
    expect(listing.entries.map((e) => e.id)).toEqual([
      'primetech-terminal',
      'buster',
      'devtoolbox',
      'termuxfm',
      'ohmytermux',
      'primetech-marketplace',
    ]);
    expect(listing.problems).toEqual([]);
  });

  it('carries the manifest name, version and per-entry detail through', () => {
    const listing = list();
    expect(listing.manifest).toBe('primetech-marketplace');
    expect(listing.version).toBe(1);
    expect(Number.isNaN(Date.parse(listing.fetchedAt))).toBe(false);
    expect(listing.entries[0]).toMatchObject({
      id: 'primetech-terminal',
      name: 'PrimeTech Terminal',
      type: 'app',
      category: 'terminal',
      version: '1.0',
      packageName: 'com.primetechterminal',
    });
    expect(listing.entries[0].capabilities?.length).toBeGreaterThan(0);
  });

  it('reports unpublished entries as unavailable and published ones as available', () => {
    // Entries whose install type is "none" are placeholders, not downloads.
    const s = states();
    expect(s['primetech-terminal']).toBe('unavailable');
    expect(s['buster']).toBe('unavailable');
    expect(s['devtoolbox']).toBe('available');
    expect(s['ohmytermux']).toBe('available');
  });

  it('reports an entry as installed only while its artefact file is on disk', () => {
    const artefact = path.join(h.state.downloads, 'devtoolbox-1.0.apk');
    fs.mkdirSync(path.dirname(artefact), { recursive: true });
    fs.writeFileSync(artefact, 'not really an apk');
    db.rows.set('devtoolbox', { artifact_name: artefact, byte_size: 18, fetched_at: '2026-01-01 00:00:00' });
    expect(states()['devtoolbox']).toBe('installed');

    // A row whose artefact was deleted outside the app must fall back to
    // 'available' rather than claiming a file that is gone.
    fs.rmSync(artefact);
    expect(states()['devtoolbox']).toBe('available');
  });
});

describe('marketplace:list — malformed entries are skipped and reported', () => {
  it('skips an entry with no install descriptor', () => {
    writeManifest(manifest([GOOD, { id: 'manual', name: 'Manual Only' }]));
    const listing = list();
    expect(listing.entries.map((e) => e.id)).toEqual(['good']);
    expect(listing.problems).toEqual(['Skipped "manual" — no install descriptor.']);
  });

  it('skips an entry whose install descriptor is not an object', () => {
    writeManifest(manifest([{ id: 'manual', name: 'Manual Only', install: 'apk' }]));
    const listing = list();
    expect(listing.entries).toEqual([]);
    expect(listing.problems).toEqual(['Skipped "manual" — no install descriptor.']);
  });

  it('skips an entry with no id', () => {
    writeManifest(manifest([GOOD, { name: 'Nameless Id', install: { type: 'none' } }]));
    const listing = list();
    expect(listing.entries.map((e) => e.id)).toEqual(['good']);
    expect(listing.problems).toEqual(['Skipped an entry with no id.']);
  });

  it('skips an entry with no name, naming the id in the problem', () => {
    writeManifest(manifest([GOOD, { id: 'nameless', install: { type: 'apk-download' } }]));
    const listing = list();
    expect(listing.entries.map((e) => e.id)).toEqual(['good']);
    expect(listing.problems).toEqual(['Skipped "nameless" — no name.']);
  });

  it('collects one problem per bad entry instead of bailing on the first', () => {
    writeManifest(manifest([{ name: 'No Id' }, { id: 'no-name' }, { id: 'no-install', name: 'No Install' }, GOOD]));
    const listing = list();
    expect(listing.entries.map((e) => e.id)).toEqual(['good']);
    expect(listing.problems).toHaveLength(3);
  });

  it('defaults the optional fields so the renderer always gets a full shape', () => {
    writeManifest(manifest([GOOD]));
    const entry = list().entries[0];
    expect(entry.type).toBe('app');
    expect(entry.category).toBe('general');
    expect(entry.description).toBe('');
    expect(entry.capabilities).toBeUndefined();
  });
});

describe('marketplace:list — an unusable manifest yields an empty list, not a crash', () => {
  it('survives invalid JSON and returns no entries', () => {
    writeManifest('{ "items": [ this is not json');
    const listing = list();
    expect(listing.entries).toEqual([]);
    // The early-return paths used to build a separate problems array, leaving
    // `listing.problems` empty — so a corrupt manifest rendered as a silently
    // empty catalogue instead of the "problems reading the manifest" banner.
    expect(listing.problems).toHaveLength(1);
    expect(listing.problems[0]).toContain('not valid JSON');
  });

  it('reports a missing items array', () => {
    writeManifest(JSON.stringify({ manifest: 'test-manifest', version: 3 }));
    const listing = list();
    expect(listing.entries).toEqual([]);
    expect(listing.problems).toContain('marketplace.json has no `items` array.');
  });

  it('reports items that is not an array', () => {
    writeManifest(JSON.stringify({ manifest: 'test-manifest', items: { 'good': GOOD } }));
    const listing = list();
    expect(listing.entries).toEqual([]);
    expect(listing.problems).toContain('marketplace.json has no `items` array.');
  });

  it('survives a manifest that is not there at all', () => {
    const listing = list();
    expect(listing.entries).toEqual([]);
    // Same class of bug as the invalid-JSON case: the reason must reach the UI.
    expect(listing.problems).toHaveLength(1);
    expect(listing.problems[0]).toContain('Could not read marketplace.json');
  });

  it('falls back to the default manifest name and version', () => {
    writeManifest(manifest([]));
    const listing = list();
    expect(listing.manifest).toBe('test-manifest');
    expect(listing.version).toBe(3);
  });
});

describe('entryIdFor — ids that will not collide in the fetch table', () => {
  it('is stable for the same name', () => {
    expect(entryIdFor('PrimeTech Terminal')).toBe(entryIdFor('PrimeTech Terminal'));
  });

  it('gives every shipped catalogue entry its own id', () => {
    // marketplace_fetches keys on this, so a collision would make one entry's
    // artefact overwrite another's.
    const names = [
      'PrimeTech Terminal',
      'Buster',
      'DevToolBox',
      'TermuxFM',
      'Oh My Termux',
      'PrimeTech Marketplace',
    ];
    const ids = names.map(entryIdFor);
    expect(new Set(ids).size).toBe(names.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});
