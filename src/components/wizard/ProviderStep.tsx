import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import OllamaElectronSetup from './OllamaElectronSetup';
import MobileProviderStep from './MobileProviderStep';

function isNativeMobile(): boolean {
  try {
    const cap = (window as any).Capacitor;
    return cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
  } catch { return false; }
}

interface ProviderStepProps {
  onNext: () => void;
  onBack: () => void;
}

type ProviderId = 'groq' | 'openrouter' | 'openai' | 'anthropic' | 'google' | 'ollama';

interface CloudOption {
  id: Exclude<ProviderId, 'ollama'>;
  label: string;
  icon: string;
  free: boolean;
  freeLabel: string;
  desc: string;
  placeholder: string;
  defaultModel: string;
  keyUrl: string;
  recommended?: boolean;
}

const CLOUD_OPTIONS: CloudOption[] = [
  {
    id: 'groq',
    label: 'Groq',
    icon: '⚡',
    free: true,
    freeLabel: 'Completely free',
    desc: 'LLaMA 3.1 8B everyday · 70B second brain — no credit card',
    placeholder: 'gsk_…',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    recommended: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: '🔀',
    free: true,
    freeLabel: 'Free models available',
    desc: '50+ models including free Llama, Mistral, Gemma',
    placeholder: 'sk-or-…',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    icon: '🤖',
    free: false,
    freeLabel: '~$0.01/message',
    desc: 'GPT-4o — strongest at complex reasoning and coding',
    placeholder: 'sk-…',
    defaultModel: 'gpt-4o',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    icon: '🌙',
    free: false,
    freeLabel: '~$0.015/message',
    desc: 'Claude — exceptional writing, analysis, long documents',
    placeholder: 'sk-ant-…',
    defaultModel: 'claude-3-5-sonnet-20241022',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google',
    label: 'Google AI',
    icon: '✨',
    free: false,
    freeLabel: 'Free quota, then cheap',
    desc: 'Gemini 1.5 Pro — solid all-rounder with a free tier',
    placeholder: 'AIza…',
    defaultModel: 'gemini-1.5-pro',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
];

const OLLAMA_SUGGESTED = [
  { name: 'llama3.2',    desc: 'Fast · great all-rounder' },
  { name: 'mistral',     desc: 'Sharp · strong at writing' },
  { name: 'phi4',        desc: 'Efficient · Microsoft' },
  { name: 'gemma3',      desc: 'Lightweight · Google' },
  { name: 'qwen2.5',     desc: 'Multilingual · Alibaba' },
];

async function probeOllama(baseUrl: string): Promise<{ ok: boolean; models: string[] }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
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

export default function ProviderStep({ onNext, onBack }: ProviderStepProps) {
  if (isNativeMobile()) {
    return <MobileProviderStep onNext={onNext} onBack={onBack} />;
  }
  return <DesktopProviderStep onNext={onNext} onBack={onBack} />;
}

function DesktopProviderStep({ onNext, onBack }: ProviderStepProps) {
  const { setProviders, updateSetting } = useStore();

  // Top-level mode: cloud or ollama
  const [mode, setMode] = useState<'cloud' | 'ollama' | null>('cloud');

  // Cloud state — default to Groq (free)
  const [selectedCloud, setSelectedCloud] = useState<CloudOption>(CLOUD_OPTIONS[0]);
  const [apiKey, setApiKey] = useState('');
  const [keyPageOpened, setKeyPageOpened] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);

  // Ollama state
  const [ollamaPhase, setOllamaPhase] = useState<'detecting' | 'found' | 'no_models' | 'not_found'>('detecting');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [customUrlInput, setCustomUrlInput] = useState('http://192.168.1.x:11434');
  const [detectedModels, setDetectedModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [copiedCmd, setCopiedCmd] = useState('');
  const probeRunning = useRef(false);
  const [forceWebMode, setForceWebMode] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isElectron = typeof window.henryAPI.ollamaIsInstalled === 'function';

  useEffect(() => {
    if (mode === 'ollama') {
      probeRunning.current = false;
      void runDetection('http://localhost:11434');
    }
  }, [mode]);

  // Focus key input when they return from the key page
  useEffect(() => {
    if (keyPageOpened) {
      setTimeout(() => keyInputRef.current?.focus(), 300);
    }
  }, [keyPageOpened]);

  async function runDetection(url: string) {
    if (probeRunning.current) return;
    probeRunning.current = true;
    setOllamaPhase('detecting');
    setSelectedModel('');
    setDetectedModels([]);
    const result = await probeOllama(url);
    probeRunning.current = false;
    if (result.ok) {
      setOllamaUrl(url);
      setDetectedModels(result.models);
      setOllamaPhase(result.models.length > 0 ? 'found' : 'no_models');
      if (result.models.length === 1) setSelectedModel(result.models[0]);
    } else {
      setOllamaPhase('not_found');
    }
  }

  function copyCmd(cmd: string) {
    safeCopyToClipboard(cmd).catch(() => {});
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(''), 2000);
  }

  function handleSelectCloud(opt: CloudOption) {
    setSelectedCloud(opt);
    setApiKey('');
    setKeyPageOpened(false);
  }

  function handleOpenKeyPage() {
    openUrl(selectedCloud.keyUrl);
    setKeyPageOpened(true);
  }

  const canContinue =
    mode === 'cloud'
      ? true  // key is optional — can add in Settings
      : mode === 'ollama'
      ? selectedModel.trim().length > 0
      : false;

  async function handleElectronModelReady(model: string) {
    setSaving(true);
    setError('');
    try {
      await window.henryAPI.saveProvider({ id: 'ollama', name: 'Ollama', apiKey: '', enabled: true, models: JSON.stringify([model]) });
      await window.henryAPI.saveSetting('ollama_base_url', 'http://127.0.0.1:11434');
      await window.henryAPI.saveSetting('companion_model', model);
      await window.henryAPI.saveSetting('companion_provider', 'ollama');
      await window.henryAPI.saveSetting('worker_model', model);
      await window.henryAPI.saveSetting('worker_provider', 'ollama');
      updateSetting('ollama_base_url', 'http://127.0.0.1:11434');
      updateSetting('companion_model', model);
      updateSetting('companion_provider', 'ollama');
      updateSetting('worker_model', model);
      updateSetting('worker_provider', 'ollama');
      const raw = await window.henryAPI.getProviders();
      setProviders(raw.map((p: any) => ({ id: p.id, name: p.name, apiKey: p.api_key ?? p.apiKey ?? '', enabled: Boolean(p.enabled), models: JSON.parse(p.models || '[]') })));
      onNext();
    } catch {
      setError('Failed to save settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleNext() {
    if (!mode || !canContinue) return;
    setSaving(true);
    setError('');
    try {
      if (mode === 'cloud') {
        const key = apiKey.trim();
        await window.henryAPI.saveProvider({
          id: selectedCloud.id,
          name: selectedCloud.label,
          apiKey: key,
          enabled: true,
          models: JSON.stringify([selectedCloud.defaultModel]),
        });
        await window.henryAPI.saveSetting('companion_model', selectedCloud.defaultModel);
        await window.henryAPI.saveSetting('companion_provider', selectedCloud.id);
        updateSetting('companion_model', selectedCloud.defaultModel);
        updateSetting('companion_provider', selectedCloud.id);

        if (selectedCloud.id === 'groq') {
          // 8B = everyday primary, 70B = deeper second brain / worker
          await window.henryAPI.saveSetting('companion_model_2', 'llama-3.3-70b-versatile');
          await window.henryAPI.saveSetting('companion_provider_2', 'groq');
          await window.henryAPI.saveSetting('worker_model', 'llama-3.3-70b-versatile');
          await window.henryAPI.saveSetting('worker_provider', 'groq');
          await window.henryAPI.saveSetting('chat_fast_model', 'llama-3.3-70b-versatile');
          await window.henryAPI.saveSetting('chat_fast_provider', 'groq');
          updateSetting('companion_model_2', 'llama-3.3-70b-versatile');
          updateSetting('companion_provider_2', 'groq');
          updateSetting('worker_model', 'llama-3.3-70b-versatile');
          updateSetting('worker_provider', 'groq');
          updateSetting('chat_fast_model', 'llama-3.3-70b-versatile');
          updateSetting('chat_fast_provider', 'groq');
        } else {
          await window.henryAPI.saveSetting('worker_model', selectedCloud.defaultModel);
          await window.henryAPI.saveSetting('worker_provider', selectedCloud.id);
          updateSetting('worker_model', selectedCloud.defaultModel);
          updateSetting('worker_provider', selectedCloud.id);
        }
      }

      if (mode === 'ollama') {
        await window.henryAPI.saveProvider({ id: 'ollama', name: 'Ollama', apiKey: '', enabled: true, models: JSON.stringify([selectedModel.trim()]) });
        await window.henryAPI.saveSetting('ollama_base_url', ollamaUrl);
        await window.henryAPI.saveSetting('companion_model', selectedModel.trim());
        await window.henryAPI.saveSetting('companion_provider', 'ollama');
        await window.henryAPI.saveSetting('worker_model', selectedModel.trim());
        await window.henryAPI.saveSetting('worker_provider', 'ollama');
        updateSetting('ollama_base_url', ollamaUrl);
        updateSetting('companion_model', selectedModel.trim());
        updateSetting('companion_provider', 'ollama');
        updateSetting('worker_model', selectedModel.trim());
        updateSetting('worker_provider', 'ollama');
      }

      const raw = await window.henryAPI.getProviders();
      setProviders(raw.map((p: any) => ({ id: p.id, name: p.name, apiKey: p.api_key ?? p.apiKey ?? '', enabled: Boolean(p.enabled), models: JSON.parse(p.models || '[]') })));
      onNext();
    } catch {
      setError('Something went wrong saving your settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-slide-up">
      {/* Henry prompt */}
      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 relative max-w-lg mx-auto mb-8">
        <div className="absolute -top-3 left-6 text-xs font-medium text-henry-text-muted bg-henry-bg px-2">Henry</div>
        <p className="text-henry-text-dim leading-relaxed">
          Two options.{' '}
          <span className="text-henry-text font-medium">Groq is free and wired in — just grab a key in 60 seconds.</span>
          {' '}Or run Ollama locally and nothing ever leaves your Mac.
        </p>
      </div>

      {/* Mode cards — same layout as mobile */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <button
          onClick={() => { setMode('cloud'); setKeyPageOpened(false); }}
          className={`rounded-2xl border-2 p-4 text-left transition-all ${
            mode === 'cloud'
              ? 'border-henry-accent bg-henry-accent/8'
              : 'border-henry-border/30 bg-henry-surface/20 hover:border-henry-border'
          }`}
        >
          <div className="text-2xl mb-2">☁️</div>
          <div className="text-sm font-semibold text-henry-text">Cloud AI</div>
          <div className="text-[11px] text-henry-success font-medium mt-0.5">Groq · OpenRouter · OpenAI · more</div>
          <div className="text-[11px] text-henry-text-muted mt-1 leading-snug">Free options available — API key required</div>
        </button>

        <button
          onClick={() => { setMode('ollama'); setKeyPageOpened(false); }}
          className={`rounded-2xl border-2 p-4 text-left transition-all ${
            mode === 'ollama'
              ? 'border-henry-success bg-henry-success/8'
              : 'border-henry-border/30 bg-henry-surface/20 hover:border-henry-border'
          }`}
        >
          <div className="text-2xl mb-2">🏠</div>
          <div className="text-sm font-semibold text-henry-text">Local (Ollama)</div>
          <div className="text-[11px] text-henry-success font-medium mt-0.5">Free · Private · Offline</div>
          <div className="text-[11px] text-henry-text-muted mt-1 leading-snug">Runs on your Mac — nothing leaves your machine</div>
        </button>
      </div>

      {/* ── CLOUD MODE ── */}
      {mode === 'cloud' && (
        <div className="animate-fade-in space-y-3 mb-5">

          {/* Provider list */}
          <div className="space-y-2">
            {CLOUD_OPTIONS.map((opt) => {
              const isSelected = selectedCloud.id === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => handleSelectCloud(opt)}
                  className={`w-full text-left px-4 py-3.5 rounded-xl border-2 transition-all ${
                    isSelected
                      ? 'border-henry-accent bg-henry-accent/8'
                      : 'border-henry-border/30 bg-henry-surface/20 hover:border-henry-border hover:bg-henry-surface/40'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl leading-none shrink-0">{opt.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-henry-text">{opt.label}</span>
                        {opt.recommended && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-success/15 text-henry-success font-semibold">
                            Recommended
                          </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          opt.free
                            ? 'bg-henry-success/10 text-henry-success'
                            : 'bg-henry-surface text-henry-text-muted border border-henry-border/30'
                        }`}>
                          {opt.freeLabel}
                        </span>
                      </div>
                      <p className="text-[11px] text-henry-text-muted mt-0.5 truncate">{opt.desc}</p>
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

          {/* Key flow panel */}
          <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-4">
            {!keyPageOpened ? (
              <>
                <p className="text-sm text-henry-text-dim">
                  Henry will open{' '}
                  <span className="text-henry-text font-medium">{selectedCloud.label}'s API key page</span>
                  {' '}in your browser. Get your key, then come right back.
                </p>
                <button
                  onClick={handleOpenKeyPage}
                  className="w-full flex items-center justify-center gap-2.5 py-4 rounded-xl bg-henry-accent text-white text-sm font-semibold hover:bg-henry-accent-hover transition-all shadow-lg shadow-henry-accent/20"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                  Open {selectedCloud.label} → get your key
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
                  Welcome back — paste your {selectedCloud.label} key:
                </div>
                <input
                  ref={keyInputRef}
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={selectedCloud.placeholder}
                  autoFocus
                  className="w-full bg-henry-bg border border-henry-border rounded-xl px-4 py-3.5 text-sm text-henry-text font-mono outline-none focus:border-henry-accent/60 focus:shadow-[0_0_0_3px_rgba(107,92,246,0.12)] transition-all"
                  onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim()) void handleNext(); }}
                />
                <div className="flex items-center justify-between">
                  <button onClick={() => setKeyPageOpened(false)}
                    className="text-xs text-henry-text-muted hover:text-henry-text transition-colors">
                    ← Reopen {selectedCloud.label}
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
          </div>
        </div>
      )}

      {/* ── OLLAMA MODE ── */}
      {mode === 'ollama' && (
        <div className="space-y-4 mb-5 animate-fade-in">

          {/* Electron auto-setup (downloads + installs Ollama automatically) */}
          {isElectron && !forceWebMode ? (
            saving ? (
              <div className="flex items-center justify-center gap-3 py-8 text-henry-text-dim text-sm">
                <div className="w-4 h-4 border-2 border-henry-accent border-t-transparent rounded-full animate-spin" />
                Saving settings…
              </div>
            ) : (
              <OllamaElectronSetup
                onModelReady={handleElectronModelReady}
                onFallback={() => setForceWebMode(true)}
              />
            )
          ) : (
            <>
              {/* Step-by-step guide — always shown */}
              <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-4">
                <p className="text-xs font-semibold text-henry-text uppercase tracking-wide">Get Ollama running</p>

                {/* Step 1 */}
                <div className="flex gap-3">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-henry-accent/15 text-henry-accent text-[11px] font-bold flex items-center justify-center mt-0.5">1</span>
                  <div>
                    <p className="text-sm font-medium text-henry-text">Download and install Ollama</p>
                    <p className="text-[11px] text-henry-text-muted mt-0.5 mb-1.5">Free, open-source — runs locally on your Mac.</p>
                    <button
                      onClick={() => openUrl('https://ollama.com/download')}
                      className="inline-flex items-center gap-1.5 text-xs text-henry-accent hover:underline"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                      </svg>
                      Open ollama.com/download
                    </button>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="flex gap-3">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-henry-accent/15 text-henry-accent text-[11px] font-bold flex items-center justify-center mt-0.5">2</span>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-henry-text">Start Ollama in Terminal</p>
                    <p className="text-[11px] text-henry-text-muted mt-0.5 mb-1.5">Open Terminal and paste this:</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-henry-bg border border-henry-border/60 rounded-lg px-3 py-2 text-[11px] text-henry-accent font-mono break-all">
                        OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve
                      </code>
                      <button
                        onClick={() => copyCmd('OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve')}
                        className="shrink-0 px-2.5 py-2 rounded-lg bg-henry-hover border border-henry-border text-xs text-henry-text-dim hover:text-henry-text transition-all"
                      >
                        {copiedCmd === 'OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve' ? '✓' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="flex gap-3">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-henry-accent/15 text-henry-accent text-[11px] font-bold flex items-center justify-center mt-0.5">3</span>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-henry-text">Pull a model</p>
                    <p className="text-[11px] text-henry-text-muted mt-0.5 mb-1.5">In a new Terminal tab:</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-henry-bg border border-henry-border/60 rounded-lg px-3 py-2 text-[11px] text-henry-accent font-mono">
                        ollama pull llama3.2
                      </code>
                      <button onClick={() => copyCmd('ollama pull llama3.2')}
                        className="shrink-0 px-2.5 py-2 rounded-lg bg-henry-hover border border-henry-border text-xs text-henry-text-dim hover:text-henry-text transition-all">
                        {copiedCmd === 'ollama pull llama3.2' ? '✓' : 'Copy'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {OLLAMA_SUGGESTED.map((m) => (
                        <span key={m.name} className="text-[10px] px-2 py-1 rounded-lg bg-henry-bg border border-henry-border/40 text-henry-text-muted">
                          <span className="font-mono text-henry-text">{m.name}</span> · {m.desc}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Detection result panel */}
              <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-5 space-y-3">

                {/* Idle — invite to check */}
                {ollamaPhase === 'detecting' && (
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 border-2 border-henry-accent border-t-transparent rounded-full animate-spin shrink-0" />
                    <p className="text-sm text-henry-text-dim">Checking for Ollama at localhost…</p>
                  </div>
                )}

                {/* Found with models */}
                {ollamaPhase === 'found' && (
                  <>
                    <div className="flex items-center gap-2 text-henry-success text-sm font-medium">
                      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Ollama is running — {detectedModels.length} model{detectedModels.length !== 1 ? 's' : ''} found
                    </div>
                    <p className="text-[11px] text-henry-text-muted">
                      {detectedModels.length === 1 ? 'One model found — selecting it.' : 'Pick which one Henry should use:'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {detectedModels.map((m) => (
                        <button key={m} onClick={() => setSelectedModel(m)}
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
                  </>
                )}

                {/* No models installed */}
                {ollamaPhase === 'no_models' && (
                  <>
                    <div className="flex items-center gap-2 text-henry-warning text-sm">
                      <span>⚠️</span><span>Ollama is running but no models installed yet — complete step 3 above.</span>
                    </div>
                    <button onClick={() => runDetection(ollamaUrl)}
                      className="w-full py-2.5 rounded-xl border border-henry-border text-sm text-henry-text-dim hover:text-henry-text transition-all">
                      ↻ Check again
                    </button>
                  </>
                )}

                {/* Not found */}
                {ollamaPhase === 'not_found' && (
                  <>
                    <div className="flex items-center gap-2 text-henry-error text-sm">
                      <span>✗</span><span>Can't reach Ollama yet — make sure step 2 is running.</span>
                    </div>
                    <button onClick={() => runDetection('http://localhost:11434')}
                      className="w-full py-2.5 rounded-xl border border-henry-border text-sm text-henry-text-dim hover:text-henry-text hover:border-henry-text-dim transition-all">
                      ↻ Try again
                    </button>
                  </>
                )}

                {/* Custom URL expander */}
                {(ollamaPhase === 'found' || ollamaPhase === 'not_found' || ollamaPhase === 'no_models') && (
                  <details className="group mt-1">
                    <summary className="text-[11px] text-henry-text-muted cursor-pointer hover:text-henry-text-dim select-none list-none flex items-center gap-1.5">
                      <span className="group-open:rotate-90 transition-transform inline-block text-xs">›</span>
                      Use a different URL
                    </summary>
                    <div className="mt-2 flex gap-2">
                      <input type="text" value={customUrlInput} onChange={(e) => setCustomUrlInput(e.target.value)}
                        placeholder="http://192.168.x.x:11434"
                        className="flex-1 bg-henry-bg border border-henry-border rounded-xl px-3 py-2 text-sm text-henry-text font-mono outline-none focus:border-henry-accent/50" />
                      <button
                        onClick={() => {
                          const url = customUrlInput.trim().replace(/\/$/, '');
                          void runDetection(url.startsWith('http') ? url : `http://${url}`);
                        }}
                        className="shrink-0 px-4 py-2 rounded-xl bg-henry-accent text-white text-sm font-medium hover:bg-henry-accent-hover transition-all">
                        Try
                      </button>
                    </div>
                  </details>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="text-center text-xs text-henry-error mb-4">{error}</p>}

      {/* Footer nav */}
      <div className="flex items-center justify-between">
        <button onClick={onBack}
          className="px-6 py-2.5 text-henry-text-dim hover:text-henry-text transition-colors text-sm">
          ← Back
        </button>

        {!(mode === 'ollama' && isElectron && !forceWebMode) && (
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
            ) : 'Continue →'}
          </button>
        )}
      </div>
    </div>
  );
}
