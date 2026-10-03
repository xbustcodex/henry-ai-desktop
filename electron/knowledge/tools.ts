/**
 * Knowledge base + deep memory recall — agent tooling.
 *
 * These tools operate on the ONE authoritative store. There is no parallel
 * memory or document store behind them: `knowledge:*` and the recall service
 * both read and write the tables `electron/ipc/memory.ts` and
 * `electron/knowledge/core.ts` own, in the same database.
 *
 * Safety tiers follow the existing convention (see tools/safetyPolicy.ts):
 * reads are `silent`, anything that pulls a URL over the network is `confirm`
 * (it can reach a remote host on the user's behalf), and local-file ingestion
 * is `confirm` because it reads from disk.
 */

import type { ToolDefinition, ToolResult } from '../agent/types';
import { KnowledgeBase, defaultKnowledgeIo } from './core';
import { createMemoryRecallService, type MemoryRecallService } from './memoryRecallService';
import { createEmbedder, type Embedder } from '../vector/embeddings';
import type Database from 'better-sqlite3';

/**
 * One knowledge base per database handle. Building it runs DDL, so doing
 * that on every tool call would mean a migration attempt per call.
 */
let instances = new WeakMap<Database.Database, { kb: KnowledgeBase; recall: MemoryRecallService }>();

/**
 * How the knowledge base builds its embedder.
 *
 * In production this is `createEmbedder`, which reaches the LOCAL Ollama
 * endpoint and falls back to lexical matching when it is unreachable. It is a
 * seam so tests can drive the tools without a network round trip — the same
 * shape as `__setPolicyForTest` in securityPolicy.ts.
 */
let embedderFactory: () => Embedder = () => createEmbedder();

/** Replace the embedder factory. Returns a restore function. */
export function __setEmbedderFactoryForTest(factory: () => Embedder): () => void {
  const previous = embedderFactory;
  embedderFactory = factory;
  return () => {
    embedderFactory = previous;
    // A WeakMap has no `clear()`, and these handles are per-database objects
    // that outlive the test — swapping the map is the correct reset.
    instances = new WeakMap();
  };
}

function services(db: Database.Database): { kb: KnowledgeBase; recall: MemoryRecallService } {
  const existing = instances.get(db);
  if (existing) return existing;
  const embedder = embedderFactory();
  const kb = new KnowledgeBase(db as never, embedder, defaultKnowledgeIo());
  kb.migrate();
  const created = { kb, recall: createMemoryRecallService(db, kb.store, embedder) };
  instances.set(db, created);
  return created;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function knowledgeTools(): ToolDefinition[] {
  return [
    // ── knowledge_search ─────────────────────────────────────────────────
    {
      name: 'knowledge_search',
      description:
        'Search Henry\'s knowledge base — everything ingested from files, URLs ' +
        'and notes. Use this for reference material, documentation and ' +
        'anything the user has explicitly asked Henry to keep. Unlike ' +
        'memory_search (which covers personal memory), this searches ' +
        'documents. Returns the most relevant passages.',
      category: 'memory',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language.' },
          limit: { type: 'number', description: 'Max passages to return (default 6).' },
          sourceKind: {
            type: 'string',
            enum: ['file', 'url', 'note'],
            description: 'Restrict to one kind of source.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const query = str(params.query);
          if (!query) return fail('query is required');
          const limit = Math.min(Math.max(Number(params.limit) || 6, 1), 25);
          const outcome = await services(db).kb.search(query, {
            limit,
            sourceKind:
              params.sourceKind === 'file' || params.sourceKind === 'url' || params.sourceKind === 'note'
                ? params.sourceKind
                : undefined,
          });
          if (outcome.hits.length === 0) {
            return ok({ query, count: 0, hits: [], note: 'Nothing in the knowledge base matched.' });
          }
          return ok({
            query,
            count: outcome.hits.length,
            backend: outcome.backend,
            note: outcome.note,
            hits: outcome.hits.map((h) => ({
              title: h.title,
              uri: h.uri,
              score: Number(h.score.toFixed(4)),
              text: h.text,
            })),
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── knowledge_add_note ───────────────────────────────────────────────
    {
      name: 'knowledge_add_note',
      description:
        'Save a note into the knowledge base so it can be retrieved later by ' +
        'search. Use when the user says "remember this for next time" about ' +
        'reference material, a decision rationale, or a spec.',
      category: 'memory',
      safetyLevel: 'notify',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note body.' },
          title: { type: 'string', description: 'Short title. Defaults to the first line.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const text = str(params.text);
          if (!text) return fail('text is required');
          const result = await services(db).kb.ingestNote(text, {
            title: str(params.title) || undefined,
            tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
          });
          return ok({
            documentId: result.document.id,
            title: result.document.title,
            chunks: result.chunkCount,
            unchanged: result.unchanged,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── knowledge_ingest_url ─────────────────────────────────────────────
    {
      name: 'knowledge_ingest_url',
      description:
        'Fetch a web page and store it in the knowledge base so it can be ' +
        'searched later. Fetches through the same SSRF-guarded path as page ' +
        'reading, so private/internal addresses are refused.',
      category: 'memory',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => `Fetch ${String(p.url)} and store it in the knowledge base`,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL.' },
          title: { type: 'string', description: 'Optional title.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const url = str(params.url);
          if (!url) return fail('url is required');
          const result = await services(db).kb.ingestUrl(url, { title: str(params.title) || undefined });
          return ok({
            documentId: result.document.id,
            title: result.document.title,
            uri: result.document.uri,
            chunks: result.chunkCount,
          });
        } catch (e) {
          // An SSRF refusal or a 404 will not fix itself on a retry.
          return fail(e instanceof Error ? e.message : String(e), false);
        }
      },
    },

    // ── knowledge_ingest_file ────────────────────────────────────────────
    {
      name: 'knowledge_ingest_file',
      description:
        'Index a file from the user\'s home directory into the knowledge base ' +
        'so its contents become searchable. Paths outside the home directory ' +
        'are refused.',
      category: 'memory',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => `Read ${String(p.path)} and store it in the knowledge base`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, absolute or home-relative.' },
          title: { type: 'string', description: 'Optional title. Defaults to the filename.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const path = str(params.path);
          if (!path) return fail('path is required');
          const result = await services(db).kb.ingestFile(path, { title: str(params.title) || undefined });
          return ok({
            documentId: result.document.id,
            title: result.document.title,
            uri: result.document.uri,
            chunks: result.chunkCount,
            unchanged: result.unchanged,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── memory_recall ────────────────────────────────────────────────────
    {
      name: 'memory_recall',
      description:
        'Deep recall across every layer of Henry\'s memory — personal facts, ' +
        'narrative arcs, project memory and saved facts — ranked by semantic ' +
        'similarity to the question rather than keyword overlap. Prefer this ' +
        'over memory_search when the user asks about something in their own ' +
        'words ("what did I decide about the budget?").',
      category: 'memory',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall, in natural language.' },
          k: { type: 'number', description: 'Max memories to return (default 8).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const query = str(params.query);
          if (!query) return fail('query is required');
          const k = Math.min(Math.max(Number(params.k) || 8, 1), 30);
          const { kb, recall } = services(db);
          // An empty index means the memory layers were never mirrored into the
          // vector store. Build it on demand rather than returning nothing and
          // making the tool look broken.
          if (kb.store.stats().chunks === 0) {
            await recall.reindexAllMemory();
          }
          const result = await recall.recall(query, k);
          return ok({
            query,
            count: result.memories.length,
            backend: result.backend,
            note: result.note,
            memories: result.memories.map((m) => ({
              table: m.table,
              label: m.label,
              detail: m.detail,
              score: Number(m.score.toFixed(4)),
            })),
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
