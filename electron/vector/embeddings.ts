/**
 * Text embeddings, with no paid API key required.
 *
 * Primary path is a LOCAL Ollama embedding model (`/api/embed`, falling back
 * to the older `/api/embeddings`). The model is configurable through the
 * existing `settings` key-value table, so switching between e.g. nomic-embed,
 * mxbai-embed-large and all-minilm needs no rebuild.
 *
 * When Ollama is not running, or has no embedding model pulled, the embedder
 * does NOT throw and does NOT silently return garbage: it degrades to a
 * deterministic hashed bag-of-words embedding (below). That fallback is
 * honest about what it is — a lexical fingerprint, so "vector" recall still
 * works and retrieval never goes dark, but it captures shared tokens rather
 * than meaning. `backend` reports which one is live so callers can tell the
 * user instead of pretending semantic search is running.
 */

/** Where embeddings came from, so the UI and callers can be truthful. */
export type EmbeddingBackend = 'ollama' | 'hashed-fallback';

export interface EmbedderStatus {
  backend: EmbeddingBackend;
  model: string;
  dimensions: number;
  /** Why the fallback is in use, when it is. */
  reason?: string;
}

/**
 * Function words carry no retrieval signal but appear in almost every query
 * and almost every chunk, so without this the cosine score is dominated by
 * how long two texts are rather than what they are about — "the vendor
 * responds in four hours" scored nearly identically to an unrelated passage
 * because both were mostly "the" and "to".
 */
const STOPWORDS: Record<string, true> = {
  a: true, an: true, and: true, are: true, as: true, at: true, be: true, been: true,
  being: true, but: true, by: true, can: true, could: true, did: true, do: true,
  does: true, doing: true, for: true, from: true, had: true, has: true, have: true,
  having: true, he: true, her: true, here: true, him: true, his: true, how: true,
  i: true, if: true, in: true, into: true, is: true, it: true, its: true, just: true,
  me: true, more: true, most: true, my: true, no: true, nor: true, not: true,
  of: true, off: true, on: true, once: true, only: true, or: true, other: true,
  our: true, out: true, over: true, own: true, same: true, she: true, should: true,
  so: true, some: true, such: true, than: true, that: true, the: true, their: true,
  them: true, then: true, there: true, these: true, they: true, this: true,
  those: true, through: true, to: true, too: true, under: true, until: true,
  up: true, very: true, was: true, we: true, were: true, what: true, when: true,
  where: true, which: true, while: true, who: true, why: true, will: true,
  with: true, would: true, you: true, your: true, am: true, any: true, all: true,
  both: true, each: true, few: true, s: true, t: true, don: true, now: true,
};

export interface Embedder {
  readonly backend: EmbeddingBackend;
  readonly model: string;
  readonly dimensions: number;
  /** Embed one text. Never throws — returns null only for unusable input. */
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  status(): EmbedderStatus;
}

export interface EmbedderConfig {
  /** Base URL of the Ollama server. */
  baseUrl?: string;
  /** Embedding model name, e.g. `nomic-embed-text`. */
  model?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort a request that has not answered within this many milliseconds. */
  timeoutMs?: number;
  /**
   * How long to stay on the fallback after a TRANSIENT failure before probing
   * again. Zero means "retry on the very next call", which is what tests want;
   * production uses the default so a struggling Ollama is not hammered.
   */
  cooldownMs?: number;
  /** Force the offline fallback with this reason, skipping any probe. */
  forceFallbackReason?: string;
}

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Dimensionality of the offline fallback. Fixed, so the store's dim check works. */
export const FALLBACK_DIMENSIONS = 256;

const FNV_OFFSET = 2166136261;

/** 32-bit FNV-1a. Stable across runs and platforms — required for a fallback
 *  whose vectors are persisted to disk and compared later. */
function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/**
 * Fold the most common English inflections so a query word and the document
 * word it refers to land in the same bucket: "deleting"/"deleted"/"deletion"
 * and "archives"/"archived". Deliberately shallow stemming — enough to stop a
 * lexical embedder failing on morphology, not a real stemmer.
 */
function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ['ations', 'ation', 'ingly', 'ings', 'ing', 'edly', 'ies', 'ied', 'es', 'ed', 'ly', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const base = token.slice(0, token.length - suffix.length);
      // "ies"/"ied" fold to "y" so "deliveries" meets "delivery".
      if (suffix === 'ies' || suffix === 'ied') return `${base}y`;
      return base;
    }
  }
  return token;
}

/**
 * Deterministic hashed bag-of-words embedding.
 *
 * Each token is hashed to a bucket and accumulated with sublinear term
 * frequency; the result is L2-normalised so it is directly comparable with the
 * Ollama vectors through the same cosine path. Unigrams AND adjacent
 * bigrams, because a bigram catches a little of the phrase structure that a
 * pure unigram bag throws away.
 */
export function hashedEmbedding(text: string, dimensions = FALLBACK_DIMENSIONS): Float32Array {
  const out = new Float32Array(dimensions);
  const tokens = text
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter((t) => t.length > 0)
    .map(stem);
  if (tokens.length === 0) return out;

  const bump = (token: string, weight: number) => {
    // Two independent hashes spread a token across buckets, which cuts the
    // collision rate at this dimension versus a single bucket per token.
    const h1 = fnv1a(token) % dimensions;
    const h2 = fnv1a(`${token}#salt`) % dimensions;
    out[h1] += weight;
    if (h2 !== h1) out[h2] += weight * 0.5;
  };

  // A text made entirely of function words would embed to all zeros and match
  // nothing at all, so fall back to the unfiltered tokens in that case.
  const contentTokens = tokens.filter((t) => STOPWORDS[t] !== true);
  const used = contentTokens.length > 0 ? contentTokens : tokens;

  for (const token of used) bump(token, 1);
  for (let i = 0; i + 1 < used.length; i++) bump(`${used[i]}_${used[i + 1]}`, 0.75);
  let sumSquares = 0;
  for (let i = 0; i < dimensions; i++) sumSquares += out[i] * out[i];
  if (sumSquares === 0) return out;
  const inv = 1 / Math.sqrt(sumSquares);
  for (let i = 0; i < dimensions; i++) out[i] *= inv;
  return out;
}

/** Parse Ollama's several response shapes into a single Float32Array. */
export function parseOllamaEmbedding(payload: unknown): Float32Array | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  // `/api/embed` (batch) → { embeddings: number[][] }
  // `/api/embed` (single) → { embedding: number[] }
  // `/api/embeddings` (legacy) → { embedding: number[] }
  const candidate = record.embeddings ?? record.embedding;
  const raw = Array.isArray(candidate) && Array.isArray(candidate[0]) ? candidate[0] : candidate;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const n = Number(raw[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

class OllamaEmbedder implements Embedder {
  private state: EmbedderStatus;
  /**
   * Latched only by PERMANENT conditions (model missing, port closed). A
   * transient failure must never set this, or one hiccup permanently changes
   * the embedding space for the life of the process.
   */
  private ollamaUnavailable = false;
  /** After a transient failure, stay on the fallback until this timestamp. */
  private retryAfter = 0;

  constructor(
    private readonly baseUrl: string,
    model: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    forceFallbackReason?: string,
    private readonly cooldownMs = 30_000,
  ) {
    this.state = { backend: 'ollama', model, dimensions: 0 };
    if (forceFallbackReason) this.note(forceFallbackReason, true);
  }

  get backend(): EmbeddingBackend {
    return this.state.backend;
  }

  get model(): string {
    return this.state.model;
  }

  get dimensions(): number {
    return this.state.dimensions;
  }

  status(): EmbedderStatus {
    return { ...this.state };
  }

  /**
   * Record that this call produced a hashed vector.
   *
   * `permanent` is the important argument. Marking a transient failure sticky
   * is a corruption bug, not a caching optimisation: the flag gates every
   * later `embed()`, so one 500 or one timeout would pin the process to 256-dim
   * vectors FOREVER, `index()` would persist those beside genuine 768-dim
   * chunks, and the store's dimension guard would then skip the real vectors —
   * leaving recall comparing fallback vectors, which looks like a working
   * feature and is close to meaningless.
   *
   * So only conditions that cannot resolve without a human (the model is not
   * pulled; nothing is listening on the port) latch. Everything else sets a
   * short cooldown, after which `embed()` probes again.
   */
  private note(reason: string, permanent: boolean): void {
    if (permanent) {
      this.ollamaUnavailable = true;
    } else {
      this.retryAfter = Date.now() + this.cooldownMs;
    }
    this.state = {
      backend: 'hashed-fallback',
      model: this.model,
      dimensions: FALLBACK_DIMENSIONS,
      reason,
    };
  }

  /** True when a probe is worth attempting right now. */
  private shouldProbe(): boolean {
    if (this.ollamaUnavailable) return false;
    return Date.now() >= this.retryAfter;
  }

  private async request(path: string, body: unknown): Promise<Float32Array | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 404 is the model not being pulled — retrying cannot help until a
        // human pulls it. 4xx otherwise is a bad request worth retrying after
        // a fix; 5xx is the server having a moment.
        const permanent = res.status === 404;
        this.note(`Ollama returned HTTP ${res.status} for ${path}`, permanent);
        return null;
      }
      const embedding = parseOllamaEmbedding(await res.json());
      if (!embedding) this.note(`Ollama returned no embedding vector from ${path}`, false);
      else {
        // A success clears both the latch and the cooldown: the embedding
        // space is real again from this point on.
        this.ollamaUnavailable = false;
        this.retryAfter = 0;
        this.state = { backend: 'ollama', model: this.model, dimensions: embedding.length };
      }
      return embedding;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A refused connection means nothing is listening — permanent until the
      // user starts Ollama. A timeout or a DNS blip is transient.
      const permanent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(msg) || /ECONNREFUSED/.test((e as { cause?: { code?: string } })?.cause?.code ?? '');
      this.note(`Ollama unreachable at ${this.baseUrl} (${msg})`, permanent);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) out.push(await this.embed(text));
    return out;
  }

  async embed(text: string): Promise<Float32Array> {
    const trimmed = text.trim();
    if (!trimmed) {
      // Note the provenance: an empty input yields a hashed vector, so
      // `status()` must not go on reporting `ollama` to the caller.
      this.note('empty input cannot be embedded by a remote model', true);
      return hashedEmbedding('', FALLBACK_DIMENSIONS);
    }
    if (!this.shouldProbe()) return hashedEmbedding(trimmed, FALLBACK_DIMENSIONS);

    // Modern batch endpoint first; it is one round trip for many texts.
    const viaEmbed = await this.request('/api/embed', { model: this.model, input: trimmed });
    if (viaEmbed) return viaEmbed;
    // Legacy single-prompt endpoint, for older Ollama builds.
    const viaLegacy = await this.request('/api/embeddings', { model: this.model, prompt: trimmed });
    if (viaLegacy) return viaLegacy;
    return hashedEmbedding(trimmed, FALLBACK_DIMENSIONS);
  }
}

/** Build an embedder from configuration. Never throws, never blocks. */
export function createEmbedder(config: EmbedderConfig = {}): Embedder {
  const baseUrl = (config.baseUrl ?? DEFAULT_OLLAMA_URL).trim() || DEFAULT_OLLAMA_URL;
  const model = (config.model ?? DEFAULT_EMBED_MODEL).trim() || DEFAULT_EMBED_MODEL;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (typeof fetchImpl !== 'function') {
    return new OllamaEmbedder(
      baseUrl,
      model,
      (() => Promise.reject(new Error('fetch unavailable'))) as typeof fetch,
      timeoutMs,
      'global fetch is unavailable in this runtime',
    );
  }
  return new OllamaEmbedder(
    baseUrl,
    model,
    fetchImpl,
    timeoutMs,
    config.forceFallbackReason,
    config.cooldownMs ?? 30_000,
  );
}
