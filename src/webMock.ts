import { v4 as uuidv4 } from 'uuid';

function getStore<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

let platformString: string;
if (typeof window !== "undefined") {
  // Renderer: use the value exposed by the preload contextBridge
  platformString = window.henryAPI.platform();
}
function setStore<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

type Listener<T> = (data: T) => void;
const listeners: Record<string, Listener<unknown>[]> = {};

function emit(event: string, data: unknown) {
  (listeners[event] || []).forEach((cb) => cb(data));
}

function on<T>(event: string, cb: Listener<T>): () => void {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(cb as Listener<unknown>);
  return () => {
    listeners[event] = listeners[event].filter((l) => l !== cb);
  };
}

const now = () => new Date().toISOString();

// ── Chat attachments (web mode) ──────────────────────────────────────────────
// The desktop build stores bytes on disk via attachments:* IPC. A browser has
// no equivalent, so bytes are held in memory for the session and the index
// lives in localStorage. Reloading the page drops the bytes — the desktop app
// is the supported path for persistent attachments.
const webAttachmentBytes = new Map<string, string>(); // id -> data URL


import { tryCerebrasFallback, isGroqRateLimit } from './henry/providers/cerebras';
import { log } from './henry/log';

// ── Direct API endpoints (bypass the Vite dev-server proxy) ───────────────
// Groq supports browser-side CORS requests natively — calling api.groq.com
// directly is simpler and more reliable than routing through the local proxy.
const GROQ_DIRECT = 'https://api.groq.com';

// ── Mobile proxy support ───────────────────────────────────────────────────
// On web/Electron: relative /proxy/* paths work (Vite dev server or IPC).
// On Capacitor iOS/Android: there is no local server — must prefix with the
// user-configured Cloudflare Worker URL stored in henry:mobile_proxy_url.
function getProxyBase(): string {
  try {
    const cap = (window as any).Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      return (localStorage.getItem('henry:mobile_proxy_url') || '').replace(/\/$/, '');
    }
  } catch { /* ignore */ }
  return '';
}

function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getProxyBase()}${path}`, init);
}

// Direct fetch to Groq — no local proxy hop, no Replit reverse-proxy layers.
function groqFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GROQ_DIRECT}${path}`, init);
}

// ── Worker Brain: actual AI execution in web mode ──────────────────────────
// Runs in the background after submitTask; injects result back into the thread.
async function runWorkerAI(params: {
  taskId: string;
  description: string;
  contextMessages: HenryAIMessage[];
  workerProvider: string;
  workerModel: string;
  apiKey: string;
  ollamaBaseUrl: string;
  conversationId?: string;
  currentMode: string;
}): Promise<void> {
  const { taskId, description, contextMessages, workerProvider, workerModel, apiKey, ollamaBaseUrl, conversationId, currentMode } = params;

  function updateTask(patch: Partial<import('./types').Task>) {
    const tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return;
    tasks[idx] = { ...tasks[idx], ...patch };
    setStore('henry:tasks', tasks);
    emit('task:update', tasks[idx]);
  }

  updateTask({ status: 'running', started_at: now() });

  const modeName = (['companion','writer','developer','builder','design3d','computer','secretary'] as const).includes(currentMode as any)
    ? (currentMode as import('./henry/charter').HenryOperatingMode)
    : 'developer';

  let systemPrompt: string;
  try {
    const { buildWorkerAITaskSystemPrompt } = await import('./henry/charter');
    const contextSummary = contextMessages
      .filter((m) => m.role !== 'system')
      .slice(-6)
      .map((m) => `${m.role === 'user' ? (localStorage.getItem('henry:owner_name')?.trim() || 'User') : 'Henry'}: ${m.content.slice(0, 400)}`)
      .join('\n');
    systemPrompt = buildWorkerAITaskSystemPrompt(contextSummary || undefined, modeName);
  } catch {
    systemPrompt = `You are Henry's Worker Brain — a background AI engine running a delegated task. Be thorough and complete. Task: ${description}`;
  }

  const messages: HenryAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...contextMessages.filter((m) => m.role !== 'system').slice(-8),
    { role: 'user', content: description },
  ];

  try {
    let resultText = '';

    if (workerProvider === 'openai') {
      const res = await proxyFetch('/proxy/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: workerModel, messages, temperature: 0.7, max_tokens: 4000 }),
      });
      const data = await res.json() as any;
      resultText = data.choices?.[0]?.message?.content ?? '';
    } else if (workerProvider === 'groq') {
      const res = await groqFetch('/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: workerModel, messages, temperature: 0.7, max_tokens: 4000 }),
      });
      const data = await res.json() as any;
      resultText = data.choices?.[0]?.message?.content ?? '';
    } else if (workerProvider === 'openrouter') {
      const res = await proxyFetch('/proxy/openrouter/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://henry.ai',
          'X-Title': 'Henry AI',
        },
        body: JSON.stringify({ model: workerModel, messages, temperature: 0.7, max_tokens: 4000 }),
      });
      const data = await res.json() as any;
      resultText = data.choices?.[0]?.message?.content ?? '';
    } else if (workerProvider === 'anthropic') {
      const sysMsg = messages.find((m) => m.role === 'system');
      const convMsgs = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      const res = await proxyFetch('/proxy/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: workerModel, max_tokens: 4000, system: sysMsg?.content ?? '', messages: convMsgs }),
      });
      const data = await res.json() as any;
      resultText = data.content?.[0]?.text ?? '';
    } else if (workerProvider === 'google') {
      const convMsgs = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const res = await proxyFetch(
        `/proxy/google/v1beta/models/${workerModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: convMsgs }),
        }
      );
      const data = await res.json() as any;
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (workerProvider === 'ollama') {
      const base = (ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: workerModel, messages, stream: false }),
      });
      const data = await res.json() as any;
      resultText = data.message?.content ?? '';
    }

    if (!resultText.trim()) throw new Error('Worker returned empty response');

    updateTask({ status: 'completed', result: resultText, completed_at: now() });

    if (conversationId) {
      const { v4: uuidv4 } = await import('uuid');
      const workerMsg: import('./types').Message = {
        id: uuidv4(),
        conversation_id: conversationId,
        role: 'assistant',
        content: `*— Worker Brain*\n\n${resultText}`,
        engine: 'worker',
        model: workerModel,
        provider: workerProvider,
        created_at: now(),
      };
      const allMsgs = getStore<import('./types').Message[]>('henry:messages', []);
      allMsgs.push(workerMsg);
      setStore('henry:messages', allMsgs);
      emit('worker:message', workerMsg);
    }
  } catch (err) {
    updateTask({ status: 'failed', error: String(err), completed_at: now() });
  }
}

// Token/cost estimator for web-mode cost tracking (no DB cost_log in browser)
function estimateUsage(
  fullText: string,
  params: { model?: string; messages?: { content: string }[] }
): { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number } {
  const outputTokens = Math.ceil(fullText.length / 4);
  const inputTokens = Math.ceil(
    (params.messages || []).reduce((s, m) => s + (m.content || '').length, 0) / 4
  );
  const MODEL_RATES: Record<string, [number, number]> = {
    'llama-3.1-8b-instant':          [0.06,  0.08],
    'llama-3.3-70b-versatile':   [0.59,  0.79],
    'llama-4-scout-17b-16e-instruct': [0.11, 0.34],
    'gpt-4o':                    [2.5,  10.0],
    'gpt-4o-mini':               [0.15,  0.60],
    'claude-sonnet-4-20250514':  [3.0,  15.0],
    'claude-3-5-haiku-20241022': [0.8,   4.0],
    'gemini-2.0-flash':          [0.1,   0.4],
    'gemini-2.5-pro':            [1.25, 10.0],
    'gemini-2.5-flash':          [0.15,  0.6],
  };
  const [inRate, outRate] = MODEL_RATES[params.model || ''] || [0.06, 0.08];
  const cost = (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cost: Math.round(cost * 1_000_000) / 1_000_000,
  };
}


const henryAPI: Window['henryAPI'] = {
  getSettings: async () => {
    return getStore<Record<string, string>>('henry:settings', {});
  },
  saveSetting: async (key, value) => {
    const s = getStore<Record<string, string>>('henry:settings', {});
    s[key] = value;
    setStore('henry:settings', s);
    return true;
  },

  getProviders: async () => {
    return getStore('henry:providers', []);
  },
  resyncProvidersToLocalStorage: async () => ({ ok: true, count: 0 }),
  saveProvider: async (provider) => {
    const providers = getStore<HenryProviderRecord[]>('henry:providers', []);
    const idx = providers.findIndex((p) => p.id === provider.id);
    const record: HenryProviderRecord = {
      ...provider,
      enabled: provider.enabled ? 1 : 0,
    };
    if (idx >= 0) {
      providers[idx] = record;
    } else {
      providers.push(record);
    }
    setStore('henry:providers', providers);
    // Matches the providers:save handler's { ok } envelope (it never returns a
    // bare boolean, and no caller branches on the value).
    return { ok: true };
  },

  platform: () => platformString,
  getConversations: async () => {
    return getStore('henry:conversations', []);
  },
  createConversation: async (title) => {
    const convos = getStore<import('./types').Conversation[]>('henry:conversations', []);
    const convo = { id: uuidv4(), title, created_at: now(), updated_at: now(), message_count: 0 };
    convos.unshift(convo);
    setStore('henry:conversations', convos);
    return convo;
  },
  updateConversation: async (id, title) => {
    const convos = getStore<import('./types').Conversation[]>('henry:conversations', []);
    const idx = convos.findIndex((c) => c.id === id);
    if (idx >= 0) {
      convos[idx] = { ...convos[idx], title, updated_at: now() };
      setStore('henry:conversations', convos);
    }
    return true;
  },
  deleteConversation: async (id) => {
    const convos = getStore<import('./types').Conversation[]>('henry:conversations', []);
    setStore('henry:conversations', convos.filter((c) => c.id !== id));
    const allMsgs = getStore<import('./types').Message[]>('henry:messages', []);
    setStore('henry:messages', allMsgs.filter((m) => m.conversation_id !== id));
    return true;
  },

  getMessages: async (conversationId) => {
    const allMsgs = getStore<import('./types').Message[]>('henry:messages', []);
    return allMsgs.filter((m) => m.conversation_id === conversationId);
  },
  saveMessage: async (message) => {
    const allMsgs = getStore<import('./types').Message[]>('henry:messages', []);
    const idx = allMsgs.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      allMsgs[idx] = message;
    } else {
      allMsgs.push(message);
    }
    setStore('henry:messages', allMsgs);
    return true;
  },

  saveAttachment: async (input) => {
    try {
      const id = uuidv4();
      const bytes =
        // Chunked: `String.fromCharCode(...bytes)` spreads the whole array as
        // arguments and throws RangeError on any real file.
        typeof input.data === 'string'
          ? input.data
          : (() => {
              let bin = '';
              const CHUNK = 0x8000;
              for (let i = 0; i < input.data.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, Array.from(input.data.subarray(i, i + CHUNK)) as number[]);
              }
              return btoa(bin);
            })();
      webAttachmentBytes.set(id, bytes);
      const rows = getStore<import('./types').MessageAttachment[]>('henry:attachments', []);
      const record: import('./types').MessageAttachment = {
        id,
        conversation_id: input.conversationId ?? null,
        message_id: input.messageId ?? null,
        file_name: input.fileName,
        mime_type: input.mimeType ?? null,
        byte_size: Math.floor((bytes.length * 3) / 4),
        created_at: now(),
      };
      rows.push(record);
      setStore('henry:attachments', rows);
      return { ok: true, attachment: record };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  linkAttachmentsToMessage: async (ids, messageId, conversationId) => {
    const rows = getStore<import('./types').MessageAttachment[]>('henry:attachments', []);
    let count = 0;
    for (const r of rows) {
      if (ids.includes(r.id)) {
        r.message_id = messageId;
        if (conversationId) r.conversation_id = conversationId;
        count++;
      }
    }
    setStore('henry:attachments', rows);
    return { ok: true, count };
  },
  listAttachments: async (conversationId) =>
    getStore<import('./types').MessageAttachment[]>('henry:attachments', [])
      .filter((a) => a.conversation_id === conversationId),
  listAttachmentsForMessage: async (messageId) =>
    getStore<import('./types').MessageAttachment[]>('henry:attachments', [])
      .filter((a) => a.message_id === messageId),
  getAttachment: async (id) => {
    const row = getStore<import('./types').MessageAttachment[]>('henry:attachments', [])
      .find((a) => a.id === id);
    if (!row) return { ok: false, error: 'Attachment not found.' };
    const dataUrl = webAttachmentBytes.get(id);
    if (!dataUrl) {
      return { ok: false, error: 'Attachment bytes are no longer in memory — this only persists in the desktop app.' };
    }
    return { ok: true, mimeType: row.mime_type ?? undefined, fileName: row.file_name, byteSize: row.byte_size, dataUrl };
  },
  deleteAttachment: async (id) => {
    const rows = getStore<import('./types').MessageAttachment[]>('henry:attachments', []);
    setStore('henry:attachments', rows.filter((a) => a.id !== id));
    webAttachmentBytes.delete(id);
    return { ok: true };
  },
  openAttachment: async (id) => {
    const res = await (henryAPI as { getAttachment: (i: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }> })
      .getAttachment(id);
    if (!res.ok || !res.dataUrl) return { ok: false, error: res.error ?? 'Could not open attachment.' };
    window.open(res.dataUrl, '_blank');
    return { ok: true };
  },

  sendMessage: async (params) => {
    const { provider, model, apiKey, messages, temperature, maxTokens } = params;

    if (provider === 'openai') {
      const res = await proxyFetch('/proxy/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, max_tokens: maxTokens }),
      });
      const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      return { content: data.choices[0].message.content, usage: data.usage };
    }

    if (provider === 'groq') {
      const res = await groqFetch('/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, max_tokens: maxTokens }),
      });
      const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: HenryAIUsage };
      return { content: data.choices[0].message.content, usage: data.usage };
    }

    if (provider === 'openrouter') {
      const res = await proxyFetch('/proxy/openrouter/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://henry.ai',
          'X-Title': 'Henry AI',
        },
        body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, max_tokens: maxTokens }),
      });
      const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: HenryAIUsage };
      return { content: data.choices[0].message.content, usage: data.usage };
    }

    if (provider === 'anthropic') {
      const systemMsg = messages.find((m) => m.role === 'system');
      const userMsgs = messages.filter((m) => m.role !== 'system');
      const res = await proxyFetch('/proxy/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          messages: userMsgs,
          system: systemMsg?.content,
          max_tokens: maxTokens ?? 4096,
          temperature: temperature ?? 0.7,
        }),
      });
      const data = await res.json() as { content: Array<{ text: string }>; usage?: unknown };
      return { content: data.content[0].text, usage: data.usage as HenryAIUsage };
    }

    if (provider === 'google') {
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const res = await proxyFetch(
        `/proxy/google/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents }),
        }
      );
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return { content: data.candidates[0].content.parts[0].text };
    }

    if (provider === 'ollama') {
      const settings = getStore<Record<string, string>>('henry:settings', {});
      const baseUrl = settings.ollama_base_url || 'http://localhost:11434';
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
      });
      const data = await res.json() as { message: { content: string } };
      return { content: data.message.content };
    }

    throw new Error(`Unsupported provider: ${provider}`);
  },

  streamMessage: (params) => {
    const { provider, model, apiKey, messages, temperature, maxTokens } = params;
    let chunkCb: ((chunk: string) => void) | null = null;
    let doneCb: ((fullText: string, usage?: HenryAIUsage) => void) | null = null;
    let errorCb: ((error: string) => void) | null = null;
    let aborted = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        let fullText = '';

        // ── Shared SSE reader for OpenAI-compatible providers ──────────────
        const readOpenAIStream = async (res: Response) => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let streamDone = false;
          while (!aborted && !streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            const lines = text.split('\n').filter((l) => l.startsWith('data: '));
            for (const line of lines) {
              const json = line.slice(6).trim();
              if (json === '[DONE]') { streamDone = true; break; }
              try {
                const parsed = JSON.parse(json) as { choices: Array<{ delta: { content?: string } }> };
                const chunk = parsed.choices[0]?.delta?.content || '';
                if (chunk) { fullText += chunk; chunkCb?.(chunk); }
              } catch { /* skip bad JSON */ }
            }
          }
        };

        if (provider === 'openai') {
          const res = await proxyFetch('/proxy/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, max_tokens: maxTokens, stream: true }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            let errMsg = `OpenAI ${res.status}: ${res.statusText}`;
            try { const j = JSON.parse(errBody) as { error?: { message?: string } }; if (j.error?.message) errMsg = `OpenAI error: ${j.error.message}`; } catch { /* */ }
            throw new Error(errMsg);
          }
          await readOpenAIStream(res);
          doneCb?.(fullText, estimateUsage(fullText, params));
        } else if (provider === 'groq') {
          const res = await groqFetch('/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, max_tokens: maxTokens, stream: true }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            let errMsg = `Groq ${res.status}: ${res.statusText}`;
            try { const j = JSON.parse(errBody) as { error?: { message?: string } }; if (j.error?.message) errMsg = `Groq error: ${j.error.message}`; } catch { /* */ }
            // Silent Cerebras fallback on 429 rate-limit
            if (isGroqRateLimit(res.status)) {
              const cerebrasKey = (params as any).cerebrasApiKey as string | undefined
                ?? localStorage.getItem('henry:cerebras_api_key') ?? undefined;
              const fallback = await tryCerebrasFallback({ cerebrasApiKey: cerebrasKey, model, messages, signal: controller.signal });
              if (fallback?.ok) { chunkCb?.(fallback.text); doneCb?.(fallback.text, estimateUsage(fallback.text, params)); return; }
            }
            throw new Error(errMsg);
          }
          await readOpenAIStream(res);
          doneCb?.(fullText, estimateUsage(fullText, params));
        } else if (provider === 'openrouter') {
          const res = await proxyFetch('/proxy/openrouter/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://henry.ai',
              'X-Title': 'Henry AI',
            },
            body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, max_tokens: maxTokens, stream: true }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            let errMsg = `OpenRouter ${res.status}: ${res.statusText}`;
            try { const j = JSON.parse(errBody) as { error?: { message?: string } }; if (j.error?.message) errMsg = `OpenRouter error: ${j.error.message}`; } catch { /* */ }
            throw new Error(errMsg);
          }
          await readOpenAIStream(res);
          doneCb?.(fullText, estimateUsage(fullText, params));
        } else if (provider === 'anthropic') {
          const systemMsg = messages.find((m) => m.role === 'system');
          const userMsgs = messages.filter((m) => m.role !== 'system');
          const res = await proxyFetch('/proxy/anthropic/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              messages: userMsgs,
              system: systemMsg?.content,
              max_tokens: maxTokens ?? 4096,
              temperature: temperature ?? 0.7,
              stream: true,
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            let errMsg = `Anthropic ${res.status}: ${res.statusText}`;
            try { const j = JSON.parse(errBody) as { error?: { message?: string } }; if (j.error?.message) errMsg = `Anthropic error: ${j.error.message}`; } catch { /* */ }
            throw new Error(errMsg);
          }
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            const lines = text.split('\n').filter((l) => l.startsWith('data: '));
            for (const line of lines) {
              const json = line.slice(6).trim();
              try {
                const parsed = JSON.parse(json) as { type: string; delta?: { text?: string } };
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  fullText += parsed.delta.text;
                  chunkCb?.(parsed.delta.text);
                }
              } catch { /* skip */ }
            }
          }
          doneCb?.(fullText, estimateUsage(fullText, params));
        } else if (provider === 'google') {
          const contents = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
          const res = await proxyFetch(
            `/proxy/google/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents }),
              signal: controller.signal,
            }
          );
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            let errMsg = `Google ${res.status}: ${res.statusText}`;
            try { const j = JSON.parse(errBody) as { error?: { message?: string } }; if (j.error?.message) errMsg = `Google error: ${j.error.message}`; } catch { /* */ }
            throw new Error(errMsg);
          }
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            const lines = text.split('\n').filter((l) => l.startsWith('data: '));
            for (const line of lines) {
              const json = line.slice(6).trim();
              try {
                const parsed = JSON.parse(json) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
                const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (chunk) {
                  fullText += chunk;
                  chunkCb?.(chunk);
                }
              } catch { /* skip */ }
            }
          }
          doneCb?.(fullText, estimateUsage(fullText, params));
        } else if (provider === 'ollama') {
          const settings = getStore<Record<string, string>>('henry:settings', {});
          const baseUrl = (settings.ollama_base_url || 'http://localhost:11434').replace(/\/$/, '');

          // Detect HTTPS→HTTP mixed-content block (web preview on Replit can't reach local Ollama)
          const isHttpOllama = baseUrl.startsWith('http://');
          const isHttpsPage = typeof window !== 'undefined' && window.location.protocol === 'https:';
          if (isHttpOllama && isHttpsPage) {
            errorCb?.(
              `Can't reach Ollama from the web browser.\n\n` +
              `This page is served over HTTPS, but Ollama is at ${baseUrl} (HTTP) — browsers block that mix.\n\n` +
              `Options:\n` +
              `• Switch to a cloud provider (Anthropic/OpenAI) in Settings → AI Providers\n` +
              `• Use the Mac desktop app where Ollama works natively\n` +
              `• Or expose Ollama over HTTPS with a tunnel (e.g. cloudflared)`
            );
            return;
          }

          const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              stream: true,
              options: { temperature: temperature ?? 0.7 },
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            if (res.status === 404) {
              throw new Error(`Model "${model}" not found in Ollama. Run: ollama pull ${model}`);
            }
            throw new Error(`Ollama ${res.status}: ${errText || res.statusText}`);
          }
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let lineBuffer = '';
          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed) as {
                  message?: { content?: string };
                  response?: string;
                  done?: boolean;
                  error?: string;
                };
                if (parsed.error) throw new Error(parsed.error);
                if (parsed.done) continue;
                const chunk = parsed.message?.content ?? parsed.response ?? '';
                if (chunk) {
                  fullText += chunk;
                  chunkCb?.(chunk);
                }
              } catch (e) {
                if ((e as Error).message && !((e as Error) instanceof SyntaxError)) throw e;
              }
            }
          }
          if (lineBuffer.trim()) {
            try {
              const parsed = JSON.parse(lineBuffer.trim()) as { message?: { content?: string }; response?: string; done?: boolean };
              if (!parsed.done) {
                const chunk = parsed.message?.content ?? parsed.response ?? '';
                if (chunk) { fullText += chunk; chunkCb?.(chunk); }
              }
            } catch { /* ignore trailing partial line */ }
          }
          doneCb?.(fullText, estimateUsage(fullText, params));
        } else {
          errorCb?.(`Unsupported provider: ${provider}`);
        }
      } catch (err: unknown) {
        if (!aborted) {
          const raw = err instanceof Error ? err.message : String(err);
          const lc = raw.toLowerCase();
          let friendly = `[${provider}] ${raw}`;
          if (lc.includes('failed to fetch') || lc.includes('networkerror') || lc.includes('network request failed') || lc.includes('load failed')) {
            if (provider === 'ollama') {
              const settings = getStore<Record<string, string>>('henry:settings', {});
              const baseUrl = settings.ollama_base_url || 'http://localhost:11434';
              friendly = `Cannot reach Ollama at ${baseUrl}.\n\nMake sure Ollama is running with:\n  OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve\n\nThen confirm the base URL in Settings → Engines matches your Mac's local IP (e.g. http://192.168.1.x:11434).`;
            } else if (provider === 'groq') {
              friendly = `Couldn't reach Groq — this is usually a brief network hiccup. Try sending again. If it keeps happening, reload the page.`;
            } else {
              friendly = `Network error reaching ${provider} API (${raw}).\n\nCheck your connection and API key in Settings → AI Providers.`;
            }
          } else if (lc.includes('context length') || lc.includes('context window') || lc.includes('prompt is too long') || lc.includes('token limit')) {
            friendly = `Context window full — the conversation is too long for this model. Start a new chat or switch to a model with a larger context window.`;
          } else if (lc.includes('model') && (lc.includes('not found') || lc.includes('does not exist') || lc.includes('404'))) {
            friendly = `Model not found in Ollama. Run \`ollama pull <model-name>\` on your Mac, then try again.`;
          }
          errorCb?.(friendly);
        }
      }
    };

    void run();

    return {
      onChunk: (cb) => { chunkCb = cb; },
      onDone: (cb) => { doneCb = cb; },
      onError: (cb) => { errorCb = cb; },
      cancel: () => {
        aborted = true;
        controller.abort();
      },
    };
  },

  getTasks: async (filter) => {
    let tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter?.limit) tasks = tasks.slice(0, filter.limit);
    return tasks;
  },
  submitTask: async (task) => {
    const tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    const newTask: import('./types').Task = {
      id: uuidv4(),
      description: task.description,
      type: task.type as import('./types').TaskType,
      status: 'pending',
      priority: task.priority ?? 5,
      payload: task.payload ? JSON.stringify(task.payload) : undefined,
      source_engine: task.sourceEngine,
      conversation_id: task.conversationId,
      created_from_mode: task.createdFromMode,
      related_file_path: task.relatedFilePath,
      created_from_message_id: task.createdFromMessageId,
      created_at: now(),
    };
    tasks.unshift(newTask);
    setStore('henry:tasks', tasks);
    emit('task:update', newTask);

    // Auto-execute with Worker AI if provider is configured
    const settings = getStore<Record<string, string>>('henry:settings', {});
    const workerProvider = settings['worker_provider'];
    const workerModel = settings['worker_model'];

    if (workerProvider && workerModel) {
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = task.payload
          ? (typeof task.payload === 'string' ? JSON.parse(task.payload) : (task.payload as Record<string, unknown>))
          : {};
      } catch { /* ignore */ }

      const contextMessages: HenryAIMessage[] = Array.isArray(parsedPayload['context_messages'])
        ? (parsedPayload['context_messages'] as HenryAIMessage[])
        : [];
      const prompt = typeof parsedPayload['prompt'] === 'string' ? parsedPayload['prompt'] : task.description;
      const currentMode = typeof parsedPayload['current_mode'] === 'string' ? parsedPayload['current_mode'] : 'developer';

      const providers = getStore<HenryProviderRecord[]>('henry:providers', []);
      const providerRecord = providers.find((p) => p.id === workerProvider);
      const apiKey = providerRecord?.api_key ?? providerRecord?.apiKey ?? '';
      const ollamaBaseUrl = settings['ollama_base_url'] || 'http://localhost:11434';

      // Schedule async — does not block task submission
      setTimeout(() => {
        void runWorkerAI({
          taskId: newTask.id,
          description: prompt,
          contextMessages,
          workerProvider,
          workerModel,
          apiKey,
          ollamaBaseUrl,
          conversationId: task.conversationId,
          currentMode,
        });
      }, 200);
    }

    return { id: newTask.id, status: newTask.status };
  },
  getTaskStatus: async (id) => {
    const tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    return tasks.find((t) => t.id === id) ?? null;
  },
  cancelTask: async (id) => {
    const tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], status: 'cancelled' };
      setStore('henry:tasks', tasks);
      emit('task:update', tasks[idx]);
      return { id, status: 'cancelled' };
    }
    return { error: 'Task not found' };
  },
  retryTask: async (id) => {
    const tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], status: 'pending', error: undefined };
      setStore('henry:tasks', tasks);
      emit('task:update', tasks[idx]);

      // Re-trigger Worker AI execution so the task doesn't sit at pending forever
      const settings = getStore<Record<string, string>>('henry:settings', {});
      const workerProvider = settings['worker_provider'];
      const workerModel = settings['worker_model'];
      if (workerProvider && workerModel) {
        const task = tasks[idx];
        let parsedPayload: Record<string, unknown> = {};
        try {
          parsedPayload = task.payload
            ? (typeof task.payload === 'string' ? JSON.parse(task.payload as string) : (task.payload as Record<string, unknown>))
            : {};
        } catch { /* ignore */ }
        const contextMessages: HenryAIMessage[] = Array.isArray(parsedPayload['context_messages'])
          ? (parsedPayload['context_messages'] as HenryAIMessage[])
          : [];
        const prompt = typeof parsedPayload['prompt'] === 'string' ? parsedPayload['prompt'] : task.description;
        const currentMode = typeof parsedPayload['current_mode'] === 'string' ? parsedPayload['current_mode'] : 'developer';
        const providers = getStore<HenryProviderRecord[]>('henry:providers', []);
        const providerRecord = providers.find((p) => p.id === workerProvider);
        const apiKey = providerRecord?.api_key ?? providerRecord?.apiKey ?? '';
        const ollamaBaseUrl = settings['ollama_base_url'] || 'http://localhost:11434';
        setTimeout(() => {
          void runWorkerAI({
            taskId: task.id,
            description: prompt,
            contextMessages,
            workerProvider,
            workerModel,
            apiKey,
            ollamaBaseUrl,
            conversationId: task.conversation_id,
            currentMode,
          });
        }, 200);
      }

      return { id, status: 'pending' };
    }
    return { error: 'Task not found' };
  },
  getTaskStats: async () => {
    const tasks = getStore<import('./types').Task[]>('henry:tasks', []);
    const byStatus: Record<string, number> = {};
    let totalCost = 0;
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.cost) totalCost += t.cost;
    }
    const activeCount = (byStatus['running'] || 0) + (byStatus['queued'] || 0);
    return {
      byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
      totalCost,
      activeCount,
    };
  },

  saveFact: async (fact) => {
    const facts = getStore<import('./types').MemoryFact[]>('henry:facts', []);
    const newFact: import('./types').MemoryFact = {
      id: fact.id || uuidv4(),
      conversation_id: fact.conversation_id,
      fact: fact.fact,
      category: fact.category || 'general',
      importance: fact.importance ?? 5,
      created_at: fact.created_at || now(),
    };
    const idx = facts.findIndex((f) => f.id === newFact.id);
    if (idx >= 0) {
      facts[idx] = newFact;
    } else {
      facts.unshift(newFact);
    }
    setStore('henry:facts', facts);
    return newFact;
  },
  searchFacts: async (query) => {
    const facts = getStore<import('./types').MemoryFact[]>('henry:facts', []);
    const q = query.query.toLowerCase();
    return facts.filter((f) => f.fact.toLowerCase().includes(q) || f.category.toLowerCase().includes(q))
      .slice(0, query.limit || 20);
  },
  getAllFacts: async (limit) => {
    const facts = getStore<import('./types').MemoryFact[]>('henry:facts', []);
    return limit ? facts.slice(0, limit) : facts;
  },
  buildContext: async (params) => {
    const facts = getStore<import('./types').MemoryFact[]>('henry:facts', []);
    const summaries = getStore<Record<string, string>>('henry:summaries', {});
    const conversationSummary = params.conversationId ? (summaries[params.conversationId] || null) : null;
    const relevantFacts = facts.slice(0, params.maxFactsFetch || 40);
    return {
      lean: {
        conversationSummary,
        facts: relevantFacts.map((f) => ({ fact: f.fact, category: f.category })),
        workspaceHints: [],
      },
      estimatedTokens: relevantFacts.reduce((acc, f) => acc + Math.ceil(f.fact.length / 4), 0),
      factCount: relevantFacts.length,
    };
  },
  saveSummary: async (summary) => {
    // Store the same row shape the main process returns so getSummary's type
    // holds in both the Electron and web builds.
    const summaries = getStore<Record<string, HenryConversationSummary>>('henry:summaries', {});
    const row: HenryConversationSummary = {
      id: summary.conversationId,
      conversation_id: summary.conversationId,
      summary: summary.summary,
      message_count: summary.messageCount ?? 0,
      token_count: summary.tokenCount ?? Math.ceil(summary.summary.length / 4),
      created_at: new Date().toISOString(),
    };
    summaries[summary.conversationId] = row;
    setStore('henry:summaries', summaries);
    return { id: row.id };
  },
  getSummary: async (conversationId) => {
    const summaries = getStore<Record<string, HenryConversationSummary>>('henry:summaries', {});
    return summaries[conversationId] || null;
  },

  // ── Memory Layer 2: Session ────────────────────────────────────────────────
  saveSessionMemory: async (session) => {
    const id = (session.conversationId as string) || uuidv4();
    const sessions = getStore<Record<string, unknown>>('henry:sessions', {});
    const existing = sessions[id] as Record<string, unknown> | undefined;
    sessions[id] = { ...session, id, updated_at: new Date().toISOString() };
    setStore('henry:sessions', sessions);
    return { id, created: !existing, updated: !!existing };
  },
  getSessionMemory: async (conversationId) => {
    const sessions = getStore<Record<string, unknown>>('henry:sessions', {});
    return (sessions[conversationId] as Record<string, unknown>) || null;
  },
  compressSession: async (opts) => {
    const summaryId = uuidv4();
    const summaries = getStore<Record<string, string>>('henry:summaries', {});
    if (opts.conversationId && opts.summary) {
      summaries[opts.conversationId as string] = opts.summary as string;
      setStore('henry:summaries', summaries);
    }
    return { compressed: true, summaryId };
  },

  // ── Memory Layer 3: Working Memory ────────────────────────────────────────
  getWorkingMemory: async (_userId?) => {
    return getStore<Record<string, unknown> | null>('henry:working_memory_api:v1', null);
  },
  updateWorkingMemory: async (updates) => {
    const current = getStore<Record<string, unknown>>('henry:working_memory_api:v1', {});
    setStore('henry:working_memory_api:v1', { ...current, ...updates, updated_at: new Date().toISOString() });
    return { updated: true };
  },

  // ── Memory Layer 4: Personal Memory ───────────────────────────────────────
  savePersonalMemory: async (item) => {
    const id = uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:personal_memory', []);
    items.push({ ...item, id, created_at: new Date().toISOString() });
    setStore('henry:personal_memory', items);
    return { id };
  },
  getPersonalMemory: async (opts?) => {
    const items = getStore<Record<string, unknown>[]>('henry:personal_memory', []);
    const limit = (opts?.limit as number) || 50;
    return items.slice(-limit).reverse();
  },
  updatePersonalMemory: async (id, updates) => {
    const items = getStore<Record<string, unknown>[]>('henry:personal_memory', []);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) { items[idx] = { ...items[idx], ...updates }; setStore('henry:personal_memory', items); }
    return { updated: idx >= 0 };
  },
  deletePersonalMemory: async (id) => {
    const items = getStore<Record<string, unknown>[]>('henry:personal_memory', []);
    const filtered = items.filter((i) => i.id !== id);
    setStore('henry:personal_memory', filtered);
    return { deleted: filtered.length < items.length };
  },
  recallPersonalMemory: async (id) => {
    const items = getStore<Record<string, unknown>[]>('henry:personal_memory', []);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) { items[idx] = { ...items[idx], last_recalled: new Date().toISOString() }; setStore('henry:personal_memory', items); }
  },

  // ── Memory Layer 5: Projects ───────────────────────────────────────────────
  saveProject: async (project) => {
    const id = (project.id as string) || uuidv4();
    const projects = getStore<Record<string, unknown>[]>('henry:projects', []);
    const idx = projects.findIndex((p) => p.id === id);
    if (idx >= 0) { projects[idx] = { ...projects[idx], ...project, id }; } else { projects.push({ ...project, id, created_at: new Date().toISOString() }); }
    setStore('henry:projects', projects);
    return { id };
  },
  getProjects: async (opts?) => {
    const projects = getStore<Record<string, unknown>[]>('henry:projects', []);
    if (opts?.active_only) return projects.filter((p) => p.status === 'active');
    return projects;
  },
  updateProject: async (id, updates) => {
    const projects = getStore<Record<string, unknown>[]>('henry:projects', []);
    const idx = projects.findIndex((p) => p.id === id);
    if (idx >= 0) { projects[idx] = { ...projects[idx], ...updates }; setStore('henry:projects', projects); }
    return { updated: idx >= 0 };
  },
  saveProjectMemory: async (item) => {
    const id = uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:project_memory', []);
    items.push({ ...item, id, created_at: new Date().toISOString() });
    setStore('henry:project_memory', items);
    return { id };
  },
  getProjectMemory: async (projectId) => {
    const items = getStore<Record<string, unknown>[]>('henry:project_memory', []);
    return items.filter((i) => i.project_id === projectId);
  },

  // ── Memory — Goals ─────────────────────────────────────────────────────────
  saveGoal: async (goal) => {
    const id = (goal.id as string) || uuidv4();
    const goals = getStore<Record<string, unknown>[]>('henry:goals', []);
    const idx = goals.findIndex((g) => g.id === id);
    if (idx >= 0) { goals[idx] = { ...goals[idx], ...goal, id }; } else { goals.push({ ...goal, id, created_at: new Date().toISOString() }); }
    setStore('henry:goals', goals);
    return { id };
  },
  getGoals: async (opts?) => {
    const goals = getStore<Record<string, unknown>[]>('henry:goals', []);
    if (opts?.active_only) return goals.filter((g) => g.status !== 'done');
    return goals;
  },
  updateGoal: async (id, updates) => {
    const goals = getStore<Record<string, unknown>[]>('henry:goals', []);
    const idx = goals.findIndex((g) => g.id === id);
    if (idx >= 0) { goals[idx] = { ...goals[idx], ...updates }; setStore('henry:goals', goals); }
    return { updated: idx >= 0 };
  },

  // ── Memory — Commitments ───────────────────────────────────────────────────
  saveCommitment: async (c) => {
    const id = (c.id as string) || uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:commitments', []);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) { items[idx] = { ...items[idx], ...c, id }; } else { items.push({ ...c, id, created_at: new Date().toISOString() }); }
    setStore('henry:commitments', items);
    return { id };
  },
  getCommitments: async (opts?) => {
    const items = getStore<Record<string, unknown>[]>('henry:commitments', []);
    if (opts?.resolved === false) return items.filter((i) => !i.resolved_at);
    return items;
  },
  resolveCommitment: async (id) => {
    const items = getStore<Record<string, unknown>[]>('henry:commitments', []);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) { items[idx] = { ...items[idx], resolved_at: new Date().toISOString() }; setStore('henry:commitments', items); }
    return { resolved: idx >= 0 };
  },
  updateCommitment: async (id, updates) => {
    const items = getStore<Record<string, unknown>[]>('henry:commitments', []);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) { items[idx] = { ...items[idx], ...updates }; setStore('henry:commitments', items); }
    return { updated: idx >= 0 };
  },

  // ── Memory — Milestones ────────────────────────────────────────────────────
  saveMilestone: async (m) => {
    const id = uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:milestones', []);
    items.push({ ...m, id, created_at: new Date().toISOString() });
    setStore('henry:milestones', items);
    return { id };
  },
  getMilestones: async (opts?) => {
    const items = getStore<Record<string, unknown>[]>('henry:milestones', []);
    const limit = (opts?.limit as number) || 30;
    return items.slice(-limit).reverse();
  },

  // ── Memory Layer 6: Relationship Memory ───────────────────────────────────
  saveRelationshipMemory: async (item) => {
    const id = uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:relationship_memory', []);
    items.push({ ...item, id, created_at: new Date().toISOString() });
    setStore('henry:relationship_memory', items);
    return { id };
  },
  getRelationshipMemory: async (opts?) => {
    const items = getStore<Record<string, unknown>[]>('henry:relationship_memory', []);
    const limit = (opts?.limit as number) || 30;
    return items.slice(-limit).reverse();
  },

  // ── Memory Layer 7: Narrative Memory ──────────────────────────────────────
  saveNarrativeMemory: async (arc) => {
    const id = (arc.id as string) || uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:narrative_memory', []);
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) { items[idx] = { ...items[idx], ...arc, id }; } else { items.push({ ...arc, id, created_at: new Date().toISOString() }); }
    setStore('henry:narrative_memory', items);
    return { id, created: idx < 0, updated: idx >= 0 };
  },
  getNarrativeMemory: async (opts?) => {
    const items = getStore<Record<string, unknown>[]>('henry:narrative_memory', []);
    const limit = (opts?.limit as number) || 10;
    return items.slice(-limit).reverse();
  },

  // ── Memory — Summaries + Graph ─────────────────────────────────────────────
  saveMemorySummary: async (s) => {
    const id = uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:memory_summaries', []);
    items.push({ ...s, id, created_at: new Date().toISOString() });
    setStore('henry:memory_summaries', items);
    return { id };
  },
  getMemorySummaries: async (opts?) => {
    const items = getStore<Record<string, unknown>[]>('henry:memory_summaries', []);
    const limit = (opts?.limit as number) || 20;
    return items.slice(-limit).reverse();
  },
  saveGraphEdge: async (edge) => {
    const id = uuidv4();
    const edges = getStore<Record<string, unknown>[]>('henry:graph_edges', []);
    edges.push({ ...edge, id, created_at: new Date().toISOString() });
    setStore('henry:graph_edges', edges);
    return { id };
  },
  getGraphEdges: async (opts?) => {
    const edges = getStore<Record<string, unknown>[]>('henry:graph_edges', []);
    if (opts?.from_id) return edges.filter((e) => e.from_id === opts.from_id || e.to_id === opts.from_id);
    return edges;
  },
  // ── Automation run history (web mode: localStorage-backed) ─────────
  automationRuns: async (opts) => {
    let runs = getStore<import('./types').AutomationRun[]>('henry:automation_runs', []);
    if (opts?.taskId) runs = runs.filter((r) => r.task_id === opts.taskId);
    if (opts?.unreadOnly) runs = runs.filter((r) => !r.read_at);
    return runs.slice(0, opts?.limit ?? 100);
  },
  automationUnreadCount: async () => ({
    count: getStore<import('./types').AutomationRun[]>('henry:automation_runs', [])
      .filter((r) => !r.read_at && r.status !== 'running').length,
  }),
  automationMarkRunRead: async (id) => {
    const runs = getStore<import('./types').AutomationRun[]>('henry:automation_runs', []);
    const r = runs.find((x) => x.id === id);
    if (r) { r.read_at = new Date().toISOString(); setStore('henry:automation_runs', runs); }
    return { ok: true };
  },
  automationMarkAllRunsRead: async () => {
    const runs = getStore<import('./types').AutomationRun[]>('henry:automation_runs', []);
    const at = new Date().toISOString();
    let count = 0;
    for (const r of runs) if (!r.read_at) { r.read_at = at; count++; }
    setStore('henry:automation_runs', runs);
    return { ok: true, count };
  },
  automationClearRuns: async () => {
    setStore('henry:automation_runs', []);
    return { ok: true };
  },
  automationAbort: async () => ({ ok: false, error: 'Routines require the Henry desktop app.' }),
  automationIsRunning: async () => ({ running: false }),
  onAutomationRunChanged: () => () => {},

  // ── PrimeTech marketplace (web: catalogue only, no filesystem) ──
  marketplaceList: async () => ({ manifest: 'web', version: 0, entries: [], problems: ['The marketplace catalogue is only available in the desktop app.'], fetchedAt: new Date().toISOString() }),
  marketplaceStates: async () => ({}),
  marketplaceFetch: async () => ({ ok: false, error: 'Marketplace downloads require the Henry desktop app.' }),
  marketplaceOpenEntry: async () => ({ ok: false, error: 'Marketplace requires the Henry desktop app.' }),
  marketplaceReveal: async () => ({ ok: false, error: 'Marketplace requires the Henry desktop app.' }),
  marketplaceHistory: async () => [],
  marketplaceRemove: async () => ({ ok: true }),
  getMemoryGraph: async () => {
    // Web mode has the same layer data in localStorage; reuse the same shape.
    const nodes: import('./types').MemoryGraphNode[] = [];
    const edges: import('./types').MemoryGraphEdge[] = [];
    const add = (type: import('./types').MemoryNodeType, id: string, label: string, detail: string) => {
      if (label) nodes.push({ id: `${type}:${id}`, type, label, detail, weight: 0.5, updatedAt: null });
    };
    for (const p of getStore<Record<string, unknown>[]>('henry:projects', [])) {
      add('project', String(p.id), String(p.name ?? ''), String(p.status ?? 'project'));
    }
    for (const g of getStore<Record<string, unknown>[]>('henry:goals', [])) {
      add('goal', String(g.id), String(g.title ?? ''), String(g.status ?? 'goal'));
    }
    for (const c of getStore<Record<string, unknown>[]>('henry:commitments', [])) {
      add('commitment', String(c.id), String(c.description ?? ''), String(c.status ?? 'commitment'));
      if (c.project_id) {
        edges.push({ from: `commitment:${String(c.id)}`, to: `project:${String(c.project_id)}`, type: 'commitment_in_project', weight: 0.8 });
      }
    }
    for (const m of getStore<Record<string, unknown>[]>('henry:milestones', [])) {
      add('milestone', String(m.id), String(m.title ?? ''), String(m.milestone_type ?? 'milestone'));
      if (m.project_id) {
        edges.push({ from: `milestone:${String(m.id)}`, to: `project:${String(m.project_id)}`, type: 'milestone_in_project', weight: 0.75 });
      }
    }
    return { ok: true, nodes, edges };
  },

  // ── Memory — Deep Context + Where-We-Left-Off ──────────────────────────────
  buildDeepContext: async (params) => {
    const sessions = getStore<Record<string, unknown>>('henry:sessions', {});
    const goals = getStore<Record<string, unknown>[]>('henry:goals', []);
    const commitments = getStore<Record<string, unknown>[]>('henry:commitments', []);
    const narrative = getStore<Record<string, unknown>[]>('henry:narrative_memory', []);
    return {
      params,
      sessions: Object.values(sessions).slice(-5),
      activeGoals: goals.filter((g) => g.status !== 'done').slice(0, 5),
      openCommitments: commitments.filter((c) => !c.resolved_at).slice(0, 5),
      narrative: narrative.slice(-3),
    };
  },
  getWhereWeLeftOff: async () => {
    const items = getStore<Record<string, unknown>[]>('henry:narrative_memory', []);
    const last = items[items.length - 1];
    return last || { summary: 'No previous sessions recorded yet.' };
  },
  saveWhereWeLeftOff: async (summary) => {
    const id = uuidv4();
    const items = getStore<Record<string, unknown>[]>('henry:narrative_memory', []);
    items.push({ id, type: 'where_we_left_off', summary, created_at: new Date().toISOString() });
    setStore('henry:narrative_memory', items);
    return { id };
  },

  recordingsList: async () => [],
  recordingsGet: async (_id: string) => null,
  recordingsSave: async (_r: unknown) => {},
  recordingsDelete: async (_id: string) => {},
  exportBackup: async () => ({ ok: false, error: 'Not available in browser' }),
  captureList: async (_limit?: number) => [],
  captureSave: async (_c: unknown) => ({ id: '' }),

  readDirectory: async (dirPath) => {
    const path = dirPath || '/workspace';
    const files = getStore<Record<string, string>>('henry:files', {});
    const prefix = path.endsWith('/') ? path : path + '/';
    const entries = Object.keys(files)
      .filter((k) => k.startsWith(prefix))
      .map((k) => {
        const rel = k.slice(prefix.length);
        const name = rel.split('/')[0];
        return { name, path: prefix + name, isDirectory: rel.includes('/') };
      })
      .filter((v, i, arr) => arr.findIndex((a) => a.name === v.name) === i);
    return { path, entries };
  },
  readFile: async (filePath) => {
    const files = getStore<Record<string, string>>('henry:files', {});
    return files[filePath] || '';
  },
  pathExists: async (filePath) => {
    const files = getStore<Record<string, string>>('henry:files', {});
    return filePath in files;
  },
  writeFile: async (filePath, content) => {
    const files = getStore<Record<string, string>>('henry:files', {});
    files[filePath] = content;
    setStore('henry:files', files);
    return true;
  },

  ollamaStatus: async (baseUrl) => {
    const url = baseUrl || 'http://localhost:11434';
    try {
      const res = await fetch(`${url}/api/version`);
      if (!res.ok) return { running: false, url, error: `Ollama returned ${res.status}` };
      const data = await res.json() as { version?: string };
      return { running: true, url, version: data.version };
    } catch {
      return { running: false, url, error: 'Ollama not available' };
    }
  },
  ollamaModels: async (baseUrl) => {
    try {
      const url = baseUrl || 'http://localhost:11434';
      const res = await fetch(`${url}/api/tags`);
      if (!res.ok) return { models: [], error: `Ollama returned ${res.status}` };
      const data = await res.json() as { models?: Array<{ name: string }> };
      return { models: data.models ?? [] };
    } catch {
      return { models: [] };
    }
  },
  ollamaPull: async (model, baseUrl) => {
    try {
      const url = baseUrl || 'http://localhost:11434';
      const res = await fetch(`${url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let errMsg = `Ollama pull failed (${res.status})`;
        try { const j = JSON.parse(errBody) as { error?: string }; if (j.error) errMsg = j.error; } catch { /* */ }
        return { success: false, error: errMsg };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
  ollamaDelete: async (model, baseUrl) => {
    try {
      const url = baseUrl || 'http://localhost:11434';
      const res = await fetch(`${url}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let errMsg = `Ollama delete failed (${res.status})`;
        try { const j = JSON.parse(errBody) as { error?: string }; if (j.error) errMsg = j.error; } catch { /* */ }
        return { success: false, error: errMsg };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
  onOllamaPullProgress: (cb) => on('ollama:pull:progress', cb),

  execTerminal: async () => {
    return { success: false, exitCode: null, stdout: '', stderr: 'Terminal not available in web mode. Use the desktop app.' };
  },
  killTerminal: async () => {
    return { killed: false, error: 'Terminal not available in web mode.' };
  },

  // ── Computer Control (web stubs — real capabilities in desktop app) ──
  computerScreenshot: async () => ({
    success: false,
    base64: null,
    error: 'Screen capture requires the Henry desktop app. Download it to get computer control.',
  }),
  computerOpenApp: async (appName: string) => ({
    success: false,
    output: `Opening apps (like "${appName}") requires the Henry desktop app.`,
  }),
  computerOpenUrl: async (url: string) => {
    window.open(url, '_blank');
    return { success: true, output: `Opened ${url} in browser.` };
  },
  computerOsascript: async () => ({
    success: false,
    output: 'AppleScript execution requires the Henry desktop app.',
  }),
  computerNewFolder: async (params: { path: string }) => ({
    ok: false,
    error: 'computerNewFolder requires the Henry desktop app',
  }),
  computerRunShell: async (params: { command: string }) => ({
    success: false,
    output: `Shell commands require the Henry desktop app. Would have run: ${params.command}`,
  }),
  computerListApps: async () => {
    const platform = navigator.platform || 'web';
    const isMac = platform.includes('Mac');
    const isLinux = platform.includes('Linux');
    
    let apps: string[];
    if (isMac) {
      apps = ['Safari', 'Chrome', 'Terminal', 'Xcode', 'VS Code', 'Finder', 'Mail', 'Calendar', 'Notes', 'Preview'];
    } else if (isLinux) {
      apps = ['Firefox', 'Chrome', 'Terminal', 'VS Code', 'Files', 'Thunderbird', 'LibreOffice', 'GIMP', 'VLC'];
    } else {
      apps = ['Edge', 'Chrome', 'Terminal', 'VS Code', 'Explorer', 'Outlook', 'Notepad', 'Calculator'];
    }
    
    return { apps, platform: 'web-preview' };
  },
  computerCheckCapabilities: async () => ({
    platform: 'web',
    clipboard: { status: 'unavailable', details: 'Clipboard needs the desktop app.' },
    selectedText: { status: 'unavailable', details: 'Selected-text capture needs the desktop app.' },
    screenCapture: { status: 'unavailable', details: 'Screen capture needs the desktop app.' },
    inputAutomation: { status: 'unavailable', details: 'Input automation needs the desktop app.' },
  }),
  computerListProcesses: async () => ({
    processes: ['This is a preview — real process list requires the desktop app.'],
  }),
  computerCheckPermissions: async () => ({
    platform: 'web',
    accessibility: false,
    screenRecording: false,
    message: 'Computer permissions apply to the Henry desktop app. Download it to unlock full computer control.',
  }),
  computerTypeText: async () => ({
    success: false,
    output: 'Keyboard control requires the Henry desktop app.',
  }),
  computerClick: async () => ({
    success: false,
    output: 'Mouse control requires the Henry desktop app.',
  }),
  computerSystemInfo: async () => ({
    platform: navigator.platform || 'web',
    arch: 'unknown',
    hostname: 'web-browser',
    homeDir: '/',
    appVersion: '0.1.0',
    totalMemoryGB: ((navigator as any).deviceMemory ?? '?').toString(),
    freeMemoryGB: '?',
  }),

  // ── 3D Printer (web stubs) ────────────────────────────────────────────
  printerCheckDeps: async () => ({
    available: false,
    installCommand: 'pip3 install pyserial',
    error: 'Printer control requires the Henry desktop app.',
  }),
  printerListPorts: async () => ({
    ports: [],
    error: 'Serial port access requires the Henry desktop app.',
    method: 'none',
  }),
  printerConnect: async () => ({
    success: false,
    error: 'Printer connection requires the Henry desktop app.',
  }),
  printerDisconnect: async () => ({
    success: false,
    error: 'Not connected.',
  }),
  printerSendGcode: async () => ({
    success: false,
    error: 'G-code requires the Henry desktop app.',
  }),
  printerStatus: async () => ({
    connected: false,
  }),
  printerPrintGcode: async () => ({
    success: false,
    error: 'Printing requires the Henry desktop app.',
  }),
  onPrinterData: (cb) => on('printer:data', cb),

  // ── Session History (web stubs) ───────────────────────────────────────
  // Persistent session history requires the desktop app's Python/SQLite
  // bridge; in the web build these degrade to empty results.
  sessionCheckDeps: async () => ({
    available: false,
    error: 'Session history requires the Henry desktop app.',
  }),
  sessionCreate: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionEnd: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionResume: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionBranch: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionList: async () => ({ ok: true, result: { sessions: [], total: 0 } }),
  sessionSearch: async () => ({ ok: true, result: { results: [] } }),
  sessionAddMessage: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionGetMessages: async () => ({ ok: true, result: { messages: [] } }),
  sessionGet: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionSetTitle: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionArchive: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionUpdateTokens: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionDelete: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionExport: async () => ({ ok: false, error: 'Session history requires the Henry desktop app.' }),
  sessionStats: async () => ({ ok: true, result: { sessions: 0, messages: 0, fts_enabled: false } }),

  getCostLog: async (period?: string) => {
    // Messages are stored at flat key 'henry:messages', NOT per-conversation keys
    const allMessages = getStore<import('./types').Message[]>('henry:messages', []);
    const now = Date.now();
    const cutoff = period === '7d' ? now - 7 * 86400000
      : period === '30d' ? now - 30 * 86400000
      : 0;
    return allMessages
      .filter(m => m.role === 'assistant' && m.cost && m.cost > 0)
      .filter(m => cutoff === 0 || new Date(m.created_at).getTime() > cutoff)
      .map(m => ({
        id: m.id,
        provider: m.provider || 'unknown',
        model: m.model || 'unknown',
        tokens_input: Math.floor((m.tokens_used || 0) * 0.4),
        tokens_output: Math.floor((m.tokens_used || 0) * 0.6),
        cost: m.cost || 0,
        conversation_id: m.conversation_id || null,
        task_id: null,
        created_at: m.created_at || new Date().toISOString(),
      }));
  },

  onTaskUpdate: (cb) => on('task:update', cb),
  onTaskResult: (cb) => on('task:result', cb),
  onEngineStatus: (cb) => on('engine:status', cb),
  onWorkerMessage: (cb) => on('worker:message', cb),

  checkForUpdates: async () => null,
  installUpdate: async () => {},
  onUpdateAvailable: () => () => {},
  onUpdateDownloaded: () => () => {},

  whisperTranscribe: async (audioBlob: Blob, apiKey: string): Promise<string> => {
    // Groq Whisper validates by file extension — derive correct one from MIME type
    const MIME_TO_EXT: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/mp4': 'mp4',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/x-m4a': 'm4a',
    };
    const baseType = audioBlob.type.split(';')[0].trim();
    const ext = MIME_TO_EXT[baseType] || 'webm';
    const form = new FormData();
    form.append('file', audioBlob, `recording.${ext}`);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'text');
    const res = await groqFetch('/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Whisper error ${res.status}${errText ? ': ' + errText.slice(0, 200) : ''}`);
    }
    return await res.text();
  },
};

// Only install the mock in non-Electron contexts (plain browser / Capacitor).
// In Electron, preload already exposes henryAPI via contextBridge as a
// non-writable property — reassigning it throws a TypeError that prevents React from mounting.
// Sync/companion stubs — real versions come from preload IPC
const syncMock = {
  syncStart: async () => ({ ok: false }),
  syncStop: async () => ({ ok: false }),
  syncGetState: async () => ({
    running: false,
    port: 4242,
    localIp: '127.0.0.1',
    tunnelUrl: null,
    pairToken: null,
    pairTokenExpiry: 0,
    linkedDevices: [],
  }),
  syncGeneratePairToken: async () => null,
  syncRevokePairToken: async () => ({ ok: false }),
  syncUnlinkDevice: async (_id: string) => ({ ok: false }),
  syncPushEvent: async () => ({ ok: false }),
  syncAddPendingAction: async () => ({ ok: false }),
  syncUpdateNotes: async () => ({ ok: false }),
  syncUpdateSettings: async () => ({ ok: false }),
  syncStartTunnel: async () => ({ ok: false, url: null }),
  syncStopTunnel: async () => ({ ok: false }),
  syncGetTunnelUrl: async () => ({ url: null }),
  onCompanionCapture: () => () => {},
  onCompanionPrompt: () => () => {},
  onCompanionActionDecision: () => () => {},
  onCompanionDeviceLinked: () => () => {},
};

// Only install the webMock if we're NOT in the real Electron app.
// The preload exposes henryAPI.__isElectron = true via contextBridge.
// We check this AFTER henryAPI is defined by the preload.
// The preload sets window.henryAPI synchronously via contextBridge before
// any renderer JS runs. If it exists here, it IS the real Electron IPC.
// No flag detection needed — presence of henryAPI = real Electron.
// The sync/companion stubs are part of the web-mode surface. They were
// declared but never merged, so syncStart/syncGetState and friends were simply
// undefined in the PWA build.
// The stubs are deliberately narrower than the real IPC types (web mode has
// no sync server), so this is an explicit widening at the merge point.
const mergedWebApi: Window['henryAPI'] = {
  ...(henryAPI as Window['henryAPI']),
  ...(syncMock as unknown as Partial<Window['henryAPI']>),
};

if (!window.henryAPI) {
  window.henryAPI = mergedWebApi;
  log.debug('[webMock] Installed — no preload detected (web/dev mode)');
} else {
  log.debug('[webMock] Skipped — real Electron IPC active (preload set henryAPI)');
}
