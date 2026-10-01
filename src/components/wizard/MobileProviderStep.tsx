import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';

interface Props {
  onNext: () => void;
  onBack: () => void;
}

type TopMode = 'cloud' | 'mac' | null;
type MacPhase = 'input' | 'detecting' | 'found' | 'no_models' | 'not_found';

interface FreeProvider {
  id: 'groq' | 'openrouter' | 'google';
  label: string;
  icon: string;
  tagline: string;
  desc: string;
  placeholder: string;
  defaultModel: string;
  keyUrl: string;
  recommended?: boolean;
}

const FREE_PROVIDERS: FreeProvider[] = [
  {
    id: 'groq',
    label: 'Groq',
    icon: '⚡',
    tagline: 'Completely free',
    desc: 'Llama 3.3 70B & Mistral — fast, no credit card',
    placeholder: 'gsk_…',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    recommended: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: '🔀',
    tagline: 'Free models available',
    desc: '50+ free models — Llama, Mistral, Gemma, more',
    placeholder: 'sk-or-…',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    icon: '✨',
    tagline: 'Free tier',
    desc: 'Gemini 1.5 Flash — free quota to start',
    placeholder: 'AIza…',
    defaultModel: 'gemini-1.5-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
];

const MAC_STEPS = [
  {
    n: 1,
    title: 'Open Henry on your Mac',
    detail: 'Henry desktop needs to be running. If you haven\'t installed it yet, download the DMG first.',
  },
  {
    n: 2,
    title: 'Start Ollama on your Mac',
    cmd: 'OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve',
    detail: 'Paste this in your Mac\'s Terminal. It opens Ollama to your local network.',
  },
  {
    n: 3,
    title: 'Find your Mac\'s IP',
    detail: 'On your Mac: System Settings → Wi-Fi → Details → IP Address',
  },
];

const SUGGESTED_MODELS = [
  { name: 'llama3.2', desc: 'Fast · great all-rounder' },
  { name: 'mistral', desc: 'Sharp · strong at writing' },
  { name: 'phi4', desc: 'Efficient · Microsoft' },
  { name: 'gemma3', desc: 'Lightweight · Google' },
];

async function probeOllama(ip: string): Promise<{ ok: boolean; models: string[] }> {
  const base = `http://${ip.replace(/^https?:\/\//, '').replace(/\/$/, '')}:11434`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json() as { models?: Array<{ name?: string }> };
    return { ok: true, models: (data.models || []).map((m) => m.name || '').filter(Boolean) };
  } catch {
    return { ok: false, models: [] };
  }
}

function openUrl(url: string) {
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
}

export default function MobileProviderStep({ onNext, onBack }: Props) {
  const { setProviders, updateSetting } = useStore();

  const [topMode, setTopMode] = useState<TopMode>('cloud');

  // Cloud state
  const [selectedProvider, setSelectedProvider] = useState<FreeProvider>(FREE_PROVIDERS[0]);
  const [keyPageOpened, setKeyPageOpened] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const keyInputRef = useRef<HTMLInputElement>(null);

  // Proxy URL (required for mobile cloud calls to work)
  const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem('henry:mobile_proxy_url') || '');
  const [showProxyField, setShowProxyField] = useState(false);

  // Mac / Ollama state
  const [macIp, setMacIp] = useState('');
  const [macPhase, setMacPhase] = useState<MacPhase>('input');
  const [macModels, setMacModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [resolvedBase, setResolvedBase] = useState('');
  const [copiedCmd, setCopiedCmd] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (keyPageOpened) setTimeout(() => keyInputRef.current?.focus(), 300);
  }, [keyPageOpened]);

  function handleSelectProvider(p: FreeProvider) {
    setSelectedProvider(p);
    setApiKey('');
    setKeyPageOpened(false);
    setError('');
  }

  function handleOpenKeyPage() {
    openUrl(selectedProvider.keyUrl);
    setKeyPageOpened(true);
  }

  async function handleProbeOllama() {
    if (!macIp.trim()) return;
    setMacPhase('detecting');
    setMacModels([]);
    setSelectedModel('');
    setError('');
    const ip = macIp.trim().replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    const result = await probeOllama(ip);
    const base = `http://${ip}:11434`;
    if (result.ok) {
      setResolvedBase(base);
      setMacModels(result.models);
      setMacPhase(result.models.length > 0 ? 'found' : 'no_models');
      if (result.models.length === 1) setSelectedModel(result.models[0]);
    } else {
      setMacPhase('not_found');
    }
  }

  const canContinue =
    topMode === 'cloud'
      ? true
      : topMode === 'mac'
      ? selectedModel.trim().length > 0
      : false;

  async function handleNext() {
    if (!canContinue) return;
    setSaving(true);
    setError('');
    try {
      if (topMode === 'cloud') {
        const key = apiKey.trim();
        // Save proxy URL if set
        if (proxyUrl.trim()) {
          localStorage.setItem('henry:mobile_proxy_url', proxyUrl.trim());
          await window.henryAPI.saveSetting('mobile_proxy_url', proxyUrl.trim());
          updateSetting('mobile_proxy_url', proxyUrl.trim());
        }
        await window.henryAPI.saveProvider({
          id: selectedProvider.id,
          name: selectedProvider.label,
          apiKey: key,
          enabled: true,
          models: JSON.stringify([selectedProvider.defaultModel]),
        });
        await window.henryAPI.saveSetting('companion_model', selectedProvider.defaultModel);
        await window.henryAPI.saveSetting('companion_provider', selectedProvider.id);
        await window.henryAPI.saveSetting('worker_model', selectedProvider.defaultModel);
        await window.henryAPI.saveSetting('worker_provider', selectedProvider.id);
        updateSetting('companion_model', selectedProvider.defaultModel);
        updateSetting('companion_provider', selectedProvider.id);
        updateSetting('worker_model', selectedProvider.defaultModel);
        updateSetting('worker_provider', selectedProvider.id);
      }

      if (topMode === 'mac') {
        const model = selectedModel.trim();
        await window.henryAPI.saveProvider({
          id: 'ollama',
          name: 'Mac (Ollama)',
          apiKey: '',
          enabled: true,
          models: JSON.stringify([model]),
        });
        await window.henryAPI.saveSetting('ollama_base_url', resolvedBase);
        await window.henryAPI.saveSetting('companion_model', model);
        await window.henryAPI.saveSetting('companion_provider', 'ollama');
        await window.henryAPI.saveSetting('worker_model', model);
        await window.henryAPI.saveSetting('worker_provider', 'ollama');
        updateSetting('ollama_base_url', resolvedBase);
        updateSetting('companion_model', model);
        updateSetting('companion_provider', 'ollama');
        updateSetting('worker_model', model);
        updateSetting('worker_provider', 'ollama');
      }

      const raw = await window.henryAPI.getProviders();
      setProviders(raw.map((p: any) => ({
        id: p.id, name: p.name,
        apiKey: p.api_key ?? p.apiKey ?? '',
        enabled: Boolean(p.enabled),
        models: JSON.parse(p.models || '[]'),
      })));
      onNext();
    } catch (err) {
      console.error(err);
      setError('Something went wrong. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-slide-up">
      {/* Henry quote */}
      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 relative max-w-lg mx-auto mb-8">
        <div className="absolute -top-3 left-6 text-xs font-medium text-henry-text-muted bg-henry-bg px-2">Henry</div>
        <p className="text-henry-text-dim leading-relaxed">
          Two options here.{' '}
          <span className="text-henry-text font-medium">Groq is free and wired in — just grab a key.</span>
          {' '}Or point me at Ollama on your Mac and I run fully local.
        </p>
      </div>

      {/* Top mode toggle */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <button
          onClick={() => { setTopMode('cloud'); setError(''); }}
          className={`rounded-2xl border-2 p-4 text-left transition-all ${
            topMode === 'cloud'
              ? 'border-henry-accent bg-henry-accent/8'
              : 'border-henry-border/30 bg-henry-surface/20 hover:border-henry-border'
          }`}
        >
          <div className="text-2xl mb-2">☁️</div>
          <div className="text-sm font-semibold text-henry-text">Free Cloud AI</div>
          <div className="text-[11px] text-henry-success font-medium mt-0.5">Groq · OpenRouter · Google</div>
          <div className="text-[11px] text-henry-text-muted mt-1 leading-snug">API key required — all have free tiers</div>
        </button>

        <button
          onClick={() => { setTopMode('mac'); setMacPhase('input'); setError(''); }}
          className={`rounded-2xl border-2 p-4 text-left transition-all ${
            topMode === 'mac'
              ? 'border-henry-success bg-henry-success/8'
              : 'border-henry-border/30 bg-henry-surface/20 hover:border-henry-border'
          }`}
        >
          <div className="text-2xl mb-2">🖥️</div>
          <div className="text-sm font-semibold text-henry-text">Use your Mac</div>
          <div className="text-[11px] text-henry-success font-medium mt-0.5">Ollama · Local · Free</div>
          <div className="text-[11px] text-henry-text-muted mt-1 leading-snug">Runs through Henry on your desktop</div>
        </button>
      </div>

      {/* ── CLOUD SECTION ── */}
      {topMode === 'cloud' && (
        <div className="space-y-3 mb-5 animate-fade-in">

          {/* Provider cards */}
          <div className="space-y-2">
            {FREE_PROVIDERS.map((p) => {
              const isSelected = selectedProvider.id === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => handleSelectProvider(p)}
                  className={`w-full text-left px-4 py-3.5 rounded-xl border-2 transition-all ${
                    isSelected
                      ? 'border-henry-accent bg-henry-accent/8'
                      : 'border-henry-border/30 bg-henry-surface/20 hover:border-henry-border hover:bg-henry-surface/40'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl leading-none shrink-0">{p.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-henry-text">{p.label}</span>
                        {p.recommended && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-success/15 text-henry-success font-semibold">
                            Default
                          </span>
                        )}
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-success/10 text-henry-success font-medium">
                          {p.tagline}
                        </span>
                      </div>
                      <p className="text-[11px] text-henry-text-muted mt-0.5">{p.desc}</p>
                    </div>
                    {isSelected && (
                      <svg className="w-4 h-4 text-henry-accent shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Key flow */}
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-4">
            {!keyPageOpened ? (
              <>
                <p className="text-sm text-henry-text-dim">
                  Henry will open{' '}
                  <span className="text-henry-text font-medium">{selectedProvider.label}</span>
                  {' '}in your browser. Get your free key, then come right back.
                </p>
                <button
                  onClick={handleOpenKeyPage}
                  className="w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-henry-accent text-white text-sm font-semibold hover:bg-henry-accent-hover transition-all shadow-lg shadow-henry-accent/20"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                  Open {selectedProvider.label} → get free key
                </button>
                <p className="text-center text-[11px] text-henry-text-muted">
                  Already have one?{' '}
                  <button onClick={() => setKeyPageOpened(true)} className="text-henry-accent hover:underline">
                    Paste it here
                  </button>
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-henry-success text-sm font-medium">
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Welcome back — paste your {selectedProvider.label} key:
                </div>
                <input
                  ref={keyInputRef}
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={selectedProvider.placeholder}
                  autoFocus
                  className="w-full bg-henry-bg border border-henry-border rounded-xl px-4 py-3.5 text-sm text-henry-text font-mono outline-none focus:border-henry-accent/60 transition-all"
                  onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim()) void handleNext(); }}
                />
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setKeyPageOpened(false)}
                    className="text-xs text-henry-text-muted hover:text-henry-text transition-colors"
                  >
                    ← Reopen {selectedProvider.label}
                  </button>
                  {!apiKey.trim() && (
                    <button onClick={() => void handleNext()}
                      className="text-[11px] text-henry-text-muted hover:text-henry-accent transition-colors">
                      Skip for now →
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Proxy URL — hidden until needed */}
            <details className="group" onToggle={(e) => setShowProxyField((e.target as HTMLDetailsElement).open)}>
              <summary className="text-[11px] text-henry-text-muted cursor-pointer hover:text-henry-text-dim select-none list-none flex items-center gap-1.5">
                <span className="group-open:rotate-90 transition-transform inline-block text-xs">›</span>
                Mobile proxy URL (advanced)
              </summary>
              <div className="mt-3 space-y-1.5">
                <p className="text-[11px] text-henry-text-muted">
                  Required for cloud AI on native mobile. Deploy the Cloudflare Worker once and paste its URL here.
                </p>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="https://henry-ai-proxy.*.workers.dev"
                  className="w-full bg-henry-bg border border-henry-border rounded-xl px-4 py-2.5 text-sm text-henry-text font-mono outline-none focus:border-henry-accent/50 transition-all"
                />
              </div>
            </details>
          </div>
        </div>
      )}

      {/* ── MAC / OLLAMA SECTION ── */}
      {topMode === 'mac' && (
        <div className="space-y-4 mb-5 animate-fade-in">

          {/* Pre-flight steps */}
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-4">
            <p className="text-xs font-semibold text-henry-text uppercase tracking-wide">Before you connect</p>

            {MAC_STEPS.map((step) => (
              <div key={step.n} className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-henry-accent/15 text-henry-accent text-[11px] font-bold flex items-center justify-center mt-0.5">
                  {step.n}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-henry-text">{step.title}</p>
                  <p className="text-[11px] text-henry-text-muted mt-0.5">{step.detail}</p>
                  {step.cmd && (
                    <div className="flex items-center gap-2 mt-2">
                      <code className="flex-1 bg-henry-bg border border-henry-border/50 rounded-lg px-3 py-2 text-[11px] text-henry-accent font-mono break-all">
                        {step.cmd}
                      </code>
                      <button
                        onClick={() => {
                          safeCopyToClipboard(step.cmd!).catch(() => {});
                          setCopiedCmd(true);
                          setTimeout(() => setCopiedCmd(false), 2000);
                        }}
                        className="shrink-0 px-2.5 py-2 rounded-lg bg-henry-hover border border-henry-border text-[11px] text-henry-text-dim hover:text-henry-text transition-all"
                      >
                        {copiedCmd ? '✓' : 'Copy'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* IP entry + probe */}
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-4">
            <p className="text-sm font-medium text-henry-text">Enter your Mac's IP address</p>

            <div className="flex gap-2">
              <input
                type="text"
                value={macIp}
                onChange={(e) => { setMacIp(e.target.value); setMacPhase('input'); setError(''); }}
                placeholder="192.168.1.x"
                className="flex-1 bg-henry-bg border border-henry-border rounded-xl px-4 py-3 text-sm text-henry-text font-mono outline-none focus:border-henry-accent/50 transition-all"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleProbeOllama(); }}
              />
              <button
                onClick={() => void handleProbeOllama()}
                disabled={!macIp.trim() || macPhase === 'detecting'}
                className="shrink-0 px-5 py-3 rounded-xl bg-henry-accent text-white text-sm font-medium hover:bg-henry-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {macPhase === 'detecting' ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Checking…
                  </span>
                ) : 'Connect'}
              </button>
            </div>

            {/* Detecting */}
            {macPhase === 'detecting' && (
              <div className="flex items-center gap-2 text-henry-text-dim text-sm">
                <div className="w-3.5 h-3.5 border-2 border-henry-accent border-t-transparent rounded-full animate-spin shrink-0" />
                Reaching Ollama at {macIp}…
              </div>
            )}

            {/* Found with models */}
            {macPhase === 'found' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-center gap-2 text-henry-success text-sm font-medium">
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Connected to your Mac — {macModels.length} model{macModels.length !== 1 ? 's' : ''} found
                </div>
                <p className="text-[11px] text-henry-text-muted">
                  {macModels.length === 1 ? 'Selecting the one model automatically.' : 'Pick which model Henry should use:'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {macModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => setSelectedModel(m)}
                      className={`px-3 py-1.5 rounded-xl text-sm font-mono border transition-all ${
                        selectedModel === m
                          ? 'bg-henry-success/15 border-henry-success text-henry-success'
                          : 'bg-henry-hover border-henry-border text-henry-text-dim hover:border-henry-text-dim'
                      }`}
                    >
                      {selectedModel === m && <span className="mr-1.5">✓</span>}
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* No models installed */}
            {macPhase === 'no_models' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-center gap-2 text-henry-warning text-sm">
                  <span>⚠️</span>
                  <span>Ollama is running but no models are installed on your Mac yet.</span>
                </div>
                <p className="text-[11px] text-henry-text-muted">
                  On your Mac, open Terminal and run one of these:
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_MODELS.map((m) => (
                    <div key={m.name} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-henry-bg border border-henry-border/50">
                      <span className="font-mono text-xs text-henry-text">{m.name}</span>
                      <span className="text-[10px] text-henry-text-muted">· {m.desc}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-henry-text-muted">
                  Example: <code className="text-henry-accent font-mono">ollama pull llama3.2</code>
                </p>
                <button
                  onClick={() => void handleProbeOllama()}
                  className="w-full py-2.5 rounded-xl border border-henry-border text-sm text-henry-text-dim hover:text-henry-text hover:border-henry-text-dim transition-all"
                >
                  ↻ Try again
                </button>
              </div>
            )}

            {/* Not found */}
            {macPhase === 'not_found' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-center gap-2 text-henry-error text-sm">
                  <span>✗</span>
                  <span>Couldn't reach Ollama at {macIp}. Check the IP and make sure step 2 is done.</span>
                </div>
                <button
                  onClick={() => void handleProbeOllama()}
                  className="w-full py-2.5 rounded-xl border border-henry-border text-sm text-henry-text-dim hover:text-henry-text transition-all"
                >
                  ↻ Try again
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-center text-xs text-henry-error mb-4">{error}</p>}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-6 py-2.5 text-henry-text-dim hover:text-henry-text transition-colors text-sm"
        >
          ← Back
        </button>

        <button
          onClick={() => void handleNext()}
          disabled={!canContinue || saving}
          className={`px-8 py-2.5 rounded-xl font-medium text-sm transition-all ${
            canContinue && !saving
              ? 'bg-henry-accent text-white hover:bg-henry-accent-hover'
              : 'bg-henry-hover text-henry-text-muted cursor-not-allowed'
          }`}
        >
          {saving ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Saving…
            </span>
          ) : topMode === 'cloud' && keyPageOpened && apiKey.trim() ? (
            'Continue →'
          ) : topMode === 'cloud' ? (
            'Continue →'
          ) : (
            'Continue →'
          )}
        </button>
      </div>
    </div>
  );
}
