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
 *
 * ── Why this module exists rather than a bare vector search ──────────────────
 * Two failures motivated the current shape, and both were of the same kind:
 * the ranking function was correct while nothing ever supplied the value it
 * ranked on.
 *
 *   1. `memory_type` never reached the blend. A lesson recorded by
 *      `electron/agent/tools/lessons.ts` was indexed as an anonymous chunk, so
 *      it surfaced as ordinary mid-tier memory and ranked no higher than a
 *      passing coffee preference.
 *   2. The index was never refreshed on write. `reindexAllMemory` existed, was
 *      correct, and fired only from a manual IPC channel or when the store was
 *      completely empty — so a lesson recorded in one session simply was not in
 *      the index for the next one, however good the ranking would have been.
 *
 * The fixes are correspondingly unglamorous: carry the type, and sync the
 * index on the read path so whoever wrote the row does not have to remember to
 * mirror it.
 */

import type Database from 'better-sqlite3';
import { chunkText } from '../vector/chunk';
import type { Embedder } from '../vector/embeddings';
import type { VectorStore } from '../vector/store';
import type { SqlDatabase } from '../vector/sql';

/** The authoritative memory layers this service indexes and recalls from. */
export type MemoryLayer = 'personal_memory' | 'memory_facts' | 'narrative_memory' | 'project_memory';

/**
 * `personal_memory.memory_type` value that marks a row as a recorded lesson.
 * Kept as a constant because two files now have to agree on this string, and a
 * silent disagreement would degrade the feature back to "lessons rank as
 * ordinary memory" without a single error.
 */
export const LESSON_MEMORY_TYPE = 'lesson';

export interface RecalledMemory {
  /** Row id in whichever authoritative table this came from. */
  id: string;
  /** Which memory layer the memory lives in. */
  table: MemoryLayer;
  /**
   * `personal_memory.memory_type` for personal memories (`'lesson'`,
   * `'preference'`, `'policy'`, …); `null` for layers that have no such
   * column. This is what makes a recalled memory identifiable AS a lesson
   * rather than merely scoring well.
   */
  memoryType: string | null;
  /**
   * For a lesson, the stored trigger — the "when this applies" half of the
   * rule. Null for everything else.
   */
  trigger: string | null;
  label: string;
  detail: string;
  score: number;
  /** The type-conditioned blend inputs, so a ranking is explainable, not magic. */
  ranking: {
    semantic: number;
    significance: number;
    /** 1.0 for ordinary memory; up to 1.3 for a lesson whose trigger fires. */
    priority: number;
    /** Fraction of the lesson's trigger vocabulary the query named, 0..1. */
    triggerSignal: number;
  };
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

export interface MemoryRecallOptions {
  /**
   * Restrict results to these `personal_memory.memory_type` values. The
   * constraint half of "type-aware": a caller that wants the standing rules
   * and nothing else asks for `['lesson']` instead of ranking all memory by a
   * weighted guess about what it wants.
   */
  types?: string[];
}

interface MemoryRow {
  id: string;
  label: string;
  detail: string;
  updatedAt: string;
  strategic: number | null;
  emotional: number | null;
  confidence: number | null;
  /** personal_memory only; null for layers without a type column. */
  memoryType: string | null;
  /** personal_memory only: the lesson's "when this applies" trigger. */
  trigger: string | null;
  /** Content hash already stored in the vector index for this row. */
  indexedHash: string | null;
}

/**
 * The blueprint's retrieval formula (memory.ts:23-51), reproduced here so the
 * vector score and the significance score can be combined rather than one
 * silently replacing the other. A semantically perfect match to a trivial
 * note should not outrank the project's stated priority.
 */
const VECTOR_WEIGHT = 0.65;
const SIGNIFICANCE_WEIGHT = 0.35;

/**
 * Ceiling on the lesson priority lift.
 *
 * This is a bounded prior, not a ranking constant, and the bound is the point.
 * A lesson is user-authored standing guidance with an explicit trigger, and
 * the cost of missing one — Henry asking again for something already settled —
 * is worse than the cost of surfacing one that turns out to be irrelevant. So
 * it earns a prior above ordinary memory. But a prior is not a promotion: it
 * must never outrank a genuinely better topical match, which is why it is
 * capped well below 1.0 of the scale and why it is gated on the trigger (see
 * `triggerSignal`) rather than granted to every lesson unconditionally.
 *
 * At the cap a lesson needs a blended base about 23% below a rival's to still
 * lose to it. General recall is untouched: the multiplier for every non-lesson
 * row is exactly 1.0, so the relative order of ordinary memories is bit-identical
 * to the pre-change formula.
 */
const LESSON_PRIORITY_MAX = 0.3;

const HASH_SEP = '\u0000';

/** Significance fields are 0..1 across most layers — but not all of them. */
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * `memory_facts.importance` is an INTEGER written on a 1..10 scale
 * (values 1, 2, 3, 5, 8 and 9 all appear in this codebase). Feeding that
 * straight into a 0..1 weighted sum let one ordinary fact contribute 0.9 —
 * more than the entire significance budget — and out-rank a project memory
 * that matched it better. Every input is clamped so no single field can
 * exceed the weight it was given.
 */
function significanceOf(row: Pick<MemoryRow, 'strategic' | 'emotional' | 'confidence'>): number {
  const strategic = clamp01(row.strategic ?? 0.5);
  const emotional = clamp01(row.emotional ?? 0.3);
  const confidence = clamp01(row.confidence ?? 0.7);
  return strategic * 0.25 + emotional * 0.15 + confidence * 0.10;
}

/**
 * Split text into comparable terms. Mirrors `electron/agent/tools/lessons.ts`
 * so a lesson ranks the same way by keyword there and by type here.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * How much of a lesson's stored trigger the query actually names, 0..1.
 *
 * Whole-word matches only. A substring hit ("deploy" inside "deployment")
 * would fire the lift for a lesson the user never invoked, which is precisely
 * the "crank a constant until the test passes" failure mode: the lesson would
 * surface on queries where it has no bearing, and every other recall on those
 * queries would be pushed down.
 */
function triggerSignal(terms: string[], trigger: string | null): number {
  if (!terms.length || !trigger) return 0;
  const words = new Set(tokenize(trigger));
  if (!words.size) return 0;
  let hits = 0;
  for (const term of terms) {
    if (words.has(term)) hits++;
  }
  return Math.min(1, hits / words.size);
}

/**
 * Stable content hash over everything whose change should re-embed a row.
 * FNV-1a: the same function the offline embedder uses, for the same reason —
 * it has to produce the same digest on every platform and every run, because
 * the stored value is compared against in a later process.
 */
function contentHash(row: MemoryRow): string {
  const input = [row.label, row.detail, row.memoryType ?? '', row.trigger ?? ''].join(HASH_SEP);
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The per-layer read that backs both the full reindex and the incremental
 * sync. `s.content_hash` is joined in so drift detection is one query per
 * layer rather than one query per row.
 */
const LAYER_QUERIES: { table: MemoryLayer; sql: string; optional?: string[] }[] = [
  {
    table: 'personal_memory',
    // `memory_type` and `summary` carry the lesson identity and its trigger.
    // Both are substituted for NULL on a database that predates them rather
    // than failing the whole layer: losing every personal memory because one
    // optional column is absent is a far worse failure than losing the ability
    // to tell a lesson from a preference on that old database.
    optional: ['memory_type', 'summary'],
    sql: `SELECT t.id, t.memory_key AS label, t.memory_value AS detail, t.updated_at AS updatedAt,
                 t.strategic_significance_score AS strategic,
                 t.emotional_significance_score AS emotional,
                 t.confidence_score AS confidence,
                 {memory_type} AS memoryType,
                 {summary} AS trigger,
                 s.content_hash AS indexedHash
          FROM personal_memory t
          LEFT JOIN vector_sources s
            ON s.id = 'personal_memory:' || t.id AND s.source_type = 'memory'
          WHERE COALESCE(t.active_status, 1) = 1`,
  },
  {
    table: 'memory_facts',
    sql: `SELECT t.id, t.fact AS label, t.category AS detail, t.created_at AS updatedAt,
                 NULL AS strategic, NULL AS emotional, t.importance AS confidence,
                 NULL AS memoryType, NULL AS trigger,
                 s.content_hash AS indexedHash
          FROM memory_facts t
          LEFT JOIN vector_sources s
            ON s.id = 'memory_facts:' || t.id AND s.source_type = 'memory'`,
  },
  {
    table: 'narrative_memory',
    sql: `SELECT t.id, t.arc_name AS label, t.summary AS detail, t.updated_at AS updatedAt,
                 t.importance_score AS strategic, NULL AS emotional, NULL AS confidence,
                 NULL AS memoryType, NULL AS trigger,
                 s.content_hash AS indexedHash
          FROM narrative_memory t
          LEFT JOIN vector_sources s
            ON s.id = 'narrative_memory:' || t.id AND s.source_type = 'memory'
          WHERE COALESCE(t.active_status, 1) = 1`,
  },
  {
    table: 'project_memory',
    sql: `SELECT t.id, t.memory_key AS label, t.memory_value AS detail, t.updated_at AS updatedAt,
                 t.relevance_score AS strategic, NULL AS emotional, t.confidence_score AS confidence,
                 NULL AS memoryType, NULL AS trigger,
                 s.content_hash AS indexedHash
          FROM project_memory t
          LEFT JOIN vector_sources s
            ON s.id = 'project_memory:' || t.id AND s.source_type = 'memory'`,
  },
];

const MEMORY_TABLES = new Set<string>(LAYER_QUERIES.map((l) => l.table));

export class MemoryRecallService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  /** Columns present per table, probed once. See `layerSql`. */
  private readonly columns = new Map<string, Set<string>>();

  /**
   * Resolve a layer's SQL, substituting NULL for any optional column this
   * database does not have. `PRAGMA table_info` is one cheap call per table,
   * cached for the life of the service.
   */
  private layerSql(layer: (typeof LAYER_QUERIES)[number]): string {
    if (!layer.optional?.length) return layer.sql;
    let present = this.columns.get(layer.table);
    if (!present) {
      present = new Set<string>();
      try {
        for (const row of this.db.prepare(`PRAGMA table_info(${layer.table})`).all() as { name?: unknown }[]) {
          if (typeof row?.name === 'string') present.add(row.name);
        }
      } catch {
        // An unreadable table will fail the SELECT below with a clearer error.
      }
      this.columns.set(layer.table, present);
    }
    return layer.optional.reduce(
      (sql, column) => sql.replaceAll(`{${column}}`, present!.has(column) ? `t.${column}` : 'NULL'),
      layer.sql,
    );
  }


  /**
   * Mirror the authoritative memory tables into the vector index.
   *
   * Safe to re-run and safe to call concurrently: embedding is the slow part,
   * so a row whose content hash already matches what is indexed is skipped
   * rather than re-embedded. That is what makes this affordable to call on
   * every recall.
   *
   * Also prunes index entries whose authoritative row is gone or deactivated —
   * a revoked lesson has to leave semantic recall, not just keyword recall.
   */
  async reindexAllMemory(): Promise<{ indexed: number; skipped: number; pruned: number }> {
    let indexed = 0;
    let skipped = 0;
    const live = new Set<string>();

    for (const layer of LAYER_QUERIES) {
      let rows: MemoryRow[];
      try {
        rows = this.db.prepare(this.layerSql(layer)).all() as MemoryRow[];
      } catch (e: unknown) {
        // A table this build predates simply contributes nothing — but a
        // genuine SQL error was previously swallowed here too, which made a
        // broken reindex look exactly like an empty one. Say which it was.
        const message = e instanceof Error ? e.message : String(e);
        if (!/no such table/.test(message)) {
          console.error(`[memoryRecall] indexing ${layer.table} failed:`, message);
        }
        continue;
      }

      for (const row of rows) {
        const sourceId = `${layer.table}:${row.id}`;
        live.add(sourceId);
        if (row.indexedHash && row.indexedHash === contentHash(row)) {
          skipped++;
          continue;
        }
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
            // The type and the trigger are the ranking inputs. They have to be
            // carried here at index time because the blend has nothing else to
            // read them from at query time.
            metadata: {
              table: layer.table,
              memoryId: row.id,
              strategic: row.strategic,
              emotional: row.emotional,
              confidence: row.confidence,
              memoryType: row.memoryType,
              trigger: row.trigger,
            },
          });
        }
        // The source id is namespaced per table so two layers can never
        // collide on the same id and overwrite each other's chunks.
        this.store.upsertSource({
          id: sourceId,
          sourceType: 'memory',
          sourceUri: `${layer.table}/${row.id}`,
          title: row.label ?? '',
          contentHash: contentHash(row),
          chunks: embedded,
        });
        indexed++;
      }
    }

    let pruned = 0;
    for (const source of this.store.listSources({ sourceType: 'memory', limit: 500 })) {
      if (live.has(source.id)) continue;
      if (this.store.deleteSource(source.id).deleted) pruned++;
    }
    return { indexed, skipped, pruned };
  }

  /** Semantic recall across every indexed memory layer. */
  async recall(query: string, k = 10, opts: MemoryRecallOptions = {}): Promise<MemoryRecallResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      const status = this.embedder.status();
      return { memories: [], backend: status.backend, model: status.model };
    }

    // Refresh first. This is the load-bearing line for the whole feature: a
    // lesson recorded by any writer — the agent tool, the IPC handler, a
    // migration — is in the index before the very next recall, without that
    // writer knowing this module exists.
    try {
      await this.reindexAllMemory();
    } catch (e: unknown) {
      // A sync failure must not make recall fail: the index still holds
      // whatever it had, which is degraded but correct.
      console.error('[memoryRecall] index sync failed:', e instanceof Error ? e.message : String(e));
    }

    const vector = await this.embedder.embed(trimmed);
    const matches = this.store.query(vector, Math.min(Math.max(k, 1), 50), { sourceType: 'memory' });
    const terms = [...new Set(tokenize(trimmed))];
    const wanted = opts.types?.length ? new Set(opts.types.map((t) => t.toLowerCase())) : null;

    const memories: RecalledMemory[] = [];
    for (const match of matches) {
      const table = String(match.chunk.metadata.table ?? '') as RecalledMemory['table'];
      if (!MEMORY_TABLES.has(table)) continue;
      const row = match.chunk.metadata;
      const strategic = typeof row.strategic === 'number' ? row.strategic : null;
      const emotional = typeof row.emotional === 'number' ? row.emotional : null;
      const confidence = typeof row.confidence === 'number' ? row.confidence : null;
      const memoryType = typeof row.memoryType === 'string' && row.memoryType ? row.memoryType.toLowerCase() : null;
      const trigger = typeof row.trigger === 'string' && row.trigger ? row.trigger : null;
      if (wanted && !(memoryType ? wanted.has(memoryType) : false)) continue;

      // Rescale cosine from [-1,1] to [0,1] so the blend below is a genuine
      // weighted sum rather than a sum that can go negative.
      const semantic = (match.score + 1) / 2;
      const significance = significanceOf({ strategic, emotional, confidence });
      const signal = memoryType === LESSON_MEMORY_TYPE ? triggerSignal(terms, trigger) : 0;
      const priority = 1 + LESSON_PRIORITY_MAX * signal;
      const blended = (semantic * VECTOR_WEIGHT + significance * SIGNIFICANCE_WEIGHT) * priority;

      memories.push({
        id: String(match.chunk.metadata.memoryId ?? match.chunk.sourceId.split(':').slice(1).join(':')),
        table,
        memoryType,
        trigger,
        label: match.chunk.title,
        detail: match.chunk.text,
        score: blended,
        ranking: { semantic, significance, priority, triggerSignal: signal },
        updatedAt: match.chunk.updatedAt,
        significance: { strategic: strategic ?? 0.5, emotional: emotional ?? 0.3, confidence: confidence ?? 0.7 },
      });
    }

    // Rank by the blended score. The vector store returns cosine order; sorting
    // here is what makes the type-conditioned priority actually change what
    // the caller sees first.
    memories.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

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
    if (!MEMORY_TABLES.has(table)) return { deleted: false };
    return this.store.deleteSource(`${table}:${id}`);
  }
}

export function createMemoryRecallService(
  db: Database.Database,
  store: VectorStore,
  embedder: Embedder,
): MemoryRecallService {
  return new MemoryRecallService(db as unknown as SqlDatabase, store, embedder);
}