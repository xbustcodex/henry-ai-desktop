/**
 * Customization — "Make it yours".
 *
 * The paid product pairs an accent colour with its reactor identity in one
 * editor (recovered from the 1.7.0 renderer: `customization-view`, "Customize",
 * "Make it yours"). Ours does the same, and the orb preview is live rather than
 * a picture, because the orb is ours to render.
 *
 * Tailwind compiles the accent to a literal, so theming works by overriding the
 * generated custom properties on :root rather than by editing the config at
 * runtime. Applied once on mount and whenever the value changes.
 */

export interface ThemeSettings {
  accent: string;
  /** 0 = compact, 1 = comfortable, 2 = roomy. */
  density: 'compact' | 'comfortable' | 'roomy';
  /** Visual skin for the whole app chrome, and for the demo orb. */
  skin: 'default' | 'minimalistic';
  reduceMotion: boolean;
}

export const DEFAULT_THEME: ThemeSettings = {
  accent: '#6366f1',
  density: 'comfortable',
  skin: 'default',
  reduceMotion: false,
};

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Cyan', value: '#5cdcff' },
  { name: 'Violet', value: '#a855f7' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Rose', value: '#f43f5e' },
];

const DENSITY_SCALE: Record<ThemeSettings['density'], number> = {
  compact: 0.88,
  comfortable: 1,
  roomy: 1.12,
};

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten/darken toward white/black, used for the hover and dim variants. */
function shift(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const out = rgb.map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))
      .toString(16)
      .padStart(2, '0')
  );
  return `#${out.join('')}`;
}

/**
 * Push the theme onto :root. Every colour the app uses is a generated custom
 * property, so one write retheme the whole surface without a rebuild.
 */
export function applyTheme(theme: ThemeSettings): void {
  const root = document.documentElement;
  const accent = /^#[0-9a-fA-F]{6}$/.test(theme.accent.trim()) ? theme.accent.trim() : DEFAULT_THEME.accent;

  // Tailwind emits --tw-* colour variables for the palette; override the three
  // the app leans on. alpha variants (bg-henry-accent/15) derive from these.
  const rgb = hexToRgb(accent);
  if (rgb) {
    const [r, g, b] = rgb;
    root.style.setProperty('--henry-accent-rgb', `${r} ${g} ${b}`);
    root.style.setProperty('--color-henry-accent', accent);
    root.style.setProperty('--color-henry-accent-hover', shift(accent, 0.22));
    root.style.setProperty('--color-henry-accent-dim', shift(accent, -0.22));
    root.style.setProperty('--color-henry-companion', accent);
  }

  root.style.setProperty('--density-scale', String(DENSITY_SCALE[theme.density] ?? 1));
  root.dataset.density = theme.density;
  root.dataset.skin = theme.skin;
  root.dataset.reduceMotion = theme.reduceMotion ? 'true' : 'false';

  // Respect the OS preference as a floor: we can offer less motion, never more.
  const prefers = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  root.classList.toggle('reduce-motion', theme.reduceMotion || prefers);
}

/** Validate and default anything that arrives from storage or the renderer. */
export function sanitizeTheme(input: unknown): ThemeSettings {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_THEME };
  const r = input as Record<string, unknown>;
  return {
    accent: typeof r.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.accent) ? r.accent : DEFAULT_THEME.accent,
    density:
      r.density === 'compact' || r.density === 'roomy' ? r.density : DEFAULT_THEME.density,
    skin: r.skin === 'minimalistic' ? 'minimalistic' : 'default',
    reduceMotion: typeof r.reduceMotion === 'boolean' ? r.reduceMotion : DEFAULT_THEME.reduceMotion,
  };
}