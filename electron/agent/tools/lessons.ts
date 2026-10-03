/**
 * Lessons — the durable self-improvement loop.
 *
 * When the user corrects Henry ("no, always run the tests from the repo root")
 * or states a standing preference, that has to survive the session. This module
 * records it, and — more importantly — RECALLS it on later turns, so the loop
 * actually closes instead of writing a log nobody reads.
 *
 * Storage: the existing `personal_memory` table (schema in
 * `electron/ipc/database.ts` → migrateMemoryBlueprintSchema), written exactly
 * the way `electron/ipc/memory.ts` writes it via `memory:savePersonalMemory`:
 *
 *   memory_key    scope ('general', 'code-review', …) — the searchable handle
 *   memory_value  the rule itself, in the user's own words
 *   memory_type   always 'lesson' — the marker that separates these rows
 *   summary       the trigger ("when it applies"), or NULL
 *   source        'agent_recorded' — never claimed to be an extracted fact
 *   confidence_score / relevance_score  mirror the confidence the user implied
 *
 * NOT the `lessons`/`courses`/`lesson_reviews` tables — those are the
 * AI-generated curriculum surface where Henry teaches the user. This is the
 * opposite direction: the user teaching Henry.
 *
 * Revocation is `active_status = 0`, the soft-delete the rest of the codebase
 * uses (see `memory:getPersonalMemory` activeOnly). Rows are never DELETEd, so
 * a revoked lesson stays auditable and can be restored.
 *
 * Safety tiers:
 *   lesson_record  notify — silently rewriting Henry's long-term memory would
 *                  be worse than a toast; the user should see what stuck.
 *   lesson_recall  silent — a read plus a timestamp bump.
 *   lesson_list    silent — a read.
 *   lesson_revoke  confirm — the user must see the exact text being discarded.
 */

import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolResult } from '../types';

type Row = Record<string, unknown>;

/** Rows scanned per recall. Bounds the work when a user has many lessons. */
const MAX_CANDIDATES = 500;
/** A rule longer than this is a paste, not a preference. */
const MAX_LESSON_CHARS = 2000;
const MAX_TRIGGER_CHARS = 200;
/** Ceiling on the injected block so one recall can't flood the context. */
const MAX_BLOCK_CHARS = 4000;

/** A recalled lesson carrying its relevance score for this query. */
type ScoredRow = Row & { _score: number };
/** Every row written here carries this source tag. */
const SOURCE = 'agent_recorded';
const MEMORY_TYPE = 'lesson';

const COLUMNS = `id, memory_key, memory_value, summary, source,
       confidence_score, relevance_score, active_status, created_at, last_recalled_at`;

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

function like(s: string): string {
  return `%${s.trim()}%`;
}

/** Coerce + clamp a numeric param; `fallback` when absent or unusable. */
function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clamp01(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Split into comparable terms. Single characters are dropped — "a", "/" and
 * "C" as search terms match everything and only dilute the ranking.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Relevance of one lesson to one query, 0..~1.3.
 *
 * The distinction that makes ranking meaningful: a term that appears as a WHOLE
 * WORD scores 1, a term that only appears as a substring of a longer word
 * ("deploy" inside "deployment") scores 0.35. So an exact keyword hit always
 * outranks a near miss, and a near miss is still recalled rather than dropped.
 * Confidence scales the result — a rule the user stated emphatically should
 * beat a hedged one that happens to match the same words.
 */
function scoreLesson(
  query: string,
  terms: string[],
  haystack: string,
  confidence: number,
  relevance: number,
): number {
  if (!terms.length) return 0;
  const words = new Set(tokenize(haystack));
  let hits = 0;
  let allWholeWords = true;
  for (const term of terms) {
    if (words.has(term)) {
      hits += 1;
    } else {
      allWholeWords = false;
      if (haystack.includes(term)) hits += 0.35;
    }
  }
  if (!hits) return 0;

  let score = hits / terms.length;
  // Contiguous multi-word phrase ("pull request") beats the words scattered.
  if (terms.length > 1 && allWholeWords && haystack.includes(query.trim().toLowerCase())) {
    score += 0.15;
  }
  return score * (0.6 + 0.4 * confidence) + 0.05 * relevance;
}

/** Shape a personal_memory row into what the model and the user actually read. */
function present(row: Row): Record<string, unknown> {
  const score = Number(row.confidence_score ?? 0);
  const relevance = Number(row.relevance_score ?? 0);
  return {
    id: String(row.id ?? ''),
    lesson: String(row.memory_value ?? ''),
    trigger: row.summary ? String(row.summary) : null,
    scope: String(row.memory_key ?? 'general'),
    confidence: score,
    relevance,
    active: Number(row.active_status ?? 1) === 1,
    created_at: row.created_at ?? null,
    last_recalled_at: row.last_recalled_at ?? null,
    ...(row._score === undefined ? {} : { score: Number(row._score) }),
  };
}

export function lessonsTools(): ToolDefinition[] {
  return [
    // ── lesson_record ───────────────────────────────────────────────────
    {
      name: 'lesson_record',
      description:
        "Save a correction or standing preference the user just stated, so it " +
        "applies to every future conversation. Use this the moment the user " +
        'corrects Henry ("no, always use tabs", "stop asking, just do it") or ' +
        'states how they want something done ("never touch my main branch"). ' +
        "Record the rule in THEIR words, not a paraphrase — the point is that " +
        "lesson_recall can find and replay it later. Do not record one-off " +
        "instructions or anything you were merely guessing at.",
      category: 'memory',
      safetyLevel: 'notify',
      inputSchema: {
        type: 'object',
        properties: {
          lesson: {
            type: 'string',
            description: "The rule or preference, in the user's own words.",
          },
          trigger: {
            type: 'string',
            description: 'When this applies, e.g. "writing commit messages".',
          },
          scope: {
            type: 'string',
            description: "Area it governs, e.g. 'code', 'email', 'general'.",
          },
          confidence: {
            type: 'number',
            description:
              'How sure the rule is (0..1, default 0.9 — something the user ' +
              'stated outright is high confidence).',
          },
        },
        required: ['lesson'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const lesson = String(params.lesson ?? '').trim();
          if (!lesson) return fail('lesson is required');
          if (lesson.length > MAX_LESSON_CHARS) {
            return fail(
              `lesson is too long (${lesson.length} chars, max ${MAX_LESSON_CHARS}) — record the rule, not the whole explanation`,
            );
          }
          const rawTrigger = String(params.trigger ?? '').trim();
          const trigger = rawTrigger ? rawTrigger.slice(0, MAX_TRIGGER_CHARS) : null;
          const scope =
            String(params.scope ?? '').trim().slice(0, 60) || 'general';
          const confidence = clamp01(params.confidence, 0.9);

          const id = randomUUID();
          const now = nowIso();
          db.prepare(
            `INSERT INTO personal_memory
               (id, memory_key, memory_value, memory_type, summary, source,
                confidence_score, relevance_score, active_status, tags_json,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          ).run(
            id,
            scope,
            lesson,
            MEMORY_TYPE,
            trigger,
            SOURCE,
            confidence,
            confidence,
            JSON.stringify([scope]),
            now,
            now,
          );

          return ok({ id, lesson, trigger, scope, confidence });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── lesson_recall ───────────────────────────────────────────────────
    {
      name: 'lesson_recall',
      description:
        'Look up previously recorded lessons/preferences relevant to a topic, ' +
        'and get back a ready-to-use summary block. Call this BEFORE acting on ' +
        'anything the user has previously corrected — writing code, sending ' +
        'email, editing files — so a standing instruction is not re-learned ' +
        "every session. The `block` field is written for direct injection into " +
        'the conversation; honour every line in it.',
      category: 'memory',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: "Topic to match against, e.g. 'commits' or 'deploy'.",
          },
          limit: { type: 'number', description: 'Max lessons (default 5, max 20).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const query = String(params.query ?? '').trim();
          if (!query) return fail('query is required');
          const terms = tokenize(query);
          if (!terms.length) return fail('query has no searchable terms');
          const limit = clampNumber(params.limit, 5, 1, 20);

          // All active lessons, most recently touched first — ranking is done in
          // JS because the whole-word/substring distinction can't be expressed
          // in SQL LIKE. Bounded by MAX_CANDIDATES.
          const candidates = db
            .prepare(
              `SELECT ${COLUMNS} FROM personal_memory
               WHERE active_status = 1 AND memory_type = ?
               ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
               LIMIT ?`,
            )
            .all(MEMORY_TYPE, MAX_CANDIDATES) as Row[];

          const ranked: ScoredRow[] = candidates
            .map((row): ScoredRow => {
              const haystack =
                `${row.memory_key ?? ''} ${row.memory_value ?? ''} ${row.summary ?? ''}`.toLowerCase();
              return {
                ...row,
                _score: scoreLesson(
                  query,
                  terms,
                  haystack,
                  Number(row.confidence_score ?? 0.5),
                  Number(row.relevance_score ?? 0.5),
                ),
              };
            })
            .filter((row) => row._score > 0)
            .sort(
              (a, b) =>
                b._score - a._score ||
                Number(b.confidence_score ?? 0) - Number(a.confidence_score ?? 0) ||
                String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
            )
            .slice(0, limit);

          // The recall loop: every lesson handed back gets stamped. A lesson
          // that has never been recalled is a lesson the model may be quietly
          // forgetting, and this timestamp is what makes that visible.
          if (ranked.length) {
            const now = nowIso();
            const bump = db.prepare(
              `UPDATE personal_memory SET last_recalled_at = ? WHERE id = ?`,
            );
            for (const row of ranked) bump.run(now, String(row.id));
            for (const row of ranked) row.last_recalled_at = now;
          }

          const lines = ranked.map((row) => {
            const lesson = String(row.memory_value ?? '');
            const when = String(row.summary ?? '') || String(row.memory_key ?? 'general');
            return `- ${when}: ${lesson}`;
          });
          let block = lines.length ? `Remembered preferences:\n${lines.join('\n')}` : '';
          if (block.length > MAX_BLOCK_CHARS) block = `${block.slice(0, MAX_BLOCK_CHARS)}…`;

          return ok({
            query,
            count: ranked.length,
            block,
            lessons: ranked.map(present),
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── lesson_list ─────────────────────────────────────────────────────
    {
      name: 'lesson_list',
      description:
        'List the stored lessons and preferences. Use when the user asks what ' +
        "Henry remembers about them, or to find a lesson's id before revoking it.",
      category: 'memory',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max lessons (default 20, max 100).' },
          include_revoked: {
            type: 'boolean',
            description: 'Include revoked lessons too (default false).',
          },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const limit = clampNumber(params.limit, 20, 1, 100);
          const includeRevoked = params.include_revoked === true;

          const rows = db
            .prepare(
              `SELECT ${COLUMNS} FROM personal_memory
               WHERE memory_type = ?${includeRevoked ? '' : ' AND active_status = 1'}
               ORDER BY confidence_score DESC, datetime(created_at) DESC
               LIMIT ?`,
            )
            .all(MEMORY_TYPE, limit) as Row[];

          const lessons = rows.map(present);
          return ok({ count: lessons.length, include_revoked: includeRevoked, lessons });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── lesson_revoke ───────────────────────────────────────────────────
    {
      name: 'lesson_revoke',
      description:
        "Retire a stored lesson/preference — the user changed their mind or the " +
        'rule no longer applies. Prefer passing the lesson text so the user can ' +
        'see exactly what is being thrown away; pass the id from lesson_list ' +
        'if the text is ambiguous. The row is kept (marked inactive), never ' +
        'deleted, and disappears from lesson_recall immediately.',
      category: 'memory',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => {
        const text = String(p.lesson ?? '').trim();
        const shown = text.length > 160 ? `${text.slice(0, 160)}…` : text;
        const id = p.id ? ` (id ${String(p.id)})` : '';
        return shown
          ? `Forget this standing preference${id}:\n"${shown}"`
          : `Forget the standing preference with id ${String(p.id ?? '')}`;
      },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Lesson id from lesson_list.' },
          lesson: {
            type: 'string',
            description: 'Lesson text to match (partial ok) if the id is unknown.',
          },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const id = String(params.id ?? '').trim();
          const text = String(params.lesson ?? '').trim();
          if (!id && !text) return fail('provide an id or the lesson text');

          const row = (
            id
              ? db
                  .prepare(
                    `SELECT ${COLUMNS} FROM personal_memory WHERE id = ? AND memory_type = ?`,
                  )
                  .get(id, MEMORY_TYPE)
              : db
                  .prepare(
                    `SELECT ${COLUMNS} FROM personal_memory
                     WHERE memory_type = ?
                       AND (memory_value LIKE ? OR summary LIKE ? OR memory_key LIKE ?)
                     ORDER BY active_status DESC, datetime(updated_at) DESC
                     LIMIT 1`,
                  )
                  .get(MEMORY_TYPE, like(text), like(text), like(text))
          ) as Row | undefined;

          if (!row) return fail(`No stored lesson matched ${id ? `id "${id}"` : `"${text}"`}`);
          if (Number(row.active_status ?? 1) !== 1) {
            return fail('That lesson is already revoked.');
          }

          db.prepare(
            `UPDATE personal_memory SET active_status = 0, updated_at = ? WHERE id = ?`,
          ).run(nowIso(), String(row.id));

          return ok({
            id: String(row.id),
            revoked: true,
            lesson: String(row.memory_value ?? ''),
            scope: String(row.memory_key ?? 'general'),
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
