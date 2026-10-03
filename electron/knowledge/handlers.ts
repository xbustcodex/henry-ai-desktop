/**
 * IPC surface for the knowledge base and semantic memory recall.
 *
 * Registered from `registerMemoryHandlers` (electron/ipc/memory.ts) so the
 * channels share the one database handle the memory system already owns — no
 * second connection, no second store.
 *
 * Channels added here:
 *   knowledge:ingestFile / :ingestUrl / :ingestNote
 *   knowledge:list / :get / :delete / :stats / :search
 *   knowledge:reindexMemory / :recallMemory
 *
 * All of them run behind the existing IPC payload validation, and every one
 * that touches the filesystem defers to `resolveUserPath` for confinement.
 */

import {
  createMemoryRecallService,
  type MemoryRecallResult,
  type MemoryRecallService,
} from './memoryRecallService';

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { createKnowledgeBase, type KnowledgeBase, type KnowledgeSourceKind } from './core';

// Re-exported so `electron/ipc/memory.ts` can name the recall result type
// without reaching through this module's dependency graph.
export type { MemoryRecallResult, MemoryRecallService };
let kb: KnowledgeBase | null = null;
let recall: MemoryRecallService | null = null;

let pendingDb: Database.Database | null = null;

/**
 * Schema migrations run LAZILY, on first real use, not at handler
 * registration.
 *
 * Registering handlers must stay side-effect free: `registerMemoryHandlers`
 * calls this, and a caller may hand it a database handle that does not
 * implement the full DDL surface (an IPC test fixture, for one). Running
 * `CREATE TABLE` eagerly turned every such caller into a registration-time
 * crash — the handler existed but the app could not boot past it. With the
 * migration deferred, a fixture that never touches the knowledge surface never
 * pays for it, and one that does gets the schema exactly when it needs it.
 */
function ensureReady(): void {
  if (kb) return;
  if (!pendingDb) throw new Error('Knowledge base is not initialised.');
  const created = createKnowledgeBase(pendingDb);
  kb = created;
  recall = createMemoryRecallService(pendingDb as never, created.store, created.embedder);
}

function knowledge(): KnowledgeBase {
  ensureReady();
  if (!kb) throw new Error('Knowledge base is not initialised.');
  return kb;
}

function recallService(): MemoryRecallService {
  ensureReady();
  if (!recall) throw new Error('Memory recall is not initialised.');
  return recall;
}

/** Every handler returns an envelope so a thrown error never loses its shape. */
async function envelope<T>(fn: () => T | Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[knowledge]', message);
    return { ok: false, error: message };
  }
}

function sourceKindOf(value: unknown): KnowledgeSourceKind | undefined {
  return value === 'file' || value === 'url' || value === 'note' ? value : undefined;
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
}

export function registerKnowledgeHandlers(db: Database.Database): void {
  pendingDb = db;
  kb = null;
  recall = null;

  ipcMain.handle('knowledge:ingestFile', (_e, payload: { path?: string; title?: string; tags?: unknown }) =>
    envelope(() =>
      knowledge().ingestFile(String(payload?.path ?? ''), {
        title: typeof payload?.title === 'string' ? payload.title : undefined,
        tags: tagsOf(payload?.tags),
      }),
    ),
  );

  ipcMain.handle('knowledge:ingestUrl', (_e, payload: { url?: string; title?: string; tags?: unknown }) =>
    envelope(() =>
      knowledge().ingestUrl(String(payload?.url ?? ''), {
        title: typeof payload?.title === 'string' ? payload.title : undefined,
        tags: tagsOf(payload?.tags),
      }),
    ),
  );

  ipcMain.handle('knowledge:ingestNote', (_e, payload: { text?: string; title?: string; tags?: unknown }) =>
    envelope(() =>
      knowledge().ingestNote(String(payload?.text ?? ''), {
        title: typeof payload?.title === 'string' ? payload.title : undefined,
        tags: tagsOf(payload?.tags),
      }),
    ),
  );

  ipcMain.handle('knowledge:list', (_e, payload: { sourceKind?: unknown; limit?: unknown } = {}) =>
    envelope(() =>
      knowledge().listDocuments({
        sourceKind: sourceKindOf(payload?.sourceKind),
        limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
      }),
    ),
  );

  ipcMain.handle('knowledge:get', (_e, id: string) => envelope(() => knowledge().getDocument(String(id ?? ''))));

  ipcMain.handle('knowledge:delete', (_e, id: string) => envelope(() => knowledge().deleteDocument(String(id ?? ''))));

  ipcMain.handle('knowledge:stats', () =>
    envelope(() => ({ ...knowledge().stats(), embedder: knowledge().embedder.status() })),
  );

  ipcMain.handle(
    'knowledge:search',
    (_e, payload: { query?: string; limit?: unknown; sourceKind?: unknown; terms?: unknown } = {}) =>
      envelope(() =>
        knowledge().search(String(payload?.query ?? ''), {
          limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
          sourceKind: sourceKindOf(payload?.sourceKind),
          terms: Array.isArray(payload?.terms) ? payload.terms.map(String) : undefined,
        }),
      ),
  );

  ipcMain.handle('knowledge:reindexMemory', () => envelope(() => recallService().reindexAllMemory()));

  ipcMain.handle('knowledge:recallMemory', (_e, payload: { query?: string; k?: unknown } = {}) =>
    envelope(() =>
      recallService().recall(String(payload?.query ?? ''), typeof payload?.k === 'number' ? payload.k : 10),
    ),
  );
}

/** The live knowledge base, for callers inside the main process. */
export function getKnowledgeBase(): KnowledgeBase {
  return knowledge();
}

export function getMemoryRecallService(): MemoryRecallService {
  return recallService();
}
