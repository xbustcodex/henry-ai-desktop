/**
 * Customization — accent, density, skin and motion, with a live orb preview.
 *
 * Mirrors the paid product's "Customize / Make it yours" view, implemented from
 * our own code. The orb preview is the same generator the demo stage uses, so
 * what you pick here is what you get on stage.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ACCENT_PRESETS,
  DEFAULT_THEME,
  applyTheme,
  sanitizeTheme,
  type ThemeSettings,
} from '../../henry/theme';

const cardCls = 'bg-henry-surface border border-henry-border/20 rounded-2xl p-4';
const labelCls = 'block text-[11px] font-medium text-henry-text-muted mb-1';

function OrbPreview({ skin, accent }: { skin: ThemeSettings['skin']; accent: string }) {
  const slow = skin === 'minimalistic';
  return (
    <div className="flex items-center justify-center py-4">
      <div style={{ width: 150, height: 150 }} className="drop-shadow-[0_0_18px_var(--color-henry-accent)]">
        <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%' }}>
          {slow ? (
            <>
              <circle cx="100" cy="100" r="74" fill="none" stroke={accent} strokeWidth="1.5" opacity=".35" />
              <circle cx="100" cy="100" r="46" fill="none" stroke={accent} strokeWidth="2" opacity=".6" />
              <circle cx="100" cy="100" r="30" fill="none" stroke={accent} strokeWidth="1" opacity=".3" />
              <circle cx="100" cy="100" r="16" fill={accent} opacity=".9" />
            </>
          ) : (
            <>
              {[0, 1, 2, 3, 4].map((i) => {
                const rr = 58 + (i % 2) * 18;
                return (
                  <g key={i} transform={`rotate(${i * 36} 100 100)`}>
                    <path
                      d={`M ${100 - rr} 100 A ${rr} ${rr} 0 0 1 ${100 + rr} 100`}
                      fill="none"
                      stroke={accent}
                      strokeWidth={i % 2 ? 1 : 2}
                      opacity={0.25 + 0.1 * i}
                    />
                  </g>
                );
              })}
              <circle cx="100" cy="100" r="34" fill="none" stroke={accent} strokeWidth="2" opacity=".55" />
              <circle cx="100" cy="100" r="20" fill="none" stroke={accent} strokeWidth="1" opacity=".4" />
              <circle cx="100" cy="100" r="66" fill="none" stroke={accent} strokeWidth=".6" opacity=".2" />
              <circle cx="100" cy="100" r="9" fill={accent} opacity=".9" />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

export default function CustomizationPanel() {
  const [theme, setTheme] = useState<ThemeSettings>({ ...DEFAULT_THEME });

  const load = useCallback(async () => {
    try {
      const all = await window.henryAPI.getSettings?.();
      const raw = (all as Record<string, string> | undefined)?.['theme_json'];
      const t = sanitizeTheme(raw ? JSON.parse(raw) : null);
      setTheme(t);
      applyTheme(t);
    } catch {
      applyTheme(DEFAULT_THEME);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((p: Partial<ThemeSettings>) => {
    setTheme((prev) => {
      const next = sanitizeTheme({ ...prev, ...p });
      applyTheme(next);
      void window.henryAPI
        .saveSetting?.('theme_json', JSON.stringify(next))
        .catch(() => { /* theming is cosmetic; never block the UI on it */ });
      return next;
    });
  }, []);

  return (
    <div className="p-5 space-y-4 overflow-y-auto">
      <div>
        <p className="text-[10px] uppercase tracking-widest text-henry-text-muted">Customize</p>
        <h2 className="text-xl font-bold text-henry-text mt-0.5">Make it yours</h2>
        <p className="text-xs text-henry-text-muted mt-1 max-w-2xl">
          Accent, density and identity. Stored locally on this device.
        </p>
      </div>

      <div className={cardCls}>
        <label className={labelCls}>Accent</label>
        <div className="flex flex-wrap gap-2 mb-3">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => update({ accent: p.value })}
              title={p.name}
              className={`w-8 h-8 rounded-lg border-2 transition-transform hover:scale-110 ${
                theme.accent.toLowerCase() === p.value.toLowerCase()
                  ? 'border-henry-text'
                  : 'border-transparent'
              }`}
              style={{ background: p.value }}
            />
          ))}
          <input
            type="color"
            value={theme.accent}
            onChange={(e) => update({ accent: e.target.value })}
            className="w-8 h-8 rounded-lg border border-henry-border/40 bg-transparent"
            title="Custom accent"
          />
        </div>
        <p className="text-[11px] text-henry-text-muted font-mono">{theme.accent}</p>
      </div>

      <div className={cardCls}>
        <label className={labelCls}>Density</label>
        <div className="flex gap-2">
          {(['compact', 'comfortable', 'roomy'] as const).map((d) => (
            <button
              key={d}
              onClick={() => update({ density: d })}
              className={`flex-1 px-3 py-2 rounded-lg border text-xs capitalize transition-colors ${
                theme.density === d
                  ? 'border-henry-accent bg-henry-accent/10 text-henry-text'
                  : 'border-henry-border/40 text-henry-text-muted hover:border-henry-accent/50'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className={cardCls}>
        <label className={labelCls}>Identity</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => update({ skin: 'default' })}
            className={`rounded-xl border p-2 transition-colors ${
              theme.skin === 'default'
                ? 'border-henry-accent bg-henry-accent/5'
                : 'border-henry-border/40 hover:border-henry-accent/50'
            }`}
          >
            <OrbPreview skin="default" accent={theme.accent} />
            <span className="block text-xs text-henry-text">Reactor</span>
            <span className="block text-[10px] text-henry-text-muted">Full arc-reactor HUD</span>
          </button>
          <button
            onClick={() => update({ skin: 'minimalistic' })}
            className={`rounded-xl border p-2 transition-colors ${
              theme.skin === 'minimalistic'
                ? 'border-henry-accent bg-henry-accent/5'
                : 'border-henry-border/40 hover:border-henry-accent/50'
            }`}
          >
            <OrbPreview skin="minimalistic" accent={theme.accent} />
            <span className="block text-xs text-henry-text">Minimal</span>
            <span className="block text-[10px] text-henry-text-muted">Classic orb</span>
          </button>
        </div>
      </div>

      <div className={cardCls}>
        <label className="flex items-center gap-2 text-sm text-henry-text">
          <input
            type="checkbox"
            checked={theme.reduceMotion}
            onChange={(e) => update({ reduceMotion: e.target.checked })}
          />
          Reduce motion
        </label>
        <p className="text-[10px] text-henry-text-muted mt-1">
          Your system&rsquo;s reduced-motion preference is always respected; this can only add to it.
        </p>
      </div>
    </div>
  );
}