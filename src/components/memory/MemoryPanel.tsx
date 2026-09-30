/**
 * Henry Memory Panel — see and manage everything Henry remembers.
 *
 * Surfaces all 7 layers of Henry's memory blueprint:
 *   - Facts        (Layer 4 — personal_memory)
 *   - Projects     (Layer 5 — projects + project_memory)
 *   - Goals        (goals + commitments)
 *   - Story        (Layer 7 — narrative_memory + milestones)
 *   - Live         (Layer 3 — working_memory, read-only snapshot)
 *
 * Each tab lets you see what Henry knows, add new entries, edit, or delete.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import MemoryGraphView from './MemoryGraphView';
import { sendToHenry } from '../../actions/store/chatBridgeStore';
import { useStore } from '../../store';
import { confirmDialog, toast } from '../ui/Toast';

const api = (typeof window !== 'undefined' ? (window as any).henryAPI : null) as Record<string, (...a: any[]) => Promise<any>> | null;

// ── Types (loose, since IPC returns Record<string,unknown>) ─────────────────
interface Fact { id: string; fact?: string; memory_value?: string; memory_key?: string; category?: string; memory_type?: string; importance?: number; confidence_score?: number; relevance_score?: number; created_at: string; }
interface Project { id: string; name: string; type?: string; status: string; summary?: string; updated_at?: string; last_active_at?: string; }
interface Goal { id: string; title: string; summary?: string; status: string; priority_score?: number; updated_at?: string; }
interface Commitment { id: string; description: string; status: string; due_date?: string; created_at: string; }
interface Narrative { id: string; arc_name: string; summary: string; start_date?: string; end_date?: string; importance_score?: number; active_status?: number; }
interface Milestone { id: string; title: string; summary?: string; milestone_type: string; significance_score?: number; created_at: string; }

const FACT_CATS = ['identity','preference','goal','relationship','health','finance','work','belief','habit','project','other'];
const FACT_ICONS: Record<string, string> = {
  identity: '🪪', preference: '❤️', goal: '◎', relationship: '🤝', health: '🏃',
  finance: '💰', work: '💼', belief: '🙏', habit: '✓', project: '◧', other: '📌',
};
const NARRATIVE_KINDS = ['origin','arc','transition','breakthrough','setback','chapter'];
const MILESTONE_KINDS = ['win','setback','launch','decision','realization','breakthrough','other'];

const inputCls = 'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

function L({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1.5 block">{children}</label>;
}

type TabId = 'facts' | 'projects' | 'goals' | 'story' | 'live' | 'graph';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'facts',    label: 'Facts',    icon: '🧠' },
  { id: 'projects', label: 'Projects', icon: '◧' },
  { id: 'goals',    label: 'Goals',    icon: '◎' },
  { id: 'story',    label: 'Story',    icon: '📜' },
  { id: 'live',     label: 'Live',     icon: '⚡' },
  { id: 'graph',    label: 'Graph',    icon: '🕸️' },
];

export default function MemoryPanel() {
  const { setCurrentView } = useStore();
  const [tab, setTab] = useState<TabId>('facts');
  const [search, setSearch] = useState('');

  // ── Layer data ─────────────────────────────────────────────────────────
  const [facts, setFacts] = useState<Fact[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [narratives, setNarratives] = useState<Narrative[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [working, setWorking] = useState<Record<string, any> | null>(null);
  const [whereLeftOff, setWhereLeftOff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Add forms ──────────────────────────────────────────────────────────
  const [adding, setAdding] = useState<TabId | null>(null);
  const [factForm, setFactForm] = useState({ memory_value: '', memory_type: 'identity', confidence_score: 0.8 });
  const [projectForm, setProjectForm] = useState({ name: '', type: 'general', status: 'active', summary: '' });
  const [goalForm, setGoalForm] = useState({ title: '', summary: '', status: 'active', priority_score: 0.5 });
  const [narrativeForm, setNarrativeForm] = useState({ arc_name: '', summary: '', importance_score: 0.7 });
  const [milestoneForm, setMilestoneForm] = useState({ title: '', summary: '', milestone_type: 'win', significance_score: 0.7 });

  // ── Edit state (in-place editing) ──────────────────────────────────────
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editFactDraft, setEditFactDraft] = useState({ memory_value: '', memory_type: 'identity', confidence_score: 0.8 });
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editProjectDraft, setEditProjectDraft] = useState({ name: '', type: 'general', status: 'active', summary: '' });
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [editGoalDraft, setEditGoalDraft] = useState({ title: '', summary: '', status: 'active', priority_score: 0.5 });

  const reload = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const [f, p, g, c, n, m, wm, wlo] = await Promise.all([
        api.getAllFacts?.(200).catch(() => []),
        api.getProjects?.({}).catch(() => []),
        api.getGoals?.({}).catch(() => []),
        api.getCommitments?.({}).catch(() => []),
        api.getNarrativeMemory?.({}).catch(() => []),
        api.getMilestones?.({}).catch(() => []),
        api.getWorkingMemory?.().catch(() => null),
        api.getWhereWeLeftOff?.().catch(() => null),
      ]);
      setFacts(f || []);
      setProjects(p || []);
      setGoals(g || []);
      setCommitments(c || []);
      setNarratives(n || []);
      setMilestones(m || []);
      setWorking(wm || null);
      setWhereLeftOff(typeof wlo === 'string' ? wlo : (wlo?.summary || wlo?.value || null));
    } catch (e) { console.warn('memory load failed', e); }
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // ── Save handlers ──────────────────────────────────────────────────────
  async function saveFact() {
    if (!factForm.memory_value.trim() || !api?.savePersonalMemory) return;
    await api.savePersonalMemory({
      memory_key: factForm.memory_type,
      memory_value: factForm.memory_value,
      memory_type: factForm.memory_type,
      confidence_score: factForm.confidence_score,
      relevance_score: 0.7,
    });
    setFactForm({ memory_value: '', memory_type: 'identity', confidence_score: 0.8 });
    setAdding(null);
    void reload();
  }
  async function delFact(id: string) {
    if (!api?.deletePersonalMemory) return;
    // R3-Fix 1: was native confirm() — replaced with in-app modal.
    if (!(await confirmDialog('Delete this memory?', { destructive: true, confirmLabel: 'Delete' }))) return;
    try {
      await api.deletePersonalMemory(id);
      toast.success('Memory deleted');
      void reload();
    } catch (e) {
      toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Edit handlers (in-place) ───────────────────────────────────────────
  function startEditFact(f: Fact) {
    setEditingFactId(f.id);
    setEditFactDraft({
      memory_value: f.memory_value || f.fact || '',
      memory_type: f.memory_type || f.category || 'identity',
      confidence_score: f.confidence_score ?? 0.8,
    });
  }
  async function saveEditFact() {
    if (!editingFactId || !api?.updatePersonalMemory) { setEditingFactId(null); return; }
    if (!editFactDraft.memory_value.trim()) return;
    await api.updatePersonalMemory(editingFactId, {
      memory_value: editFactDraft.memory_value,
      memory_type: editFactDraft.memory_type,
      memory_key: editFactDraft.memory_type,
      confidence_score: editFactDraft.confidence_score,
    });
    setEditingFactId(null);
    void reload();
  }

  function startEditProject(p: Project) {
    setEditingProjectId(p.id);
    setEditProjectDraft({
      name: p.name || '',
      type: p.type || 'general',
      status: p.status || 'active',
      summary: p.summary || '',
    });
  }
  async function saveEditProject() {
    if (!editingProjectId || !api?.updateProject) { setEditingProjectId(null); return; }
    if (!editProjectDraft.name.trim()) return;
    await api.updateProject(editingProjectId, editProjectDraft);
    setEditingProjectId(null);
    void reload();
  }

  function startEditGoal(g: Goal) {
    setEditingGoalId(g.id);
    setEditGoalDraft({
      title: g.title || '',
      summary: g.summary || '',
      status: g.status || 'active',
      priority_score: g.priority_score ?? 0.5,
    });
  }
  async function saveEditGoal() {
    if (!editingGoalId || !api?.updateGoal) { setEditingGoalId(null); return; }
    if (!editGoalDraft.title.trim()) return;
    await api.updateGoal(editingGoalId, editGoalDraft);
    setEditingGoalId(null);
    void reload();
  }

  async function saveProject() {
    if (!projectForm.name.trim() || !api?.saveProject) return;
    await api.saveProject(projectForm);
    setProjectForm({ name: '', type: 'general', status: 'active', summary: '' });
    setAdding(null);
    void reload();
  }

  async function saveGoal() {
    if (!goalForm.title.trim() || !api?.saveGoal) return;
    await api.saveGoal(goalForm);
    setGoalForm({ title: '', summary: '', status: 'active', priority_score: 0.5 });
    setAdding(null);
    void reload();
  }

  async function saveNarrative() {
    if (!narrativeForm.arc_name.trim() || !api?.saveNarrativeMemory) return;
    await api.saveNarrativeMemory({ ...narrativeForm, active_status: 1 });
    setNarrativeForm({ arc_name: '', summary: '', importance_score: 0.7 });
    setAdding(null);
    void reload();
  }

  async function saveMilestone() {
    if (!milestoneForm.title.trim() || !api?.saveMilestone) return;
    // The IPC handler takes camelCase (milestoneType/significanceScore). The
    // form state is snake_case, so passing it straight through silently
    // dropped the chosen type — every milestone was stored as "win" at 0.7.
    await api.saveMilestone({
      title: milestoneForm.title,
      summary: milestoneForm.summary,
      milestoneType: milestoneForm.milestone_type,
      significanceScore: milestoneForm.significance_score,
    });
    setMilestoneForm({ title: '', summary: '', milestone_type: 'win', significance_score: 0.7 });
    setAdding(null);
    void reload();
  }

  // ── Counts for tab badges ──────────────────────────────────────────────
  const counts: Record<TabId, number> = {
    facts: facts.length,
    projects: projects.length,
    goals: goals.length + commitments.filter(c => c.status === 'open' || c.status === 'in_progress').length,
    story: narratives.length + milestones.length,
    live: 0,
    graph: projects.length + goals.length + facts.length + commitments.length + milestones.length + narratives.length,
  };

  // ── Filter for search across visible tab ───────────────────────────────
  const visibleFacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return facts;
    return facts.filter(f => (f.memory_value || f.fact || '').toLowerCase().includes(q) || (f.memory_type || f.category || '').toLowerCase().includes(q));
  }, [facts, search]);

  const groupedFacts = useMemo(() => {
    const out = new Map<string, Fact[]>();
    visibleFacts.forEach(f => {
      const cat = (f.memory_type || f.category || 'other').toLowerCase();
      if (!out.has(cat)) out.set(cat, []);
      out.get(cat)!.push(f);
    });
    return out;
  }, [visibleFacts]);

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-henry-text">Memory</h1>
            <p className="text-[11px] text-henry-text-muted mt-0.5">
              {facts.length} facts · {projects.length} projects · {goals.length} goals · {milestones.length} milestones
            </p>
          </div>
          <button onClick={() => { sendToHenry('Summarize what you know about me right now — the most important facts, active projects, current goals, and where we left off.'); setCurrentView('chat' as any); }}
            className="text-[11px] px-3 py-1.5 rounded-xl bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 transition-all">
            ⚡ What do you know about me?
          </button>
        </div>

        {/* Where-we-left-off ribbon */}
        {whereLeftOff && (
          <div className="mb-3 p-2.5 rounded-xl bg-henry-accent/8 border border-henry-accent/20">
            <p className="text-[10px] uppercase tracking-wider text-henry-accent font-semibold mb-0.5">Where we left off</p>
            <p className="text-[12px] text-henry-text leading-snug">{whereLeftOff}</p>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-3 overflow-x-auto pb-0.5">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all whitespace-nowrap ${
                tab === t.id ? 'bg-henry-accent text-white' : 'bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
              }`}>
              {t.icon} {t.label}{counts[t.id] > 0 && ` (${counts[t.id]})`}
            </button>
          ))}
        </div>

        {/* Search (Facts only) */}
        {tab === 'facts' && (
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search memory…"
            className={inputCls} />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {loading && <p className="text-center text-henry-text-muted text-sm py-8">Loading…</p>}

        {/* ── FACTS TAB ─────────────────────────────────────────────── */}
        {!loading && tab === 'facts' && (
          <>
            <div className="flex justify-end">
              <button onClick={() => setAdding(adding === 'facts' ? null : 'facts')}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all">
                {adding === 'facts' ? '✕ Cancel' : '+ Add fact'}
              </button>
            </div>

            {adding === 'facts' && (
              <div className="p-4 rounded-2xl bg-henry-surface/40 border border-henry-border/20 space-y-3">
                <div>
                  <L>What should Henry remember?</L>
                  <textarea rows={2} value={factForm.memory_value} onChange={e => setFactForm({ ...factForm, memory_value: e.target.value })}
                    placeholder="e.g. I run MixedMakerShop and prefer concise direct answers" className={inputCls + ' resize-none'} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <L>Category</L>
                    <select value={factForm.memory_type} onChange={e => setFactForm({ ...factForm, memory_type: e.target.value })} className={inputCls}>
                      {FACT_CATS.map(c => <option key={c} value={c}>{FACT_ICONS[c]} {c}</option>)}
                    </select>
                  </div>
                  <div>
                    <L>Confidence ({Math.round(factForm.confidence_score * 100)}%)</L>
                    <input type="range" min={0.1} max={1} step={0.05} value={factForm.confidence_score}
                      onChange={e => setFactForm({ ...factForm, confidence_score: Number(e.target.value) })}
                      className="w-full mt-2" />
                  </div>
                </div>
                <button onClick={() => void saveFact()} disabled={!factForm.memory_value.trim()}
                  className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40">Save</button>
              </div>
            )}

            {Array.from(groupedFacts.entries()).map(([cat, items]) => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">{FACT_ICONS[cat] || '📌'}</span>
                  <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold capitalize">{cat}</p>
                  <span className="text-[9px] text-henry-text-muted/60">({items.length})</span>
                </div>
                <div className="space-y-1.5">
                  {items.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0)).map(f => {
                    const isEditing = editingFactId === f.id;
                    if (isEditing) {
                      return (
                        <div key={f.id} className="p-3 rounded-xl bg-henry-accent/8 border border-henry-accent/30 space-y-2">
                          <textarea rows={2} value={editFactDraft.memory_value}
                            onChange={e => setEditFactDraft({ ...editFactDraft, memory_value: e.target.value })}
                            className={inputCls + ' resize-none'} autoFocus />
                          <div className="grid grid-cols-2 gap-2">
                            <select value={editFactDraft.memory_type}
                              onChange={e => setEditFactDraft({ ...editFactDraft, memory_type: e.target.value })}
                              className={inputCls}>
                              {FACT_CATS.map(c => <option key={c} value={c}>{FACT_ICONS[c]} {c}</option>)}
                            </select>
                            <div>
                              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted mb-0.5">
                                Confidence ({Math.round(editFactDraft.confidence_score * 100)}%)
                              </p>
                              <input type="range" min={0.1} max={1} step={0.05}
                                value={editFactDraft.confidence_score}
                                onChange={e => setEditFactDraft({ ...editFactDraft, confidence_score: Number(e.target.value) })}
                                className="w-full" />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => setEditingFactId(null)}
                              className="flex-1 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-[11px] text-henry-text-muted hover:text-henry-text">
                              Cancel
                            </button>
                            <button onClick={() => void saveEditFact()}
                              disabled={!editFactDraft.memory_value.trim()}
                              className="flex-1 py-1.5 rounded-lg bg-henry-accent text-white text-[11px] font-semibold disabled:opacity-40">
                              Save changes
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={f.id} className="group flex items-start gap-2 p-2.5 rounded-xl bg-henry-surface/40 border border-henry-border/10 hover:border-henry-border/30 transition-all">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-henry-text leading-snug">{f.memory_value || f.fact}</p>
                          <div className="flex items-center gap-3 mt-1">
                            {(f.confidence_score ?? f.importance) != null && (
                              <span className="text-[9px] text-henry-text-muted">
                                conf {Math.round((f.confidence_score ?? (f.importance ?? 0) / 10) * 100)}%
                              </span>
                            )}
                            <span className="text-[9px] text-henry-text-muted">{new Date(f.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-all">
                          <button onClick={() => startEditFact(f)}
                            className="p-1 text-henry-text-muted hover:text-henry-accent text-xs"
                            title="Edit">✎</button>
                          <button onClick={() => void delFact(f.id)}
                            className="p-1 text-henry-text-muted hover:text-rose-400 text-xs"
                            title="Delete">✕</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {visibleFacts.length === 0 && !adding && (
              <div className="text-center py-12">
                <p className="text-3xl mb-3">🧠</p>
                <p className="text-henry-text-muted text-sm">Henry hasn't stored facts about you yet — talk to him for a while and they'll start appearing, or add some manually.</p>
              </div>
            )}
          </>
        )}

        {/* ── PROJECTS TAB ───────────────────────────────────────────── */}
        {!loading && tab === 'projects' && (
          <>
            <div className="flex justify-end">
              <button onClick={() => setAdding(adding === 'projects' ? null : 'projects')}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all">
                {adding === 'projects' ? '✕ Cancel' : '+ Add project'}
              </button>
            </div>

            {adding === 'projects' && (
              <div className="p-4 rounded-2xl bg-henry-surface/40 border border-henry-border/20 space-y-3">
                <div><L>Name</L><input value={projectForm.name} onChange={e => setProjectForm({ ...projectForm, name: e.target.value })} className={inputCls} placeholder="e.g. Henry AI launch" /></div>
                <div><L>Summary</L><textarea rows={2} value={projectForm.summary} onChange={e => setProjectForm({ ...projectForm, summary: e.target.value })} className={inputCls + ' resize-none'} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <L>Type</L>
                    <input value={projectForm.type} onChange={e => setProjectForm({ ...projectForm, type: e.target.value })} placeholder="business, personal, creative…" className={inputCls} />
                  </div>
                  <div>
                    <L>Status</L>
                    <select value={projectForm.status} onChange={e => setProjectForm({ ...projectForm, status: e.target.value })} className={inputCls}>
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="completed">Completed</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                </div>
                <button onClick={() => void saveProject()} disabled={!projectForm.name.trim()}
                  className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40">Save project</button>
              </div>
            )}

            {projects.length === 0 && !adding && <p className="text-sm text-henry-text-muted text-center py-8">No projects yet.</p>}
            <div className="grid gap-2 grid-cols-1 md:grid-cols-2">
              {projects.map(p => {
                const isEditing = editingProjectId === p.id;
                if (isEditing) {
                  return (
                    <div key={p.id} className="p-3 rounded-2xl bg-henry-accent/8 border border-henry-accent/30 space-y-2">
                      <input value={editProjectDraft.name}
                        onChange={e => setEditProjectDraft({ ...editProjectDraft, name: e.target.value })}
                        className={inputCls} autoFocus />
                      <textarea rows={2} value={editProjectDraft.summary}
                        onChange={e => setEditProjectDraft({ ...editProjectDraft, summary: e.target.value })}
                        className={inputCls + ' resize-none'} />
                      <div className="grid grid-cols-2 gap-2">
                        <input value={editProjectDraft.type}
                          onChange={e => setEditProjectDraft({ ...editProjectDraft, type: e.target.value })}
                          placeholder="type" className={inputCls} />
                        <select value={editProjectDraft.status}
                          onChange={e => setEditProjectDraft({ ...editProjectDraft, status: e.target.value })}
                          className={inputCls}>
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                          <option value="completed">Completed</option>
                          <option value="archived">Archived</option>
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setEditingProjectId(null)}
                          className="flex-1 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-[11px] text-henry-text-muted hover:text-henry-text">
                          Cancel
                        </button>
                        <button onClick={() => void saveEditProject()}
                          disabled={!editProjectDraft.name.trim()}
                          className="flex-1 py-1.5 rounded-lg bg-henry-accent text-white text-[11px] font-semibold disabled:opacity-40">
                          Save
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={p.id} className="group p-3 rounded-2xl bg-henry-surface/40 border border-henry-border/15 relative">
                    <button onClick={() => startEditProject(p)}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 text-henry-text-muted hover:text-henry-accent text-xs transition-all"
                      title="Edit">✎</button>
                    <div className="flex items-center justify-between mb-1 pr-5">
                      <p className="text-sm font-semibold text-henry-text truncate">{p.name}</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        p.status === 'active' ? 'bg-emerald-400/10 text-emerald-400' :
                        p.status === 'paused' ? 'bg-amber-400/10 text-amber-400' :
                        p.status === 'completed' ? 'bg-sky-400/10 text-sky-400' :
                        'bg-henry-surface text-henry-text-muted'
                      }`}>{p.status}</span>
                    </div>
                    {p.summary && <p className="text-[11px] text-henry-text-muted leading-snug">{p.summary}</p>}
                    {p.last_active_at && <p className="text-[10px] text-henry-text-muted/70 mt-2">last active {new Date(p.last_active_at).toLocaleDateString()}</p>}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── GOALS TAB ──────────────────────────────────────────────── */}
        {!loading && tab === 'goals' && (
          <>
            <div className="flex justify-end">
              <button onClick={() => setAdding(adding === 'goals' ? null : 'goals')}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all">
                {adding === 'goals' ? '✕ Cancel' : '+ Add goal'}
              </button>
            </div>

            {adding === 'goals' && (
              <div className="p-4 rounded-2xl bg-henry-surface/40 border border-henry-border/20 space-y-3">
                <div><L>Goal</L><input value={goalForm.title} onChange={e => setGoalForm({ ...goalForm, title: e.target.value })} className={inputCls} placeholder="e.g. Ship Henry v1 by April" /></div>
                <div><L>Why it matters</L><textarea rows={2} value={goalForm.summary} onChange={e => setGoalForm({ ...goalForm, summary: e.target.value })} className={inputCls + ' resize-none'} /></div>
                <div>
                  <L>Priority ({Math.round(goalForm.priority_score * 100)}%)</L>
                  <input type="range" min={0} max={1} step={0.05} value={goalForm.priority_score}
                    onChange={e => setGoalForm({ ...goalForm, priority_score: Number(e.target.value) })}
                    className="w-full mt-2" />
                </div>
                <button onClick={() => void saveGoal()} disabled={!goalForm.title.trim()}
                  className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40">Save goal</button>
              </div>
            )}

            {goals.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold mb-2">Active goals</p>
                <div className="space-y-2">
                  {goals.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0)).map(g => {
                    const isEditing = editingGoalId === g.id;
                    if (isEditing) {
                      return (
                        <div key={g.id} className="p-3 rounded-xl bg-henry-accent/8 border border-henry-accent/30 space-y-2">
                          <input value={editGoalDraft.title}
                            onChange={e => setEditGoalDraft({ ...editGoalDraft, title: e.target.value })}
                            className={inputCls} autoFocus />
                          <textarea rows={2} value={editGoalDraft.summary}
                            onChange={e => setEditGoalDraft({ ...editGoalDraft, summary: e.target.value })}
                            className={inputCls + ' resize-none'} />
                          <div className="grid grid-cols-2 gap-2">
                            <select value={editGoalDraft.status}
                              onChange={e => setEditGoalDraft({ ...editGoalDraft, status: e.target.value })}
                              className={inputCls}>
                              <option value="active">Active</option>
                              <option value="paused">Paused</option>
                              <option value="completed">Completed</option>
                              <option value="abandoned">Abandoned</option>
                            </select>
                            <div>
                              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted mb-0.5">
                                Priority ({Math.round(editGoalDraft.priority_score * 100)}%)
                              </p>
                              <input type="range" min={0} max={1} step={0.05}
                                value={editGoalDraft.priority_score}
                                onChange={e => setEditGoalDraft({ ...editGoalDraft, priority_score: Number(e.target.value) })}
                                className="w-full" />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => setEditingGoalId(null)}
                              className="flex-1 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-[11px] text-henry-text-muted hover:text-henry-text">
                              Cancel
                            </button>
                            <button onClick={() => void saveEditGoal()}
                              disabled={!editGoalDraft.title.trim()}
                              className="flex-1 py-1.5 rounded-lg bg-henry-accent text-white text-[11px] font-semibold disabled:opacity-40">
                              Save
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={g.id} className="group p-3 rounded-xl bg-henry-surface/40 border border-henry-border/15 relative">
                        <button onClick={() => startEditGoal(g)}
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 text-henry-text-muted hover:text-henry-accent text-xs transition-all"
                          title="Edit">✎</button>
                        <div className="flex items-center justify-between pr-5">
                          <p className="text-sm font-semibold text-henry-text">{g.title}</p>
                          <span className="text-[10px] text-henry-text-muted">priority {Math.round((g.priority_score ?? 0) * 100)}%</span>
                        </div>
                        {g.summary && <p className="text-[11px] text-henry-text-muted mt-1">{g.summary}</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {commitments.filter(c => c.status === 'open' || c.status === 'in_progress').length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold mb-2 mt-4">Open commitments</p>
                <div className="space-y-2">
                  {commitments.filter(c => c.status !== 'completed' && c.status !== 'dropped').map(c => (
                    <div key={c.id} className="p-3 rounded-xl bg-henry-surface/40 border border-henry-border/15 flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <p className="text-sm text-henry-text">{c.description}</p>
                        {c.due_date && <p className="text-[10px] text-amber-400 mt-1">due {c.due_date.slice(0, 10)}</p>}
                      </div>
                      <button onClick={async () => { await api?.resolveCommitment?.(c.id); void reload(); }}
                        className="text-[11px] px-2 py-1 rounded-lg bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20">✓ Done</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {goals.length === 0 && commitments.length === 0 && !adding && (
              <p className="text-sm text-henry-text-muted text-center py-8">No goals or commitments yet.</p>
            )}
          </>
        )}

        {/* ── STORY TAB ──────────────────────────────────────────────── */}
        {!loading && tab === 'story' && (
          <>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAdding(adding === 'story' ? null : 'story')}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-all">
                {adding === 'story' ? '✕ Cancel' : '+ Add chapter'}
              </button>
            </div>

            {adding === 'story' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-henry-surface/40 border border-henry-border/20 space-y-3">
                  <p className="text-[10px] uppercase tracking-wider text-henry-accent font-semibold">New narrative chapter</p>
                  <div><L>Arc name</L><input value={narrativeForm.arc_name} onChange={e => setNarrativeForm({ ...narrativeForm, arc_name: e.target.value })} className={inputCls} placeholder="e.g. Building Henry" /></div>
                  <div><L>Summary</L><textarea rows={3} value={narrativeForm.summary} onChange={e => setNarrativeForm({ ...narrativeForm, summary: e.target.value })} className={inputCls + ' resize-none'} placeholder="What's this chapter of life or work about?" /></div>
                  <button onClick={() => void saveNarrative()} disabled={!narrativeForm.arc_name.trim()}
                    className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40">Save chapter</button>
                </div>

                <div className="p-4 rounded-2xl bg-henry-surface/40 border border-henry-border/20 space-y-3">
                  <p className="text-[10px] uppercase tracking-wider text-henry-accent font-semibold">Or — log a milestone</p>
                  <div><L>Title</L><input value={milestoneForm.title} onChange={e => setMilestoneForm({ ...milestoneForm, title: e.target.value })} className={inputCls} placeholder="e.g. v1.0 shipped" /></div>
                  <div><L>Detail</L><textarea rows={2} value={milestoneForm.summary} onChange={e => setMilestoneForm({ ...milestoneForm, summary: e.target.value })} className={inputCls + ' resize-none'} /></div>
                  <div>
                    <L>Type</L>
                    <select value={milestoneForm.milestone_type} onChange={e => setMilestoneForm({ ...milestoneForm, milestone_type: e.target.value })} className={inputCls}>
                      {MILESTONE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <button onClick={() => void saveMilestone()} disabled={!milestoneForm.title.trim()}
                    className="w-full py-2.5 rounded-xl bg-henry-accent text-white font-semibold disabled:opacity-40">Save milestone</button>
                </div>
              </div>
            )}

            {narratives.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold mb-2">Narrative arcs</p>
                <div className="space-y-2">
                  {narratives.sort((a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0)).map(n => (
                    <div key={n.id} className="p-3 rounded-xl bg-henry-surface/40 border border-henry-border/15">
                      <p className="text-sm font-semibold text-henry-text">{n.arc_name}</p>
                      <p className="text-[12px] text-henry-text-muted mt-1 leading-snug">{n.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {milestones.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold mb-2 mt-4">Milestones</p>
                <div className="space-y-2">
                  {milestones.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map(m => (
                    <div key={m.id} className="p-3 rounded-xl bg-henry-surface/40 border border-henry-border/15">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-henry-text">{m.title}</p>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-henry-accent/10 text-henry-accent">{m.milestone_type}</span>
                      </div>
                      {m.summary && <p className="text-[11px] text-henry-text-muted mt-1">{m.summary}</p>}
                      <p className="text-[10px] text-henry-text-muted/70 mt-1">{new Date(m.created_at).toLocaleDateString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {narratives.length === 0 && milestones.length === 0 && !adding && (
              <p className="text-sm text-henry-text-muted text-center py-8">No story yet. Add an arc or log a milestone — the things you'd want Henry to remember years from now.</p>
            )}
          </>
        )}

        {/* ── LIVE TAB (working memory snapshot, read-only) ─────────────── */}
        {!loading && tab === 'live' && (
          <>
            <p className="text-[11px] text-henry-text-muted mb-2">
              This is the rolling buffer Henry keeps loaded across sessions — what he's actively thinking about right now.
              Updated automatically as you work.
            </p>
            {!working && <p className="text-sm text-henry-text-muted text-center py-8">Working memory is empty.</p>}
            {working && (
              <div className="space-y-2">
                {working.active_context_summary && (
                  <Section title="Active context">
                    <p className="text-sm text-henry-text leading-relaxed">{working.active_context_summary}</p>
                  </Section>
                )}
                {working.active_project_ids_json && JSON.parse(working.active_project_ids_json || '[]').length > 0 && (
                  <Section title="Active projects">
                    <p className="text-[12px] text-henry-text-muted">{JSON.parse(working.active_project_ids_json).length} project ID(s) loaded</p>
                  </Section>
                )}
                {working.pending_commitments_json && JSON.parse(working.pending_commitments_json || '[]').length > 0 && (
                  <Section title="Pending commitments">
                    {(JSON.parse(working.pending_commitments_json) as any[]).map((c, i) => (
                      <p key={i} className="text-sm text-henry-text">• {c.description || c}</p>
                    ))}
                  </Section>
                )}
                {working.refreshed_at && (
                  <p className="text-[10px] text-henry-text-muted text-center mt-2">Refreshed {new Date(working.refreshed_at).toLocaleString()}</p>
                )}
              </div>
            )}
          </>
        )}
        {tab === 'graph' && (
          <div className="flex-1 min-h-0">
            <MemoryGraphView />
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-3 rounded-xl bg-henry-surface/40 border border-henry-border/15">
      <p className="text-[10px] uppercase tracking-wider text-henry-text-muted font-semibold mb-1.5">{title}</p>
      {children}
    </div>
  );
}
