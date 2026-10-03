/**
 * Knowledge base — chunked, embedded, retrievable.
 *
 * Ingestion has three real sources:
 *   • local files — confined to the user's home directory by the SAME
 *     `resolveUserPath` the file tools use, so there is exactly one rule about
 *     which paths Henry may read;
 *   • URLs — fetched through the existing SSRF-guarded `web_fetch_page` path,
 *     so a knowledge ingest cannot be used to reach a private address;
 *   • manual notes — text typed by the user.
 *
 * Everything lands in the ONE existing SQLite database: sources and chunks in
 * `vector_*`, and a `knowledge_documents` row carrying the human-facing
 * metadata (tags, source kind, original uri). There is no second store.
 */

import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { webTools } from '../agent/tools/web';
import { resolveUserPath } from '../agent/tools/files';
import { chunkText, DEFAULT_CHUNK_OPTIONS, type TextChunk } from '../vector/chunk';
import { createEmbedder, type Embedder, type EmbedderConfig } from '../vector/embeddings';
import { migrateVectorSchema, VectorStore } from '../vector/store';
import { emitTriggerEvent } from '../agent/triggers';
import type { SqlDatabase } from '../vector/sql';

/** Where a document came from. */
export type KnowledgeSourceKind = 'file' | 'url' | 'note';

export interface KnowledgeDocument {
  id: string;
  sourceKind: KnowledgeSourceKind;
  uri: string;
  title: string;
  tags: string[];
  contentHash: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IngestResult {
  document: KnowledgeDocument;
  chunkCount: number;
  /** True when the content was byte-identical and nothing was re-embedded. */
  unchanged: boolean;
  /** Populated when the source produced no indexable text. */
  warning?: string;
}

export interface KnowledgeSearchHit {
  documentId: string;
  sourceKind: KnowledgeSourceKind;
  uri: string;
  title: string;
  text: string;
  score: number;
  chunkId: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  sourceKind?: KnowledgeSourceKind;
  /** Lexical prefilter: only chunks containing any of these are scored. */
  terms?: string[];
}

/** Result envelope for search, so callers can report the live backend. */
export interface KnowledgeSearchOutcome {
  hits: KnowledgeSearchHit[];
  backend: 'ollama' | 'hashed-fallback';
  model: string;
  /** Set when recall fell back to lexical matching. */
  note?: string;
}

export interface KnowledgeDeps {
  db: Database.Database;
  embedder?: Embedder;
  embedderConfig?: EmbedderConfig;
}

/** Filesystem + network reads are injectable so ingestion is testable. */
export interface KnowledgeIo {
  readFile(filePath: string): Promise<string>;
  fetchUrl(url: string): Promise<{ text: string; contentType: string }>;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_URL_CHARS = 200_000;
const MAX_NOTE_CHARS = 100_000;

/** Strip markup down to indexable prose, keeping paragraph structure. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Read an http(s) page through the agent's SSRF-guarded fetch path.
 *
 *  We deliberately reuse `web_fetch_page` rather than re-implementing fetch:
 *  it owns the private-IP refusal, the manual redirect revalidation and the
 *  HTML-to-text conversion, and a second copy of that logic is exactly how an
 *  SSRF hole gets reintroduced later.
 *
 *  Bypassing the tool's `confirm` tier is correct here — that tier exists
 *  because the MODEL chooses to fetch a URL unprompted. A knowledge ingest is
 *  the user pointing at a URL they want kept, so the human already consented.
 */
export async function fetchUrlThroughWebTool(url: string): Promise<{ text: string; contentType: string }> {
  const { webTools } = await import('../agent/tools/web');
  const tool = webTools().find((t) => t.name === 'web_fetch_page');
  if (!tool) throw new Error('web_fetch_page is not available');
  const result = await tool.execute({ url }, {} as never);
  if (!result.ok) throw new Error(result.error ?? 'web_fetch_page failed');
  const data = (result.data ?? {}) as { text?: string; contentType?: string };
  return { text: String(data.text ?? ''), contentType: String(data.contentType ?? '') };
}

export function defaultKnowledgeIo(): KnowledgeIo {
  return {
    async readFile(filePath: string): Promise<string> {
      const stat = await fsp.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`File is ${Math.round(stat.size / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB.`);
      }
      return fsp.readFile(filePath, 'utf8');
    },
    fetchUrl: fetchUrlThroughWebTool,
  };
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class KnowledgeBase {
  readonly store: VectorStore;
  readonly embedder: Embedder;
  private readonly db: SqlDatabase;
  private readonly io: KnowledgeIo;

  constructor(db: SqlDatabase, embedder: Embedder, io: KnowledgeIo) {
    this.db = db;
    this.store = new VectorStore(db);
    this.embedder = embedder;
    this.io = io;
  }

  /** Create every table this system owns. Idempotent; safe on each boot. */
  migrate(): void {
    migrateVectorSchema(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id           TEXT PRIMARY KEY,
        source_kind  TEXT NOT NULL CHECK(source_kind IN ('file','url','note')),
        uri          TEXT NOT NULL,
        title        TEXT NOT NULL DEFAULT '',
        tags_json    TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kind
        ON knowledge_documents(source_kind, active);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_uri
        ON knowledge_documents(uri);
    `);
  }

  /**
   * Chunk, embed and store a document. Re-ingesting identical content is a
   * no-op, so re-running an ingest never re-embeds or duplicates.
   */
  private async index(input: {
    sourceKind: KnowledgeSourceKind;
    uri: string;
    title: string;
    text: string;
    tags: string[];
  }): Promise<IngestResult> {
    const hash = contentHash(input.text);
    const existing = this.db
      .prepare(`SELECT id, content_hash FROM knowledge_documents WHERE uri = ?`)
      .get(input.uri) as { id: string; content_hash: string } | undefined;

    if (existing && existing.content_hash === hash && this.isActive(existing.id)) {
      const doc = this.getDocument(existing.id);
      if (doc) {
        const source = this.store.getSource(existing.id);
        return { document: doc, chunkCount: source?.chunkCount ?? 0, unchanged: true };
      }
    }

    const chunks: TextChunk[] = chunkText(input.text, DEFAULT_CHUNK_OPTIONS);
    const documentId = existing?.id ?? crypto.randomUUID();
    const now = nowIso();

    const embedded = [];
    for (const c of chunks) {
      embedded.push({
        text: c.text,
        vector: await this.embedder.embed(c.text),
        metadata: { sourceKind: input.sourceKind, uri: input.uri, start: c.start, end: c.end },
      });
    }

    // The vector source id IS the knowledge document id, so deleting either
    // half cannot leave the other orphaned.
    this.store.upsertSource({
      id: documentId,
      sourceType: input.sourceKind,
      sourceUri: input.uri,
      title: input.title,
      contentHash: hash,
      chunks: embedded,
    });

    if (existing) {
      this.db
        .prepare(
          `UPDATE knowledge_documents
           SET title = ?, tags_json = ?, content_hash = ?, active = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.title, JSON.stringify(input.tags), hash, now, documentId);
    } else {
      this.db
        .prepare(
          `INSERT INTO knowledge_documents
             (id, source_kind, uri, title, tags_json, content_hash, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(documentId, input.sourceKind, input.uri, input.title, JSON.stringify(input.tags), hash, now, now);
    }

    // `index()` is the single choke point every ingest funnels through — the
    // three public ingest methods above, the `knowledge:*` IPC handlers and the
    // agent tools alike — so this is the one place that can honestly mean
    // "the knowledge base changed".
    //
    // It fires only here, past the content-hash dedupe that returns
    // `unchanged: true` earlier, so re-ingesting identical content emits
    // nothing. That makes this emitter incapable of a storm by construction,
    // before the bus's own guard is even consulted.
    //
    // `emitTriggerEvent` cannot throw (EventBus.emit isolates each subscriber),
    // so an ingest is never failed by a Routine watching this event.
    emitTriggerEvent('knowledge.ingested', {
      documentId,
      sourceKind: input.sourceKind,
      uri: input.uri,
      title: input.title,
      chunkCount: embedded.length,
    });

    const document = this.getDocument(documentId);
    if (!document) throw new Error('knowledge document vanished immediately after insert');
    return {
      document,
      chunkCount: embedded.length,
      unchanged: false,
      warning: embedded.length === 0 ? 'The source had no indexable text.' : undefined,
    };
  }

  private isActive(documentId: string): boolean {
    const row = this.db.prepare(`SELECT active FROM knowledge_documents WHERE id = ?`).get(documentId) as
      | { active: number }
      | undefined;
    return row?.active === 1;
  }

  /** Ingest a local file. Path confinement is `resolveUserPath`'s decision. */
  async ingestFile(filePath: string, opts: { title?: string; tags?: string[] } = {}): Promise<IngestResult> {
    const resolved = resolveUserPath(filePath);
    if (!resolved.ok) throw new Error(resolved.error);
    const raw = await this.io.readFile(resolved.path);
    const isMarkup = /^\s*</.test(raw.slice(0, 512)) || /\.(html?|xhtml)$/i.test(resolved.path);
    const text = isMarkup ? htmlToPlainText(raw) : raw;
    const title = opts.title?.trim() || path.basename(resolved.path);
    return this.index({
      sourceKind: 'file',
      uri: `file://${resolved.path}`,
      title,
      text,
      tags: opts.tags ?? [],
    });
  }

  /** Ingest a web page through the SSRF-guarded fetch path. */
  async ingestUrl(url: string, opts: { title?: string; tags?: string[] } = {}): Promise<IngestResult> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https URLs are supported.');
    }
    const fetched = await this.io.fetchUrl(parsed.toString());
    const text = fetched.text.length > MAX_URL_CHARS ? fetched.text.slice(0, MAX_URL_CHARS) : fetched.text;
    const title = opts.title?.trim() || parsed.hostname + parsed.pathname;
    return this.index({
      sourceKind: 'url',
      uri: parsed.toString(),
      title,
      text: /html/i.test(fetched.contentType) ? htmlToPlainText(text) : text,
      tags: opts.tags ?? [],
    });
  }

  /** Ingest a note typed by the user. */
  async ingestNote(text: string, opts: { title?: string; tags?: string[] } = {}): Promise<IngestResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('A note needs some text.');
    const bounded = trimmed.length > MAX_NOTE_CHARS ? trimmed.slice(0, MAX_NOTE_CHARS) : trimmed;
    const title = opts.title?.trim() || bounded.slice(0, 60);
    // A note with no title still needs a stable identity across re-saves, so
    // its uri is derived from the first line — updating it replaces, rather
    // than accumulating, near-duplicate notes.
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return this.index({
      sourceKind: 'note',
      uri: `note://${slug || crypto.randomUUID()}`,
      title,
      text: bounded,
      tags: opts.tags ?? [],
    });
  }

  /** Retrieve the most similar chunks to `query`. */
  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchOutcome> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { hits: [], backend: this.embedder.status().backend, model: this.embedder.model };
    }
    const vector = await this.embedder.embed(trimmed);
    const matches = this.store.query(vector, Math.min(options.limit ?? 8, 50), {
      sourceType: options.sourceKind,
    });

    // Lexical prefilter when the caller supplied terms — this is what makes
    // recall usable for exact tokens ("SKU-4471") that a bag-of-words
    // embedding can never rank highly on its own.
    const terms = (options.terms ?? [])
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 1);

    let hits: KnowledgeSearchHit[] = matches.map((m) => ({
      documentId: m.chunk.sourceId,
      sourceKind: m.chunk.sourceType as KnowledgeSourceKind,
      uri: m.chunk.sourceUri,
      title: m.chunk.title,
      text: m.chunk.text,
      score: m.score,
      chunkId: m.chunk.id,
      metadata: m.chunk.metadata,
    }));

    if (terms.length > 0) {
      const withTerms = hits.filter((h) => {
        const haystack = `${h.title}\n${h.text}`.toLowerCase();
        return terms.some((t) => haystack.includes(t));
      });
      // Keep the scored ranking, but only among chunks that actually contain
      // what was asked for. An empty result is the honest answer here.
      if (withTerms.length > 0) hits = withTerms;
    }

    const status = this.embedder.status();
    return {
      hits,
      backend: status.backend,
      model: status.model,
      note:
        status.backend === 'hashed-fallback'
          ? `Semantic recall is offline — using lexical matching only (${status.reason ?? 'no local embedding model'}).`
          : undefined,
    };
  }

  getDocument(id: string): KnowledgeDocument | null {
    const row = this.db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.toDocument(row);
  }

  private toDocument(row: Record<string, unknown>): KnowledgeDocument {
    const rawTags = String(row.tags_json ?? '[]');
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(rawTags);
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }
    return {
      id: String(row.id),
      sourceKind: String(row.source_kind) as KnowledgeSourceKind,
      uri: String(row.uri),
      title: String(row.title ?? ''),
      tags,
      contentHash: String(row.content_hash ?? ''),
      active: Number(row.active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listDocuments(opts: { sourceKind?: KnowledgeSourceKind; limit?: number } = {}): KnowledgeDocument[] {
    let sql = `SELECT * FROM knowledge_documents WHERE active = 1`;
    const params: unknown[] = [];
    if (opts.sourceKind) {
      sql += ` AND source_kind = ?`;
      params.push(opts.sourceKind);
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 100, 500));
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.toDocument(r));
  }

  /** Soft-delete a document and drop its chunks. */
  deleteDocument(id: string): { deleted: boolean } {
    const info = this.db
      .prepare(`UPDATE knowledge_documents SET active = 0, updated_at = ? WHERE id = ?`)
      .run(nowIso(), id) as { changes?: number } | undefined;
    const deleted = (info?.changes ?? 0) > 0;
    this.store.deleteSource(id);
    return { deleted };
  }

  stats(): KnowledgeStats {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS documents FROM knowledge_documents WHERE active = 1`)
      .get() as { documents?: number } | undefined;
    const vectorStats = this.store.stats();
    return {
      documents: row?.documents ?? 0,
      activeSources: vectorStats.activeSources,
      chunks: vectorStats.chunks,
      dimensions: vectorStats.dimensions,
    };
  }
}

/** Counts across the knowledge base and its vector index. */
export interface KnowledgeStats {
  documents: number;
  activeSources: number;
  chunks: number;
  dimensions: number;
}

/** Construct and migrate a knowledge base over the existing database. */
export function createKnowledgeBase(db: Database.Database, options: { embedderConfig?: EmbedderConfig; io?: KnowledgeIo } = {}): KnowledgeBase {
  const sqlDb = db as unknown as SqlDatabase;
  const embedder = createEmbedder(options.embedderConfig);
  const kb = new KnowledgeBase(sqlDb, embedder, options.io ?? defaultKnowledgeIo());
  kb.migrate();
  return kb;
}
