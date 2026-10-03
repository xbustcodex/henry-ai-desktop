/**
 * Text chunking for the vector index.
 *
 * Splits on real structure first (markdown headings, blank lines) and only
 * falls back to sentence boundaries, then to a hard character cut as a last
 * resort — so a chunk is almost always a complete thought, which is what makes
 * a retrieved chunk quotable without the surrounding context.
 *
 * Overlap is deliberate: a fact that straddles a split ("the retention policy
 * is 90 days" / "and applies to archived projects") is retrievable from either
 * side only if the two halves overlap.
 */

export interface ChunkOptions {
  /** Target characters per chunk. */
  maxChars?: number;
  /** Characters repeated from the end of one chunk into the next. */
  overlapChars?: number;
  /** Chunks shorter than this are merged forward — they index poorly. */
  minChars?: number;
}

export interface TextChunk {
  index: number;
  text: string;
  /** Character offset in the original text, for citation. */
  start: number;
  end: number;
}

const SENTENCE_END = /[.!?…]["')\]]?\s+/g;
const HARD_MIN = 200;
const HARD_MAX = 1600;
const HARD_OVERLAP = 160;

/** Split into paragraphs, keeping each paragraph's offset in the source. */
function paragraphs(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const slice = text.slice(cursor, match.index);
    if (slice.trim()) out.push({ text: slice, start: cursor });
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail.trim()) out.push({ text: tail, start: cursor });
  return out;
}

/** Greedily pack sentences up to `maxChars`. */
function packSentences(block: string, maxChars: number): string[] {
  const sentences: string[] = [];
  let last = 0;
  SENTENCE_END.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(block)) !== null) {
    sentences.push(block.slice(last, match.index + match[0].length - match[0].trimEnd().length));
    last = match.index + match[0].length;
  }
  if (last < block.length) sentences.push(block.slice(last));

  const packed: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (current && current.length + trimmed.length > maxChars) {
      packed.push(current);
      current = trimmed;
    } else {
      current = current ? `${current} ${trimmed}` : trimmed;
    }
  }
  if (current) packed.push(current);
  return packed;
}

/**
 * Chunk `text` for indexing. Returns chunks in source order, each carrying the
 * offsets it was cut from.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(options.maxChars ?? 900, 100);
  const overlapChars = Math.max(Math.min(options.overlapChars ?? 120, maxChars - 1), 0);
  const minChars = Math.max(options.minChars ?? 80, 0);

  const normalised = text.replace(/\r\n?/g, '\n');
  if (!normalised.trim()) return [];

  // Pass 1 — pack each paragraph into one or more chunks.
  const units: { text: string; start: number }[] = [];
  for (const para of paragraphs(normalised)) {
    if (para.text.length <= maxChars) {
      units.push(para);
      continue;
    }
    let consumed = 0;
    const parts = packSentences(para.text, maxChars);
    for (const part of parts) {
      const offset = para.text.indexOf(part, consumed);
      units.push({ text: part, start: para.start + (offset < 0 ? consumed : offset) });
      consumed = (offset < 0 ? consumed : offset) + part.length;
    }
    // Pass 2 — a sentence longer than maxChars still has to be split, or it
    // becomes one oversized chunk that dilutes every similarity score.
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i];
      if (unit.text.length <= maxChars) continue;
      const pieces: { text: string; start: number }[] = [];
      for (let at = 0; at < unit.text.length; at += maxChars) {
        pieces.push({ text: unit.text.slice(at, at + maxChars), start: unit.start + at });
      }
      units.splice(i, 1, ...pieces);
    }
  }

  // Pass 3 — merge runt chunks forward so nothing is indexed as a fragment.
  const merged: { text: string; start: number }[] = [];
  for (const unit of units) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text.length < minChars && previous.text.length + unit.text.length <= maxChars) {
      previous.text = `${previous.text}\n\n${unit.text}`;
      continue;
    }
    merged.push({ ...unit });
  }

  // Pass 4 — apply overlap between consecutive chunks.
  const out: TextChunk[] = [];
  merged.forEach((unit, index) => {
    const trimmed = unit.text.trim();
    if (!trimmed) return;
    let text = trimmed;
    let start = unit.start;
    if (overlapChars > 0 && index > 0) {
      const previous = merged[index - 1].text;
      if (previous.length > overlapChars) {
        const tail = previous.slice(-overlapChars).trim();
        // Never prepend a tail that begins mid-sentence — it reads as broken
        // prose in a retrieved chunk. Require a capital or digit, so a cut
        // landing inside "Henry's" ("'s retention policy…") is rejected too.
        if (tail && /^[A-Z0-9]/.test(tail)) text = `${tail} ${text}`;
      }
    }
    const at = normalised.indexOf(trimmed, Math.min(unit.start, normalised.length - 1));
    if (at >= 0) start = at;
    out.push({ index: out.length, text, start, end: start + trimmed.length });
  });

  return out;
}

/** Defaults applied when a caller does not specify chunk sizing. */
export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxChars: 900,
  overlapChars: 120,
  minChars: 80,
};

export { HARD_MIN as MIN_CHUNK_CHARS, HARD_MAX as MAX_CHUNK_CHARS, HARD_OVERLAP as DEFAULT_OVERLAP_CHARS };
