/**
 * Henry AI — the single front door for any panel that needs to call an LLM.
 *
 * Every panel that does AI work (journal reflection, task suggestions, etc.)
 * should call `callHenryAI()` instead of hitting providers directly.
 *
 * Routing chain (in priority order):
 *   1. User's own Groq key (free, BYOK) — if they have one configured, use it.
 *   2. User's local Ollama — if it's running, use it. Free, private, offline.
 *   3. User's own OpenAI / Anthropic / Google key — same logic, BYOK.
 *   4. Henry Cloud Proxy — ONLY if the user has a license key. This is the
 *      paid path that the developer pre-pays for. Without a license, this
 *      branch is skipped entirely so the developer never pays for free users.
 *   5. Throw `NoBackendAvailableError` with a friendly message pointing the
 *      user at the easiest setup path (free Groq key, 60 seconds).
 *
 * This is the cost protection: free users with NO setup get a friendly nudge
 * to add a free Groq key, NOT a free ride on the developer's dime.
 */

import { canUseHenryProxy, getDeviceId, getLicenseKey, HENRY_PROXY_URL, incrementUsage } from './proxyUsage';

export interface HenryAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallHenryAIOptions {
  messages: HenryAIMessage[];
  /** Max tokens to generate. Keep this tight — 200 is enough for most reflections. */
  maxTokens?: number;
  /** Temperature. 0.7 is the default; lower for factual, higher for creative. */
  temperature?: number;
  /** Preferred Groq/proxy model. Defaults to llama-3.1-8b for speed/cost. */
  preferredModel?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Whether the panel is OK with no backend (returns null instead of throwing). */
  allowNoBackend?: boolean;
}

export class NoBackendAvailableError extends Error {
  readonly userFacingMessage: string;
  constructor() {
    super('No AI backend available. User needs to set up Groq, Ollama, or a license.');
    this.name = 'NoBackendAvailableError';
    this.userFacingMessage =
      "Henry needs an AI provider to answer that. The fastest setup: open **Settings → AI Providers**, " +
      "tap **Groq**, and paste a free key from console.groq.com (60 seconds). " +
      "Or install **Ollama** for fully-local, fully-free AI.";
  }
}

interface ResolvedBackend {
  kind: 'groq' | 'ollama' | 'openai' | 'anthropic' | 'google' | 'proxy';
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

/** Look at user-configured providers and decide which (if any) we can use. */
async function resolveBackend(preferredModel?: string): Promise<ResolvedBackend | null> {
  const apiObj = (typeof window !== 'undefined' ? (window as { henryAPI?: { getProviders?: () => Promise<unknown[]> } }).henryAPI : null);
  let providers: Array<{ id: string; api_key?: string; apiKey?: string; enabled?: boolean }> = [];
  try {
    if (apiObj?.getProviders) {
      providers = (await apiObj.getProviders()) as typeof providers;
    }
  } catch { /* fall through to proxy/local */ }

  const findKey = (id: string): string => {
    const p = providers.find((p) => p.id === id);
    return ((p?.api_key || p?.apiKey || '') as string).trim();
  };

  // 1. Groq key (BYOK) — preferred because it's free + fast for the user
  const groqKey = findKey('groq');
  if (groqKey.length > 10) {
    return { kind: 'groq', apiKey: groqKey, model: preferredModel || 'llama-3.1-8b-instant' };
  }

  // 2. Local Ollama
  const ollamaProvider = providers.find((p) => p.id === 'ollama' && p.enabled);
  if (ollamaProvider) {
    // Quick liveness check — don't return ollama if the daemon isn't running
    const baseUrl = (() => {
      try {
        const raw = localStorage.getItem('henry:settings');
        if (raw) {
          const s = JSON.parse(raw) as Record<string, string>;
          return s.ollama_base_url || 'http://localhost:11434';
        }
      } catch { /* ignore */ }
      return 'http://localhost:11434';
    })();
    try {
      const ping = await fetch(baseUrl + '/api/tags', { signal: AbortSignal.timeout(800) });
      if (ping.ok) {
        // Pick the first installed model — caller can override
        const data = await ping.json() as { models?: Array<{ name: string }> };
        const firstModel = data.models?.[0]?.name;
        if (firstModel) {
          return { kind: 'ollama', baseUrl, model: preferredModel || firstModel };
        }
      }
    } catch { /* ollama not running — try other backends */ }
  }

  // 3. OpenAI / Anthropic / Google (BYOK)
  for (const id of ['openai', 'anthropic', 'google'] as const) {
    const key = findKey(id);
    if (key.length > 10) {
      const defaultModels: Record<string, string> = {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-haiku-4-5-20251001',
        google: 'gemini-2.0-flash',
      };
      return { kind: id, apiKey: key, model: preferredModel || defaultModels[id] };
    }
  }

  // 4. Henry Cloud Proxy — gated by license key
  if (canUseHenryProxy()) {
    return { kind: 'proxy', model: preferredModel || 'llama-3.3-70b-versatile' };
  }

  // 5. No backend
  return null;
}

/**
 * Call an LLM, routing through the best available backend.
 *
 * Returns the text response, or `null` when `allowNoBackend: true` and there's
 * no path. Throws `NoBackendAvailableError` otherwise. Throws on network/HTTP
 * errors after attempting the chosen backend.
 */
export async function callHenryAI(opts: CallHenryAIOptions): Promise<string | null> {
  const backend = await resolveBackend(opts.preferredModel);
  if (!backend) {
    if (opts.allowNoBackend) return null;
    throw new NoBackendAvailableError();
  }

  const maxTokens = opts.maxTokens ?? 500;
  const temperature = opts.temperature ?? 0.7;
  const signal = opts.signal ?? AbortSignal.timeout(30_000);

  // ── Groq (direct via user's key) ────────────────────────────────────────
  if (backend.kind === 'groq') {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${backend.apiKey}` },
      body: JSON.stringify({ model: backend.model, messages: opts.messages, max_tokens: maxTokens, temperature, stream: false }),
      signal,
    });
    if (!r.ok) throw new Error(`Groq error ${r.status}: ${await r.text().catch(() => 'unknown')}`);
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  // ── Ollama (local) ──────────────────────────────────────────────────────
  if (backend.kind === 'ollama') {
    const r = await fetch((backend.baseUrl || 'http://localhost:11434') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: backend.model, messages: opts.messages, stream: false, options: { temperature, num_predict: maxTokens } }),
      signal,
    });
    if (!r.ok) throw new Error(`Ollama error ${r.status}`);
    const data = await r.json() as { message?: { content?: string } };
    return data.message?.content?.trim() ?? '';
  }

  // ── OpenAI ──────────────────────────────────────────────────────────────
  if (backend.kind === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${backend.apiKey}` },
      body: JSON.stringify({ model: backend.model, messages: opts.messages, max_tokens: maxTokens, temperature }),
      signal,
    });
    if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  // ── Anthropic ───────────────────────────────────────────────────────────
  if (backend.kind === 'anthropic') {
    // Convert OpenAI-style messages to Anthropic system + messages
    const sys = opts.messages.find((m) => m.role === 'system')?.content;
    const turns = opts.messages.filter((m) => m.role !== 'system');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': backend.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: backend.model,
        max_tokens: maxTokens,
        temperature,
        ...(sys ? { system: sys } : {}),
        messages: turns.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal,
    });
    if (!r.ok) throw new Error(`Anthropic error ${r.status}`);
    const data = await r.json() as { content?: Array<{ text?: string }> };
    return data.content?.map((c) => c.text || '').join('').trim() ?? '';
  }

  // ── Google Gemini ───────────────────────────────────────────────────────
  if (backend.kind === 'google') {
    const sys = opts.messages.find((m) => m.role === 'system')?.content;
    const turns = opts.messages.filter((m) => m.role !== 'system');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${backend.model}:generateContent?key=${backend.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
        contents: turns.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
      signal,
    });
    if (!r.ok) throw new Error(`Gemini error ${r.status}`);
    const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() ?? '';
  }

  // ── Henry Cloud Proxy (license required) ────────────────────────────────
  if (backend.kind === 'proxy') {
    const r = await fetch(HENRY_PROXY_URL + '/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Henry-Device': getDeviceId(),
        'X-Henry-License': getLicenseKey(),
      },
      body: JSON.stringify({ model: backend.model, messages: opts.messages, max_tokens: maxTokens, temperature, stream: false }),
      signal,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        throw new Error('Henry license expired or invalid — check Settings → License.');
      }
      if (r.status === 429) {
        throw new Error('Henry proxy daily limit reached. Add your free Groq key for unlimited use.');
      }
      throw new Error(`Henry proxy error ${r.status}`);
    }
    try { incrementUsage(); } catch { /* non-critical */ }
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  return null;
}

/**
 * Convenience: check whether ANY AI backend is available right now.
 * Useful for panels that want to disable an AI button when nothing is configured.
 */
export async function hasAIBackend(): Promise<boolean> {
  return (await resolveBackend()) !== null;
}

/**
 * Returns a friendly description of which backend would be used, for diagnostic
 * UI. Examples: "Your Groq key", "Local Ollama", "Henry license proxy", "None".
 */
export async function describeActiveBackend(): Promise<string> {
  const b = await resolveBackend();
  if (!b) return 'None — set up an AI provider';
  switch (b.kind) {
    case 'groq':      return `Your Groq key (${b.model})`;
    case 'ollama':    return `Local Ollama (${b.model})`;
    case 'openai':    return `Your OpenAI key (${b.model})`;
    case 'anthropic': return `Your Anthropic key (${b.model})`;
    case 'google':    return `Your Google key (${b.model})`;
    case 'proxy':     return `Henry license proxy (${b.model})`;
  }
}
