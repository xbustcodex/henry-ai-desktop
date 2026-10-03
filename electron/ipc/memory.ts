/**
 * Henry Memory System — Full 7-Layer Memory Blueprint
 *
 * Layers:
 *   1 — Live Turn (current message, handled in ChatView)
 *   2 — Session Memory (per-conversation summaries + active state)
 *   3 — Working Memory (rolling cross-session buffer, DB-backed)
 *   4 — Long-Term Personal Memory (personal_memory table, scored)
 *   5 — Project Memory (projects + project_memory tables)
 *   6 — Relationship Memory (support style, pattern recognition)
 *   7 — Narrative Memory (life/work arcs, milestones)
 *
 * Plus: memory scoring engine, bandwidth modes, compression,
 *       where-we-left-off, and memory graph edges.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import type { HenryLeanMemoryParts } from '../../src/types';
import { registerKnowledgeHandlers, getMemoryRecallService, type MemoryRecallResult } from '../knowledge/handlers';
import { registerCompanionHandlers } from '../companion/handlers';
import { policyFlag } from './securityPolicy';

let db: Database.Database;

// ── Scoring formula (from blueprint section 5) ────────────────────────────────
// retrieval_score = (relevance*0.30) + (recency*0.20) + (emotional*0.15)
//                 + (strategic*0.25) + (confidence*0.10)
function computeRetrievalScore(row: {
  relevance_score?: number;
  recency_score?: number;
  emotional_significance_score?: number;
  strategic_significance_score?: number;
  confidence_score?: number;
  created_at?: string;
}): number {
  const relevance  = row.relevance_score  ?? 0.5;
  const emotional  = row.emotional_significance_score ?? 0.3;
  const strategic  = row.strategic_significance_score ?? 0.5;
  const confidence = row.confidence_score ?? 0.7;

  // Recency: decays over 90 days
  let recency = row.recency_score ?? 1.0;
  if (row.created_at) {
    const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86_400_000;
    recency = Math.max(0, 1 - ageDays / 90);
  }

  return (relevance  * 0.30)
       + (recency    * 0.20)
       + (emotional  * 0.15)
       + (strategic  * 0.25)
       + (confidence * 0.10);
}

// ── Registration ──────────────────────────────────────────────────────────────

// ── Safe DB helper — wraps any IPC handler body to prevent main-process crashes ──
function safeHandle<T>(channel: string, fn: () => T): T {
  try {
    return fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${channel}] DB error:`, msg);
    throw new Error(`Henry memory error: ${msg}`);
  }
}


/**
 * Privacy gate for memory WRITES — the Security switch `persistMemory`.
 *
 * Every `memory:save*` / `memory:update*` / `memory:delete*` handler opens with
 *   if (!policyFlag('persistMemory')) return <its own success shape>;
 * so a user who has turned persistence off writes nothing, and the renderer
 * still receives the exact envelope it would have on success. It must NOT
 * throw: the caller did nothing wrong, and callers that destructure
 * `saved.id` / `saved.error` would break on a privacy setting rather than on
 * an error.
 *
 * Reads are deliberately NOT gated. Someone who disabled persistence must still
 * be able to read the memories that already exist — otherwise the switch
 * becomes destructive instead of protective.
 *
 * `policyFlag` is a synchronous, allocation-free read that fails closed before
 * boot and on a corrupt settings row.
 */
export function registerMemoryHandlers(database: Database.Database) {
  db = database;

  // Knowledge base + semantic memory recall (rows 9.4 / 9.5 / 9.3). They
  // share this exact database handle — the vector index and the knowledge
  // documents are additional tables in the one existing store, not a
  // second database.
  registerKnowledgeHandlers(database);

  // Companion personality / emotional context / voice / memory graph
  // (rows 8.2–8.5). Same database handle — these are additional tables in
  // the one existing store, not a second store.
  registerCompanionHandlers(database);

  // ══════════════════════════════════════════════════════════════════════
  // LEGACY — keep backward-compatible channels for memory_facts
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveFact',  async (_e, fact: {
    conversationId?: string; conversation_id?: string;
    fact: string;
    category?: string;
    importance?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { skipped: true, reason: 'memory persistence is off' };
    try {
      // Only save real extracted facts — never raw conversation messages
      const BLOCKED_CATEGORIES = ['conversation', 'message', 'raw', 'chat'];
      const factText = (fact.fact || '').trim();
      const category = (fact.category || 'general').toLowerCase();

      // Reject blocked categories
      if (BLOCKED_CATEGORIES.includes(category)) return { skipped: true, reason: 'blocked category' };

      // Reject raw-looking message text (questions, commands)
      const rawPatterns = [/^(what|who|how|when|where|why|can you|do you|tell me|show me|i want|i need|please)/i, /\?$/, /^[a-z]/];
      if (rawPatterns.slice(0,2).some(p => p.test(factText)) && !factText.includes(':')) {
        return { skipped: true, reason: 'looks like raw message' };
      }

      // Minimum quality: must have a colon (structured fact like "Name: Topher") or be >= 15 chars of real info
      if (factText.length < 10) return { skipped: true, reason: 'too short' };

      const convId = fact.conversationId || fact.conversation_id || null;
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO memory_facts (id, conversation_id, fact, category, importance, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, convId, fact.fact, fact.category || 'general', fact.importance || 1, new Date().toISOString());

      // Mirror into personal_memory for scored retrieval
      db.prepare(`
        INSERT INTO personal_memory
          (id, memory_key, memory_value, memory_type, confidence_score, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        fact.category || 'general',
        fact.fact,
        fact.category || 'general',
        (fact.importance || 1) / 10,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveFact]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:searchFacts', async (_e, query: {
    // Accept both spellings: the declared renderer type used `query.query`
    // while the handler read `query.text`, so one of the two always sent an
    // empty search.
    text?: string; query?: string; category?: string; conversationId?: string; limit?: number;
  }) => {
    const searchText = (query.text ?? query.query ?? '').trim();
    const limit = query.limit || 40;
    // Use FTS5 for full-text queries — falls back to LIKE if FTS table not ready
    if (query.text && query.text.trim()) {
      try {
        // FTS5: rank by relevance, apply secondary filters in the outer query
        let sql = `
          SELECT mf.* FROM memory_facts mf
          JOIN memory_facts_fts fts ON mf.rowid = fts.rowid
          WHERE memory_facts_fts MATCH ?
        `;
        const params: (string | number)[] = [query.text.trim().replace(/['"*^]/g, '') + '*'];
        if (query.category)       { sql += ' AND mf.category = ?';         params.push(query.category); }
        if (query.conversationId) { sql += ' AND mf.conversation_id = ?';  params.push(query.conversationId); }
        sql += ' ORDER BY fts.rank, mf.importance DESC, mf.created_at DESC LIMIT ?';
        params.push(limit);
        return db.prepare(sql).all(...params);
      } catch {
        // FTS not yet populated — fall through to LIKE
      }
    }
    // Fallback LIKE path (no text query, or FTS not ready)
    let sql = 'SELECT * FROM memory_facts WHERE 1=1';
    const params: (string | number)[] = [];
    if (query.text)           { sql += ' AND fact LIKE ?';           params.push(`%${query.text}%`); }
    if (query.category)       { sql += ' AND category = ?';          params.push(query.category); }
    if (query.conversationId) { sql += ' AND conversation_id = ?';   params.push(query.conversationId); }
    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  });

  // ══════════════════════════════════════════════════════════════════════
  // UNIFIED MEMORY SEARCH (row 9.3)
  //
  // `memory:searchFacts` above is FTS5/LIKE over `memory_facts` only, so it
  // cannot answer "what did I decide about retention?" — the answer lives in
  // personal_memory or narrative_memory and shares no vocabulary with the
  // query. This channel searches EVERY memory layer and merges two signals:
  // exact lexical matches (which catch SKUs, names and identifiers that no
  // embedding ranks well) and semantic recall through the vector store.
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:searchAll', async (_e, payload: {
    query?: string; limit?: number; includeSemantic?: boolean;
  } = {}) => {
    return safeHandle('memory:searchAll', async () => {
      const query = String(payload.query ?? '').trim();
      const limit = Math.min(Math.max(Number(payload.limit) || 20, 1), 100);
      const includeSemantic = payload.includeSemantic !== false;

      /** One `memory_facts` row, as the lexical half of the merge returns it. */
      interface LexicalFactRow {
        id: string;
        label: string;
        detail: string | null;
        updated_at: string;
        weight: number | null;
      }

      const lexical: LexicalFactRow[] = query
        ? (db.prepare(`
              SELECT id, fact AS label, category AS detail, created_at AS updated_at,
                     importance AS weight
              FROM memory_facts
              WHERE fact LIKE ?
              ORDER BY importance DESC, created_at DESC
              LIMIT ?
            `).all(`%${query}%`, limit) as LexicalFactRow[])
        : [];

      // An index that has not been built yet yields nothing rather than an
      // error, so keyword search still works on a fresh install.
      let semantic: MemoryRecallResult = { memories: [], backend: 'hashed-fallback', model: '' };
      if (includeSemantic && query) {
        try {
          semantic = await getMemoryRecallService().recall(query, limit);
        } catch (e: unknown) {
          // A vector index that is not built yet must not break keyword search.
          console.error('[memory:searchAll] semantic recall unavailable:', e instanceof Error ? e.message : String(e));
        }
      }

      const results = [
        ...lexical.map((r) => ({
          id: String(r.id), table: 'memory_facts' as const,
          label: String(r.label), detail: String(r.detail ?? ''),
          // Lexical hits start from a fixed high floor so an exact substring
          // match outranks a merely similar one, then importance nudges it.
          score: 0.6 + Math.min(Number(r.weight ?? 0) / 20, 0.4),
          updatedAt: String(r.updated_at ?? ''), match: 'lexical' as const,
        })),
        ...semantic.memories.map((m) => ({
          id: m.id, table: m.table,
          label: m.label, detail: m.detail,
          score: m.score, updatedAt: m.updatedAt, match: 'semantic' as const,
        })),
      ].sort((a, b) => b.score - a.score);

      return {
        query,
        results: results.slice(0, limit),
        backend: semantic.backend,
        model: semantic.model,
        note: semantic.note,
      };
    });
  });

  ipcMain.handle('memory:getAllFacts', async (_e, limit?: number) =>
    db.prepare(`SELECT * FROM memory_facts ORDER BY importance DESC, created_at DESC LIMIT ?`)
      .all(limit || 50)
  );

  // ══════════════════════════════════════════════════════════════════════
  // CONVERSATION SUMMARIES
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveSummary',  async (_e, payload: Record<string, unknown>) => {
    if (!policyFlag('persistMemory')) return { id: null as string | null };
    try {
      const conversationId =
        (typeof payload.conversationId === 'string' && payload.conversationId) ||
        (typeof payload.conversation_id === 'string' && payload.conversation_id) || '';
      const summaryText = typeof payload.summary === 'string' ? payload.summary : '';
      if (!conversationId.trim() || !summaryText.trim())
        return { id: null as string | null, error: 'conversationId and summary are required.' };
      const messageCount = (typeof payload.messageCount === 'number' ? payload.messageCount
        : typeof payload.message_count === 'number' ? payload.message_count : 0);
      const tokenCount = (typeof payload.tokenCount === 'number' ? payload.tokenCount
        : typeof payload.token_count === 'number' ? payload.token_count
        : Math.ceil(summaryText.length / 4));
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO conversation_summaries (id, conversation_id, summary, message_count, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, conversationId, summaryText, messageCount, tokenCount, new Date().toISOString());
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveSummary]', e instanceof Error ? e.message : String(e));
      // Callers destructure `saved.error` / `saved.id`, so the failure path has
      // to keep the envelope shape — returning bare null threw a TypeError in
      // MemoryAwarenessPanel instead of surfacing the DB error.
      return { id: null as string | null, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('memory:getSummary', async (_e, conversationId: string) =>
    // better-sqlite3 .get() yields undefined for "no rows"; the renderer
    // contract types this as `| null`, so normalise rather than leak undefined.
    db.prepare(`SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(conversationId) ?? null
  );

  // ══════════════════════════════════════════════════════════════════════
  // WORKSPACE INDEX
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:indexFile',  async (_e, file: {
    path: string; type: string; summary: string; sizeBytes: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      db.prepare(`INSERT OR REPLACE INTO workspace_index (id, file_path, file_type, summary, last_indexed, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, file.path, file.type, file.summary, new Date().toISOString(), file.sizeBytes);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:indexFile]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:searchWorkspace', async (_e, query: string) => {
    if (!query.trim()) return [];
    try {
      // Try FTS5 on workspace_index if available, else fall back to LIKE
      return db.prepare(`SELECT * FROM workspace_index WHERE file_path LIKE ? OR summary LIKE ? ORDER BY last_indexed DESC LIMIT 20`)
        .all(`%${query}%`, `%${query}%`);
    } catch {
      return [];
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // LAYER 4 — PERSONAL MEMORY (scored, typed)
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:savePersonalMemory',  async (_e, item: {
    memoryKey: string;
    memoryValue: string;
    memoryType?: string;
    summary?: string;
    source?: string;
    confidenceScore?: number;
    emotionalSignificanceScore?: number;
    strategicSignificanceScore?: number;
    tags?: string[];
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO personal_memory
          (id, memory_key, memory_value, memory_type, summary, source,
           confidence_score, emotional_significance_score, strategic_significance_score,
           tags_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, item.memoryKey, item.memoryValue, item.memoryType || 'general',
        item.summary || null, item.source || null,
        item.confidenceScore ?? 0.7,
        item.emotionalSignificanceScore ?? 0.3,
        item.strategicSignificanceScore ?? 0.5,
        JSON.stringify(item.tags || []),
        now, now,
      );
      return { id };
    } catch (e: unknown) {
      console.error('[memory:savePersonalMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getPersonalMemory', async (_e, opts: {
    memoryType?: string; limit?: number; activeOnly?: boolean;
  } = {}) => {
    try {
      let sql = 'SELECT * FROM personal_memory WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.activeOnly !== false) { sql += ' AND active_status = 1'; }
      if (opts.memoryType)           { sql += ' AND memory_type = ?'; params.push(opts.memoryType); }
      sql += ' ORDER BY strategic_significance_score DESC, emotional_significance_score DESC, created_at DESC LIMIT ?';
      params.push(opts.limit || 50);
      const rows = db.prepare(sql).all(...params) as any[];
      return rows
        .map((r) => ({ ...r, _retrieval_score: computeRetrievalScore(r) }))
        .sort((a, b) => b._retrieval_score - a._retrieval_score);
    } catch (e: unknown) {
      console.error('[memory:getPersonalMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:updatePersonalMemory',  async (_e, id: string, updates: Record<string, unknown>) => {
    if (!policyFlag('persistMemory')) return { updated: false };
    try {
      const allowed = ['memory_value','summary','confidence_score','emotional_significance_score',
                       'strategic_significance_score','active_status','tags_json'];
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const key of allowed) {
        if (key in updates) { sets.push(`${key} = ?`); vals.push(updates[key]); }
      }
      if (sets.length === 0) return { updated: false };
      sets.push('updated_at = ?');
      vals.push(new Date().toISOString());
      vals.push(id);
      db.prepare(`UPDATE personal_memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return { updated: true };
    } catch (e: unknown) {
      console.error('[memory:updatePersonalMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:deletePersonalMemory',  async (_e, id: string) => {
    if (!policyFlag('persistMemory')) return { deleted: false };
    try {
      db.prepare('UPDATE personal_memory SET active_status = 0, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
      return { deleted: true };
    } catch (e: unknown) {
      console.error('[memory:deletePersonalMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:recallPersonalMemory', async (_e, id: string) => {
    try {
      db.prepare('UPDATE personal_memory SET last_recalled_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    } catch (e: unknown) {
      console.error('[memory:recallPersonalMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // LAYER 5 — PROJECTS
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveProject',  async (_e, project: {
    name: string; type?: string; summary?: string;
    strategicImportanceScore?: number; emotionalImportanceScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO projects (id, name, type, summary, strategic_importance_score, emotional_importance_score, created_at, updated_at, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, project.name, project.type || 'general', project.summary || null,
             project.strategicImportanceScore ?? 0.5, project.emotionalImportanceScore ?? 0.5,
             now, now, now);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveProject]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getProjects', async (_e, opts: { status?: string; limit?: number } = {}) => {
    try {
      let sql = 'SELECT * FROM projects WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
      sql += ' ORDER BY strategic_importance_score DESC, last_active_at DESC LIMIT ?';
      params.push(opts.limit || 20);
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getProjects]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:updateProject',  async (_e, id: string, updates: Record<string, unknown>) => {
    if (!policyFlag('persistMemory')) return { updated: false };
    try {
      const allowed = ['name','type','status','summary','strategic_importance_score','emotional_importance_score'];
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of allowed) { if (k in updates) { sets.push(`${k} = ?`); vals.push(updates[k]); } }
      if (sets.length === 0) return { updated: false };
      sets.push('updated_at = ?', 'last_active_at = ?');
      const now = new Date().toISOString();
      vals.push(now, now, id);
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return { updated: true };
    } catch (e: unknown) {
      console.error('[memory:updateProject]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:saveProjectMemory',  async (_e, item: {
    projectId: string; memoryKey: string; memoryValue: string;
    summary?: string; blockerFlag?: boolean; deadline?: string;
    confidenceScore?: number; relevanceScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO project_memory
          (id, project_id, memory_key, memory_value, summary, blocker_flag, deadline,
           confidence_score, relevance_score, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, item.projectId, item.memoryKey, item.memoryValue,
             item.summary || null, item.blockerFlag ? 1 : 0,
             item.deadline || null, item.confidenceScore ?? 0.8, item.relevanceScore ?? 0.7,
             now, now);
      // Touch project last_active_at
      db.prepare(`UPDATE projects SET last_active_at = ? WHERE id = ?`).run(now, item.projectId);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveProjectMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getProjectMemory', async (_e, projectId: string) =>
    db.prepare(`SELECT * FROM project_memory WHERE project_id = ? ORDER BY blocker_flag DESC, relevance_score DESC, created_at DESC LIMIT 30`)
      .all(projectId)
  );

  // ══════════════════════════════════════════════════════════════════════
  // LAYER 2 — SESSION MEMORY
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveSessionMemory',  async (_e, session: {
    conversationId: string; summary?: string;
    activeGoals?: string[]; activeTasks?: string[]; activeFiles?: string[];
    emotionalPattern?: string; unresolvedItems?: string[]; projectId?: string;
  }) => {
    if (!policyFlag('persistMemory')) return { id: '', created: false, skipped: true };
    try {
      const now = new Date().toISOString();
      const existing = db.prepare('SELECT id FROM session_memory WHERE conversation_id = ?')
        .get(session.conversationId) as { id: string } | undefined;
      if (existing) {
        db.prepare(`
          UPDATE session_memory SET
            summary = COALESCE(?, summary),
            active_goals_json = ?,
            active_tasks_json = ?,
            active_files_json = ?,
            emotional_pattern = COALESCE(?, emotional_pattern),
            unresolved_items_json = ?,
            project_id = COALESCE(?, project_id),
            updated_at = ?
          WHERE conversation_id = ?
        `).run(
          session.summary || null,
          JSON.stringify(session.activeGoals || []),
          JSON.stringify(session.activeTasks || []),
          JSON.stringify(session.activeFiles || []),
          session.emotionalPattern || null,
          JSON.stringify(session.unresolvedItems || []),
          session.projectId || null, now,
          session.conversationId,
        );
        return { id: existing.id, updated: true };
      }
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO session_memory
          (id, conversation_id, summary, active_goals_json, active_tasks_json,
           active_files_json, emotional_pattern, unresolved_items_json, project_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, session.conversationId, session.summary || null,
        JSON.stringify(session.activeGoals || []),
        JSON.stringify(session.activeTasks || []),
        JSON.stringify(session.activeFiles || []),
        session.emotionalPattern || null,
        JSON.stringify(session.unresolvedItems || []),
        session.projectId || null, now, now,
      );
      return { id, created: true };
    } catch (e: unknown) {
      console.error('[memory:saveSessionMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getSessionMemory', async (_e, conversationId: string) =>
    db.prepare('SELECT * FROM session_memory WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(conversationId)
  );

  // ══════════════════════════════════════════════════════════════════════
  // LAYER 3 — WORKING MEMORY (DB-backed, single row per user)
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:getWorkingMemory', async (_e, userId = 'default') =>
    db.prepare('SELECT * FROM working_memory WHERE user_id = ?').get(userId)
  );

  ipcMain.handle('memory:updateWorkingMemory',  async (_e, updates: {
    userId?: string;
    activeContextSummary?: string;
    activeProjectIds?: string[];
    activeGoalIds?: string[];
    pendingCommitments?: string[];
    relevantFileIds?: string[];
    relevantMemoryIds?: string[];
  }) => {
    if (!policyFlag('persistMemory')) return { updated: false };
    try {
      const userId = updates.userId || 'default';
      const now = new Date().toISOString();
      const existing = db.prepare('SELECT id FROM working_memory WHERE user_id = ?').get(userId);
      if (existing) {
        const sets: string[] = ['refreshed_at = ?'];
        const vals: unknown[] = [now];
        if (updates.activeContextSummary !== undefined) { sets.push('active_context_summary = ?'); vals.push(updates.activeContextSummary); }
        if (updates.activeProjectIds)                   { sets.push('active_project_ids_json = ?'); vals.push(JSON.stringify(updates.activeProjectIds)); }
        if (updates.activeGoalIds)                      { sets.push('active_goal_ids_json = ?'); vals.push(JSON.stringify(updates.activeGoalIds)); }
        if (updates.pendingCommitments)                 { sets.push('pending_commitments_json = ?'); vals.push(JSON.stringify(updates.pendingCommitments)); }
        if (updates.relevantFileIds)                    { sets.push('relevant_file_ids_json = ?'); vals.push(JSON.stringify(updates.relevantFileIds)); }
        if (updates.relevantMemoryIds)                  { sets.push('relevant_memory_ids_json = ?'); vals.push(JSON.stringify(updates.relevantMemoryIds)); }
        vals.push(userId);
        db.prepare(`UPDATE working_memory SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
      } else {
        db.prepare(`
          INSERT INTO working_memory
            (id, user_id, active_context_summary, active_project_ids_json, active_goal_ids_json,
             pending_commitments_json, relevant_file_ids_json, relevant_memory_ids_json, refreshed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), userId,
          updates.activeContextSummary || null,
          JSON.stringify(updates.activeProjectIds || []),
          JSON.stringify(updates.activeGoalIds || []),
          JSON.stringify(updates.pendingCommitments || []),
          JSON.stringify(updates.relevantFileIds || []),
          JSON.stringify(updates.relevantMemoryIds || []),
          now,
        );
      }
      return { updated: true };
    } catch (e: unknown) {
      console.error('[memory:updateWorkingMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // GOALS
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveGoal',  async (_e, goal: {
    title: string; summary?: string;
    priorityScore?: number; emotionalSignificanceScore?: number; strategicSignificanceScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO goals (id, title, summary, priority_score, emotional_significance_score, strategic_significance_score, created_at, updated_at, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, goal.title, goal.summary || null,
             goal.priorityScore ?? 0.5, goal.emotionalSignificanceScore ?? 0.5, goal.strategicSignificanceScore ?? 0.5,
             now, now, now);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveGoal]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // Goals could be created, edited and archived, but never removed — so a
  // goal you did not want was stuck in the table forever. Deleting is
  // irreversible, so the panel asks first.
  ipcMain.handle('memory:deleteGoal',  async (_e, id: string) => {
    if (!policyFlag('persistMemory')) return { deleted: false };
    try {
      if (typeof id !== 'string' || !id) return { deleted: false, error: 'A goal id is required.' };
      const info = db.prepare('DELETE FROM goals WHERE id = ?').run(id);
      return { deleted: info.changes > 0 };
    } catch (e: unknown) {
      console.error('[memory:deleteGoal]', e instanceof Error ? e.message : String(e));
      return { deleted: false, error: 'Could not delete that goal.' };
    }
  });

  ipcMain.handle('memory:getGoals', async (_e, opts: { status?: string; limit?: number } = {}) => {
    try {
      let sql = 'SELECT * FROM goals WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
      else { sql += " AND status = 'active'"; }
      sql += ' ORDER BY priority_score DESC, strategic_significance_score DESC LIMIT ?';
      params.push(opts.limit || 20);
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getGoals]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:updateGoal',  async (_e, id: string, updates: Record<string, unknown>) => {
    if (!policyFlag('persistMemory')) return { updated: false };
    try {
      const allowed = ['title','summary','status','priority_score','emotional_significance_score','strategic_significance_score'];
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of allowed) { if (k in updates) { sets.push(`${k} = ?`); vals.push(updates[k]); } }
      if (sets.length === 0) return { updated: false };
      sets.push('updated_at = ?', 'last_active_at = ?');
      const now = new Date().toISOString();
      vals.push(now, now, id);
      db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return { updated: true };
    } catch (e: unknown) {
      console.error('[memory:updateGoal]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // COMMITMENTS (Henry's explicit promises)
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveCommitment',  async (_e, c: {
    description: string; sourceConversationId?: string; projectId?: string;
    dueDate?: string; importanceScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO commitments (id, source_conversation_id, project_id, description, importance_score, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, c.sourceConversationId || null, c.projectId || null,
             c.description, c.importanceScore ?? 0.5, now, now);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveCommitment]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getCommitments', async (_e, opts: { status?: string; limit?: number } = {}) => {
    try {
      let sql = 'SELECT * FROM commitments WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
      else { sql += " AND status IN ('open','in_progress')"; }
      sql += ' ORDER BY importance_score DESC, created_at ASC LIMIT ?';
      params.push(opts.limit || 30);
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getCommitments]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:resolveCommitment',  async (_e, id: string) => {
    if (!policyFlag('persistMemory')) return { resolved: false };
    try {
      const now = new Date().toISOString();
      db.prepare(`UPDATE commitments SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, id);
      return { resolved: true };
    } catch (e: unknown) {
      console.error('[memory:resolveCommitment]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:updateCommitment',  async (_e, id: string, updates: Record<string, unknown>) => {
    if (!policyFlag('persistMemory')) return { updated: false };
    try {
      const allowed = ['description','status','due_date','importance_score','project_id'];
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of allowed) { if (k in updates) { sets.push(`${k} = ?`); vals.push(updates[k]); } }
      if (sets.length === 0) return { updated: false };
      sets.push('updated_at = ?');
      vals.push(new Date().toISOString(), id);
      db.prepare(`UPDATE commitments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return { updated: true };
    } catch (e: unknown) {
      console.error('[memory:updateCommitment]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // MILESTONES
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveMilestone',  async (_e, m: {
    title: string; summary?: string; milestoneType?: string;
    projectId?: string; significanceScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO milestones (id, project_id, title, summary, milestone_type, significance_score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, m.projectId || null, m.title, m.summary || null,
             m.milestoneType || 'win', m.significanceScore ?? 0.7, new Date().toISOString());
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveMilestone]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getMilestones', async (_e, opts: { projectId?: string; limit?: number } = {}) => {
    try {
      let sql = 'SELECT * FROM milestones WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.projectId) { sql += ' AND project_id = ?'; params.push(opts.projectId); }
      sql += ' ORDER BY significance_score DESC, created_at DESC LIMIT ?';
      params.push(opts.limit || 20);
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getMilestones]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // LAYER 6 — RELATIONSHIP MEMORY
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveRelationshipMemory',  async (_e, item: {
    patternType: string; summary: string;
    supportPreference?: string; contextTrigger?: string;
    confidenceScore?: number; relevanceScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const now = new Date().toISOString();
      // Upsert by pattern_type — merge with existing if confidence is higher
      const existing = db.prepare('SELECT id, confidence_score FROM relationship_memory WHERE pattern_type = ? ORDER BY confidence_score DESC LIMIT 1')
        .get(item.patternType) as { id: string; confidence_score: number } | undefined;
      if (existing && (item.confidenceScore ?? 0.5) < existing.confidence_score) {
        return { id: existing.id, skipped: true };
      }
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO relationship_memory
          (id, pattern_type, summary, support_preference, context_trigger, confidence_score, relevance_score, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, item.patternType, item.summary,
             item.supportPreference || null, item.contextTrigger || null,
             item.confidenceScore ?? 0.5, item.relevanceScore ?? 0.5,
             now, now);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveRelationshipMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getRelationshipMemory', async (_e, opts: { limit?: number } = {}) =>
    db.prepare(`SELECT * FROM relationship_memory ORDER BY confidence_score DESC, relevance_score DESC LIMIT ?`)
      .all(opts.limit || 10)
  );

  // ══════════════════════════════════════════════════════════════════════
  // LAYER 7 — NARRATIVE MEMORY (life/work arcs)
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveNarrativeMemory',  async (_e, arc: {
    arcName: string; summary: string; startDate?: string; endDate?: string;
    importanceScore?: number; linkedProjectIds?: string[]; linkedMemoryIds?: string[];
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const now = new Date().toISOString();
      // Update existing arc by name if it exists
      const existing = db.prepare('SELECT id FROM narrative_memory WHERE arc_name = ? AND active_status = 1 LIMIT 1')
        .get(arc.arcName) as { id: string } | undefined;
      if (existing) {
        db.prepare(`UPDATE narrative_memory SET summary = ?, importance_score = COALESCE(?, importance_score), linked_project_ids_json = COALESCE(?, linked_project_ids_json), updated_at = ? WHERE id = ?`)
          .run(arc.summary, arc.importanceScore || null, arc.linkedProjectIds ? JSON.stringify(arc.linkedProjectIds) : null, now, existing.id);
        return { id: existing.id, updated: true };
      }
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO narrative_memory
          (id, arc_name, summary, start_date, end_date, importance_score,
           linked_project_ids_json, linked_memory_ids_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, arc.arcName, arc.summary, arc.startDate || null, arc.endDate || null,
             arc.importanceScore ?? 0.7,
             JSON.stringify(arc.linkedProjectIds || []),
             JSON.stringify(arc.linkedMemoryIds || []),
             now, now);
      return { id, created: true };
    } catch (e: unknown) {
      console.error('[memory:saveNarrativeMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getNarrativeMemory', async (_e, opts: { activeOnly?: boolean; limit?: number } = {}) => {
    try {
      let sql = 'SELECT * FROM narrative_memory WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.activeOnly !== false) { sql += ' AND active_status = 1'; }
      sql += ' ORDER BY importance_score DESC, updated_at DESC LIMIT ?';
      params.push(opts.limit || 10);
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getNarrativeMemory]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // MEMORY SUMMARIES (daily/weekly/monthly/where-left-off)
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveMemorySummary',  async (_e, s: {
    summaryType: string; periodLabel?: string; summary: string;
    linkedMemoryIds?: string[]; linkedProjectIds?: string[];
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO memory_summaries
          (id, summary_type, period_label, summary, linked_memory_ids_json, linked_project_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, s.summaryType, s.periodLabel || null, s.summary,
             JSON.stringify(s.linkedMemoryIds || []),
             JSON.stringify(s.linkedProjectIds || []),
             new Date().toISOString());
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveMemorySummary]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getMemorySummaries', async (_e, opts: {
    summaryType?: string; limit?: number;
  } = {}) => {
    try {
      let sql = 'SELECT * FROM memory_summaries WHERE 1=1';
      const params: (string | number)[] = [];
      if (opts.summaryType) { sql += ' AND summary_type = ?'; params.push(opts.summaryType); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(opts.limit || 10);
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getMemorySummaries]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // MEMORY GRAPH EDGES
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:saveGraphEdge',  async (_e, edge: {
    fromEntityType: string; fromEntityId: string;
    toEntityType: string; toEntityId: string;
    relationshipType: string; weightScore?: number;
  }) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR REPLACE INTO memory_graph_edges
          (id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type, weight_score, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, edge.fromEntityType, edge.fromEntityId,
             edge.toEntityType, edge.toEntityId,
             edge.relationshipType, edge.weightScore ?? 0.5, now, now);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveGraphEdge]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:getGraphEdges', async (_e, opts: {
    fromEntityId?: string; toEntityId?: string;
    fromEntityType?: string; relationshipType?: string;
  } = {}) => {
    try {
      let sql = 'SELECT * FROM memory_graph_edges WHERE 1=1';
      const params: string[] = [];
      if (opts.fromEntityId)    { sql += ' AND from_entity_id = ?';    params.push(opts.fromEntityId); }
      if (opts.toEntityId)      { sql += ' AND to_entity_id = ?';      params.push(opts.toEntityId); }
      if (opts.fromEntityType)  { sql += ' AND from_entity_type = ?';  params.push(opts.fromEntityType); }
      if (opts.relationshipType){ sql += ' AND relationship_type = ?'; params.push(opts.relationshipType); }
      sql += ' ORDER BY weight_score DESC LIMIT 50';
      return db.prepare(sql).all(...params);
    } catch (e: unknown) {
      console.error('[memory:getGraphEdges]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // BANDWIDTH-AWARE DEEP CONTEXT BUILDER
  // ══════════════════════════════════════════════════════════════════════
  // Modes: shallow | normal | deep | maximum
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:buildContext', async (_e, params: {
    conversationId?: string;
    query?: string;
    maxFactsFetch?: number;
    bandwidth?: 'shallow' | 'normal' | 'deep' | 'maximum';
  }) => {
    try {
      const bandwidth = params.bandwidth || 'normal';
      return buildDeepContext(params.conversationId, params.query || '', params.maxFactsFetch, bandwidth);
    } catch (e: unknown) {
      console.error('[memory:buildContext]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:buildDeepContext', async (_e, params: {
    conversationId?: string;
    query?: string;
    bandwidth?: 'shallow' | 'normal' | 'deep' | 'maximum';
  }) => {
    try {
      return buildDeepContext(params.conversationId, params.query || '', undefined, params.bandwidth || 'maximum');
    } catch (e: unknown) {
      console.error('[memory:buildDeepContext]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // WHERE WE LEFT OFF — startup recovery summary
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:getWhereWeLeftOff', async () => {
    try {
      return buildWhereWeLeftOff();
    } catch (e: unknown) {
      console.error('[memory:getWhereWeLeftOff]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  ipcMain.handle('memory:saveWhereWeLeftOff',  async (_e, summary: string) => {
    if (!policyFlag('persistMemory')) return { id: null };
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // Keep only last 3 where-we-left-off entries
      const old = db.prepare(`SELECT id FROM memory_summaries WHERE summary_type = 'where_we_left_off' ORDER BY created_at DESC LIMIT -1 OFFSET 3`).all() as { id: string }[];
      for (const o of old) db.prepare('DELETE FROM memory_summaries WHERE id = ?').run(o.id);
      db.prepare(`INSERT INTO memory_summaries (id, summary_type, period_label, summary, created_at) VALUES (?, 'where_we_left_off', ?, ?, ?)`)
        .run(id, new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), summary, now);
      return { id };
    } catch (e: unknown) {
      console.error('[memory:saveWhereWeLeftOff]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // COMPRESSION — session end handler
  // ══════════════════════════════════════════════════════════════════════

  ipcMain.handle('memory:compressSession',  async (_e, opts: {
    conversationId: string;
    summary: string;
    unresolvedItems?: string[];
    emotionalPattern?: string;
  }) => {
    if (!policyFlag('persistMemory')) return { compressed: false };
    try {
      const now = new Date().toISOString();
      // Save session end summary
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO memory_summaries (id, summary_type, period_label, summary, created_at)
        VALUES (?, 'session_end', ?, ?, ?)
      `).run(id, `Session ${opts.conversationId.slice(0, 8)}`, opts.summary, now);

      // Update session memory with final state
      if (opts.unresolvedItems || opts.emotionalPattern) {
        db.prepare(`
          UPDATE session_memory SET
            summary = COALESCE(?, summary),
            unresolved_items_json = COALESCE(?, unresolved_items_json),
            emotional_pattern = COALESCE(?, emotional_pattern),
            updated_at = ?
          WHERE conversation_id = ?
        `).run(opts.summary, opts.unresolvedItems ? JSON.stringify(opts.unresolvedItems) : null,
               opts.emotionalPattern || null, now, opts.conversationId);
      }

      return { compressed: true, summaryId: id };
    } catch (e: unknown) {
      console.error('[memory:compressSession]', e instanceof Error ? e.message : String(e));
      return null as any;
    }
  });

  // ── Personal Tasks ────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS personal_tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
    priority INTEGER NOT NULL DEFAULT 2, due_at TEXT,
    created_at TEXT NOT NULL, completed_at TEXT
  )`).run();

  ipcMain.handle('tasks:list', (_e, filter?: { status?: string }) => {
    try {
      let sql = 'SELECT * FROM personal_tasks';
      const params: string[] = [];
      if (filter?.status) { sql += ' WHERE status = ?'; params.push(filter.status); }
      sql += ' ORDER BY CASE status WHEN \'doing\' THEN 0 WHEN \'todo\' THEN 1 ELSE 2 END, priority DESC, created_at DESC';
      return db.prepare(sql).all(...params);
    } catch (e) { console.error('[tasks:list]', e); return []; }
  });

  ipcMain.handle('tasks:create', (_e, task: { id: string; title: string; notes?: string; priority?: number; due_at?: string }) => {
    try {
      db.prepare('INSERT INTO personal_tasks (id,title,notes,status,priority,due_at,created_at) VALUES (?,?,?,\'todo\',?,?,?)')
        .run(task.id, task.title, task.notes || null, task.priority ?? 2, task.due_at || null, new Date().toISOString());
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('tasks:update', (_e, id: string, patch: { status?: string; title?: string; notes?: string; priority?: number }) => {
    try {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (patch.title !== undefined) { sets.push('title=?'); vals.push(patch.title); }
      if (patch.notes !== undefined) { sets.push('notes=?'); vals.push(patch.notes); }
      if (patch.priority !== undefined) { sets.push('priority=?'); vals.push(patch.priority); }
      if (patch.status !== undefined) {
        sets.push('status=?'); vals.push(patch.status);
        if (patch.status === 'done') { sets.push('completed_at=?'); vals.push(new Date().toISOString()); }
      }
      if (sets.length === 0) return { ok: true };
      vals.push(id);
      db.prepare(`UPDATE personal_tasks SET ${sets.join(',')} WHERE id=?`).run(...vals);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('tasks:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM personal_tasks WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── Contacts / CRM ────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
    company TEXT, role TEXT, notes TEXT, tags TEXT DEFAULT '[]',
    last_contact TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();

  // Migrate contacts table — add columns if missing
  try {
    const cols = (db.prepare("PRAGMA table_info(contacts)").all() as any[]).map((r:any) => r.name);
    if (!cols.includes('project_value'))  db.prepare("ALTER TABLE contacts ADD COLUMN project_value REAL DEFAULT 0").run();
    if (!cols.includes('revenue_total'))  db.prepare("ALTER TABLE contacts ADD COLUMN revenue_total REAL DEFAULT 0").run();
    if (!cols.includes('next_followup'))  db.prepare("ALTER TABLE contacts ADD COLUMN next_followup TEXT").run();
    if (!cols.includes('priority'))       db.prepare("ALTER TABLE contacts ADD COLUMN priority INTEGER DEFAULT 2").run();
    if (!cols.includes('source'))         db.prepare("ALTER TABLE contacts ADD COLUMN source TEXT").run();
  } catch { /* columns may already exist */ }

  ipcMain.handle('contacts:list', (_e, query?: string) => {
    try {
      if (query && query.trim()) {
        return db.prepare(`SELECT * FROM contacts WHERE
          name LIKE ? OR email LIKE ? OR company LIKE ? OR notes LIKE ?
          ORDER BY name ASC LIMIT 50`)
          .all(...Array(4).fill('%' + query.trim() + '%'));
      }
      return db.prepare('SELECT * FROM contacts ORDER BY name ASC').all();
    } catch (e) { return []; }
  });

  ipcMain.handle('contacts:get', (_e, id: string) => {
    try { return db.prepare('SELECT * FROM contacts WHERE id=?').get(id) || null; }
    catch { return null; }
  });

  ipcMain.handle('contacts:create', (_e, c: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO contacts (id,name,email,phone,company,role,notes,tags,last_contact,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(c.id,c.name,c.email||null,c.phone||null,c.company||null,c.role||null,
             c.notes||null,JSON.stringify(c.tags||[]),c.last_contact||null,now,now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('contacts:update', (_e, id: string, patch: Record<string,unknown>) => {
    try {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const allowed = ['name','email','phone','company','role','notes','tags','last_contact'];
      for (const k of allowed) {
        if (patch[k] !== undefined) {
          sets.push(k + '=?');
          vals.push(k === 'tags' ? JSON.stringify(patch[k]) : patch[k]);
        }
      }
      sets.push('updated_at=?'); vals.push(new Date().toISOString());
      if (sets.length < 2) return { ok: true };
      vals.push(id);
      db.prepare('UPDATE contacts SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('contacts:delete', (_e, id: string) => {
    try { db.prepare('DELETE FROM contacts WHERE id=?').run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── Finance ───────────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, amount REAL NOT NULL,
    category TEXT NOT NULL, description TEXT, date TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`).run();

  ipcMain.handle('finance:create', (_e, t: Record<string,unknown>) => {
    try {
      db.prepare(
        'INSERT INTO transactions (id,date,description,category,amount,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(
        String(t.id || ''), String(t.date || ''), String(t.description || ''),
        String(t.category || 'other'), Number(t.amount) || 0, String(t.type || 'expense'),
        String(t.created_at || new Date().toISOString()),
        String(t.updated_at || new Date().toISOString())
      );
      return { ok: true, id: t.id };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('finance:list', (_e, month?: string) => {
    try {
      if (month) return db.prepare("SELECT * FROM transactions WHERE date LIKE ? ORDER BY date DESC").all(month + '%');
      return db.prepare("SELECT * FROM transactions ORDER BY date DESC LIMIT 200").all();
    } catch { return []; }
  });
  ipcMain.handle('finance:add', (_e, t: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO transactions (id,type,amount,category,description,date,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(t.id, t.type, t.amount, t.category, t.description||null, t.date, now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('finance:delete', (_e, id: string) => {
    try { db.prepare("DELETE FROM transactions WHERE id=?").run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('finance:summary', (_e, month: string) => {
    try {
      const rows = db.prepare("SELECT type, SUM(amount) as total, category FROM transactions WHERE date LIKE ? GROUP BY type, category").all(month + '%') as {type:string;total:number;category:string}[];
      const income = rows.filter(r=>r.type==='income').reduce((s,r)=>s+r.total,0);
      const expenses = rows.filter(r=>r.type==='expense').reduce((s,r)=>s+r.total,0);
      return { income, expenses, net: income-expenses, breakdown: rows };
    } catch { return { income:0, expenses:0, net:0, breakdown:[] }; }
  });

  // ── Journal ───────────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, title TEXT,
    content TEXT NOT NULL, mood TEXT, tags TEXT DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();

  ipcMain.handle('journal:list', (_e, search?: string) => {
    try {
      if (search?.trim()) {
        return db.prepare("SELECT * FROM journal_entries WHERE content LIKE ? OR title LIKE ? ORDER BY date DESC LIMIT 50")
          .all('%'+search+'%', '%'+search+'%');
      }
      return db.prepare("SELECT id,date,title,mood,tags,created_at FROM journal_entries ORDER BY date DESC LIMIT 100").all();
    } catch { return []; }
  });
  ipcMain.handle('journal:get', (_e, id: string) => {
    try { return db.prepare("SELECT * FROM journal_entries WHERE id=?").get(id) || null; }
    catch { return null; }
  });
  ipcMain.handle('journal:save', (_e, entry: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO journal_entries (id,date,title,content,mood,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(date) DO UPDATE SET title=excluded.title,content=excluded.content,mood=excluded.mood,tags=excluded.tags,updated_at=excluded.updated_at`)
        .run(entry.id||crypto.randomUUID(),entry.date,entry.title||null,entry.content,entry.mood||null,JSON.stringify(entry.tags||[]),now,now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('journal:delete', (_e, id: string) => {
    try { db.prepare("DELETE FROM journal_entries WHERE id=?").run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── Reminders (persistent across restarts) ────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT,
    due_at TEXT NOT NULL, repeat TEXT DEFAULT 'none',
    done INTEGER DEFAULT 0, notified_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();

  ipcMain.handle('reminders:list', () => {
    try { return db.prepare("SELECT * FROM reminders ORDER BY due_at ASC").all(); }
    catch { return []; }
  });
  ipcMain.handle('reminders:save', (_e, r: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO reminders (id,title,notes,due_at,repeat,done,notified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes=excluded.notes,due_at=excluded.due_at,
        repeat=excluded.repeat,done=excluded.done,notified_at=excluded.notified_at,updated_at=excluded.updated_at`)
        .run(r.id,r.title,r.notes||null,r.dueAt||r.due_at,r.repeat||'none',r.done?1:0,r.notifiedAt||r.notified_at||null,now,now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('reminders:delete', (_e, id: string) => {
    try { db.prepare("DELETE FROM reminders WHERE id=?").run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('reminders:due', () => {
    try {
      const now = new Date().toISOString();
      return db.prepare("SELECT * FROM reminders WHERE due_at <= ? AND done=0 AND notified_at IS NULL").all(now);
    } catch { return []; }
  });

  // ── Lists ─────────────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '📝',
    color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, text TEXT NOT NULL,
    done INTEGER DEFAULT 0, position INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
  )`).run();

  ipcMain.handle('lists:all', () => {
    try {
      const allLists = db.prepare("SELECT * FROM lists ORDER BY updated_at DESC").all() as {id:string;name:string;icon:string;color:string;created_at:string;updated_at:string}[];
      return allLists.map(l => ({
        ...l,
        items: db.prepare("SELECT * FROM list_items WHERE list_id=? ORDER BY done ASC, position ASC, created_at ASC").all(l.id)
      }));
    } catch { return []; }
  });
  ipcMain.handle('lists:save', (_e, list: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO lists (id,name,icon,color,created_at,updated_at) VALUES (?,?,?,?,COALESCE((SELECT created_at FROM lists WHERE id=?),?),?)")
        .run(list.id, list.name, list.icon||'📝', list.color||null, list.id, now, now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('lists:delete', (_e, id: string) => {
    try { db.prepare("DELETE FROM lists WHERE id=?").run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('lists:add-item', (_e, listId: string, item: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      const pos = (db.prepare("SELECT COUNT(*) as c FROM list_items WHERE list_id=?").get(listId) as {c:number}).c;
      db.prepare("INSERT INTO list_items (id,list_id,text,done,position,created_at) VALUES (?,?,?,0,?,?)")
        .run(item.id, listId, item.text, pos, now);
      db.prepare("UPDATE lists SET updated_at=? WHERE id=?").run(now, listId);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('lists:toggle-item', (_e, itemId: string) => {
    try {
      db.prepare("UPDATE list_items SET done = CASE done WHEN 0 THEN 1 ELSE 0 END WHERE id=?").run(itemId);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('lists:delete-item', (_e, itemId: string) => {
    try { db.prepare("DELETE FROM list_items WHERE id=?").run(itemId); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('lists:clear-done', (_e, listId: string) => {
    try { db.prepare("DELETE FROM list_items WHERE list_id=? AND done=1").run(listId); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── Focus Sessions ────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS focus_sessions (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, duration_mins INTEGER NOT NULL,
    completed_at TEXT NOT NULL, henry_checkin TEXT
  )`).run();

  ipcMain.handle('focus:save', (_e, s: Record<string,unknown>) => {
    try {
      db.prepare("INSERT OR REPLACE INTO focus_sessions (id,task,duration_mins,completed_at,henry_checkin) VALUES (?,?,?,?,?)")
        .run(s.id, s.task, s.duration, s.completedAt, s.henryCheckIn||null);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('focus:list', (_e, limit=50) => {
    try { return db.prepare("SELECT * FROM focus_sessions ORDER BY completed_at DESC LIMIT ?").all(limit); }
    catch { return []; }
  });
  ipcMain.handle('focus:stats', () => {
    try {
      const today = new Date().toISOString().slice(0,10);
      const week = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      const todayMins = (db.prepare("SELECT SUM(duration_mins) as t FROM focus_sessions WHERE completed_at >= ?").get(today+'T00:00:00') as {t:number|null}).t || 0;
      const weekMins = (db.prepare("SELECT SUM(duration_mins) as t FROM focus_sessions WHERE completed_at >= ?").get(week+'T00:00:00') as {t:number|null}).t || 0;
      const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM focus_sessions").get() as {c:number}).c;
      return { todayMins, weekMins, totalSessions };
    } catch { return { todayMins:0, weekMins:0, totalSessions:0 }; }
  });

  // ── Weekly Review data pull ───────────────────────────────────────────────
  ipcMain.handle('weekly:data', () => {
    try {
      const week = new Date(Date.now()-7*86400000).toISOString();
      return {
        tasks: db.prepare("SELECT * FROM personal_tasks WHERE created_at >= ? OR updated_at >= ? ORDER BY status ASC LIMIT 20").all(week, week),
        journal: db.prepare("SELECT date,title,mood FROM journal_entries WHERE date >= ? ORDER BY date DESC LIMIT 7").all(week.slice(0,10)),
        finance: db.prepare("SELECT type,SUM(amount) as total FROM transactions WHERE date >= ? GROUP BY type").all(week.slice(0,10)),
        focusStats: db.prepare("SELECT SUM(duration_mins) as mins, COUNT(*) as sessions FROM focus_sessions WHERE completed_at >= ?").get(week),
        reminders: db.prepare("SELECT * FROM reminders WHERE done=0 ORDER BY due_at ASC LIMIT 10").all(),
        memories: db.prepare("SELECT fact,category FROM memory_facts ORDER BY importance DESC LIMIT 8").all(),
      };
    } catch (e) { return { tasks:[], journal:[], finance:[], focusStats:{mins:0,sessions:0}, reminders:[], memories:[] }; }
  });

  // ── Meeting Recordings ────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, duration_secs INTEGER DEFAULT 0,
    transcript TEXT, summary TEXT, action_items TEXT DEFAULT '[]',
    recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();

  ipcMain.handle('recordings:list', () => {
    try { return db.prepare("SELECT id,title,duration_secs,recorded_at,updated_at FROM recordings ORDER BY recorded_at DESC LIMIT 50").all(); }
    catch { return []; }
  });
  ipcMain.handle('recordings:get', (_e, id: string) => {
    try { return db.prepare("SELECT * FROM recordings WHERE id=?").get(id) || null; }
    catch { return null; }
  });
  ipcMain.handle('recordings:save', (_e, r: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO recordings (id,title,duration_secs,transcript,summary,action_items,recorded_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,duration_secs=excluded.duration_secs,
        transcript=excluded.transcript,summary=excluded.summary,action_items=excluded.action_items,updated_at=excluded.updated_at`)
        .run(r.id, r.title, r.durationSecs||0, r.transcript||null, r.summary||null, JSON.stringify(r.actionItems||[]), r.recordedAt||now, now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('recordings:delete', (_e, id: string) => {
    try { db.prepare("DELETE FROM recordings WHERE id=?").run(id); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  // ── Quick Captures (fast notes routed to tasks/reminders/journal) ─────────
  db.prepare(`CREATE TABLE IF NOT EXISTS quick_captures (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, routed_to TEXT,
    routed_id TEXT, captured_at TEXT NOT NULL
  )`).run();

  ipcMain.handle('capture:save', (_e, c: Record<string,unknown>) => {
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO quick_captures (id,text,routed_to,routed_id,captured_at) VALUES (?,?,?,?,?)")
        .run(c.id, c.text, c.routedTo||null, c.routedId||null, now);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });
  // ── Health & Habits ────────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS health_logs (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT,
    value REAL,
    unit TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS habits (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '✓',
    color TEXT DEFAULT '#7c3aed',
    target_per_day INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS habit_logs (
    id TEXT PRIMARY KEY,
    habit_id TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    note TEXT,
    logged_at TEXT DEFAULT (datetime('now')),
    UNIQUE(habit_id, date)
  )`).run();

  ipcMain.handle('health:logSave', (_e, log: { id?:string; date:string; category:string; label?:string; value?:number; unit?:string; note?:string }) => {
    try {
      const id = log.id || crypto.randomUUID();
      db.prepare(`INSERT OR REPLACE INTO health_logs (id, date, category, label, value, unit, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, log.date, log.category, log.label||null, log.value||null, log.unit||null, log.note||null);
      return { id };
    } catch(e) { return { error: String(e) }; }
  });
  ipcMain.handle('health:logsForDate', (_e, date: string) => {
    return db.prepare('SELECT * FROM health_logs WHERE date = ? ORDER BY created_at DESC').all(date);
  });
  ipcMain.handle('health:logsRange', (_e, from: string, to: string) => {
    return db.prepare('SELECT * FROM health_logs WHERE date >= ? AND date <= ? ORDER BY date DESC').all(from, to);
  });
  ipcMain.handle('health:logDelete', (_e, id: string) => {
    db.prepare('DELETE FROM health_logs WHERE id = ?').run(id);
    return { ok: true };
  });

  // Habits
  ipcMain.handle('health:habitList', () => db.prepare('SELECT * FROM habits WHERE active=1 ORDER BY created_at').all());
  ipcMain.handle('health:habitSave', (_e, h: { id?:string; name:string; icon?:string; color?:string; target_per_day?:number }) => {
    const id = h.id || crypto.randomUUID();
    db.prepare(`INSERT OR REPLACE INTO habits (id, name, icon, color, target_per_day)
      VALUES (?, ?, ?, ?, ?)`).run(id, h.name, h.icon||'✓', h.color||'#7c3aed', h.target_per_day||1);
    return { id };
  });
  ipcMain.handle('health:habitDelete', (_e, id: string) => {
    db.prepare('UPDATE habits SET active=0 WHERE id=?').run(id);
    return { ok: true };
  });
  ipcMain.handle('health:habitLog', (_e, opts: { habit_id: string; date: string; count?: number }) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO habit_logs (id, habit_id, date, count) VALUES (?, ?, ?, ?)
      ON CONFLICT(habit_id, date) DO UPDATE SET count=count+excluded.count`).run(id, opts.habit_id, opts.date, opts.count||1);
    return { ok: true };
  });
  ipcMain.handle('health:habitUnlog', (_e, opts: { habit_id: string; date: string }) => {
    db.prepare('DELETE FROM habit_logs WHERE habit_id=? AND date=?').run(opts.habit_id, opts.date);
    return { ok: true };
  });
  ipcMain.handle('health:habitLogsForDate', (_e, date: string) => {
    return db.prepare('SELECT * FROM habit_logs WHERE date=?').all(date);
  });
  ipcMain.handle('health:habitLogsRange', (_e, from: string, to: string) => {
    return db.prepare('SELECT * FROM habit_logs WHERE date>=? AND date<=? ORDER BY date DESC').all(from, to);
  });

  // ── Recurring transactions ──────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS recurring_transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    day_of_month INTEGER NOT NULL DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();

  ipcMain.handle('finance:recurring:list', () => {
    return db.prepare('SELECT * FROM recurring_transactions WHERE active=1 ORDER BY day_of_month').all();
  });
  ipcMain.handle('finance:recurring:save', (_e, r: { id?: string; type: string; amount: number; category: string; description?: string; day_of_month: number }) => {
    const id = r.id || crypto.randomUUID();
    db.prepare(`INSERT OR REPLACE INTO recurring_transactions (id, type, amount, category, description, day_of_month) VALUES (?,?,?,?,?,?)`)
      .run(id, r.type, r.amount, r.category, r.description || null, r.day_of_month || 1);
    return { id };
  });
  ipcMain.handle('finance:recurring:delete', (_e, id: string) => {
    db.prepare('UPDATE recurring_transactions SET active=0 WHERE id=?').run(id);
    return { ok: true };
  });
  // Auto-post recurring transactions for the current month if not already posted
  ipcMain.handle('finance:recurring:autopost', async () => {
    const today = new Date();
    const month = today.toISOString().slice(0, 7);
    const dayOfMonth = today.getDate();
    const recurrings = db.prepare('SELECT * FROM recurring_transactions WHERE active=1 AND day_of_month <= ?').all(dayOfMonth) as any[];
    let posted = 0;
    for (const r of recurrings) {
      const dateStr = `${month}-${String(r.day_of_month).padStart(2, '0')}`;
      const existing = db.prepare("SELECT id FROM transactions WHERE description LIKE ? AND date=?").get(`[Auto] ${r.description || r.category}%`, dateStr);
      if (!existing) {
        db.prepare(`INSERT INTO transactions (id, type, amount, category, description, date, created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(crypto.randomUUID(), r.type, r.amount, r.category, `[Auto] ${r.description || r.category}`, dateStr, new Date().toISOString());
        posted++;
      }
    }
    return { posted };
  });


  // ── Data Export/Backup ─────────────────────────────────────────────────────
  ipcMain.handle('data:export-backup', async () => {
    try {
      const nodeos = require('os') as typeof import('os');
      const nodefs = require('fs') as typeof import('fs');
      const nodepath = require('path') as typeof import('path');
      const { execSync } = require('child_process') as typeof import('child_process');

      const ts = new Date().toISOString().slice(0, 10);
      const desktopDir = nodepath.join(nodeos.homedir(), 'Desktop');
      const backupDir = nodepath.join(desktopDir, `henry-backup-${ts}`);
      nodefs.rmSync(backupDir, { recursive: true, force: true });
      nodefs.mkdirSync(backupDir, { recursive: true });

      // 1. Consistent database snapshot.
      //    copyFileSync() of a WAL database silently omits every transaction
      //    that has not been checkpointed yet, so the "backup" was missing
      //    recent data. db.backup() takes a real, consistent snapshot.
      const dbPath = (db as unknown as { name: string }).name;
      const snapshotPath = nodepath.join(backupDir, 'henry.db');
      await db.backup(snapshotPath);

      // 2. Strip secrets from the snapshot. The raw database carries the
      //    `providers` table and `*api_key*` settings; a backup written
      //    unencrypted to the Desktop leaked live credentials.
      try {
        const Database = (await import('better-sqlite3')).default;
        const snap = new Database(snapshotPath);
        try {
          snap.exec("UPDATE providers SET api_key = '' WHERE api_key IS NOT NULL AND api_key != ''");
          snap.exec("UPDATE settings SET value = '' WHERE key LIKE '%api_key%' AND value != ''");
          // VACUUM rewrites the file so the redacted values are not still
          // sitting in freed pages.
          snap.exec('VACUUM');
        } finally {
          snap.close();
        }
      } catch (e) {
        // Never ship an unredacted backup.
        nodefs.rmSync(backupDir, { recursive: true, force: true });
        return { ok: false, error: `Backup aborted: could not remove stored API keys (${e instanceof Error ? e.message : String(e)})` };
      }

      // 3. Export user tables as JSON (no credentials in these).
      const tables = [
        'journal_entries', 'tasks', 'reminders', 'contacts', 'goals',
        'habits', 'habit_logs', 'health_logs', 'transactions',
        'memory_facts', 'recordings', 'lists', 'list_items',
      ];
      const exportData: Record<string, unknown[]> = { _exported_at: [new Date().toISOString() as unknown] };
      for (const table of tables) {
        try {
          exportData[table] = db.prepare(`SELECT * FROM "${table}"`).all();
        } catch { exportData[table] = []; }
      }
      nodefs.writeFileSync(
        nodepath.join(backupDir, 'henry-data.json'),
        JSON.stringify(exportData, null, 2)
      );

      // 4. Zip if the `zip` tool exists; otherwise hand back the directory.
      //    The old code rm'd the staging dir only on success, so a missing
      //    `zip` binary (common on minimal installs) left the full database
      //    sitting on the Desktop while reporting failure.
      const zipPath = nodepath.join(desktopDir, `henry-backup-${ts}.zip`);
      const hasZip = (() => {
        try { execSync('which zip', { stdio: 'ignore' }); return true; } catch { return false; }
      })();
      if (hasZip) {
        execSync(`cd "${desktopDir}" && zip -r "${zipPath}" "${nodepath.basename(backupDir)}"`, { stdio: 'ignore' });
        nodefs.rmSync(backupDir, { recursive: true, force: true });
        return { ok: true, path: zipPath };
      }
      return { ok: true, path: backupDir };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('capture:list', (_e, limit=20) => {
    try { return db.prepare("SELECT * FROM quick_captures ORDER BY captured_at DESC LIMIT ?").all(limit); }
    catch { return []; }
  });
}

// ── Bandwidth-aware context builder ───────────────────────────────────────────

function buildDeepContext(
  conversationId: string | undefined,
  query: string,
  maxFactsFetch?: number,
  bandwidth: 'shallow' | 'normal' | 'deep' | 'maximum' = 'normal',
) {
  const factFetchCap = Math.min(Math.max(maxFactsFetch ?? 40, 10), 80);

  // ── Layer 1+2: Facts + Conversation Summary (all modes) ──────────────
  type FactRow = { fact: string; category: string; importance?: number; created_at?: string };
  let factRows: FactRow[] = [];

  if (bandwidth === 'shallow') {
    factRows = db.prepare(`SELECT fact, category, importance, created_at FROM memory_facts ORDER BY importance DESC, created_at DESC LIMIT 15`).all() as FactRow[];
  } else if (conversationId) {
    factRows = db.prepare(`
      SELECT fact, category, importance, created_at FROM memory_facts
      WHERE conversation_id IS NULL OR conversation_id = ?
      ORDER BY CASE WHEN conversation_id = ? THEN 0 ELSE 1 END, importance DESC, created_at DESC
      LIMIT ?
    `).all(conversationId, conversationId, factFetchCap) as FactRow[];
  } else {
    factRows = db.prepare(`SELECT fact, category, importance, created_at FROM memory_facts ORDER BY importance DESC, created_at DESC LIMIT ?`).all(factFetchCap) as FactRow[];
  }

  const facts: HenryLeanMemoryParts['facts'] = factRows.map((r) => ({
    fact: r.fact,
    category: r.category || 'general',
    importance: r.importance,
    created_at: r.created_at,
  }));

  let conversationSummary: string | null = null;
  if (conversationId) {
    const row = db.prepare(`SELECT summary FROM conversation_summaries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`).get(conversationId) as { summary: string } | undefined;
    conversationSummary = row?.summary ?? null;
  }

  // Workspace hints
  let workspaceHints: Array<{ file_path: string; summary: string }> = [];
  if (query && bandwidth !== 'shallow') {
    const like = `%${query}%`;
    const files = db.prepare(`SELECT file_path, summary FROM workspace_index WHERE file_path LIKE ? OR summary LIKE ? ORDER BY last_indexed DESC LIMIT 5`).all(like, like) as { file_path: string; summary: string }[];
    workspaceHints = files.slice(0, 3).map((f) => ({ file_path: f.file_path, summary: f.summary || '' }));
  }

  const lean: HenryLeanMemoryParts = { conversationSummary, facts, workspaceHints };

  // ── Shallow stops here ───────────────────────────────────────────────
  if (bandwidth === 'shallow') {
    return { lean, bandwidth, estimatedTokens: Math.ceil(JSON.stringify(lean).length / 4), factCount: facts.length };
  }

  // ── Normal+: Working memory + personal memory ────────────────────────
  const workingMemory = db.prepare(`SELECT * FROM working_memory WHERE user_id = 'default' LIMIT 1`).get() as any;
  const personalMemory = db.prepare(`
    SELECT memory_key, memory_value, memory_type, confidence_score, emotional_significance_score,
           strategic_significance_score, created_at
    FROM personal_memory WHERE active_status = 1
    ORDER BY strategic_significance_score DESC, emotional_significance_score DESC
    LIMIT 30
  `).all() as any[];

  const openCommitments = db.prepare(`
    SELECT description, importance_score, created_at FROM commitments
    WHERE status IN ('open','in_progress') ORDER BY importance_score DESC LIMIT 15
  `).all() as any[];

  const activeGoals = db.prepare(`
    SELECT title, summary, priority_score FROM goals
    WHERE status = 'active' ORDER BY priority_score DESC LIMIT 10
  `).all() as any[];

  // ── Deep+: Projects, relationship memory, narrative ──────────────────
  let activeProjects: any[] = [];
  let relationshipMemory: any[] = [];
  let narrativeMemory: any[] = [];

  if (bandwidth === 'deep' || bandwidth === 'maximum') {
    activeProjects = db.prepare(`SELECT name, summary, strategic_importance_score, last_active_at FROM projects WHERE status = 'active' ORDER BY strategic_importance_score DESC, last_active_at DESC LIMIT 5`).all() as any[];
    relationshipMemory = db.prepare(`SELECT pattern_type, summary, support_preference FROM relationship_memory ORDER BY confidence_score DESC LIMIT 5`).all() as any[];
    narrativeMemory = db.prepare(`SELECT arc_name, summary, importance_score FROM narrative_memory WHERE active_status = 1 ORDER BY importance_score DESC LIMIT 5`).all() as any[];
  }

  // ── Maximum: Milestones + recent sessions + where-we-left-off ────────
  let recentMilestones: any[] = [];
  let whereWeLeftOff: string | null = null;
  let recentSessions: any[] = [];

  if (bandwidth === 'maximum') {
    recentMilestones = db.prepare(`SELECT title, summary, milestone_type, significance_score, created_at FROM milestones ORDER BY significance_score DESC, created_at DESC LIMIT 5`).all() as any[];
    const wlo = db.prepare(`SELECT summary FROM memory_summaries WHERE summary_type = 'where_we_left_off' ORDER BY created_at DESC LIMIT 1`).get() as { summary: string } | undefined;
    whereWeLeftOff = wlo?.summary ?? null;
    recentSessions = db.prepare(`SELECT summary, emotional_pattern, created_at FROM memory_summaries WHERE summary_type = 'session_end' ORDER BY created_at DESC LIMIT 3`).all() as any[];
  }

  const extended = {
    workingMemory: workingMemory || null,
    personalMemory,
    openCommitments,
    activeGoals,
    activeProjects,
    relationshipMemory,
    narrativeMemory,
    recentMilestones,
    whereWeLeftOff,
    recentSessions,
  };

  const estimatedTokens = Math.ceil(JSON.stringify({ lean, extended }).length / 4);

  return {
    lean,
    extended,
    bandwidth,
    estimatedTokens,
    factCount: facts.length,
  };
}

// ── Where-we-left-off recovery builder ───────────────────────────────────────

function buildWhereWeLeftOff(): {
  lastProject: string | null;
  openCommitments: { description: string; importance_score: number }[];
  activeGoals: { title: string; priority_score: number }[];
  recentSession: { summary: string; emotional_pattern: string | null } | null;
  lastWhereWeLeftOff: string | null;
  recentMilestone: { title: string; milestone_type: string } | null;
} {
  const lastProject = db.prepare(`SELECT name FROM projects WHERE status = 'active' ORDER BY last_active_at DESC LIMIT 1`).get() as { name: string } | undefined;
  const openCommitments = db.prepare(`SELECT description, importance_score FROM commitments WHERE status IN ('open','in_progress') ORDER BY importance_score DESC LIMIT 5`).all() as { description: string; importance_score: number }[];
  const activeGoals = db.prepare(`SELECT title, priority_score FROM goals WHERE status = 'active' ORDER BY priority_score DESC LIMIT 3`).all() as { title: string; priority_score: number }[];
  const recentSession = db.prepare(`SELECT summary, emotional_pattern FROM memory_summaries WHERE summary_type = 'session_end' ORDER BY created_at DESC LIMIT 1`).get() as { summary: string; emotional_pattern: string | null } | undefined;
  const wlo = db.prepare(`SELECT summary FROM memory_summaries WHERE summary_type = 'where_we_left_off' ORDER BY created_at DESC LIMIT 1`).get() as { summary: string } | undefined;
  const recentMilestone = db.prepare(`SELECT title, milestone_type FROM milestones ORDER BY created_at DESC LIMIT 1`).get() as { title: string; milestone_type: string } | undefined;

  return {
    lastProject: lastProject?.name ?? null,
    openCommitments,
    activeGoals,
    recentSession: recentSession ?? null,
    lastWhereWeLeftOff: wlo?.summary ?? null,
    recentMilestone: recentMilestone ?? null,
  };
}

// ── Fact extraction utility ───────────────────────────────────────────────────

export function extractFactsFromMessage(content: string): string[] {
  const facts: string[] = [];
  const patterns = [
    /(?:my name is|i'm called|call me)\s+(\w+)/gi,
    /(?:i work (?:at|for|with))\s+(.+?)(?:\.|,|$)/gi,
    /(?:the (?:project|company|team) is)\s+(.+?)(?:\.|,|$)/gi,
    /(?:(?:use|using|prefer|want)\s+)(\w+(?:\s+\w+)?)\s+(?:for|as|to)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) facts.push(match[0].trim());
  }
  return facts;
}
