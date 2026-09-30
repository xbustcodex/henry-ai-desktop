/**
 * Henry AI — Life Areas / Domains System
 *
 * Henry understands that life doesn't happen in one blob.
 * He can tag items, infer domain focus, and give perspective
 * on which areas are getting attention and which are being neglected.
 *
 * Areas:
 * business  — work, clients, products, revenue, professional
 * faith     — prayer, worship, church, spiritual growth
 * health    — physical energy, exercise, sleep, food, wellness
 * family    — marriage, kids, parents, relationships, home
 * money     — budget, income, expenses, savings, financial
 * creative  — writing, design, ideas, art, content, music
 * admin     — logistics, email, scheduling, paperwork, cleanup
 * growth    — learning, habits, skills, personal development
 */

export type LifeArea =
  | 'business'
  | 'faith'
  | 'health'
  | 'family'
  | 'money'
  | 'creative'
  | 'admin'
  | 'growth';

export const LIFE_AREA_LABELS: Record<LifeArea, string> = {
  business:  'Business',
  faith:     'Faith',
  health:    'Health',
  family:    'Family',
  money:     'Money',
  creative:  'Creative',
  admin:     'Admin',
  growth:    'Growth',
};

// ── Keyword inference ─────────────────────────────────────────────────────────

const AREA_KEYWORDS: Record<LifeArea, string[]> = {
  business:  ['work', 'client', 'project', 'product', 'revenue', 'business', 'app', 'service', 'deploy', 'launch', 'marketing', 'customer', 'startup', 'company', 'meeting', 'proposal', 'invoice', 'contract', 'code', 'build', 'feature', 'release', 'github', 'development'],
  faith:     ['prayer', 'church', 'faith', 'devotion', 'spiritual', 'god', 'jesus', 'worship', 'ethiopian', 'orthodox', 'tewahedo', 'fasting', 'mass', 'sermon', 'holy'],
  health:    ['workout', 'exercise', 'health', 'energy', 'sleep', 'food', 'diet', 'running', 'gym', 'rest', 'tired', 'walk', 'stretch', 'nutrition', 'water', 'mental health', 'stress', 'medicine', 'doctor'],
  family:    ['family', 'wife', 'husband', 'child', 'kids', 'son', 'daughter', 'parents', 'marriage', 'home', 'relationship', 'together', 'dinner', 'date', 'anniversary', 'mom', 'dad', 'sibling'],
  money:     ['money', 'income', 'budget', 'expense', 'invoice', 'bank', 'savings', 'debt', 'stripe', 'finance', 'tax', 'payment', 'pay', 'cost', 'price', 'financial', 'revenue', 'profit', 'invest'],
  creative:  ['write', 'writing', 'design', 'art', 'music', 'idea', 'creative', 'draft', 'story', 'poem', 'video', 'content', 'shoot', 'record', 'edit', 'create', 'blog', 'book', 'chapter', 'screenplay'],
  admin:     ['email', 'schedule', 'calendar', 'reminder', 'todo', 'admin', 'paperwork', 'cleanup', 'inbox', 'reply', 'follow up', 'forms', 'documents', 'appointment', 'logistics', 'errand', 'organize'],
  growth:    ['learn', 'read', 'study', 'course', 'practice', 'habit', 'skill', 'develop', 'journal', 'reflect', 'goal', 'improve', 'podcast', 'book', 'mentor', 'coaching', 'grow', 'discipline'],
};

/**
 * Infer the most likely life area from a text snippet.
 * Returns null if no clear match.
 */
export function inferLifeArea(text: string): LifeArea | null {
  const lower = text.toLowerCase();
  let best: LifeArea | null = null;
  let bestScore = 0;

  for (const [area, keywords] of Object.entries(AREA_KEYWORDS) as [LifeArea, string[]][]) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += kw.length > 6 ? 2 : 1; // longer keywords count more
    }
    if (score > bestScore) {
      bestScore = score;
      best = area;
    }
  }

  return bestScore >= 2 ? best : null;
}

// ── Domain distribution ───────────────────────────────────────────────────────

export interface DomainDistribution {
  area: LifeArea;
  label: string;
  count: number;
  pct: number;
}

function safeJSON<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback; const _p = JSON.parse(raw); return (Array.isArray(fallback) && !Array.isArray(_p)) ? fallback : (_p as T);
  } catch { return fallback; }
}

/**
 * Compute domain distribution across active threads, tasks, and captures.
 * Returns areas ordered by frequency, each with a percentage.
 */
export function computeDomainDistribution(): DomainDistribution[] {
  if (typeof localStorage === 'undefined') return [];

  const counts: Partial<Record<LifeArea, number>> = {};

  function tally(text: string): void {
    const area = inferLifeArea(text);
    if (area) counts[area] = (counts[area] ?? 0) + 1;
  }

  // Threads
  const threads = safeJSON<Array<{ title: string; status: string }>>('henry:continuity_threads:v1', []);
  for (const t of threads.filter((t) => t.status !== 'done')) {
    tally(t.title);
  }

  // Tasks
  const tasks = safeJSON<Array<{ description: string; status: string }>>('henry:tasks', []);
  for (const t of tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')) {
    tally(t.description);
  }

  // Captures
  const captures = safeJSON<Array<{ text?: string; content?: string; routed?: boolean }>>('henry:captures_v1', []);
  for (const c of captures.slice(0, 20)) {
    const text = c.text ?? c.content ?? '';
    if (text) tally(text);
  }

  // Working memory
  const wm = safeJSON<Array<{ content: string; resolved: boolean }>>('henry:working_memory:v1', []);
  for (const item of wm.filter((i) => !i.resolved)) {
    tally(item.content);
  }

  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  if (total === 0) return [];

  return (Object.entries(counts) as [LifeArea, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([area, count]) => ({
      area,
      label: LIFE_AREA_LABELS[area],
      count,
      pct: Math.round((count / total) * 100),
    }));
}

// ── System Prompt Block ───────────────────────────────────────────────────────

/**
 * Build a brief life area context block for the system prompt.
 * Only injects if there's a clear dominant domain (>45%).
 * Keeps it to 1–2 lines so it doesn't bloat the prompt.
 */
export function buildLifeAreaBlock(): string {
  if (typeof localStorage === 'undefined') return '';

  const dist = computeDomainDistribution();
  if (dist.length === 0) return '';

  const primary = dist[0];
  if (primary.pct < 45) return ''; // No clear dominant domain

  const secondary = dist.slice(1, 3).filter((d) => d.pct >= 10);
  const secondaryStr = secondary.length > 0
    ? ` Also active: ${secondary.map((d) => d.label).join(', ')}.`
    : '';

  return `## Domain Focus: ${primary.label} (${primary.pct}%)
Current threads and work are primarily in the ${primary.label} area.${secondaryStr}
Weight ${primary.label.toLowerCase()}-related context and suggestions more in this session.`;
}
