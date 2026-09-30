import { useState, useEffect } from 'react';
import {
  loadCustomModes, saveCustomMode, deleteCustomMode, newCustomMode,
  type CustomMode, CUSTOM_MODE_COLORS,
} from '../../henry/customModes';
import { useStore } from '../../store';
import { PANEL_QUICK_ASK } from '../../henry/henryQuickAsk';

const BUILT_IN_MODES = [
  { id: 'companion', name: 'Chat', icon: '💬', description: 'Day-to-day conversation and thinking out loud', color: 'violet' },
  { id: 'writer', name: 'Writing', icon: '✍️', description: 'Draft, edit, and shape anything worth keeping', color: 'emerald' },
  { id: 'developer', name: 'Code', icon: '⚡', description: 'Plan → build → review, with diffs & checkpoints', color: 'amber' },
  { id: 'builder', name: 'App Builder', icon: '🌐', description: 'Describe an app — Henry builds it live', color: 'sky' },
  { id: 'design3d', name: '3D / Design', icon: '🖨️', description: 'Spatial layouts, 3D printing, photo-to-3D', color: 'cyan' },
  { id: 'secretary', name: 'Secretary', icon: '🗓️', description: 'Email, scheduling, task triage, briefings', color: 'orange' },
  { id: 'computer', name: 'Computer', icon: '🖥️', description: 'Run commands, control apps, automate tasks', color: 'pink' },
  { id: 'coach', name: 'Coach', icon: '🎯', description: 'Accountability, clarity, follow-through — one question at a time', color: 'violet' },
  { id: 'strategic', name: 'Strategic', icon: '♟️', description: 'Big picture thinking, priorities, tradeoffs, roadmaps', color: 'sky' },
  { id: 'business', name: 'Business Builder', icon: '🚀', description: 'Idea → offer → plan → first revenue', color: 'emerald' },
];

const ICON_OPTIONS = ['✨', '🚀', '🎯', '🧪', '📚', '💡', '🌿', '🔥', '🎨', '🧘', '⚔️', '🏗️', '🔬', '🎭', '🌍', '💪', '📝', '🧩', '🎵', '🏋️'];

export default function ModesPanel() {
  const [modes, setModes] = useState<CustomMode[]>([]);
  const [editing, setEditing] = useState<CustomMode | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => { setModes(loadCustomModes()); }, []);

  function startNew() {
    setEditing(newCustomMode());
  }

  function handleSave() {
    if (!editing || !editing.name.trim()) return;
    saveCustomMode({ ...editing, name: editing.name.trim() });
    setModes(loadCustomModes());
    setEditing(null);
  }

  function handleDelete(id: string) {
    deleteCustomMode(id);
    setModes(loadCustomModes());
    setConfirmDelete(null);
  }

  function launchMode(modeId: string) {
    try { localStorage.setItem('henry_operating_mode', modeId); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: modeId, prompt: '' } }));
    useStore.getState().setCurrentView('chat');
  }

  function launchCustomMode(mode: CustomMode) {
    try { localStorage.setItem('henry_operating_mode', 'companion'); } catch { /* ignore */ }
    localStorage.setItem('henry_custom_mode_override', JSON.stringify(mode));
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: 'companion', prompt: '' } }));
    useStore.getState().setCurrentView('chat');
  }

  return (
    <div className="h-full flex flex-col bg-henry-bg overflow-y-auto">
      <div className="shrink-0 px-6 py-4 border-b border-henry-border/50 flex items-center justify-between">
        <div>
          <div className="flex items-center justify-between w-full">
                <h1 className="text-lg font-semibold text-henry-text">Modes</h1>
                <button
                onClick={() => PANEL_QUICK_ASK.today()}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
              >🧠 Ask Henry</button>
              </div>
          <p className="text-xs text-henry-text-muted mt-0.5">Built-in and custom Henry operating modes</p>
        </div>
        <button
          onClick={startNew}
          className="px-4 py-2 rounded-xl text-xs font-semibold bg-henry-accent/15 text-henry-accent border border-henry-accent/25 hover:bg-henry-accent/25 transition-all flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Mode
        </button>
      </div>

      <div className="flex-1 px-6 py-6 space-y-8 max-w-3xl mx-auto w-full">
        {/* Custom modes */}
        {modes.length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wider mb-3">Your Modes</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {modes.length === 0 && (
                <div className="col-span-2 flex flex-col items-center justify-center py-12 text-center">
                  <span className="text-4xl mb-3">🎭</span>
                  <p className="text-sm font-medium text-henry-text mb-1">No custom modes yet</p>
                  <p className="text-xs text-henry-text-muted max-w-xs">Create a mode to give Henry a specific persona, tone, or set of instructions for a recurring context.</p>
                </div>
              )}
              {modes.map((mode) => (
                <div
                  key={mode.id}
                  className="group relative p-4 rounded-xl border border-henry-border/30 bg-henry-surface/30 hover:bg-henry-surface/60 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-xl leading-none mt-0.5">{mode.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-henry-text">{mode.name}</p>
                      <p className="text-xs text-henry-text-dim mt-0.5 leading-relaxed">{mode.description || 'Custom mode'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => launchCustomMode(mode)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-henry-accent/15 text-henry-accent hover:bg-henry-accent/25 border border-henry-accent/20 transition-all font-medium"
                    >
                      Launch
                    </button>
                    <button
                      onClick={() => setEditing({ ...mode })}
                      className="text-xs px-3 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-dim hover:text-henry-text transition-all"
                    >
                      Edit
                    </button>
                    {confirmDelete === mode.id ? (
                      <>
                        <button onClick={() => handleDelete(mode.id)} className="text-xs text-henry-error hover:text-henry-error/80 transition-colors">Confirm delete</button>
                        <button onClick={() => setConfirmDelete(null)} className="text-xs text-henry-text-muted hover:text-henry-text transition-colors">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmDelete(mode.id)} className="ml-auto text-[10px] text-henry-text-muted/50 hover:text-henry-error transition-colors opacity-0 group-hover:opacity-100">Delete</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Editor */}
        {editing && (
          <div className="rounded-2xl border border-henry-accent/25 bg-henry-accent/5 p-5 space-y-4">
            <p className="text-sm font-semibold text-henry-text">{editing.id.startsWith('custom_') && !loadCustomModes().find((m) => m.id === editing.id) ? 'New Mode' : 'Edit Mode'}</p>

            {/* Icon picker */}
            <div>
              <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-2">Icon</p>
              <div className="flex flex-wrap gap-2">
                {ICON_OPTIONS.map((ic) => (
                  <button
                    key={ic}
                    onClick={() => setEditing({ ...editing, icon: ic })}
                    className={`w-8 h-8 rounded-lg text-lg flex items-center justify-center transition-all ${editing.icon === ic ? 'bg-henry-accent/25 ring-2 ring-henry-accent/50' : 'hover:bg-henry-surface/60'}`}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div>
              <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1.5">Name</p>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Sermon Prep, Dad Mode, Client Work…"
                className="w-full bg-henry-bg border border-henry-border/40 rounded-xl px-3 py-2.5 text-sm text-henry-text placeholder-henry-text-muted outline-none focus:border-henry-accent/50 transition-all"
              />
            </div>

            {/* Description */}
            <div>
              <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1.5">Short description</p>
              <input
                type="text"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="What does Henry do in this mode?"
                className="w-full bg-henry-bg border border-henry-border/40 rounded-xl px-3 py-2.5 text-sm text-henry-text placeholder-henry-text-muted outline-none focus:border-henry-accent/50 transition-all"
              />
            </div>

            {/* System prompt */}
            <div>
              <p className="text-[10px] text-henry-text-muted uppercase tracking-wider mb-1.5">System prompt (what Henry knows in this mode)</p>
              <textarea
                value={editing.systemPrompt}
                onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                placeholder="You are Henry in [mode name] mode. In this mode you…"
                rows={5}
                className="w-full bg-henry-bg border border-henry-border/40 rounded-xl px-3 py-2.5 text-sm text-henry-text placeholder-henry-text-muted outline-none focus:border-henry-accent/50 transition-all resize-none leading-relaxed"
              />
            </div>

            <div className="flex items-center gap-2.5">
              <button
                onClick={handleSave}
                disabled={!editing.name.trim()}
                className="px-5 py-2 rounded-xl text-xs font-semibold bg-henry-accent text-white hover:bg-henry-accent/90 disabled:opacity-40 transition-all"
              >
                Save Mode
              </button>
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-xl text-xs text-henry-text-dim hover:text-henry-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Built-in modes */}
        <div>
          <p className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wider mb-3">Built-in Modes</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {BUILT_IN_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => launchMode(mode.id)}
                className="group text-left p-4 rounded-xl border border-henry-border/20 bg-henry-surface/20 hover:bg-henry-surface/50 hover:border-henry-border/40 transition-all"
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl leading-none mt-0.5">{mode.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-henry-text">{mode.name}</div>
                    <div className="text-xs text-henry-text-dim mt-0.5 leading-relaxed">{mode.description}</div>
                  </div>
                  <svg className="w-3.5 h-3.5 text-henry-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
