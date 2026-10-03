/**
 * KnowledgePanel — everything Henry's knowledge base holds, and the only way
 * to put anything into it.
 *
 * The knowledge base was fully built: a chunked, embedded vector store with
 * five agent tools that write to it, a self-healing memory index, and ten
 * `knowledge:*` IPC handlers. None of it was reachable from the UI, so a user
 * had a working store they could not see, search, or add to — the knowledge
 * tools filled it only when the agent happened to be asked.
 *
 * Four jobs, in the order a person does them:
 *   - see what is in there and how healthy the index is
 *   - add a note, a file, or a web page
 *   - search it, and be told which retrieval backend answered
 *   - remove something that should not be there
 *
 * Every call goes through `window.henryAPI`. Nothing here touches a Node
 * built-in or a second store — the main process owns the data and this is a
 * view onto it.
 */

import { useCallback, useEffect, useState } from 'react';
import { confirmDialog, toast } from '../ui/Toast';
import {
  BookOpen,
  FileUp,
  Link2,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Loader2,
  RefreshCw,
} from 'lucide-react';

/** One indexed source, as `knowledge:list` returns it. */
interface KnowledgeDocument {
  id: string;
  sourceKind: 'file' | 'url' | 'note';
  uri: string;
  title: string;
  tags: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `knowledge:stats`, plus the live embedder status the handler appends. */
interface KnowledgeStats {
  documents: number;
  activeSources: number;
  chunks: number;
  dimensions: number;
  embedder: {
    backend: 'ollama' | 'hashed-fallback';
    model: string;
    dimensions: number;
    reason?: string;
  };
}

interface KnowledgeSearchHit {
  documentId: string;
  sourceKind: 'file' | 'url' | 'note';
  uri: string;
  title: string;
  text: string;
  score: number;
  chunkId: string;
}

interface KnowledgeSearchOutcome {
  hits: KnowledgeSearchHit[];
  backend: 'ollama' | 'hashed-fallback';
  model: string;
  note?: string;
}

/** `knowledge:ingest*` returns this. */
interface IngestResult {
  document: KnowledgeDocument;
  chunkCount: number;
  unchanged: boolean;
  warning?: string;
}

/**
 * Unchecked cast, one reason: `knowledgeSearch` is declared in preload but not
 * yet in `global.d.ts`, and this file is not permitted to edit that. It really
 * is optional — when the bridge is absent the panel says search is unavailable
 * rather than showing an empty result set that reads as "nothing matched".
 */
const api = window.henryAPI as unknown as {
  knowledgeList?: (opts?: { sourceKind?: string; limit?: number }) => Promise<unknown>;
  knowledgeStats?: () => Promise<unknown>;
  knowledgeIngestNote?: (text: string, title?: string) => Promise<unknown>;
  knowledgeIngestFile?: (path: string, title?: string) => Promise<unknown>;
  knowledgeIngestUrl?: (url: string, title?: string) => Promise<unknown>;
  knowledgeDelete?: (id: string) => Promise<unknown>;
  knowledgeReindexMemory?: () => Promise<unknown>;
  knowledgeSearch?: (
    query: string,
    opts?: { limit?: number; sourceKind?: string; terms?: string[] },
  ) => Promise<unknown>;
};

/**
 * Every `knowledge:*` handler returns an envelope rather than rejecting, so a
 * failed ingest has to be read out of the result — not caught.
 */
function unwrap<T>(res: unknown): { value: T | null; error: string | null } {
  const env = res as { ok?: boolean; result?: T; error?: string } | null | undefined;
  if (!env) return { value: null, error: 'No response from Henry.' };
  if (env.ok === false) return { value: null, error: env.error ?? 'That did not work.' };
  return { value: (env.result ?? null) as T | null, error: null };
}

const KIND_LABEL: Record<KnowledgeDocument['sourceKind'], string> = {
  note: 'Note',
  file: 'File',
  url: 'Web page',
};

type IngestKind = KnowledgeDocument['sourceKind'];

const EMPTY_INGEST = { kind: 'note' as IngestKind, title: '', value: '' };

function formatDate(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const inputCls =
  'w-full rounded-lg border border-henry-border/40 bg-henry-bg/40 px-2.5 py-1.5 text-xs text-henry-text placeholder:text-henry-text-muted focus:outline-none focus:border-henry-accent/50';

export default function KnowledgePanel() {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filter, setFilter] = useState<IngestKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [showIngest, setShowIngest] = useState(false);
  const [ingest, setIngest] = useState(EMPTY_INGEST);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [list, stat] = await Promise.all([
      typeof api.knowledgeList === 'function'
        ? api.knowledgeList({ limit: 200 })
        : Promise.resolve(null),
      typeof api.knowledgeStats === 'function' ? api.knowledgeStats() : Promise.resolve(null),
    ]);
    const l = unwrap<KnowledgeDocument[]>(list);
    const s = unwrap<KnowledgeStats>(stat);
    if (l.value) setDocs(l.value);
    if (s.value) setStats(s.value);
    // Either half failing is worth saying; neither is fatal.
    setLoadError(l.error ?? s.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearchNote(null);
      return;
    }
    if (typeof api.knowledgeSearch !== 'function') {
      setHits(null);
      setSearchNote('Search is not available in this build.');
      return;
    }
    setSearching(true);
    try {
      const res = unwrap<KnowledgeSearchOutcome>(
        await api.knowledgeSearch(q, {
          limit: 10,
          sourceKind: filter === 'all' ? undefined : filter,
        }),
      );
      if (res.error) {
        setHits(null);
        setSearchNote(res.error);
        return;
      }
      const outcome = res.value;
      setHits(outcome?.hits ?? []);
      // The embedder backend decides whether these are semantic matches or
      // lexical ones. Reporting "no matches" without saying which would lie.
      setSearchNote(
        outcome?.backend === 'hashed-fallback'
          ? (outcome.note ?? 'Semantic search is offline — these are lexical matches only.')
          : null,
      );
    } finally {
      setSearching(false);
    }
  }

  async function submitIngest(e: React.FormEvent) {
    e.preventDefault();
    const value = ingest.value.trim();
    if (!value) {
      setIngestError('Nothing to add yet.');
      return;
    }
    setBusy(true);
    setIngestError(null);
    try {
      const res =
        ingest.kind === 'note'
          ? await api.knowledgeIngestNote?.(value, ingest.title.trim() || undefined)
          : ingest.kind === 'url'
            ? await api.knowledgeIngestUrl?.(value, ingest.title.trim() || undefined)
            : await api.knowledgeIngestFile?.(value, ingest.title.trim() || undefined);
      const out = unwrap<IngestResult>(res);
      if (out.error) {
        setIngestError(out.error);
        return;
      }
      const result = out.value;
      if (result?.unchanged) {
        toast.info('Already in there — nothing changed.');
      } else if (result?.warning) {
        toast.info(result.warning);
      } else {
        toast.success(
          `Added "${result?.document.title ?? 'source'}" — ${result?.chunkCount ?? 0} chunks indexed.`,
        );
      }
      setIngest(EMPTY_INGEST);
      setShowIngest(false);
      await reload();
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(doc: KnowledgeDocument) {
    // Deleting drops the document's chunks from the vector index and there is
    // no undo, so it is confirmed the way the Goals panel confirms a goal.
    const ok = await confirmDialog(
      `"${doc.title || doc.uri}" and its chunks will be removed from the knowledge base. This cannot be undone.`,
      { confirmLabel: 'Delete', cancelLabel: 'Keep', destructive: true },
    );
    if (!ok) return;
    const out = unwrap<{ deleted: boolean }>(await api.knowledgeDelete?.(doc.id));
    if (out.error) {
      toast.error(out.error);
      return;
    }
    if (out.value && out.value.deleted === false) {
      toast.error('That source was already gone.');
      return;
    }
    toast.success('Removed from the knowledge base.');
    await reload();
  }

  async function reindexMemory() {
    setBusy(true);
    try {
      const out = unwrap<{ documents: number; chunks: number }>(
        await api.knowledgeReindexMemory?.(),
      );
      if (out.error) {
        toast.error(out.error);
        return;
      }
      toast.success(`Re-indexed memory — ${out.value?.chunks ?? 0} chunks.`);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const visible = filter === 'all' ? docs : docs.filter((d) => d.sourceKind === filter);
  const backendOffline = stats?.embedder.backend === 'hashed-fallback';

  return (
    <div className="h-full overflow-y-auto px-5 py-5 max-w-3xl mx-auto w-full space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-henry-accent" />
            <h1 className="text-lg font-bold text-henry-text">Knowledge base</h1>
          </div>
          <p className="text-xs text-henry-text-muted mt-1">
            Everything Henry can look things up in. Add notes, files, and web pages here, or just ask
            him — he writes to the same place.
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => void reindexMemory()}
            disabled={busy}
            title="Rebuild the memory index from what Henry already remembers"
            aria-label="Re-index memory"
            className="p-1.5 rounded-lg border border-henry-border/40 text-henry-text-muted hover:text-henry-text disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => {
              setShowIngest((v) => !v);
              setIngestError(null);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-henry-accent/15 text-henry-accent border border-henry-accent/20 hover:bg-henry-accent/25 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>

      {/* Index health. `backend` is load-bearing: without it this box would
          imply semantic search is running when it is matching tokens. */}
      {stats && (
        <div
          className={`rounded-xl border p-3 text-[11px] ${
            backendOffline
              ? 'border-amber-500/30 bg-amber-500/5 text-amber-200'
              : 'border-henry-border/25 bg-henry-surface/30 text-henry-text-muted'
          }`}
        >
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <strong className="text-henry-text">{stats.documents}</strong> sources
            </span>
            <span>
              <strong className="text-henry-text">{stats.chunks}</strong> chunks
            </span>
            <span>
              <strong className="text-henry-text">{stats.dimensions}</strong> dimensions
            </span>
            <span>
              Index: <strong className="text-henry-text">{stats.embedder.backend}</strong>
              {stats.embedder.model ? ` (${stats.embedder.model})` : ''}
            </span>
          </div>
          {backendOffline && (
            <p className="mt-1.5 leading-relaxed">
              Search is matching words, not meaning —{' '}
              {stats.embedder.reason ?? 'no local embedding model is running'}. Start Ollama and pull
              an embedding model to turn this on.
            </p>
          )}
        </div>
      )}

      {/* Search */}
      <form onSubmit={(e) => void runSearch(e)} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-henry-text-dim" />
          <input
            aria-label="Search the knowledge base"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything Henry knows"
            className={`${inputCls} pl-8`}
          />
        </div>
        <select
          aria-label="Source type"
          value={filter}
          onChange={(e) => setFilter(e.target.value as IngestKind | 'all')}
          className="rounded-lg border border-henry-border/40 bg-henry-bg/40 px-2 py-1.5 text-xs focus:outline-none focus:border-henry-accent/50"
        >
          <option value="all">All types</option>
          <option value="note">Notes</option>
          <option value="file">Files</option>
          <option value="url">Web pages</option>
        </select>
        <button
          type="submit"
          disabled={searching}
          className="px-3 py-1.5 text-xs rounded-lg bg-henry-accent text-white font-medium hover:bg-henry-accent/90 disabled:opacity-40 transition-colors inline-flex items-center gap-1.5"
        >
          {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          Search
        </button>
      </form>

      {searchNote && <p className="text-[11px] text-amber-200/90 leading-relaxed">{searchNote}</p>}

      {hits && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-wide text-henry-text-muted">
            {hits.length} result{hits.length === 1 ? '' : 's'}
          </h2>
          {hits.length === 0 && (
            <p className="text-xs text-henry-text-muted">Nothing in the knowledge base matched that.</p>
          )}
          {hits.map((h) => (
            <article
              key={h.chunkId}
              className="rounded-xl border border-henry-border/25 bg-henry-surface/30 p-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-henry-text truncate">
                  {h.title || h.uri}
                </span>
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-henry-bg/50 border border-henry-border/30 text-henry-text-muted">
                  {KIND_LABEL[h.sourceKind]}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-henry-text-dim font-mono">
                  {h.score.toFixed(3)}
                </span>
              </div>
              <p className="text-[11px] text-henry-text-muted leading-relaxed whitespace-pre-wrap break-words line-clamp-4">
                {h.text}
              </p>
            </article>
          ))}
        </section>
      )}

      {/* Add */}
      {showIngest && (
        <form
          onSubmit={(e) => void submitIngest(e)}
          className="rounded-xl border border-henry-border/40 bg-henry-surface/30 p-4 space-y-3"
        >
          <div className="flex gap-1.5">
            {(
              [
                { kind: 'note' as IngestKind, Icon: StickyNote },
                { kind: 'file' as IngestKind, Icon: FileUp },
                { kind: 'url' as IngestKind, Icon: Link2 },
              ] as const
            ).map(({ kind, Icon }) => (
              <button
                key={kind}
                type="button"
                aria-pressed={ingest.kind === kind}
                onClick={() => setIngest((s) => ({ ...s, kind, value: '' }))}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                  ingest.kind === kind
                    ? 'bg-henry-accent/15 text-henry-accent border-henry-accent/25'
                    : 'text-henry-text-muted border-henry-border/30 hover:border-henry-border/50'
                }`}
              >
                <Icon className="w-3 h-3" />
                {KIND_LABEL[kind]}
              </button>
            ))}
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Title <span className="text-henry-text-dim normal-case">(optional)</span>
            </label>
            <input
              aria-label="Title"
              value={ingest.title}
              onChange={(e) => setIngest((s) => ({ ...s, title: e.target.value }))}
              className={inputCls}
            />
          </div>

          {ingest.kind === 'note' ? (
            <div>
              <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
                Note
              </label>
              <textarea
                aria-label="Note text"
                rows={5}
                value={ingest.value}
                onChange={(e) => setIngest((s) => ({ ...s, value: e.target.value }))}
                placeholder="Anything worth remembering — a decision, a detail, a piece of context."
                className={`${inputCls} resize-y leading-relaxed`}
              />
            </div>
          ) : (
            <div>
              <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
                {ingest.kind === 'url' ? 'Web page URL' : 'Full path on this machine'}
              </label>
              <input
                aria-label={ingest.kind === 'url' ? 'Web page URL' : 'File path'}
                value={ingest.value}
                onChange={(e) => setIngest((s) => ({ ...s, value: e.target.value }))}
                placeholder={
                  ingest.kind === 'url' ? 'https://example.com/page' : '/home/you/Documents/brief.md'
                }
                className={inputCls}
              />
              <p className="text-[10px] text-henry-text-dim mt-1">
                {ingest.kind === 'url'
                  ? 'The page is fetched through the same guarded path Henry uses, and only the readable text is kept.'
                  : 'Henry can only read files you have access to, and text and markdown are what index usefully.'}
              </p>
            </div>
          )}

          {ingestError && <p className="text-[11px] text-henry-error">{ingestError}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy || !ingest.value.trim()}
              className="px-4 py-1.5 text-xs rounded-lg bg-henry-accent text-white font-medium hover:bg-henry-accent/90 disabled:opacity-40 transition-colors"
            >
              {busy ? 'Indexing…' : 'Add to knowledge base'}
            </button>
          </div>
        </form>
      )}

      {/* Sources */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-henry-text-muted py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading knowledge base…
        </div>
      ) : loadError ? (
        <p className="text-xs text-henry-error py-6 text-center">{loadError}</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-henry-text-muted py-8 text-center">
          Nothing here yet. Add a note, or just ask Henry a question that needs looking something up.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((d) => (
            <li
              key={d.id}
              className="rounded-xl border border-henry-border/25 bg-henry-surface/30 px-4 py-3 flex items-start gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-henry-text truncate">
                    {d.title || d.uri}
                  </span>
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-henry-bg/50 border border-henry-border/30 text-henry-text-muted">
                    {KIND_LABEL[d.sourceKind]}
                  </span>
                </div>
                <p className="text-[10px] text-henry-text-dim mt-0.5 truncate font-mono" title={d.uri}>
                  {d.uri}
                </p>
                <p className="text-[10px] text-henry-text-dim mt-0.5">
                  Added {formatDate(d.createdAt)}
                  {d.updatedAt !== d.createdAt ? ` · updated ${formatDate(d.updatedAt)}` : ''}
                </p>
              </div>
              <button
                onClick={() => void remove(d)}
                title="Remove from knowledge base"
                aria-label={`Remove ${d.title || d.uri}`}
                className="p-1 rounded-lg text-henry-text-dim hover:text-henry-error transition-colors shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}