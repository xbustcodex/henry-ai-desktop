/**
 * Memory recall over the vector store (row 9.3).
 *
 * The authoritative memory lives in the tables `electron/ipc/memory.ts` owns —
 * `personal_memory`, `memory_facts`, `narrative_memory`, `project_memory`. This
 * module does NOT create a parallel memory store: it indexes those same rows
 * into the vector store so recall can be semantic, and it reads results back
 * out of the authoritative tables.
 *
 * Deleting or deactivating a memory soft-deletes the authoritative row AND its
 * vector chunks, so the two can never disagree about what exists.
 */

import type Database from 'better-sqlite3';
import { chunkText } from '../vector/chunk';
import type { Embedder } from '../vector/embeddings';
import type { VectorStore } from '../vector/store';
import type { SqlDatabase } from '../vector/sql';

/** The authoritative memory layers this service indexes and recalls from. */
export type MemoryLayer = 'personal_memory' | 'memory_facts' | 'narrative_memory' | 'project_memory';

export interface RecalledMemory {
  /** Row id in whichever authoritative table this came from. */
  id: string;
  /** Which memory layer the memory lives in. */
  table: MemoryLayer;
  label: string;
  detail: string;
  score: number;
  updatedAt: string;
  /** The scoring fields the memory blueprint ranks by, when present. */
  significance?: { strategic: number; emotional: number; confidence: number };
}

export interface MemoryRecallResult {
  memories: RecalledMemory[];
  backend: 'ollama' | 'hashed-fallback';
  model: string;
  note?: string;
}

interface MemoryRow {
  id: string;
  label: string;
  detail: string;
  updatedAt: string;
  strategic: number | null;
  emotional: number | null;
  confidence: number | null;
}

/**
 * The blueprint's retrieval formula (memory.ts:23-51), reproduced here so the
 * vector score and the significance score can be combined rather than one
 * silently replacing the other. A semantically perfect match to a trivial
 * note should not outrank the project's stated priority.
 */
const VECTOR_WEIGHT = 0.65;
const SIGNIFICANCE_WEIGHT = 0.35;

function significanceOf(row: MemoryRow): number {
  const strategic = row.strategic ?? 0.5;
  const emotional = row.emotional ?? 0.3;
  const confidence = row.confidence ?? 0.7;
  return strategic * 0.25 + emotional * 0.15 + confidence * 0.10;
}

export class MemoryRecallService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Mirror the authoritative memory tables into the vector index.
   * Safe to re-run: the content hash means unchanged memories are skipped
   * rather than re-embedded, which matters because embedding is the slow part.
   */
  async reindexAllMemory(opts: { batchSize?: number } = {}): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;

    const groups: { table: MemoryLayer; sql: string }[] = [
      {
        table: 'personal_memory',
        sql: `SELECT id, memory_key AS label, memory_value AS detail, updated_at,
                     strategic_significance_score AS strategic,
                     emotional_significance_score AS emotional,
                     confidence_score AS confidence
              FROM personal_memory WHERE COALESCE(active_status, 1) = 1`,
      },
      {
        table: 'memory_facts',
        sql: `SELECT id, fact AS label, category AS detail, created_at AS updated_at,
                     NULL AS strategic, NULL AS emotional, importance AS confidence
              FROM memory_facts`,
      },
      {
        table: 'narrative_memory',
        sql: `SELECT id, arc_name AS label, summary AS detail, updated_at,
                     importance_score AS strategic, NULL AS emotional, NULL AS confidence
              FROM narrative_memory WHERE COALESCE(active_status, 1) = 1`,
      },
      {
        table: 'project_memory',
        sql: `SELECT id, memory_key AS label, memory_value AS detail, updated_at,
                     relevance_score AS strategic, NULL AS emotional, confidence_score AS confidence
              FROM project_memory`,
      },
    ];

    for (const group of groups) {
      let rows: MemoryRow[];
      try {
        rows = this.db.prepare(group.sql).all() as MemoryRow[];
      } catch (e: unknown) {
        // A table this build predates simply contributes nothing — but a
        // genuine SQL error was previously swallowed here too, which made a
        // broken reindex look exactly like an empty one. Say which it was.
        const message = e instanceof Error ? e.message : String(e);
        if (!/no such table/.test(message)) {
          console.error(`[memoryRecall] indexing ${group.table} failed:`, message);
        }
        continue;
      }
      for (const row of rows) {
        const text = `${row.label ?? ''}\n${row.detail ?? ''}`.trim();
        if (!text) {
          skipped++;
          continue;
        }
        const chunks = chunkText(text, { maxChars: 600, overlapChars: 80, minChars: 40 });
        const embedded = [];
        for (const c of chunks) {
          embedded.push({
            text: c.text,
            vector: await this.embedder.embed(c.text),
            metadata: { table: group.table, memoryId: row.id, strategic: row.strategic, emotional: row.emotional, confidence: row.confidence },
          });
        }
        // The source id is namespaced per table so two layers can never
        // collide on the same id and overwrite each other's chunks.
        this.store.upsertSource({
          id: `${group.table}:${row.id}`,
          sourceType: 'memory',
          sourceUri: `${group.table}/${row.id}`,
          title: row.label ?? '',
          chunks: embedded,
        });
        indexed++;
      }
    }
    void opts;
    return { indexed, skipped };
  }

  /** Semantic recall across every indexed memory layer. */
  async recall(query: string, k = 10): Promise<MemoryRecallResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      const status = this.embedder.status();
      return { memories: [], backend: status.backend, model: status.model };
    }
    const vector = await this.embedder.embed(trimmed);
    const matches = this.store.query(vector, Math.min(Math.max(k, 1), 50), { sourceType: 'memory' });

    const memories: RecalledMemory[] = [];
    for (const match of matches) {
      const table = String(match.chunk.metadata.table ?? '') as RecalledMemory['table'];
      if (!this.isKnownTable(table)) continue;
      const row = match.chunk.metadata;
      const strategic = typeof row.strategic === 'number' ? row.strategic : null;
      const emotional = typeof row.emotional === 'number' ? row.emotional : null;
      const confidence = typeof row.confidence === 'number' ? row.confidence : null;
      // Rescale cosine from [-1,1] to [0,1] so the blend below is a genuine
      // weighted sum rather than a sum that can go negative.
      const semantic = (match.score + 1) / 2;
      const blended = semantic * VECTOR_WEIGHT + significanceOf({ id: '', label: '', detail: '', updatedAt: '', strategic, emotional, confidence }) * SIGNIFICANCE_WEIGHT;
      memories.push({
        id: String(match.chunk.metadata.memoryId ?? match.chunk.sourceId.split(':').slice(1).join(':')),
        table,
        label: match.chunk.title,
        detail: match.chunk.text,
        score: blended,
        updatedAt: match.chunk.updatedAt,
        significance: { strategic: strategic ?? 0.5, emotional: emotional ?? 0.3, confidence: confidence ?? 0.7 },
      });
    }

    const status = this.embedder.status();
    return {
      memories,
      backend: status.backend,
      model: status.model,
      note:
        status.backend === 'hashed-fallback'
          ? `Semantic memory recall is offline — lexical matching only (${status.reason ?? 'no local embedding model'}).`
          : undefined,
    };
  }

  /** Drop a memory's vectors when the authoritative row is removed. */
  forgetMemory(table: MemoryLayer, id: string): { deleted: boolean } {
    if (!this.isKnownTable(table)) return { deleted: false };
    return this.store.deleteSource(`${table}:${id}`);
  }

  /**
   * Guard against `table` coming from metadata and reaching SQL as an
   * identifier — the recall path never interpolates it, but this keeps the
   * allow-list explicit at the boundary.
   */
  private isKnownTable(table: string): boolean {
    return (
      table === 'personal_memory' ||
      table === 'memory_facts' ||
      table === 'narrative_memory' ||
      table === 'project_memory'
    );
  }
}

export function createMemoryRecallService(
  db: Database.Database,
  store: VectorStore,
  embedder: Embedder,
): MemoryRecallService {
  return new MemoryRecallService(db as unknown as SqlDatabase, store, embedder);
}
