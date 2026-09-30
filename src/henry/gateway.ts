import { classifyIntent, DEFAULT_CODER_MODEL } from './coderModels';
import { buildCoderSystemPrompt } from './buildCoderSystemPrompt';

/**
 * Henry Iron Gateway — Cost-Optimized Request Router
 *
 * Every message passes through here before touching any AI API.
 * Routes to the cheapest capable path:
 *
 * Tier 0 — Free local (rules, shell, math, greetings) — $0.00
 * Tier 1 — Groq llama-3.1-8b-instant — $0.05/1M tokens (basically free)
 * Tier 2 — Groq llama-3.3-70b-versatile — $0.59/1M tokens (cheap)
 * Tier 3 — OpenAI/Runway — only for image/video gen
 */

export interface LocalResult {
  handled: true;
  response: string;
}

export interface AIResult {
  handled: false;
  tier: 1 | 2 | 3;
  provider: string;
  model: string;
  reason: string;
  estimatedTokens: number;
  coderSystem?: string; // set when intent=code, used by ChatView to override system prompt
}

export type GatewayResult = LocalResult | AIResult;

export interface GatewayContext {
  macHome?: string;
  settings?: Record<string, string>;
  history?: { role: string; content: string }[];
}

// ── Tier 0: local patterns — zero cost ────────────────────────────────────
const LOCAL_PATTERNS: Array<{
  match: RegExp | ((t: string) => boolean);
  respond: (t: string) => string | null;
}> = [
  {
    match: /^(what('?s| is) the (time|date|day)|what time is it|today'?s? date|current time)\??$/i,
    respond: () => {
      const now = new Date();
      return now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
        + ' \u00b7 ' + now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    },
  },
  {
    match: (t) => /^[\d\s\+\-\*\/\(\)\.\,\%]+[\=\?]?\s*$/.test(t) && t.length < 50,
    respond: (t) => {
      try {
        const expr = t.replace(/[=?]/g, '').trim();
         
        const result = Function('"use strict"; return (' + expr + ')')();
        if (typeof result === 'number' && isFinite(result)) return `${expr} = ${result.toLocaleString()}`;
      } catch { /* not math */ }
      return null;
    },
  },
  {
    match: /^(hi|hello|hey|yo|sup|hiya|howdy|good (morning|afternoon|evening|night))[!\.]*$/i,
    respond: () => {
      const h = new Date().getHours();
      return (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + '. What do you need?';
    },
  },
  {
    match: /^(thanks|thank you|thx|ty|cheers|appreciate it|perfect|great|awesome|nice|cool|got it|ok|okay|k|yep|yup)[!\.]*$/i,
    respond: () => "You're welcome.",
  },
];

// ── Tier classification ────────────────────────────────────────────────────
function classifyTier(text: string): { tier: 1 | 2 | 3; reason: string } {
  const len = text.length;

  // Image/video → paid only
  if (/\b(generate|create|make|draw|render)\b.{0,20}(image|photo|picture|illustration|art|painting|logo|icon)\b/i.test(text)) {
    return { tier: 3, reason: 'image gen \u2192 DALL-E' };
  }
  if (/\b(generate|create|make)\b.{0,20}(video|animation|clip|reel)\b/i.test(text)) {
    return { tier: 3, reason: 'video gen \u2192 Runway' };
  }

  // Short messages → fast 8b
  if (len < 80) return { tier: 1, reason: 'short \u2192 8b' };

  // Complex tasks → 70b (still Groq, still cheap)
  const complex = [
    /\b(analyze|analyse|explain|compare|evaluate|strategy|roadmap|plan|draft|write|rewrite|summarize)\b.{15,}/i,
    /\b(pros and cons|trade.?offs?|recommend|decision|swot|business)\b/i,
    /\b(step by step|detailed|comprehensive|in.depth)\b/i,
    /```[\s\S]{30,}/,
    /\b(debug|refactor|optimize|implement|build)\b.{20,}/i,
  ];
  if (complex.some(p => p.test(text)) || len > 400) return { tier: 2, reason: 'complex \u2192 70b' };

  return { tier: 1, reason: 'standard \u2192 8b' };
}

function getModel(tier: 1 | 2 | 3, settings: Record<string, string>): { provider: string; model: string } {
  if (tier === 1) return {
    provider: settings.chat_fast_provider || settings.companion_provider || 'groq',
    model:    settings.chat_fast_model    || 'llama-3.3-70b-versatile',
  };
  if (tier === 2) return {
    provider: settings.companion_provider || 'groq',
    model:    settings.companion_model    || 'gemini-2.0-flash',
  };
  return { provider: 'openai', model: 'dall-e-3' };
}

// ── Main entry point ───────────────────────────────────────────────────────
export function route(text: string, context: GatewayContext = {}): GatewayResult {
  const trimmed = text.trim();

  // Tier 0: local — always first
  for (const p of LOCAL_PATTERNS) {
    const matched = typeof p.match === 'function' ? p.match(trimmed) : p.match.test(trimmed);
    if (matched) {
      const r = p.respond(trimmed);
      if (r !== null) return { handled: true, response: r };
    }
  }

  // Tier 1-3: AI routing
  const { tier, reason } = classifyTier(trimmed);
  const settings = context.settings || {};

  // ── Smart coder routing — Qwen 2.5 Coder 32B for code questions ──────────
  const smartCodeRouting = settings.smart_code_routing !== 'false'; // default ON
  const intent = classifyIntent(trimmed);
  if (intent === 'code' && smartCodeRouting) {
    return {
      handled: false,
      tier: 1,
      provider: 'groq',
      model: DEFAULT_CODER_MODEL,
      reason: 'code intent → Qwen Coder 32B',
      estimatedTokens: Math.ceil(trimmed.length / 4) + 600,
      coderSystem: buildCoderSystemPrompt({ userName: settings.user_name }),
    };
  }

  const { provider, model } = getModel(tier, settings);
  return { handled: false, tier, provider, model, reason, estimatedTokens: Math.ceil(trimmed.length / 4) + 600 };
}

// ── Cost tracking ──────────────────────────────────────────────────────────
const PRICING: Record<string, number> = {
  'llama-3.1-8b-instant':        0.05  / 1_000_000,
  'llama-3.3-70b-versatile': 0.59  / 1_000_000,
  'gemma2-9b-it':            0.20  / 1_000_000,
  'gpt-4o-mini':             0.15  / 1_000_000,
  'gpt-4o':                  2.50  / 1_000_000,
  'dall-e-3':                0.04, // per image
};

export function estimateCost(tokens: number, model: string): number {
  return tokens * (PRICING[model] || 0.001 / 1_000_000);
}

export function trackCost(model: string, tokens: number): void {
  try {
    const entries = JSON.parse(localStorage.getItem('henry:cost_log') || '[]') as { ts:number; model:string; tokens:number; cost:number }[];
    entries.unshift({ ts: Date.now(), model, tokens, cost: estimateCost(tokens, model) });
    localStorage.setItem('henry:cost_log', JSON.stringify(entries.slice(0, 500)));
  } catch { /* ignore */ }
}

export function getDailyCost(): { tokens: number; costUsd: number; savedVsGpt4: number; topModel: string } {
  try {
    const entries = JSON.parse(localStorage.getItem('henry:cost_log') || '[]') as { ts:number; model:string; tokens:number; cost:number }[];
    const today = new Date().setHours(0,0,0,0);
    const todayEntries = entries.filter(e => e.ts >= today);
    const tokens = todayEntries.reduce((s,e) => s+e.tokens, 0);
    const costUsd = todayEntries.reduce((s,e) => s+e.cost, 0);
    const savedVsGpt4 = todayEntries.reduce((s,e) => s + (e.tokens * 2.50/1_000_000) - e.cost, 0);
    const modelCounts: Record<string,number> = {};
    todayEntries.forEach(e => { modelCounts[e.model] = (modelCounts[e.model]||0) + 1; });
    const topModel = Object.entries(modelCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'none';
    return { tokens, costUsd, savedVsGpt4, topModel };
  } catch {
    return { tokens:0, costUsd:0, savedVsGpt4:0, topModel:'none' };
  }
}
