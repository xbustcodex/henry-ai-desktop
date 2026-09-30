/**
 * Memory graph — how the things Henry remembers relate to each other.
 *
 * The graph is derived from relationships Henry actually stores, never
 * invented: FK columns (commitments/milestones → projects), the narrative
 * link arrays, and any explicit `memory_graph_edges` rows. A fresh install
 * with no memories yields an empty graph rather than a fabricated one.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';

export type MemoryNodeType =
  | 'fact' | 'project' | 'goal' | 'commitment' | 'milestone' | 'narrative' | 'personal';

export interface MemoryGraphNode {
  id: string;
  type: MemoryNodeType;
  label: string;
  detail: string;
  /** 0..1 — drives node size in the view. */
  weight: number;
  updatedAt: string | null;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
}

/** Keys are `${type}:${id}` so entity refs from memory_graph_edges line up. */
const key = (type: string, id: string) => `${type}:${id}`;

function parseIdArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function clamp01(n: unknown, fallback = 0.5): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function truncate(s: string | null | undefined, n = 160): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function buildMemoryGraph(db: Database.Database): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodes = new Map<string, MemoryGraphNode>();
  const edges: MemoryGraphEdge[] = [];
  const addEdge = (from: string, to: string, type: string, weight = 0.6) => {
    if (from === to) return;
    if (!nodes.has(from) || !nodes.has(to)) return; // only connect nodes we actually show
    if (edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return;
    edges.push({ from, to, type, weight });
  };

  // ── Nodes ────────────────────────────────────────────────────────────────
  const facts = db.prepare('SELECT id, fact, category, importance, created_at FROM memory_facts ORDER BY importance DESC, created_at DESC LIMIT 400').all() as
    { id: string; fact: string; category: string | null; importance: number | null; created_at: string }[];
  for (const f of facts) {
    nodes.set(key('fact', f.id), {
      id: key('fact', f.id), type: 'fact',
      label: truncate(f.fact, 70), detail: f.category || 'fact',
      weight: clamp01((f.importance ?? 5) / 10, 0.5), updatedAt: f.created_at ?? null,
    });
  }

  const projects = db.prepare('SELECT id, name, status, summary, strategic_importance_score, updated_at FROM projects').all() as
    { id: string; name: string; status: string | null; summary: string | null; strategic_importance_score: number | null; updated_at: string | null }[];
  for (const p of projects) {
    nodes.set(key('project', p.id), {
      id: key('project', p.id), type: 'project',
      label: truncate(p.name, 60), detail: [p.status, truncate(p.summary, 90)].filter(Boolean).join(' · ') || 'project',
      weight: clamp01(p.strategic_importance_score, 0.6), updatedAt: p.updated_at ?? null,
    });
  }

  const goals = db.prepare('SELECT id, title, status, summary, priority_score, updated_at FROM goals').all() as
    { id: string; title: string; status: string | null; summary: string | null; priority_score: number | null; updated_at: string | null }[];
  for (const g of goals) {
    nodes.set(key('goal', g.id), {
      id: key('goal', g.id), type: 'goal',
      label: truncate(g.title, 70), detail: [g.status, truncate(g.summary, 90)].filter(Boolean).join(' · ') || 'goal',
      weight: clamp01(g.priority_score, 0.55), updatedAt: g.updated_at ?? null,
    });
  }

  const commitments = db.prepare('SELECT id, description, status, project_id, importance_score, created_at FROM commitments').all() as
    { id: string; description: string; status: string | null; project_id: string | null; importance_score: number | null; created_at: string | null }[];
  for (const c of commitments) {
    nodes.set(key('commitment', c.id), {
      id: key('commitment', c.id), type: 'commitment',
      label: truncate(c.description, 70), detail: c.status || 'commitment',
      weight: clamp01(c.importance_score, 0.5), updatedAt: c.created_at ?? null,
    });
  }

  const milestones = db.prepare('SELECT id, title, milestone_type, project_id, significance_score, created_at FROM milestones').all() as
    { id: string; title: string; milestone_type: string | null; project_id: string | null; significance_score: number | null; created_at: string | null }[];
  for (const m of milestones) {
    nodes.set(key('milestone', m.id), {
      id: key('milestone', m.id), type: 'milestone',
      label: truncate(m.title, 70), detail: m.milestone_type || 'milestone',
      weight: clamp01(m.significance_score, 0.5), updatedAt: m.created_at ?? null,
    });
  }

  const narratives = db.prepare('SELECT id, arc_name, summary, importance_score, active_status, linked_project_ids_json, linked_memory_ids_json, updated_at FROM narrative_memory').all() as
    { id: string; arc_name: string; summary: string | null; importance_score: number | null; active_status: number | null; linked_project_ids_json: string | null; linked_memory_ids_json: string | null; updated_at: string | null }[];

  // ── Edges from real stored relationships ────────────────────────────────
  for (const c of commitments) {
    if (c.project_id) addEdge(key('commitment', c.id), key('project', c.project_id), 'commitment_in_project', 0.8);
  }
  for (const m of milestones) {
    if (m.project_id) addEdge(key('milestone', m.id), key('project', m.project_id), 'milestone_in_project', 0.75);
  }
  for (const n of narratives) {
    nodes.set(key('narrative', n.id), {
      id: key('narrative', n.id), type: 'narrative',
      label: truncate(n.arc_name, 70), detail: truncate(n.summary, 110) || (n.active_status ? 'active arc' : 'arc'),
      weight: clamp01(n.importance_score, 0.65), updatedAt: n.updated_at ?? null,
    });
    for (const pid of parseIdArray(n.linked_project_ids_json)) {
      addEdge(key('narrative', n.id), key('project', pid), 'narrative_covers_project', 0.7);
    }
    for (const mid of parseIdArray(n.linked_memory_ids_json)) {
      // These ids may point at personal_memory or memory_facts; link whichever exists.
      if (nodes.has(key('personal', mid))) addEdge(key('narrative', n.id), key('personal', mid), 'narrative_cites_memory', 0.6);
      else if (nodes.has(key('fact', mid))) addEdge(key('narrative', n.id), key('fact', mid), 'narrative_cites_fact', 0.6);
    }
  }

  const personal = db.prepare('SELECT id, memory_key, memory_value, memory_type, updated_at FROM personal_memory').all() as
    { id: string; memory_key: string | null; memory_value: string | null; memory_type: string | null; updated_at: string | null }[];
  for (const p of personal) {
    nodes.set(key('personal', p.id), {
      id: key('personal', p.id), type: 'personal',
      label: truncate(p.memory_key || p.memory_value || 'memory', 70),
      detail: [p.memory_type, truncate(p.memory_value, 90)].filter(Boolean).join(' · ') || 'memory',
      weight: 0.5, updatedAt: p.updated_at ?? null,
    });
  }

  // Explicit edges (entity ids here are the raw table ids).
  const explicit = db.prepare('SELECT from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type, weight_score FROM memory_graph_edges ORDER BY weight_score DESC LIMIT 300').all() as
    { from_entity_type: string; from_entity_id: string; to_entity_type: string; to_entity_id: string; relationship_type: string; weight_score: number | null }[];
  for (const e of explicit) {
    addEdge(
      key(e.from_entity_type, e.from_entity_id),
      key(e.to_entity_type, e.to_entity_id),
      e.relationship_type || 'related',
      clamp01(e.weight_score, 0.5),
    );
  }

  return { nodes: [...nodes.values()], edges };
}

export function registerMemoryGraphHandlers(db: Database.Database): void {
  ipcMain.handle('memory:getGraph', () => {
    try {
      return { ok: true, ...buildMemoryGraph(db) };
    } catch (e: unknown) {
      console.error('[memory:getGraph]', e);
      return { ok: false, nodes: [], edges: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
}
