/**
 * PrimeTech marketplace.
 *
 * Reads the same `marketplace.json` manifest the PrimeTech apps ship, so the
 * catalogue has one definition shared across the family. Catalog metadata is
 * kept strictly separate from runtime state, as in the Kotlin original.
 *
 * On a desktop host most entries are Android packages. The honest behaviour is
 * to fetch the artefact into the user's Downloads folder and say plainly what
 * it is — not pretend an APK can be installed here.
 */

import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export type CatalogEntryType = 'app' | 'tool' | 'plugin' | 'extension';

export interface CatalogInstall {
  type: 'none' | 'apk-download' | 'termux-run' | string;
  scriptUrl?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  type: CatalogEntryType | string;
  category: string;
  description: string;
  version?: string;
  author?: string;
  packageName?: string;
  repository?: string;
  homepage?: string;
  apkUrl?: string;
  capabilities?: string[];
  integrations?: string[];
  requirements?: Record<string, unknown>;
  install: CatalogInstall;
}

/** installed = fetched before; available = fetchable now; unavailable = nothing to fetch. */
export type CatalogEntryState = 'installed' | 'available' | 'unavailable';

export interface CatalogListing {
  manifest: string;
  version: number;
  entries: CatalogEntry[];
  /** Non-fatal problems found while parsing — surfaced rather than hidden. */
  problems: string[];
  fetchedAt: string;
}

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

function manifestPath(): string {
  // In a packaged build the manifest is copied to Resources/marketplace via
  // extraResources. In a dev run it lives beside the project. __dirname is the
  // bundled main output (dist-electron/), so a relative path from there
  // overshoots the repo — app.getAppPath() is correct in both cases.
  if (app.isPackaged) return path.join(process.resourcesPath, 'marketplace', 'marketplace.json');
  return path.join(app.getAppPath(), 'resources', 'marketplace', 'marketplace.json');
}

function downloadsDir(): string {
  const dir = path.join(app.getPath('downloads'), 'prime-tech-marketplace');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Files already fetched into the local marketplace cache. */
function installedDir(): string {
  const dir = path.join(app.getPath('userData'), 'marketplace');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Whether we have actually fetched this entry.
 *
 * The DB row is the source of truth and the file check guards against a row
 * whose artefact was deleted outside the app — checking a synthetic
 * `<id>.artifact` path instead reported 'available' forever, because downloads
 * land in the Downloads folder under a versioned name.
 */
function stateOf(entry: CatalogEntry, fetchedPath: (id: string) => string | null): CatalogEntryState {
  if (entry.install?.type === 'none' || !entry.install?.type) return 'unavailable';
  const path_ = fetchedPath(entry.id);
  return path_ && fs.existsSync(path_) ? 'installed' : 'available';
}

function readManifest(): { listing: CatalogListing; problems: string[] } {
  const problems: string[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath(), 'utf8');
  } catch (e: unknown) {
    // Push into the SAME array the listing carries — the early returns used to
    // build a separate one, so a missing or corrupt manifest reported zero
    // problems and the UI showed a silently empty catalogue.
    problems.push(`Could not read marketplace.json: ${e instanceof Error ? e.message : String(e)}`);
    return {
      problems,
      listing: { manifest: 'primech-marketplace', version: 0, entries: [], problems, fetchedAt: new Date().toISOString() },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    problems.push(`marketplace.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return {
      problems,
      listing: { manifest: 'primech-marketplace', version: 0, entries: [], problems, fetchedAt: new Date().toISOString() },
    };
  }

  const doc = parsed as { manifest?: string; version?: number; items?: unknown };
  const items = Array.isArray(doc.items) ? doc.items : [];
  if (!Array.isArray(doc.items)) problems.push('marketplace.json has no `items` array.');

  const entries: CatalogEntry[] = [];
  for (const item of items) {
    const e = item as Partial<CatalogEntry>;
    // A malformed entry is skipped and reported rather than poisoning the list.
    if (!e || typeof e.id !== 'string' || !e.id.trim()) { problems.push('Skipped an entry with no id.'); continue; }
    if (typeof e.name !== 'string' || !e.name) { problems.push(`Skipped "${e.id}" — no name.`); continue; }
    if (!e.install || typeof e.install !== 'object') {
      problems.push(`Skipped "${e.id}" — no install descriptor.`);
      continue;
    }
    entries.push({
      id: e.id.trim(),
      name: e.name,
      type: e.type ?? 'app',
      category: e.category ?? 'general',
      description: e.description ?? '',
      version: e.version,
      author: e.author,
      packageName: e.packageName,
      repository: e.repository,
      homepage: e.homepage,
      apkUrl: e.apkUrl,
      capabilities: Array.isArray(e.capabilities) ? e.capabilities : undefined,
      integrations: Array.isArray(e.integrations) ? e.integrations : undefined,
      requirements: e.requirements,
      install: e.install,
    });
  }

  return {
    problems,
    listing: {
      manifest: doc.manifest ?? 'primech-marketplace',
      version: typeof doc.version === 'number' ? doc.version : 0,
      entries,
      problems,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** Download an artefact to a path, following redirects and refusing to overshoot. */
async function download(url: string, dest: string): Promise<number> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ARTIFACT_BYTES) {
    throw new Error(`That file is ${(declared / 1048576).toFixed(0)} MB — too large to fetch.`);
  }

  const tmp = `${dest}.part`;
  const writer = fs.createWriteStream(tmp);
  let written = 0;
  try {
    if (res.body) {
      // for await over the web stream keeps this simple and correctly streamed.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.byteLength;
        if (written > MAX_ARTIFACT_BYTES) throw new Error('Download exceeded the size limit.');
        if (!writer.write(chunk)) {
          await new Promise<void>((r) => writer.once('drain', () => r()));
        }
      }
    }
  } finally {
    await new Promise<void>((r) => writer.end(r));
  }
  fs.renameSync(tmp, dest);
  return written;
}

export function registerMarketplaceHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_fetches (
      entry_id TEXT PRIMARY KEY,
      artifact_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const fetchedPath = (entryId: string): string | null => {
    const row = db
      .prepare('SELECT artifact_name FROM marketplace_fetches WHERE entry_id = ?')
      .get(entryId) as { artifact_name: string } | undefined;
    return row?.artifact_name ?? null;
  };

  ipcMain.handle('marketplace:list', () => readManifest().listing);

  ipcMain.handle('marketplace:states', () => {
    const states: Record<string, CatalogEntryState> = {};
    for (const e of readManifest().listing.entries) states[e.id] = stateOf(e, fetchedPath);
    return states;
  });

  /** Fetch an entry's artefact into Downloads. Never executes anything. */
  ipcMain.handle('marketplace:fetch', async (_e, entryId: string) => {
    try {
      const { listing } = readManifest();
      const entry = listing.entries.find((e) => e.id === entryId);
      if (!entry) return { ok: false, error: `No catalogue entry called "${entryId}".` };

      const url = entry.install.type === 'termux-run' ? entry.install.scriptUrl : entry.apkUrl;
      if (!url) {
        return { ok: false, error: `"${entry.name}" has nothing to download.` };
      }

      const ext = entry.install.type === 'termux-run' ? 'sh' : 'apk';
      const name = `${entry.id}-${entry.version ?? 'latest'}.${ext}`;
      const dest = path.join(downloadsDir(), name);

      const bytes = await download(url, dest);

      db.prepare(
        `INSERT INTO marketplace_fetches (entry_id, artifact_name, byte_size, fetched_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(entry_id) DO UPDATE SET artifact_name=excluded.artifact_name,
           byte_size=excluded.byte_size, fetched_at=excluded.fetched_at`,
      ).run(entry.id, dest, bytes);

      return { ok: true, path: dest, name, byteSize: bytes };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('marketplace:openEntry', async (_e, entryId: string) => {
    const { listing } = readManifest();
    const entry = listing.entries.find((e) => e.id === entryId);
    if (!entry) return { ok: false, error: `No catalogue entry called "${entryId}".` };
    // Prefer an artefact we already fetched, else the project page.
    const fetched = fetchedPath(entry.id);
    if (fetched && fs.existsSync(fetched)) {
      shell.showItemInFolder(fetched);
      return { ok: true, revealed: fetched };
    }
    const target = entry.homepage || entry.repository;
    if (!target) return { ok: false, error: `"${entry.name}" has no link to open.` };
    await shell.openExternal(target);
    return { ok: true, opened: target };
  });

  ipcMain.handle('marketplace:reveal', (_e, filePath: string) => {
    // Only ever reveal something inside our own cache/downloads folder.
    const resolved = path.resolve(filePath);
    const allowed = [downloadsDir(), installedDir()].map((p) => path.resolve(p));
    if (!allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
      return { ok: false, error: 'That file is outside the marketplace folders.' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'That file is no longer there.' };
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.handle('marketplace:history', () =>
    db.prepare('SELECT * FROM marketplace_fetches ORDER BY fetched_at DESC').all(),
  );

  ipcMain.handle('marketplace:remove', (_e, entryId: string) => {
    try {
      const file = fetchedPath(entryId);
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
      db.prepare('DELETE FROM marketplace_fetches WHERE entry_id = ?').run(entryId);
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('marketplace:chooseFolder', async () => {
    const parent = getWindow();
    const res = parent
      ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return res.canceled ? { ok: false, cancelled: true } : { ok: true, path: res.filePaths[0] };
  });
}

/** Stable id helper so the renderer never invents entry ids. */
export function entryIdFor(name: string): string {
  return crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);
}
