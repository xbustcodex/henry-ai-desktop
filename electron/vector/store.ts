/**
 * Local vector store — chunk embeddings persisted in the existing SQLite
 * database, with cosine-similarity retrieval.
 *
 * Why a BLOB + TS scan rather than sqlite-vec: the installed better-sqlite3
 * (v11.10) ships no `vec0` virtual-table module, `loadExtension` needs a
 * native .so that would have to be built per-ABI, and the app ships to Windows
 * and Linux from one installer. A linear scan keeps Henry dependency-free.
 *
 * HONEST SCOPE: an exact linear cosine scan is O(n*d) over every chunk in the
 * filter. That is comfortably correct for the tens of thousands of chunks a
 * personal knowledge base accumulates, and costs a few milliseconds there. It
 * is the wrong structure past ~10^6 chunks — at that point this module is the
 * only thing that needs an ANN index, and `query()` is the single seam where
 * that swap happens.
 *
 * Storage: vectors are stored L2-normalised as little-endian float32 BLOBs, so
 * cosine similarity reduces to a dot product with no per-row sqrt.
 */

import { col, num, str, toBlob, toFloat32, type Row, type SqlDatabase } from './sql';

/** A single retrievable unit: one chunk of one source document. */
export interface VectorChunk {
  id: string;
  sourceId: string;
  /** `file` | `url` | `note` | `memory` — lets retrieval filter by origin. */
  sourceType: string;
  sourceUri: string;
  title: string;
  text: string;
  vector: Float32Array;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A ranked search result. `score` is cosine similarity in [-1, 1]. */
export interface VectorMatch {
  chunk: VectorChunk;
  score: number;
}

export interface VectorQueryOptions {
  /** Narrow to one source type (`'file'`, `'url'`, …). */
  sourceType?: string;
  /** Narrow to one source document. */
  sourceId?: string;
  /** Discard matches scoring below this. */
  minScore?: number;
  /** Hard cap on how many rows are scanned, newest first. Protects latency. */
  maxScan?: number;
}

export interface UpsertChunkInput {
  id?: string;
  sourceId: string;
  sourceType: string;
  sourceUri?: string;
  title?: string;
  text: string;
  vector: Float32Array;
  metadata?: Record<string, unknown>;
}

const DEFAULT_MAX_SCAN = 20_000;

/**
 * Scale a vector to unit length, so cosine similarity is a plain dot product.
 * A zero vector (an embedder that returned nothing for this text) is returned
 * unchanged — it matches nothing rather than matching everything.
 */
export function l2normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i];
  if (sumSquares === 0) return vector;
  const inv = 1 / Math.sqrt(sumSquares);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] * inv;
  return out;
}


/** Counts describing the current state of the index. */
export interface VectorStats {
  sources: number;
  activeSources: number;
  chunks: number;
  dimensions: number;
}

/** A source document registered in the index, with its chunk count. */
export interface VectorSource {
  id: string;
  sourceType: string;
  sourceUri: string;
  title: string;
  active: boolean;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Cosine similarity. Inputs are expected pre-normalised; this stays exact. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);

  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  // Guard the norm-squared product against both vectors being unnormalised.
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseMetadata(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * DDL for the vector tables. Called from the shared migration runner so the
 * schema lands in the one existing database rather than a second store.
 */
export function migrateVectorSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_sources (
      id           TEXT PRIMARY KEY,
      source_type  TEXT NOT NULL,
      source_uri   TEXT NOT NULL DEFAULT '',
      title        TEXT NOT NULL DEFAULT '',
      content_hash TEXT,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vector_sources_type
      ON vector_sources(source_type, active);

    CREATE TABLE IF NOT EXISTS vector_chunks (
      id           TEXT PRIMARY KEY,
      source_id    TEXT NOT NULL,
      chunk_index  INTEGER NOT NULL DEFAULT 0,
      text         TEXT NOT NULL,
      vector       BLOB NOT NULL,
      dim          INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vector_chunks_source
      ON vector_chunks(source_id, chunk_index);
  `);
}

export class VectorStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Create the tables if they are absent. Safe to call on every boot. */
  migrate(): void {
    migrateVectorSchema(this.db);
  }

  /**
   * Record a source document and its chunks. Replacing a document is a
   * delete-then-insert inside one transaction so a partial re-index can never
   * leave a document with a half-updated chunk set visible to `query()`.
   */
  upsertSource(input: {
    id?: string;
    sourceType: string;
    sourceUri?: string;
    title?: string;
    contentHash?: string;
    chunks: { text: string; vector: Float32Array; metadata?: Record<string, unknown> }[];
  }): { sourceId: string; chunkIds: string[]; replaced: boolean } {
    const sourceId = input.id ?? this.newId();
    const now = new Date().toISOString();

    const existing = this.db
      .prepare(`SELECT id, content_hash FROM vector_sources WHERE id = ?`)
      .get(sourceId) as Row | undefined;

    const chunkIds: string[] = [];
    this.transaction(() => {
      // Re-indexing a document replaces it wholesale — stale chunks from a
      // previous (longer or edited) version would otherwise keep surfacing in
      // search results forever, since nothing else would ever remove them.
      this.db.prepare(`DELETE FROM vector_chunks WHERE source_id = ?`).run(sourceId);

      const insertChunk = this.db.prepare(`
        INSERT INTO vector_chunks (id, source_id, chunk_index, text, vector, dim, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      input.chunks.forEach((chunk, index) => {
        const chunkId = this.newId();
        chunkIds.push(chunkId);
        const normalised = l2normalize(chunk.vector);
        insertChunk.run(
          chunkId,
          sourceId,
          index,
          chunk.text,
          toBlob(normalised),
          normalised.length,
          JSON.stringify(chunk.metadata ?? {}),
          now,
          now,
        );
      });

      if (existing) {
        this.db
          .prepare(
            `UPDATE vector_sources
             SET source_type = ?, source_uri = ?, title = ?, content_hash = ?,
                 active = 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.sourceType,
            input.sourceUri ?? '',
            input.title ?? '',
            input.contentHash ?? null,
            now,
            sourceId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO vector_sources
               (id, source_type, source_uri, title, content_hash, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            sourceId,
            input.sourceType,
            input.sourceUri ?? '',
            input.title ?? '',
            input.contentHash ?? null,
            now,
            now,
          );
      }
    });

    return { sourceId, chunkIds, replaced: Boolean(existing) };
  }

  /**
   * Rank stored chunks against `queryVector`, best first.
   * This is the retrieval path the knowledge base and memory recall both use.
   */
  query(queryVector: Float32Array, k: number, options: VectorQueryOptions = {}): VectorMatch[] {
    if (k <= 0 || queryVector.length === 0) return [];

    const limit = Math.min(Math.floor(k), 200);
    const params: unknown[] = [];
    let sql = `
      SELECT c.id, c.source_id, c.text, c.vector, c.metadata_json, c.created_at, c.updated_at,
             s.source_type, s.source_uri, s.title
      FROM vector_chunks c
      JOIN vector_sources s ON s.id = c.source_id
      WHERE s.active = 1
    `;
    if (options.sourceType) {
      sql += ` AND s.source_type = ?`;
      params.push(options.sourceType);
    }
    if (options.sourceId) {
      sql += ` AND c.source_id = ?`;
      params.push(options.sourceId);
    }
    sql += ` ORDER BY c.updated_at DESC, c.chunk_index ASC LIMIT ?`;
    params.push(options.maxScan ?? DEFAULT_MAX_SCAN);

    const rows = this.db.prepare(sql).all(...params) as Row[];
    const matches: VectorMatch[] = [];
    const minScore = options.minScore ?? 0;

    for (const row of rows) {
      const vector = toFloat32(col(row, 'vector'));
      // A chunk stored by a different embedding model has a different
      // dimension; scoring it against this query would compare a prefix of
      // both vectors and quietly return nonsense, so skip it.
      if (!vector || vector.length !== queryVector.length) continue;
      const score = cosineSimilarity(queryVector, vector);
      if (score <= minScore) continue;
      matches.push({
        score,
        chunk: {
          id: str(row, 'id'),
          sourceId: str(row, 'source_id'),
          sourceType: str(row, 'source_type'),
          sourceUri: str(row, 'source_uri'),
          title: str(row, 'title'),
          text: str(row, 'text'),
          vector,
          metadata: parseMetadata(str(row, 'metadata_json')),
          createdAt: str(row, 'created_at'),
          updatedAt: str(row, 'updated_at'),
        },
      });
    }

    // Descending by score, then by id so equal scores are deterministic
    // across runs instead of depending on row order.
    matches.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    return matches.slice(0, limit);
  }

  /** Soft-delete a source and its chunks. */
  deleteSource(sourceId: string): { deleted: boolean } {
    const info = this.db
      .prepare(`UPDATE vector_sources SET active = 0, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), sourceId) as { changes?: number } | undefined;
    if ((info?.changes ?? 0) > 0) {
      this.db.prepare(`DELETE FROM vector_chunks WHERE source_id = ?`).run(sourceId);
      return { deleted: true };
    }
    return { deleted: false };
  }

  getSource(sourceId: string): VectorSource | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.source_type, s.source_uri, s.title, s.active, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM vector_chunks c WHERE c.source_id = s.id) AS chunk_count
         FROM vector_sources s WHERE s.id = ?`,
      )
      .get(sourceId) as Row | undefined;
    if (!row) return null;
    return {
      id: str(row, 'id'),
      sourceType: str(row, 'source_type'),
      sourceUri: str(row, 'source_uri'),
      title: str(row, 'title'),
      active: num(row, 'active') === 1,
      chunkCount: num(row, 'chunk_count'),
      createdAt: str(row, 'created_at'),
      updatedAt: str(row, 'updated_at'),
    };
  }

  listSources(opts: { sourceType?: string; includeInactive?: boolean; limit?: number } = {}): VectorSource[] {
    let sql = `SELECT id FROM vector_sources WHERE 1=1`;
    const params: unknown[] = [];
    if (opts.sourceType) {
      sql += ` AND source_type = ?`;
      params.push(opts.sourceType);
    }
    if (!opts.includeInactive) sql += ` AND active = 1`;
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 100, 500));

    const rows = this.db.prepare(sql).all(...params) as Row[];
    const out: VectorSource[] = [];
    for (const row of rows) {
      const source = this.getSource(str(row, 'id'));
      if (source) out.push(source);
    }
    return out;
  }

  stats(): VectorStats {
    const row = (this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM vector_sources) AS sources,
           (SELECT COUNT(*) FROM vector_sources WHERE active = 1) AS active_sources,
           (SELECT COUNT(*) FROM vector_chunks) AS chunks,
           (SELECT IFNULL(MAX(dim), 0) FROM vector_chunks) AS dimensions`,
      )
      // COUNT(*) always returns a row, but both drivers type `.get()` as
      // possibly undefined, so coerce instead of asserting.
      .get() ?? {}) as Row;
    return {
      sources: num(row, 'sources'),
      activeSources: num(row, 'active_sources'),
      chunks: num(row, 'chunks'),
      dimensions: num(row, 'dimensions'),
    };
  }

  /** Better-sqlite3 exposes `.transaction`; node:sqlite does not. */
  private transaction(fn: () => void): void {
    const withTransaction = (this.db as { transaction?: (f: () => void) => unknown }).transaction;
    if (typeof withTransaction === 'function') {
      withTransaction.call(this.db, fn);
      return;
    }
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
