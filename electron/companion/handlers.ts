/**
 * IPC surface for the companion subsystem (rows 8.2 / 8.3 / 8.4 / 8.5).
 *
 * These channels are renderer-facing only. The sync-bridge companion transport
 * reaches the same state through `electron/companion/routes.ts`, which is
 * mounted behind the existing pairing + token guard — this file adds no route
 * of its own and never widens what an unauthenticated caller can reach.
 *
 * Memory graph (8.2) is served here by delegating to the existing
 * `buildMemoryGraph`, so the companion sees exactly the graph the desktop
 * renders rather than a second, divergent one.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { buildMemoryGraph } from '../ipc/memoryGraph';
import { createCompanionProfileService, type CompanionProfileService } from './personality';

let service: CompanionProfileService | null = null;
let pendingDb: Database.Database | null = null;

/**
 * Migration runs lazily, on first use — same invariant as the knowledge
 * handlers. `registerCompanionHandlers` is called from `registerMemoryHandlers`,
 * and handler registration must not require a database that supports DDL: a
 * test fixture or a partially-migrated database must still be able to register
 * the memory handlers it came for.
 */
function companion(): CompanionProfileService {
  if (!service) {
    if (!pendingDb) throw new Error('Companion profile service is not initialised.');
    service = createCompanionProfileService(pendingDb);
  }
  return service;
}

async function envelope<T>(fn: () => T | Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[companion]', message);
    return { ok: false, error: message };
  }
}

/** The live database handle, throwing only if a companion route was reached
 *  before registration. */
function companionDb(): Database.Database {
  if (!pendingDb) throw new Error('Companion profile service is not initialised.');
  return pendingDb;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function registerCompanionHandlers(db: Database.Database): void {
  pendingDb = db;
  service = null;

  // ── 8.2 Memory graph ───────────────────────────────────────────────────
  ipcMain.handle('companion:memoryGraph', (_e, payload: { limit?: unknown } = {}) =>
    envelope(() => {
      const graph = buildMemoryGraph(companionDb());
      const limit = typeof payload.limit === 'number' ? Math.min(Math.max(payload.limit, 1), 2000) : 500;
      return {
        nodes: graph.nodes.slice(0, limit),
        edges: graph.edges.filter((e) => graph.nodes.some((n) => n.id === e.from || n.id === e.to)).slice(0, limit * 2),
        truncated: graph.nodes.length > limit,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
      };
    }),
  );

  // ── 8.3 Personality ────────────────────────────────────────────────────
  ipcMain.handle('companion:getPersonality', () => envelope(() => companion().getPersonality()));
  ipcMain.handle('companion:savePersonality', (_e, payload: Record<string, unknown>) =>
    envelope(() =>
      companion().savePersonality({
        name: payload.name as string | null | undefined,
        traits: (payload.traits ?? {}) as Record<string, number>,
        speakingStyle: payload.speakingStyle as string | null | undefined,
        values: Array.isArray(payload.values) ? payload.values.map(String) : undefined,
      }),
    ),
  );

  // ── 8.4 Emotional context ──────────────────────────────────────────────
  ipcMain.handle('companion:getEmotion', () => envelope(() => companion().getEmotion()));
  ipcMain.handle('companion:observeEmotion', (_e, payload: Record<string, unknown>) =>
    envelope(() =>
      companion().observeEmotion({
        mood: optionalString(payload.mood),
        valence: typeof payload.valence === 'number' ? payload.valence : undefined,
        arousal: typeof payload.arousal === 'number' ? payload.arousal : undefined,
        intensity: typeof payload.intensity === 'number' ? payload.intensity : undefined,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
        note: optionalString(payload.note),
      }),
    ),
  );
  ipcMain.handle('companion:emotionalHistory', (_e, limit?: number) =>
    envelope(() => companion().emotionalHistory(typeof limit === 'number' ? limit : 20)),
  );

  // ── 8.5 Companion voice ────────────────────────────────────────────────
  ipcMain.handle('companion:getVoiceProfile', () => envelope(() => companion().getVoiceProfile()));
  ipcMain.handle('companion:saveVoiceProfile', (_e, payload: Record<string, unknown>) =>
    envelope(() =>
      companion().saveVoiceProfile({
        voiceId: payload.voiceId as string | null | undefined,
        engine: payload.engine as string | null | undefined,
        rate: typeof payload.rate === 'number' ? payload.rate : undefined,
        pitch: typeof payload.pitch === 'number' ? payload.pitch : undefined,
        style: payload.style as string | null | undefined,
      }),
    ),
  );

  // ── Assembled context — what the companion prompt path consumes ────────
  ipcMain.handle('companion:getContext', () => envelope(() => companion().buildCompanionContext()));
}

export function getCompanionProfileService(): CompanionProfileService {
  return companion();
}
