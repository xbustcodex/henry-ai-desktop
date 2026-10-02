/**
 * Content Creators — scripted demo mode.
 *
 * A creator imports media (screenshots, audio, documents), writes the short
 * exchange they want filmed, and Henry plays it back either as the full-screen
 * reactive orb or as a lookalike chat window.
 *
 * This is entirely local: no Henry backend, no credits, no hosted service.
 *
 * Paid 1.7.0 has an equivalent feature, recovered from its shipped sourcemaps
 * (contracts.ts:39-215, creators-store.ts). The capability is implemented here
 * from our own code; paid's clap-to-wake activation is deliberately NOT
 * reproduced because upstream force-disabled it for false-positive activation.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CreatorDemo,
  CreatorMedia,
  CreatorTurn,
  OrbSettings,
} from '../../global';

const cardCls = 'bg-henry-surface border border-henry-border/20 rounded-2xl p-4';
const labelCls = 'block text-[11px] font-medium text-henry-text-muted mb-1';
const inputCls =
  'w-full bg-henry-bg border border-henry-border/40 rounded-lg px-3 py-1.5 text-sm text-henry-text focus:outline-none focus:border-henry-accent/60';

export default function CreatorsPanel() {
  const [demo, setDemo] = useState<CreatorDemo | null>(null);
  const [orb, setOrb] = useState<OrbSettings | null>(null);
  const [media, setMedia] = useState<CreatorMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const reload = useCallback(async () => {
    try {
      const [d, o, m] = await Promise.all([
        window.henryAPI.creatorsGetDemo(),
        window.henryAPI.creatorsGetOrb(),
        window.henryAPI.creatorsListMedia(),
      ]);
      setDemo(d);
      setOrb(o);
      setMedia(m.media ?? []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not load the demo');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const persist = useCallback(async (next: CreatorDemo) => {
    setDemo(next);
    try {
      await window.henryAPI.creatorsSaveDemo(next);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 1200);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  }, []);

  const patch = useCallback(
    (p: Partial<CreatorDemo>) => {
      if (demo) void persist({ ...demo, ...p });
    },
    [demo, persist]
  );

  const setTurn = (id: string, p: Partial<CreatorTurn>) => {
    if (!demo) return;
    void persist({ ...demo, turns: demo.turns.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  };

  const addTurn = () => {
    if (!demo) return;
    const t: CreatorTurn = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: demo.turns.length % 2 === 0 ? 'assistant' : 'user',
      text: '',
      audio: null,
      files: [],
    };
    void persist({ ...demo, turns: [...demo.turns, t] });
  };

  const removeTurn = (id: string) => {
    if (!demo) return;
    void persist({ ...demo, turns: demo.turns.filter((t) => t.id !== id) });
  };

  const launch = async (mode: 'voice' | 'chat') => {
    setBusy(true);
    try {
      const r = await window.henryAPI.creatorsLaunchStage(mode);
      if (!r.ok) setMsg(r.error ?? 'Could not open the stage');
    } finally {
      setBusy(false);
    }
  };

  const saveOrb = async (next: OrbSettings) => {
    setOrb(next);
    try {
      await window.henryAPI.creatorsSaveOrb(next);
    } catch {
      /* non-fatal; the stage keeps the previous skin */
    }
  };

  if (!demo || !orb) {
    return <div className="p-6 text-sm text-henry-text-muted">Loading demo mode…</div>;
  }

  return (
    <div className="p-5 space-y-4 overflow-y-auto">
      <div>
        <p className="text-[10px] uppercase tracking-widest text-henry-text-muted">Demo mode</p>
        <h2 className="text-xl font-bold text-henry-text mt-0.5">Content Creators</h2>
        <p className="text-xs text-henry-text-muted mt-1 max-w-2xl">
          Script a short exchange and play it back as a full-screen reactive orb or a lookalike
          chat window — for filming. Everything runs locally on this machine.
        </p>
      </div>

      {/* ── Stage mode ─────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-henry-text">Stage</h3>
          {msg && <span className="text-[10px] text-henry-accent">{msg}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            onClick={() => void launch('voice')}
            disabled={busy}
            className={`text-left p-3 rounded-xl border transition-colors ${
              demo.mode === 'voice'
                ? 'border-henry-accent bg-henry-accent/10'
                : 'border-henry-border/40 hover:border-henry-accent/50'
            }`}
          >
            <strong className="block text-sm text-henry-text">Voice</strong>
            <span className="text-[11px] text-henry-text-muted">Full-screen reactive orb</span>
          </button>
          <button
            onClick={() => void launch('chat')}
            disabled={busy}
            className={`text-left p-3 rounded-xl border transition-colors ${
              demo.mode === 'chat'
                ? 'border-henry-accent bg-henry-accent/10'
                : 'border-henry-border/40 hover:border-henry-accent/50'
            }`}
          >
            <strong className="block text-sm text-henry-text">Chat</strong>
            <span className="text-[11px] text-henry-text-muted">Lookalike chat window</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-henry-text">
            <input
              type="checkbox"
              checked={demo.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Demo active
          </label>
          <label className="flex items-center gap-2 text-xs text-henry-text">
            <input
              type="checkbox"
              checked={demo.playIntro}
              onChange={(e) => patch({ playIntro: e.target.checked })}
            />
            Power on when the demo starts
          </label>
          <label className="flex items-center gap-2 text-xs text-henry-text">
            Caption
            <select
              className="bg-henry-bg border border-henry-border/40 rounded-lg px-2 py-1 text-xs"
              value={demo.captionMode}
              onChange={(e) =>
                patch({ captionMode: e.target.value as CreatorDemo['captionMode'] })
              }
            >
              <option value="typewriter">Typewriter</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-henry-text">
            Screenshot timing {demo.fileStaggerMs}ms
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={demo.fileStaggerMs}
              onChange={(e) => patch({ fileStaggerMs: Number(e.target.value) })}
              className="w-32"
            />
          </label>
        </div>
        <p className="text-[10px] text-henry-text-muted mt-2">
          Launch with the trigger phrase, Ctrl+Shift+J, or the buttons above. The stage opens on a
          “click or press Space to activate” standby screen.
        </p>
      </div>

      {/* ── Orb ────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-henry-text mb-3">Orb</h3>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            onClick={() => void saveOrb({ ...orb, skin: 'default' })}
            className={`text-left p-3 rounded-xl border transition-colors ${
              orb.skin === 'default'
                ? 'border-henry-accent bg-henry-accent/10'
                : 'border-henry-border/40 hover:border-henry-accent/50'
            }`}
          >
            <strong className="block text-sm text-henry-text">Reactor (full HUD)</strong>
            <span className="text-[11px] text-henry-text-muted">Arc-reactor HUD with animated rings</span>
          </button>
          <button
            onClick={() => void saveOrb({ ...orb, skin: 'minimalistic' })}
            className={`text-left p-3 rounded-xl border transition-colors ${
              orb.skin === 'minimalistic'
                ? 'border-henry-accent bg-henry-accent/10'
                : 'border-henry-border/40 hover:border-henry-accent/50'
            }`}
          >
            <strong className="block text-sm text-henry-text">Minimal (classic orb)</strong>
            <span className="text-[11px] text-henry-text-muted">Clean rings, glowing voice-reactive core</span>
          </button>
        </div>
        <div className="flex items-center gap-4">
          <label className="text-xs text-henry-text flex items-center gap-2">
            Speed
            <select
              className="bg-henry-bg border border-henry-border/40 rounded-lg px-2 py-1 text-xs"
              value={orb.speed}
              onChange={(e) => void saveOrb({ ...orb, speed: e.target.value as OrbSettings['speed'] })}
            >
              <option value="slow">Slow</option>
              <option value="default">Default</option>
              <option value="fast">Fast</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="text-xs text-henry-text flex items-center gap-2">
            Name
            <input
              className="bg-henry-bg border border-henry-border/40 rounded-lg px-2 py-1 text-xs w-28"
              value={orb.assistantName}
              onChange={(e) => void saveOrb({ ...orb, assistantName: e.target.value })}
            />
          </label>
          <label className="text-xs text-henry-text flex items-center gap-2">
            Accent
            <input
              type="color"
              value={orb.accent}
              onChange={(e) => void saveOrb({ ...orb, accent: e.target.value })}
              className="w-8 h-7 rounded border border-henry-border/40 bg-transparent"
            />
          </label>
        </div>
      </div>

      {/* ── Trigger phrases ────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-henry-text mb-1">Trigger phrases</h3>
        <p className="text-[10px] text-henry-text-muted mb-2">
          Say or type one of these and the demo starts.
        </p>
        <div className="space-y-1.5">
          {demo.triggerPhrases.map((p, i) => (
            <div key={i} className="flex gap-2">
              <input
                className={inputCls}
                value={p}
                onChange={(e) => {
                  const next = [...demo.triggerPhrases];
                  next[i] = e.target.value;
                  patch({ triggerPhrases: next });
                }}
              />
              <button
                onClick={() => patch({ triggerPhrases: demo.triggerPhrases.filter((_, j) => j !== i) })}
                className="text-[11px] text-henry-text-muted hover:text-henry-error px-2"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => patch({ triggerPhrases: [...demo.triggerPhrases, 'new trigger phrase'] })}
          className="mt-2 text-[11px] px-2.5 py-1 rounded-lg border border-henry-border/40 text-henry-text hover:border-henry-accent/50"
        >
          Add phrase
        </button>
      </div>

      {/* ── Media ──────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-henry-text mb-1">Media</h3>
        <p className="text-[10px] text-henry-text-muted mb-2">
          Files are copied into a private folder on this machine and served through
          <code className="mx-1">henry-media://</code>. Executables are never accepted.
        </p>
        {media.length === 0 ? (
          <p className="text-[11px] text-henry-text-muted">No media imported yet.</p>
        ) : (
          <div className="space-y-1">
            {media.map((m) => (
              <div key={m.fileName} className="flex items-center gap-2 text-xs">
                <span className="text-henry-text-muted">{m.kind}</span>
                <span className="flex-1 text-henry-text truncate">{m.originalName}</span>
                <button
                  onClick={() => void window.henryAPI.creatorsOpenMedia(m.fileName)}
                  className="text-[10px] text-henry-accent hover:underline"
                >
                  Open
                </button>
                <button
                  onClick={async () => {
                    await window.henryAPI.creatorsDeleteMedia(m.fileName);
                    void reload();
                  }}
                  className="text-[10px] text-henry-text-muted hover:text-henry-error"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Turns ──────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-henry-text">Script ({demo.turns.length})</h3>
          <button
            onClick={addTurn}
            className="text-[11px] px-2.5 py-1 rounded-lg border border-henry-border/40 text-henry-text hover:border-henry-accent/50"
          >
            Add turn
          </button>
        </div>
        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {demo.turns.map((t, i) => (
            <div key={t.id} className="flex gap-2 items-start">
              <select
                className="bg-henry-bg border border-henry-border/40 rounded-lg px-2 py-1.5 text-xs text-henry-text"
                value={t.role}
                onChange={(e) => setTurn(t.id, { role: e.target.value as CreatorTurn['role'] })}
              >
                <option value="assistant">Henry</option>
                <option value="user">You</option>
              </select>
              <textarea
                className={inputCls + ' resize-none h-16'}
                placeholder={`Turn ${i + 1}…`}
                value={t.text}
                onChange={(e) => setTurn(t.id, { text: e.target.value })}
              />
              <button
                onClick={() => removeTurn(t.id)}
                className="text-[11px] text-henry-text-muted hover:text-henry-error px-1"
                title="Remove turn"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}