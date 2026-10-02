/**
 * SettingsView — Settings tab content.
 *
 * Rebuilt 2026-06-08 after the original 2,026-line file was lost in an
 * iCloud file-churn incident and only a 3-panel placeholder remained. The
 * earlier file depended on ~9 modules that no longer exist (proxyUsage,
 * priority/*, initiativeStore, sessionModeStore, richMemory, …), so rather
 * than resurrect dead code this is a focused, current rebuild covering the
 * settings that actually matter for a working app:
 *
 *   - Profile        — your name + location (feeds memory & weather)
 *   - AI Providers   — enter/update the API key for each provider
 *   - Engines        — assign a provider+model to the Companion and Worker
 *   - Pairing/Health — the existing RemoteControl / DeviceLink / Health panels
 *
 * Everything persists through the same IPC the setup wizard uses
 * (`providers:save`, `settings:save`) and mirrors into the Zustand store so the
 * rest of the app sees changes immediately.
 */

import { useEffect, useState, useMemo } from 'react';
import { useStore } from '../../store';
import type { AIProvider } from '../../types';
import { PROVIDERS, AVAILABLE_MODELS, formatPrice } from '../../providers/models';
import { toast } from '../ui/Toast';
import RemoteControlPanel from './RemoteControlPanel';
import DeviceLinkPanel from './DeviceLinkPanel';
import HealthPanel from './HealthPanel';
import { isMacOS, getPlatformName } from '../../utils/platform';

import {
  CODER_ENGINE_LABELS,
  CODER_ENGINE_SETTING_KEY,
  coderAvailable,
  getCoderStatus,
  isCoderEngineChoice,
  type CoderEngineChoice,
} from '../../henry/coderEngine';
import {
  voiceIpcAvailable,
  getVoiceSttStatus,
  getVoiceTtsStatus,
  runVoiceSetup,
  speak as voiceSpeak,
  stopSpeaking as voiceStopSpeaking,
  startVoiceRecording,
  stopVoiceRecording,
  transcribeLocal,
} from '../../henry/voice';
/**
 * The Voice panel describes what this machine can actually do. Whisper and the
 * system voice are macOS binaries bundled in resources/bin, so on Windows and
 * Linux those settings do nothing until something equivalent is installed —
 * saying otherwise sends people looking for settings that aren't there.
 */
function voiceSubtitle(): string {
  if (isMacOS()) {
    return 'Henry talks and listens. Listening runs FREE on your Mac (whisper.cpp). Speaking uses the free macOS voice — or ElevenLabs automatically when a key is saved.';
  }
  return `Henry talks and listens. ElevenLabs works on ${getPlatformName()} once a key is saved. Free local listening and speech need an engine installed on this ${getPlatformName()} — see the options below.`;
}


// Providers that take an API key and can drive chat. (Ollama is local/keyless.)
const CLOUD_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'groq', 'opencode-zen'] as const;

const inputCls =
  'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm ' +
  'text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';
const labelCls = 'block text-xs font-medium text-henry-text-dim mb-1';
const cardCls = 'bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4';
const btnCls =
  'px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent ' +
  'hover:bg-henry-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

/** Refresh the store's providers list from the DB (post-save). */
async function refreshProviders(setProviders: (p: AIProvider[]) => void) {
  try {
    const raw = await window.henryAPI.getProviders?.();
    if (!raw) return;
    setProviders(
      raw.map((p) => ({
        id: p.id,
        name: p.name,
        apiKey: p.api_key ?? p.apiKey ?? '',
        enabled: Boolean(p.enabled),
        models: Array.isArray(p.models)
          ? p.models
          : ((): string[] => { try { return JSON.parse(p.models || '[]'); } catch { return []; } })(),
      })),
    );
  } catch {
    /* non-fatal — store keeps its current value */
  }
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-henry-text">{title}</h2>
      {sub && <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">{sub}</p>}
    </div>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────

function ProfileSection() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const [name, setName] = useState(settings.owner_name || settings.user_name || '');
  const [location, setLocation] = useState(settings.location || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const pairs: Array<[string, string]> = [
        ['owner_name', name.trim()],
        ['user_name', name.trim()],
        ['location', location.trim()],
      ];
      for (const [k, v] of pairs) {
        await window.henryAPI.saveSetting?.(k, v);
        updateSetting(k, v);
      }
      toast.success('Profile saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardCls}>
      <SectionHeader title="Profile" sub="Henry uses these for memory and local context like weather." />
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Your name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Topher" />
        </div>
        <div>
          <label className={labelCls}>Location</label>
          <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Portland, OR" />
        </div>
        <button className={btnCls} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </div>
    </div>
  );
}

// ── AI Providers (API keys) ──────────────────────────────────────────────────

function ProviderKeyRow({ providerId }: { providerId: (typeof CLOUD_PROVIDER_IDS)[number] }) {
  const meta = PROVIDERS[providerId];
  const providers = useStore((s) => s.providers);
  const setProviders = useStore((s) => s.setProviders);
  const existing = providers.find((p) => p.id === providerId);
  const hasKey = Boolean(existing?.apiKey);

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    try {
      const models = AVAILABLE_MODELS.filter((m) => m.provider === providerId).map((m) => m.id);
      await window.henryAPI.saveProvider?.({
        id: providerId,
        name: meta.name,
        apiKey: key,
        enabled: true,
        models: JSON.stringify(models),
      });
      await refreshProviders(setProviders);
      setValue('');
      toast.success(`${meta.name} key saved`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-henry-border/20 last:border-0">
      <span className="text-lg leading-none mt-0.5" aria-hidden>{meta.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-henry-text">{meta.name}</span>
          {hasKey ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">key set</span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-border/30 text-henry-text-muted">no key</span>
          )}
        </div>
        <div className="flex gap-2 mt-1.5">
          <input
            type="password"
            className={inputCls + ' flex-1'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={hasKey ? 'Enter a new key to replace…' : `${meta.keyPrefix ?? ''}…`}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          />
          <button className={btnCls} onClick={save} disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : hasKey ? 'Replace' : 'Save'}
          </button>
        </div>
        {meta.keyUrl && (
          <a
            href={meta.keyUrl}
            onClick={(e) => { e.preventDefault(); window.henryAPI.computerOpenUrl?.(meta.keyUrl); }}
            className="text-[10px] text-henry-text-muted hover:text-henry-accent mt-1 inline-block"
          >
            Get a {meta.name} key →
          </a>
        )}
      </div>
    </div>
  );
}

function ProvidersSection() {
  return (
    <div className={cardCls}>
      <SectionHeader title="AI Providers" sub="Keys are stored locally on this device. Add at least one to use Henry." />
      <div>
        {CLOUD_PROVIDER_IDS.map((id) => <ProviderKeyRow key={id} providerId={id} />)}
      </div>
    </div>
  );
}

// ── Engine assignment ────────────────────────────────────────────────────────

function EngineRow({ engine, label, hint }: { engine: 'companion' | 'worker'; label: string; hint: string }) {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const providers = useStore((s) => s.providers);
  const setProviders = useStore((s) => s.setProviders);
  const configuredIds = new Set(providers.filter((p) => p.apiKey || p.id === 'ollama').map((p) => p.id));

  const currentProvider = settings[`${engine}_provider`] || '';
  const currentModel = settings[`${engine}_model`] || '';

  // Only offer models from providers that actually have a key (plus Ollama).
  const baseModels = AVAILABLE_MODELS.filter(
    (m) => configuredIds.size === 0 || configuredIds.has(m.provider),
  );

  // opencode models are discovered at runtime and shown in this same list, so
  // they sit alongside every other model rather than behind a separate picker.
  // opencode is listed whenever its CLI is present — it needs no API key of its
  // own, so it is not gated on `configuredIds`.
  const [opencodeModels, setOpencodeModels] = useState<import('../../types').OpencodeModelInfo[]>([]);
  const [opencodeReady, setOpencodeReady] = useState(false);
  const [testingModel, setTestingModel] = useState<string | null>(null);

  // Proves the model is actually reachable before committing to it, since
  // opencode models come and go and some are served by overloaded providers.
  const testOpencode = async (modelId: string) => {
    setTestingModel(modelId);
    try {
      const r = await window.henryAPI.opencodeTest?.(modelId);
      if (r?.ok) toast.success(`${modelId} → ${(r.reply || '').trim().slice(0, 40) || 'ok'}`);
      else toast.error(`${modelId}: ${r?.error ?? 'no response'}`);
    } finally {
      setTestingModel(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const st = await window.henryAPI.opencodeStatus?.();
        if (cancelled) return;
        setOpencodeReady(!!st?.available);
        if (!st?.available) return;
        const res = await window.henryAPI.opencodeModels?.();
        if (!cancelled && res?.ok) setOpencodeModels(res.models);
      } catch { /* opencode is optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const opencodeAsModels = useMemo(
    () =>
      opencodeModels.map((m) => ({
        id: m.id,
        name: m.name,
        provider: 'opencode',
        contextWindow: 0,
        inputPricePer1M: null,
        outputPricePer1M: null,
        description: m.isZen ? 'opencode zen' : m.provider,
      })),
    [opencodeModels],
  );

  // opencode zen first (free + always available), then the rest of opencode's
  // catalogue, then the statically-known providers.
  const zenIds = new Set(opencodeModels.filter((o) => o.isZen).map((o) => o.id));
  const zenModels = opencodeAsModels.filter((m) => zenIds.has(m.id));
  const otherOpencodeModels = opencodeAsModels.filter((m) => !zenIds.has(m.id));
  // De-dupe by id: opencode's openrouter/... entries can share a string with a
  // static one, which would render two <option>s with the same value.
  const seenModelIds = new Set<string>();
  const models = (opencodeReady
    ? [...zenModels, ...otherOpencodeModels, ...baseModels]
    : baseModels
  ).filter((m) => {
    if (seenModelIds.has(m.id)) return false;
    seenModelIds.add(m.id);
    return true;
  });

  // For Ollama, fetch installed models
  const [ollamaInstalled, setOllamaInstalled] = useState<string[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);

  useEffect(() => {
    if (currentProvider === 'ollama' || configuredIds.has('ollama')) {
      setOllamaLoading(true);
      window.henryAPI.ollamaModels?.(settings.ollama_base_url || 'http://localhost:11434')
        .then((raw: any) => {
          const installed = (raw?.models ?? []).map((m: any) => m.name as string);
          setOllamaInstalled(installed);
        })
        .catch(() => {})
        .finally(() => setOllamaLoading(false));
    }
  }, [currentProvider, settings.ollama_base_url, configuredIds]);

  const onPick = async (modelId: string) => {
    // opencode models are dynamic, so they are not in AVAILABLE_MODELS. They
    // are matched by ID, which can collide with the static `openrouter/...`
    // entries — so prefer the static entry when the id exists in both, since
    // that one has a real API key path.
    const isOpencodePick =
      opencodeModels.some((o) => o.id === modelId) && !AVAILABLE_MODELS.some((m) => m.id === modelId);

    if (isOpencodePick) {
      // A provider row is REQUIRED, not optional: consumers resolve the engine
      // with `providers.find(p => p.id === <provider>)`, so saving the setting
      // alone left every chat surface reporting "No model configured".
      await window.henryAPI.saveProvider?.({
        id: 'opencode',
        name: 'OpenCode (CLI)',
        apiKey: '',
        enabled: true,
        models: JSON.stringify(opencodeModels.map((o) => o.id)),
      });
      await refreshProviders(setProviders);
      await window.henryAPI.saveSetting?.(`${engine}_provider`, 'opencode');
      await window.henryAPI.saveSetting?.(`${engine}_model`, modelId);
      updateSetting(`${engine}_provider`, 'opencode');
      updateSetting(`${engine}_model`, modelId);
      toast.success(`Engine → ${modelId}`);
      return;
    }
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) return;
    
    // Check if this is an Ollama model that needs to be pulled
    const isOllama = model.provider === 'ollama';
    const isInstalled = isOllama && ollamaInstalled.some((inst) => inst.startsWith(model.id) || model.id.startsWith(inst.split(':')[0]));
    
    if (isOllama && !isInstalled) {
      // Model needs to be pulled first
      toast.info(`Pulling ${model.name}... this may take a few minutes`);
      
      try {
        const result = await window.henryAPI.ollamaPull?.(model.id, settings.ollama_base_url || 'http://localhost:11434');
        if (!result?.success) {
          throw new Error(result?.error || 'Failed to pull model');
        }
        
        // Pull succeeded - refresh installed list
        const refreshed = await window.henryAPI.ollamaModels?.(settings.ollama_base_url || 'http://localhost:11434');
        const installed = (refreshed?.models ?? []).map((m: any) => m.name as string);
        setOllamaInstalled(installed);
        
        toast.success(`Pulled ${model.name} successfully`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to pull model';
        toast.error(msg);
        return; // Don't proceed to set as active model
      }
    }
    
    try {
      await window.henryAPI.saveSetting?.(`${engine}_provider`, model.provider);
      await window.henryAPI.saveSetting?.(`${engine}_model`, model.id);
      updateSetting(`${engine}_provider`, model.provider);
      updateSetting(`${engine}_model`, model.id);

      // Ensure the provider exists in the database (especially for keyless providers like Ollama)
      if (model.provider === 'ollama') {
        await window.henryAPI.saveProvider?.({
          id: 'ollama',
          name: 'Ollama (Local)',
          apiKey: '',
          enabled: true,
          models: JSON.stringify(AVAILABLE_MODELS.filter((m) => m.provider === 'ollama').map((m) => m.id)),
        });
        await refreshProviders(setProviders);
      }

      toast.success(`${label} → ${model.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set engine');
    }
  };

  return (
    <div className="py-2.5 border-b border-henry-border/20 last:border-0">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-henry-text">{label}</span>
        <span className="text-[10px] text-henry-text-muted">{currentProvider || 'unset'}</span>
      </div>
      <p className="text-[11px] text-henry-text-muted mb-1.5">{hint}</p>
      <select className={inputCls} value={currentModel} onChange={(e) => onPick(e.target.value)}>
        <option value="" disabled>Choose a model…</option>
        {models.map((m) => (
          <option key={`${m.provider}:${m.id}`} value={m.id}>
            {(PROVIDERS as Record<string, { name?: string }>)[m.provider]?.name ?? m.provider} — {m.name}
            {m.inputPricePer1M != null ? ` (${formatPrice(m.inputPricePer1M)}/1M in)` : ''}
          </option>
        ))}
      </select>
      {opencodeModels.some((o) => o.id === currentModel) && (
        <button
          onClick={() => void testOpencode(currentModel)}
          disabled={testingModel != null}
          className="mt-1.5 px-2.5 py-1 rounded-lg text-[11px] border border-henry-border/40 text-henry-text hover:border-henry-accent/50 disabled:opacity-40"
        >
          {testingModel === currentModel ? 'Testing…' : 'Test this model'}
        </button>
      )}
    </div>
  );
}

function EnginesSection() {
  return (
    <div className={cardCls}>
      <SectionHeader
        title="Engines"
        sub="Companion is the chat brain you talk to. Worker runs background tasks and Routines."
      />
      <div>
        <EngineRow engine="companion" label="Companion engine" hint="Used for live conversation in Chat." />
        <EngineRow engine="worker" label="Worker engine" hint="Used for tasks, the queue, and scheduled Routines." />
      </div>
      <RelayRow />
    </div>
  );
}

/**
 * Optional hosted relay. Off until a URL is set — Henry runs entirely on your
 * own providers or local Ollama by default, and nothing here is required.
 */
function RelayRow() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const [url, setUrl] = useState(settings.relay_base_url || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = url.trim();
    if (value && !/^https?:\/\//i.test(value)) {
      toast.error('Relay URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      await window.henryAPI.saveSetting?.('relay_base_url', value);
      updateSetting('relay_base_url', value);
      toast.success(value ? 'Hosted relay enabled' : 'Hosted relay disabled');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the relay URL');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 p-3 rounded-xl border border-henry-border/25 bg-henry-surface/30">
      <p className="text-xs font-semibold text-henry-text">Hosted relay (optional)</p>
      <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
        Route requests through any OpenAI-compatible endpoint you control — a self-hosted
        gateway, a corporate proxy, or a service you already pay for. Leave blank to stay
        entirely on your own keys and local Ollama.
      </p>
      <div className="flex items-center gap-2 mt-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-relay.example.com/v1"
          spellCheck={false}
          className="flex-1 bg-henry-bg border border-henry-border/30 rounded-lg px-2.5 py-1.5 text-xs text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50"
        />
        <button
          onClick={() => void save()}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Coder Engine ─────────────────────────────────────────────────────────────

function CoderEngineSection() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const [status, setStatus] = useState<HenryCoderStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const choice: CoderEngineChoice = isCoderEngineChoice(settings[CODER_ENGINE_SETTING_KEY])
    ? (settings[CODER_ENGINE_SETTING_KEY] as CoderEngineChoice)
    : 'auto';

  const refresh = async (force = false) => {
    setChecking(true);
    try {
      setStatus(await getCoderStatus(force));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (coderAvailable()) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!coderAvailable()) return null;

  const pick = async (value: string) => {
    if (!isCoderEngineChoice(value)) return;
    try {
      await window.henryAPI.saveSetting?.(CODER_ENGINE_SETTING_KEY, value);
      updateSetting(CODER_ENGINE_SETTING_KEY, value);
      toast.success(`Coder engine → ${CODER_ENGINE_LABELS[value]}`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set coder engine');
    }
  };

  return (
    <div className={cardCls}>
      <SectionHeader
        title="Coder Engine"
        sub="Code mode in chat writes code with the Claude Code CLI, opencode, or a free local model via Ollama."
      />
      <div className="space-y-3">
        <select className={inputCls} value={choice} onChange={(e) => void pick(e.target.value)}>
          <option value="auto">Auto — Claude Code, then opencode, else local (recommended)</option>
          <option value="claude-code">Claude Code CLI only</option>
          <option value="opencode">opencode only</option>
          <option value="local">Local only — free qwen coder via Ollama</option>
        </select>

        <div className="text-[11px] text-henry-text-muted space-y-1">
          <div>
            opencode:{' '}
            {status?.opencode?.available ? (
              <span className="text-emerald-400">detected — {status.opencode.version ?? 'installed'}</span>
            ) : (
              <span>
                not found — install from{' '}
                <span className="text-henry-text-dim">opencode.ai</span>
              </span>
            )}
          </div>
          <div>
            Claude Code CLI:{' '}
            {status?.claude.available ? (
              <span className="text-emerald-400">detected — {status.claude.version ?? 'installed'}</span>
            ) : (
              <span>
                not found — install with{' '}
                <span className="text-henry-text-dim">npm install -g @anthropic-ai/claude-code</span>
              </span>
            )}
          </div>
          <div>
            Local coder:{' '}
            {status?.local.model ? (
              <span className="text-emerald-400">{status.local.model} installed</span>
            ) : status?.local.ollamaRunning ? (
              <span>model missing — {status.local.hint ?? 'run: ollama pull qwen2.5-coder:7b'}</span>
            ) : (
              <span>{status?.local.hint ?? 'Ollama not running'}</span>
            )}
          </div>
          {status && (
            <div>
              Active now:{' '}
              <span className="text-henry-text-dim">
                {status.active === 'none' ? 'no engine available' : status.active === 'claude-code' ? 'Claude Code' : `Local (${status.local.model})`}
              </span>
              {' · '}Auto-applied edits are limited to{' '}
              <span className="text-henry-text-dim">~/HenryAI/coder-projects</span>
            </div>
          )}
        </div>

        <button className={btnCls} onClick={() => void refresh(true)} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}

// ── Voice ────────────────────────────────────────────────────────────────────

function VoiceSection() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);
  const setProviders = useStore((s) => s.setProviders);

  const [stt, setStt] = useState<HenryVoiceSttStatus | null>(null);
  const [tts, setTts] = useState<HenryVoiceTtsStatus | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupProgress, setSetupProgress] = useState<HenryVoiceSetupProgress | null>(null);
  const [elevenKey, setElevenKey] = useState('');
  const [elevenBusy, setElevenBusy] = useState(false);
  const [speakBusy, setSpeakBusy] = useState(false);
  const [listenTest, setListenTest] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [listenResult, setListenResult] = useState<string | null>(null);

  const refresh = async (refreshBinary = false) => {
    const [s, t] = await Promise.all([getVoiceSttStatus(refreshBinary), getVoiceTtsStatus()]);
    setStt(s);
    setTts(t);
  };

  useEffect(() => {
    if (voiceIpcAvailable()) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!voiceIpcAvailable()) return null;

  const saveVoiceSetting = async (key: string, value: string) => {
    try {
      await window.henryAPI.saveSetting?.(key, value);
      updateSetting(key, value);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const runSetup = async () => {
    setSetupBusy(true);
    try {
      await runVoiceSetup((p) => setSetupProgress(p));
      toast.success('Free voice is ready');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Voice setup failed');
    } finally {
      setSetupBusy(false);
      setSetupProgress(null);
      void refresh(true);
    }
  };

  const greetingOn = settings.voice_greeting === 'on';

  const toggleGreeting = async () => {
    const next = greetingOn ? 'off' : 'on';
    await saveVoiceSetting('voice_greeting', next);
    if (!greetingOn) await window.henryAPI.voiceGreetingClearCache?.();
  };

  const saveElevenKey = async () => {
    const key = elevenKey.trim();
    if (!key) return;
    setElevenBusy(true);
    try {
      // Stored exactly like every other provider key (encrypted at rest).
      await window.henryAPI.saveProvider?.({
        id: 'elevenlabs',
        name: 'ElevenLabs',
        apiKey: key,
        enabled: true,
        models: '[]',
      });
      await refreshProviders(setProviders);
      setElevenKey('');
      toast.success('ElevenLabs key saved — Henry will use it for his speaking voice');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save key');
    } finally {
      setElevenBusy(false);
    }
  };

  const testSpeaking = async () => {
    setSpeakBusy(true);
    try {
      await voiceSpeak("Hi, it's Henry. This is how I sound.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Speaking test failed');
    } finally {
      setSpeakBusy(false);
    }
  };

  const testListening = async () => {
    if (listenTest === 'recording') {
      setListenTest('transcribing');
      try {
        const blob = await stopVoiceRecording();
        if (!blob) {
          setListenResult('No audio captured — try speaking a bit longer.');
        } else {
          const text = await transcribeLocal(blob);
          setListenResult(text ? `Heard: “${text}”` : 'Heard silence — try again closer to the mic.');
        }
      } catch (e) {
        setListenResult(e instanceof Error ? e.message : String(e));
      } finally {
        setListenTest('idle');
      }
      return;
    }
    setListenResult(null);
    try {
      await startVoiceRecording();
      setListenTest('recording');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Microphone unavailable');
    }
  };

  const englishVoices = (tts?.sayVoices ?? []).filter((v) => v.lang.toLowerCase().startsWith('en'));
  const engine = settings.voice_tts_engine === 'local' || settings.voice_tts_engine === 'elevenlabs'
    ? settings.voice_tts_engine
    : 'auto';

  return (
    <div className={cardCls}>
      <SectionHeader
        title="Voice"
        sub={voiceSubtitle()}
      />
      <div className="space-y-4">
        {/* ── Listening (STT) ── */}
        <div>
          <label className={labelCls}>Listening (speech-to-text)</label>
          <div className="text-[11px] text-henry-text-muted space-y-1">
            <div>
              Whisper engine:{' '}
              {stt?.binaryPresent ? (
                <span className="text-emerald-400">installed ({stt.binaryPath})</span>
              ) : (
                <span>not installed</span>
              )}
            </div>
            <div>
              Speech model (base.en, ~148MB):{' '}
              {stt?.modelPresent ? (
                <span className="text-emerald-400">downloaded</span>
              ) : (
                <span>not downloaded</span>
              )}
            </div>
          </div>
          {setupBusy && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-henry-border/40 overflow-hidden">
                <div className="h-full bg-henry-accent transition-all" style={{ width: `${setupProgress?.pct ?? 5}%` }} />
              </div>
              <p className="text-[10px] text-henry-text-muted mt-1">{setupProgress?.message ?? 'Preparing…'}</p>
            </div>
          )}
          <div className="flex gap-2 mt-2">
            {!stt?.ready && (
              <button className={btnCls} onClick={() => void runSetup()} disabled={setupBusy}>
                {setupBusy ? 'Setting up…' : 'Set up free voice (~150MB, one-time)'}
              </button>
            )}
            <button className={btnCls} onClick={() => void refresh(true)}>Re-check</button>
            <button className={btnCls} onClick={() => void testListening()} disabled={!stt?.ready || listenTest === 'transcribing'}>
              {listenTest === 'recording' ? 'Stop + transcribe' : listenTest === 'transcribing' ? 'Transcribing…' : 'Test listening'}
            </button>
          </div>
          {listenResult && <p className="text-[11px] text-henry-text-dim mt-1.5">{listenResult}</p>}
        </div>

        {/* ── Speaking (TTS) ── */}
        <div className="border-t border-henry-border/20 pt-3">
          <label className={labelCls}>Speaking voice</label>
          <select
            className={inputCls}
            value={engine}
            onChange={(e) => void saveVoiceSetting('voice_tts_engine', e.target.value)}
          >
            <option value="auto">Auto — ElevenLabs when a key is saved, else the free local voice</option>
            <option value="local">Local only — free local voice (offline)</option>
            <option value="elevenlabs">ElevenLabs only</option>
          </select>
          <p className="text-[10px] text-henry-text-muted mt-1">
            Active now:{' '}
            <span className="text-henry-text-dim">
              {tts?.active === 'elevenlabs' ? 'ElevenLabs' : 'Free local voice'}
            </span>
            {tts && !tts.elevenLabsKeyPresent && ' · no ElevenLabs key saved'}
          </p>

          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className={labelCls}>Local voice</label>
              <select
                className={inputCls}
                value={settings.voice_say_voice || tts?.sayVoice || 'Samantha'}
                onChange={(e) => void saveVoiceSetting('voice_say_voice', e.target.value)}
              >
                {englishVoices.length === 0 && <option value="Samantha">Samantha</option>}
                {englishVoices.map((v) => (
                  <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Rate (words/min)</label>
              <input
                type="number"
                min={90}
                max={400}
                className={inputCls}
                value={settings.voice_say_rate || String(tts?.sayRate ?? 175)}
                onChange={(e) => void saveVoiceSetting('voice_say_rate', e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 mt-2">
            <button className={btnCls} onClick={() => void testSpeaking()} disabled={speakBusy}>
              {speakBusy ? 'Speaking…' : 'Test speaking'}
            </button>
            <button className={btnCls} onClick={() => void voiceStopSpeaking()}>Stop</button>
            <button
              className={btnCls + (greetingOn ? ' text-henry-accent border-henry-accent/50' : '')}
              onClick={() => void toggleGreeting()}
              title="Speak a short greeting when Henry starts. Audio is generated once and cached."
            >
              {greetingOn ? '✓ Greeting on' : 'Greeting off'}
            </button>
          </div>
        </div>

        {/* ── ElevenLabs ── */}
        <div className="border-t border-henry-border/20 pt-3">
          <div className="flex items-center gap-2">
            <label className={labelCls + ' mb-0'}>ElevenLabs (optional — premium voice)</label>
            {tts?.elevenLabsKeyPresent ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">key set</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-henry-border/30 text-henry-text-muted">no key</span>
            )}
          </div>
          <div className="flex gap-2 mt-1.5">
            <input
              type="password"
              className={inputCls + ' flex-1'}
              value={elevenKey}
              onChange={(e) => setElevenKey(e.target.value)}
              placeholder={tts?.elevenLabsKeyPresent ? 'Enter a new key to replace…' : 'xi-…'}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveElevenKey(); }}
            />
            <button className={btnCls} onClick={() => void saveElevenKey()} disabled={elevenBusy || !elevenKey.trim()}>
              {elevenBusy ? 'Saving…' : tts?.elevenLabsKeyPresent ? 'Replace' : 'Save'}
            </button>
          </div>
          <div className="mt-2">
            <label className={labelCls}>ElevenLabs voice ID</label>
            <input
              className={inputCls}
              value={settings.voice_tts_voice || tts?.elevenVoiceId || '21m00Tcm4TlvDq8ikWAM'}
              onChange={(e) => void saveVoiceSetting('voice_tts_voice', e.target.value)}
              placeholder="21m00Tcm4TlvDq8ikWAM (Rachel)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function SettingsView() {
  return (
    <div className="h-full overflow-y-auto bg-henry-bg">
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-henry-text">Settings</h1>
          <p className="text-xs text-henry-text-muted mt-1">
            Profile, AI providers, engine assignment, pairing, and system health.
          </p>
        </div>

        <ProfileSection />
        <ProvidersSection />
        <EnginesSection />
        <CoderEngineSection />
        <VoiceSection />

        <div className={cardCls}>
          <SectionHeader title="Companion device" sub="Pair and control Henry from your phone." />
          <div className="space-y-5">
            <RemoteControlPanel />
            <DeviceLinkPanel />
          </div>
        </div>

        <div className={cardCls}>
          <SectionHeader title="System health" />
          <HealthPanel />
        </div>
      </div>
    </div>
  );
}
