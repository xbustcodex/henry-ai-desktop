/**
 * Memory graph — a visual map of how the things Henry remembers relate.
 *
 * Layout is a small deterministic force simulation run in an effect, so the
 * same memories always produce a stable, readable map (no random jitter on
 * every render). Nodes are colour-coded by memory type; clicking one shows
 * what it is and what it is connected to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryGraphEdge, MemoryGraphNode, MemoryNodeType } from '../../types';
import { toast } from '../ui/Toast';

const TYPE_COLOR: Record<MemoryNodeType, string> = {
  project: '#38bdf8',
  goal: '#a78bfa',
  fact: '#34d399',
  commitment: '#fbbf24',
  milestone: '#f472b6',
  narrative: '#fb923c',
  personal: '#94a3b8',
};

const TYPE_LABEL: Record<MemoryNodeType, string> = {
  project: 'Projects',
  goal: 'Goals',
  fact: 'Facts',
  commitment: 'Commitments',
  milestone: 'Milestones',
  narrative: 'Narratives',
  personal: 'Personal',
};

interface Placed extends MemoryGraphNode {
  x: number;
  y: number;
  r: number;
}

const WIDTH = 900;
const HEIGHT = 560;

/** Deterministic seed so the layout is stable across reloads. */
function seededIndex(i: number): number {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function layout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Placed[] {
  const n = nodes.length;
  if (n === 0) return [];

  // Seed on a circle by type grouping — visually separates the categories
  // before the force pass pulls related things together.
  const byType = new Map<MemoryNodeType, number>();
  const placed: Placed[] = nodes.map((node, i) => {
    const seen = byType.get(node.type) ?? 0;
    byType.set(node.type, seen + 1);
    const angle = (i / n) * Math.PI * 2;
    return {
      ...node,
      x: WIDTH / 2 + Math.cos(angle) * (WIDTH * 0.32),
      y: HEIGHT / 2 + Math.sin(angle) * (HEIGHT * 0.34),
      r: 6 + node.weight * 12,
    };
  });

  const index = new Map(placed.map((p, i) => [p.id, i]));
  const links = edges
    .map((e) => ({ a: index.get(e.from), b: index.get(e.to), w: e.weight }))
    .filter((l): l is { a: number; b: number; w: number } => l.a !== undefined && l.b !== undefined);

  // ~180 iterations of a simple spring/repulsion pass. Cheap enough to run
  // synchronously for the few hundred nodes we cap at.
  for (let iter = 0; iter < 180; iter++) {
    const cooling = 1 - iter / 180;

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        let dx = placed[j].x - placed[i].x;
        let dy = placed[j].y - placed[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (seededIndex(i + j) - 0.5) || 0.7; dy = 0.7; d2 = 1; }
        const force = 900 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        placed[i].x -= fx; placed[i].y -= fy;
        placed[j].x += fx; placed[j].y += fy;
      }
    }

    for (const l of links) {
      const a = placed[l.a];
      const b = placed[l.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const target = 120;
      const force = (d - target) * 0.02 * l.w;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.x += fx; a.y += fy;
      b.x -= fx; b.y -= fy;
    }

    for (const p of placed) {
      p.x += (WIDTH / 2 - p.x) * 0.02 * cooling;
      p.y += (HEIGHT / 2 - p.y) * 0.02 * cooling;
      p.x = Math.max(p.r + 4, Math.min(WIDTH - p.r - 4, p.x));
      p.y = Math.max(p.r + 4, Math.min(HEIGHT - p.r - 4, p.y));
    }
  }

  return placed;
}

export default function MemoryGraphView() {
  const [nodes, setNodes] = useState<MemoryGraphNode[]>([]);
  const [edges, setEdges] = useState<MemoryGraphEdge[]>([]);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [hidden, setHidden] = useState<MemoryNodeType[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.henryAPI.getMemoryGraph();
      if (!res.ok) { toast.error(res.error || 'Could not build the memory graph.'); return; }
      setNodes(res.nodes);
      setEdges(res.edges);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleNodes = useMemo(() => nodes.filter((n) => !hidden.includes(n.type)), [nodes, hidden]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to)), [edges, visibleIds]);

  useEffect(() => {
    setPlaced(layout(visibleNodes, visibleEdges));
  }, [visibleNodes, visibleEdges]);

  const neighbours = useMemo(() => {
    if (!selected) return [];
    const out: { id: string; label: string; dir: 'out' | 'in' }[] = [];
    for (const e of visibleEdges) {
      if (e.from === selected) out.push({ id: e.to, label: e.type, dir: 'out' });
      else if (e.to === selected) out.push({ id: e.from, label: e.type, dir: 'in' });
    }
    return out;
  }, [selected, visibleEdges]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  /** Zoom the viewBox about its centre, preserving the aspect ratio. */
  const zoom = (factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const [x, y, w, h] = (svg.getAttribute('viewBox') ?? `0 0 ${WIDTH} ${HEIGHT}`)
      .split(' ')
      .map(Number);
    if (!Number.isFinite(w) || w === 0) return;
    const nw = Math.max(240, Math.min(WIDTH * 2, w * factor));
    const nh = (h / w) * nw;
    svg.setAttribute('viewBox', `${x + (w - nw) / 2} ${y + (h - nh) / 2} ${nw} ${nh}`);
  };

  const presentTypes = useMemo(() => {
    const t: MemoryNodeType[] = [];
    for (const n of nodes) if (!t.includes(n.type)) t.push(n.type);
    return t;
  }, [nodes]);

  if (loading) {
    return <p className="text-sm text-henry-text-muted p-4">Building the memory graph…</p>;
  }

  if (nodes.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-henry-text-muted">
          Nothing to map yet. As Henry saves projects, goals, facts and commitments, the
          connections between them show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex flex-wrap items-center gap-2">
        {presentTypes.map((t) => {
          const on = !hidden.includes(t);
          return (
            <button
              key={t}
              onClick={() => setHidden((h) => (on ? [...h, t] : h.filter((x) => x !== t)))}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border transition-colors ${
                on ? 'border-henry-border text-henry-text' : 'border-transparent text-henry-text-muted/50 line-through'
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: TYPE_COLOR[t] }} />
              {TYPE_LABEL[t]}
              <span className="text-henry-text-muted">({nodes.filter((n) => n.type === t).length})</span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoom(0.8)} className="henry-btn px-2 py-1 text-xs" title="Zoom in">+</button>
          <button onClick={() => zoom(1.25)} className="henry-btn px-2 py-1 text-xs" title="Zoom out">−</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-full bg-henry-bg/40 rounded-xl border border-henry-border/40"
        >
          {visibleEdges.map((e, i) => {
            const a = placed.find((p) => p.id === e.from);
            const b = placed.find((p) => p.id === e.to);
            if (!a || !b) return null;
            const active = selected === e.from || selected === e.to;
            return (
              <line
                key={`${e.from}-${e.to}-${i}`}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={active ? 'hsl(var(--accent))' : 'currentColor'}
                strokeOpacity={active ? 0.9 : 0.18 + e.weight * 0.2}
                strokeWidth={active ? 2 : 0.6 + e.weight * 1.2}
              />
            );
          })}
          {placed.map((p) => {
            const isSel = selected === p.id;
            return (
              <g key={p.id} onClick={() => setSelected(isSel ? null : p.id)} style={{ cursor: 'pointer' }}>
                <circle
                  cx={p.x} cy={p.y} r={p.r}
                  fill={TYPE_COLOR[p.type]}
                  fillOpacity={isSel ? 0.95 : 0.55}
                  stroke={isSel ? 'white' : TYPE_COLOR[p.type]}
                  strokeWidth={isSel ? 2 : 1}
                />
                <text
                  x={p.x} y={p.y + p.r + 11}
                  textAnchor="middle"
                  className="fill-current"
                  fontSize="9"
                  opacity={isSel ? 1 : 0.65}
                >
                  {p.label.length > 22 ? `${p.label.slice(0, 21)}…` : p.label}
                </text>
              </g>
            );
          })}
        </svg>

        {selected && (
          <div className="absolute right-2 top-2 w-64 max-h-[85%] overflow-auto rounded-xl border border-henry-border bg-henry-surface p-3 text-xs shadow-xl">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="font-semibold text-henry-text">{byId.get(selected)?.label}</span>
              <button onClick={() => setSelected(null)} className="text-henry-text-muted hover:text-henry-text">×</button>
            </div>
            <p className="text-henry-text-muted mb-2">{byId.get(selected)?.detail}</p>
            {neighbours.length > 0 ? (
              <>
                <p className="text-henry-text-muted uppercase tracking-wide text-[10px] mb-1">Connected</p>
                <ul className="space-y-1">
                  {neighbours.map((nb, i) => (
                    <li key={`${nb.id}-${i}`}>
                      <button
                        onClick={() => setSelected(nb.id)}
                        className="text-left hover:text-henry-text flex items-center gap-1.5"
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TYPE_COLOR[byId.get(nb.id)?.type ?? 'fact'] }} />
                        <span className="truncate">{byId.get(nb.id)?.label ?? nb.id}</span>
                        <span className="text-henry-text-muted/70 text-[10px] ml-auto shrink-0">{nb.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-henry-text-muted">Not linked to anything yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
