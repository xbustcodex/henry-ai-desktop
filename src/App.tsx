import { useEffect, useState, useRef } from 'react';
import Layout from './components/layout/Layout';
import SetupWizard from './components/wizard/SetupWizard';
import ElectronAutoSetup from './components/wizard/ElectronAutoSetup';
import ClipboardAIToast from './components/ClipboardAIToast';
import ToastHost from './components/ui/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { useStore } from './store';
import type { Task } from './types';
import { startProactiveNudges, type HenryNudge } from './henry/proactiveNudges';
import { seedWorkspace } from './henry/workspaceSeeder';
import { indexWorkspace } from './henry/workspaceIndex';
import { startSelfHealing, type HenryRepairEvent } from './henry/selfHealing';
import { getTodayBriefing, saveBriefing, buildBriefingPrompt, getTodayKey } from './henry/proactiveBriefing';
import { isNative } from './capacitor';
import { checkAndNotify, syncFromDb as syncRemindersFromDb } from './henry/reminders';
import OnboardingWizard, { shouldShowOnboarding } from './components/onboarding/OnboardingWizard';
import { installCreatorsActivation } from './henry/creatorsActivation';
import { applyTheme, sanitizeTheme, DEFAULT_THEME } from './henry/theme';
import ProductTour from './components/onboarding/ProductTour';
import { buildMemoryContext } from './henry/memoryPipeline';
import { useCapturesStore } from './ambient/capturesStore';
import { registerShortcuts, buildShortcuts } from './henry/keyboardShortcuts';
import CompanionApp from './components/mobile/CompanionApp';
import ConfirmToolModal from './components/agent/ConfirmToolModal';
import { syncOllamaDefaultsToBackendIfNeeded } from './henry/ollamaConfig';
import { isMacOS, isLinux, isWindows } from './utils/platform';
import { updateCapabilitySnapshot } from './henry/capabilityRegistry';
import StartupFailureBanner from './components/health/StartupFailureBanner';

// Check if companion mode is active
// Logic: on native, default to companion mode if paired (unless user explicitly chose full mode)
const COMPANION_MODE_KEY = 'henry:companion:mode';
function isCompanionMode(): boolean {
  if (!isNative) return false;
  try {
    const explicit = localStorage.getItem(COMPANION_MODE_KEY);
    if (explicit === 'full') return false;
    if (explicit === 'companion') return true;
    // Default: use companion mode if a desktop pairing config exists
    return !!localStorage.getItem('henry:companion:config');
  } catch {
    return false;
  }
}

const HENRY_FIRST_MESSAGE = `Hey. I'm up and running.

Before we dive in — what's the most important thing on your plate right now? It could be a project you're working on, something you want to write, a question you've been turning over, or honestly anything. Just tell me and we'll start there.

If you want to explore what I can do first, try saying something like "show me what you can do" — or just talk to me like you would a smart colleague who's always around.`;

export default function App() {
  const [loading, setLoading] = useState(true);
  const [updateState, setUpdateState] = useState<'none' | 'available' | 'downloaded'>('none');
  const [nudge, setNudge] = useState<HenryNudge | null>(null);
  const [repair, setRepair] = useState<HenryRepairEvent | null>(null);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding());

  // Global event for re-launching the wizard from anywhere (Setup panel, etc.)
  useEffect(() => {
    const onOpenWizard = () => {
      try { localStorage.removeItem('henry:onboarding_v1_complete'); } catch { /* */ }
      setShowOnboarding(true);
    };
    window.addEventListener('henry_open_setup_wizard', onOpenWizard);
    return () => window.removeEventListener('henry_open_setup_wizard', onOpenWizard);
  }, []);
  const [greetingDismissed, setGroqDismissed] = useState(() => !!sessionStorage.getItem('henry:groq_warn_dismissed'));
  const [showSplash, setShowSplash] = useState(() => {
    // Only show splash on first launch of a session (not every time)
    const seen = sessionStorage.getItem('henry_splash_seen');
    return !seen;
  });
  const [missingPerms, setMissingPerms] = useState<{ accessibility: boolean; screenRecording: boolean } | null>(null);
  const firstContactDone = useRef(false);
  const briefingInjectedRef = useRef(false);
  const {
    setupComplete,
    setSetupComplete,
    setConversations,
    setProviders,
    setActiveConversation,
    addMessage,
    setCompanionStatus,
    setWorkerStatus,
    updateTask,
    setCurrentView,
    settings,
  } = useStore();

  useEffect(() => {
    void initApp();

    // Spoken startup greeting — off unless the user turned it on. The audio is
    // synthesized once and cached on disk, so this costs nothing per launch.
    if (settings.voice_greeting === 'on') {
      void (async () => {
        try {
          const res = await window.henryAPI.voiceGreeting?.({ speak: true });
          if (!res?.ok || !res.result?.audio?.length) return;
          // Copy into a fresh ArrayBuffer — IPC hands back a Uint8Array whose
          // backing buffer may be a SharedArrayBuffer, which Blob rejects.
          const bytes = new Uint8Array(res.result.audio);
          const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: res.result.mimeType }));
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
          audio.onerror = () => URL.revokeObjectURL(url);
          void audio.play().catch(() => { /* autoplay may be blocked; that's fine */ });
        } catch { /* a greeting is never worth an error */ }
      })();
    }

    // Measure what this machine can actually do before the model is told.
    // The capability block used to assume every feature worked.
    void (async () => {
      try {
        const api = window.henryAPI as { computerCheckCapabilities?: () => Promise<unknown> } | undefined;
        const caps = await api?.computerCheckCapabilities?.();
        if (caps) updateCapabilitySnapshot(caps as never);
      } catch { /* leave the block reporting "unknown" */ }
    })();
    const cleanup = setupEventListeners();
    const stopNudges = startProactiveNudges((n) => setNudge(n));
    const stopHealing = startSelfHealing((event) => {
      setRepair(event);
      setTimeout(() => setRepair(null), 8000);
    });
    // Sync reminders from SQLite to localStorage on startup
    void syncRemindersFromDb().catch(() => {});

    // Check reminders every minute for due notifications
    const reminderInterval = setInterval(() => {
      try { checkAndNotify(); } catch { /* non-critical */ }
    }, 60_000);
    // Fire once immediately on mount
    try { checkAndNotify(); } catch { /* non-critical */ }

    // Auto-start the sync server for mobile companion (LAN connection)
    if (!!!!(window.henryAPI as any)?.__isElectron?.()) {
      window.henryAPI.syncStart?.().catch?.(() => { /* ignore if already running */ });
    }

    // Listen for permission check results from main process
    function handlePermsReady(e: Event) {
      const { accessibility, screenRecording } = (e as CustomEvent).detail as { accessibility: boolean; screenRecording: boolean };
      if (!accessibility || !screenRecording) {
        setMissingPerms({ accessibility, screenRecording });
      }
    }
    window.addEventListener('henry_permissions_ready', handlePermsReady);

    // Handle henry_open_capture event (from Cmd+Shift+N shortcut)
    function handleOpenCapture() {
      useStore.getState().setCurrentView('captures' as any);
      try { useCapturesStore.getState().openPanel(); } catch { /* ignore */ }
    }
    window.addEventListener('henry_open_capture', handleOpenCapture);

    // Register global keyboard shortcuts
    const unregisterShortcuts = registerShortcuts();
    // '?' key shows shortcut help
    function handleHelpKey(e: KeyboardEvent) {
      // Escape closes splash first, then shortcuts help
      if (e.key === 'Escape') {
        setShowSplash(false);
        return;
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
        e.preventDefault();
        setShowShortcutsHelp((prev: boolean) => !prev);
      }
    }
    window.addEventListener('keydown', handleHelpKey);

    return () => { cleanup(); stopNudges(); stopHealing(); clearInterval(reminderInterval); unregisterShortcuts(); window.removeEventListener('keydown', handleHelpKey); window.removeEventListener('henry_open_capture', handleOpenCapture); };
  }, []);

  // Content Creators — Ctrl+Shift+J to open the stage, plus trigger phrases.
  useEffect(() => installCreatorsActivation(), []);

  // Theme must be applied before anything paints, or the first frame flashes
  // the default accent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await window.henryAPI.getSettings?.();
        if (cancelled) return;
        const raw = (all as Record<string, string> | undefined)?.['theme_json'];
        applyTheme(sanitizeTheme(raw ? JSON.parse(raw) : null));
      } catch {
        applyTheme(DEFAULT_THEME);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Register service worker in production only
  useEffect(() => {
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then(() => { /* registered */ })
        .catch((err) => console.warn('[Henry] SW registration failed:', err));
    }
  }, []);

  // Electron: companion sync bridge → renderer (Settings / chat can listen)
  useEffect(() => {
    const api = window.henryAPI;
    if (typeof api?.onCompanionDeviceLinked !== 'function') return;

    const bridge = (name: string, detail: unknown) => {
      window.dispatchEvent(new CustomEvent('henry_companion_bridge', { detail: { name, detail } }));
      window.dispatchEvent(new CustomEvent('henry_companion_devices_changed'));
    };

    const u0 = api.onCompanionDeviceLinked!((device) => bridge('device-linked', device));
    const uChat = (api as any).onCompanionChatUpdate?.((data: unknown) => {
      window.dispatchEvent(new CustomEvent('henry_companion_chat_update', { detail: data }));
    });
    // Wire AI extraction results → expanded capture with insights
    const uExtract = api.onQuickExtractResult?.((result: any) => {
      if (!result?.extracted || !result?.originalText) return;
      const ex = result.extracted;
      const nl = '\n';
      const parts: string[] = [];
      if (ex.summary) parts.push('📋 ' + ex.summary);
      if (ex.ideas?.length) parts.push('💡 Ideas:' + nl + (ex.ideas as string[]).map((i) => '• ' + i).join(nl));
      if (ex.prospects?.length) parts.push('🎯 Prospects:' + nl + (ex.prospects as string[]).map((p) => '• ' + p).join(nl));
      if (ex.tasks?.length) parts.push('✅ Tasks:' + nl + (ex.tasks as string[]).map((t) => '• ' + t).join(nl));
      if (ex.insights?.length) parts.push('🔍 Insights:' + nl + (ex.insights as string[]).map((i) => '• ' + i).join(nl));
      if (ex.quotes?.length) parts.push('💬 Quotes:' + nl + (ex.quotes as string[]).map((q) => '"' + q + '"').join(nl));
      if (ex.questions?.length) parts.push('❓ Questions:' + nl + (ex.questions as string[]).map((q) => '• ' + q).join(nl));
      if (parts.length > 0) {
        const preview = result.originalText.slice(0, 120) + (result.originalText.length > 120 ? '…' : '');
        const enrichedText = '⚡ Henry extracted from:' + nl + '"' + preview + '"' + nl + nl + parts.join(nl + nl);
        useCapturesStore.getState().addCapture(enrichedText, {
          sourceUrl: result.source || undefined,
          pageTitle: result.pageTitle || 'Quick Extract',
          origin: 'extension',
          category: (ex.category as any) || 'note',
        });
      }
    });

        const u1 = api.onCompanionCapture!((capture: any) => {
      bridge('capture', capture);
      // Wire capture directly into CapturesStore so Henry Engage → Captures panel works
      if (capture?.text) {
        const note = (capture.text || '').trim().slice(0, 2000);
        if (note) useCapturesStore.getState().addCapture(note, {
          sourceUrl: capture.source || undefined,
          pageTitle: capture.pageTitle || undefined,
          origin: 'extension',
          category: capture.category as any || undefined,
        });
      }
    });
    const u2 = api.onCompanionPrompt!((data) => bridge('prompt', data));
    const u3 = api.onCompanionActionDecision!((decision) => bridge('action-decision', decision));

    return () => {
      u0();
      u1();
      u2();
      u3();
      uExtract?.();
      // uChat was never unsubscribed, so every remount left another live
      // 'companion:chat-update' listener behind.
      uChat?.();
    };
  }, []);

  // Henry's autonomous first contact — fires once after wizard completes
  useEffect(() => {
    if (!setupComplete || firstContactDone.current) return;
    const isFirstLaunch = useStore.getState().settings.henry_first_launch === 'true';
    if (!isFirstLaunch) return;

    firstContactDone.current = true;
    void triggerFirstContact();
  }, [setupComplete, settings.henry_first_launch]);

  // Proactive daily briefing — inject into chat once per day, automatically
  useEffect(() => {
    if (!setupComplete || loading || briefingInjectedRef.current) return;

    const injectedKey = `henry:briefing_chat_injected:${getTodayKey()}`;
    if (localStorage.getItem(injectedKey) === 'true') return;
    // Delay slightly so the conversation list is loaded first
    const timer = setTimeout(() => { void injectDailyBriefing(injectedKey); }, 3500);
    return () => clearTimeout(timer);
  }, [setupComplete, loading]);

  async function injectDailyBriefing(injectedKey: string) {
    try {
      // If a briefing was already generated (in TodayPanel), reuse it
      let content = getTodayBriefing()?.content ?? null;

      if (!content) {
        // Build context from memory pipeline (structured facts)
        const memoryCtx = buildMemoryContext();
        const prompt = buildBriefingPrompt(memoryCtx);

        // Build a simple non-streaming AI call using the companion provider
        const st = useStore.getState();
        const companionProvider = st.settings.companion_provider || 'groq';
        const companionModel = st.settings.companion_model || 'llama-3.3-70b-versatile';
        const providerRecord = st.providers.find((p) => p.id === companionProvider);
        const apiKey = providerRecord?.apiKey || '';

        if (!apiKey) return; // No key configured — skip silently

        const result = await window.henryAPI.sendMessage({
          provider: companionProvider,
          model: companionModel,
          apiKey,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 200,
        });

        content = result.content || String(result ?? '');
        if (content) saveBriefing(content, companionModel);
      }

      if (!content) return;

      // Mark injected BEFORE saving so we don't retry on errors mid-save
      briefingInjectedRef.current = true;
      localStorage.setItem(injectedKey, 'true');

      // Find active conversation, or use the most recent one
      const st = useStore.getState();
      let conversationId = st.activeConversationId;

      if (!conversationId) {
        const convos = await window.henryAPI.getConversations();
        if (convos.length > 0) {
          conversationId = convos[0].id;
          setConversations(convos);
          setActiveConversation(conversationId);
        } else {
          const newConvo = await window.henryAPI.createConversation('Today');
          conversationId = newConvo.id;
          const convos2 = await window.henryAPI.getConversations();
          setConversations(convos2);
          setActiveConversation(conversationId);
        }
      }

      const msg = {
        id: `briefing-${getTodayKey()}`,
        conversation_id: conversationId,
        role: 'assistant' as const,
        content,
        engine: 'companion' as const,
        created_at: new Date().toISOString(),
      };

      await window.henryAPI.saveMessage(msg);
      addMessage(msg);
      setCurrentView('chat');
    } catch (err) {
      // Reset flags so next app launch can retry
      briefingInjectedRef.current = false;
      try { localStorage.removeItem(injectedKey); } catch { /* ignore */ }
      console.warn('[Henry] Daily briefing injection failed:', err);
    }
  }

  async function triggerFirstContact() {
    try {
      const convo = await window.henryAPI.createConversation("First session with Henry");
      const convos = await window.henryAPI.getConversations();
      setConversations(convos);
      setActiveConversation(convo.id);

      const firstMsg = {
        id: `henry-first-${Date.now()}`,
        conversation_id: convo.id,
        role: 'assistant' as const,
        content: HENRY_FIRST_MESSAGE,
        engine: 'companion' as const,
        created_at: new Date().toISOString(),
      };

      await window.henryAPI.saveMessage(firstMsg);
      addMessage(firstMsg);
      setCurrentView('chat');

      // Clear first launch flag
      await window.henryAPI.saveSetting('henry_first_launch', 'false');
      useStore.getState().updateSetting('henry_first_launch', 'false');
    } catch (err) {
      console.error('Failed to deliver Henry first contact:', err);
    }
  }

  async function initApp() {
    try {
      // URL bypass: ?enter or #enter skips wizard immediately
      // Only allowed if at least one provider is already configured
      const urlBypass =
        window.location.search.includes('enter') ||
        window.location.hash === '#enter' ||
        window.location.hash === '#henry';
      if (urlBypass) {
        const earlyProviders: Array<{ id: string }> = (() => {
          try { return JSON.parse(localStorage.getItem('henry:providers') || '[]'); } catch { return []; }
        })();
        if (earlyProviders.length > 0) {
          await window.henryAPI.saveSetting('setup_complete', 'true');
        }
        // Clean the URL without reload
        history.replaceState(null, '', window.location.pathname);
      }

      // ── Auto-bootstrap Groq from server env key (web/Replit preview mode) ──
      // Always refresh the key from the env var so stale/empty localStorage
      // entries never cause "Failed to fetch" errors.
      const envGroqKey = typeof __GROQ_API_KEY__ !== 'undefined' ? __GROQ_API_KEY__ : '';
      if (envGroqKey) {
        const existingProviders: HenryProviderRecord[] = (() => {
          try { return JSON.parse(localStorage.getItem('henry:providers') || '[]'); } catch { return []; }
        })();
        const savedGroq = existingProviders.find((p) => p.id === 'groq');
        const savedKey = savedGroq?.api_key || savedGroq?.apiKey || '';

        // Always upsert if the stored key differs from the env key (covers first-run
        // AND any key rotation or storage corruption scenario)
        if (savedKey !== envGroqKey) {
          await window.henryAPI.saveProvider({
            id: 'groq',
            name: 'Groq',
            api_key: envGroqKey,
            enabled: 1,
            models: JSON.stringify([]),
          } as any);
          await window.henryAPI.saveSetting('companion_provider', 'groq');
          await window.henryAPI.saveSetting('companion_model', 'llama-3.3-70b-versatile');
          await window.henryAPI.saveSetting('worker_provider', 'groq');
          await window.henryAPI.saveSetting('worker_model', 'llama-3.3-70b-versatile');
          await window.henryAPI.saveSetting('setup_complete', 'true');
        }
      }

      const settingsMap = (await window.henryAPI.getSettings()) as Record<string, string>;

      Object.entries(settingsMap).forEach(([key, value]) => {
        useStore.getState().updateSetting(key, value);
      });

      // Sync SQLite settings → localStorage so webMock streamMessage uses correct provider/model
      // This is the source-of-truth sync: SQLite wins over any stale localStorage values
      if (Object.keys(settingsMap).length > 0) {
        try {
          const existing = JSON.parse(localStorage.getItem('henry:settings') || '{}');
          const merged = { ...existing, ...settingsMap };
          localStorage.setItem('henry:settings', JSON.stringify(merged));
        } catch { /* ignore */ }
      }

      // Check setup_complete from API result OR directly from localStorage as fallback
      const lsSettings = (() => {
        try { return JSON.parse(localStorage.getItem('henry:settings') || '{}'); } catch { return {}; }
      })();

      const isComplete =
        settingsMap.setup_complete === 'true' ||
        lsSettings.setup_complete === 'true';

      // Always load providers from SQLite and sync to localStorage at startup
      // This fixes: key saved in Settings, but chat still fails until restart
      try {
        const sqliteProviders = await window.henryAPI.getProviders().catch(() => []);
        if (sqliteProviders.length > 0) {
          const syncData = sqliteProviders.map((p: HenryProviderRecord) => ({
            id: p.id, name: p.name,
            api_key: p.api_key || p.apiKey || '',
            apiKey: p.api_key || p.apiKey || '',
            enabled: Boolean(p.enabled), models: p.models || '[]',
          }));
          localStorage.setItem('henry:providers', JSON.stringify(syncData));
        }
      } catch { /* non-critical */ }

      const lsProviders: HenryProviderRecord[] = (() => {
        try { return JSON.parse(localStorage.getItem('henry:providers') || '[]'); } catch { return []; }
      })();
      const hasProviders = lsProviders.length > 0;

      if (isComplete || hasProviders) {
        // Mark complete if only providers existed without the flag
        if (!isComplete && hasProviders) {
          await window.henryAPI.saveSetting('setup_complete', 'true');
        }

        // Hardwire Groq as permanent default for both engines if not already set
        const groqProvider = lsProviders.find((p: any) => p.id === 'groq');
        if (groqProvider && groqProvider.enabled) {
          const needsCompanion = !settingsMap.companion_provider;
          const needsWorker = !settingsMap.worker_provider;
          if (needsCompanion) {
            await window.henryAPI.saveSetting('companion_provider', 'groq');
            await window.henryAPI.saveSetting('companion_model', 'llama-3.3-70b-versatile');
            useStore.getState().updateSetting('companion_provider', 'groq');
            useStore.getState().updateSetting('companion_model', 'llama-3.3-70b-versatile');
          }
          if (needsWorker) {
            await window.henryAPI.saveSetting('worker_provider', 'groq');
            await window.henryAPI.saveSetting('worker_model', 'llama-3.3-70b-versatile');
            useStore.getState().updateSetting('worker_provider', 'groq');
            useStore.getState().updateSetting('worker_model', 'llama-3.3-70b-versatile');
          }
        }

        setSetupComplete(true);

        // Seed workspace on first run (idempotent — safe to call every launch)
        try { seedWorkspace(); } catch { /* non-critical */ }
        // Background workspace indexing (non-blocking)
        setTimeout(() => { indexWorkspace().catch(() => {}); }, 5000);

        const [convos, providers] = await Promise.all([
          window.henryAPI.getConversations().catch((e: unknown) => {
            console.error('[Henry] Failed to load conversations:', e);
            return [] as Awaited<ReturnType<typeof window.henryAPI.getConversations>>;
          }),
          window.henryAPI.getProviders().catch((e: unknown) => {
            console.error('[Henry] Failed to load providers:', e);
            return [] as Awaited<ReturnType<typeof window.henryAPI.getProviders>>;
          }),
        ]);
        setConversations(convos);
        // Sync providers from SQLite → localStorage so webMock reads correct API keys
        try {
          const lsProviders = providers.map((p: HenryProviderRecord) => ({
            id: p.id,
            name: p.name,
            api_key: p.api_key || p.apiKey || '',
            apiKey: p.api_key || p.apiKey || '',
            enabled: Boolean(p.enabled),
            models: p.models || '[]',
          }));
          localStorage.setItem('henry:providers', JSON.stringify(lsProviders));
        } catch { /* ignore */ }

      // Ensure Ollama defaults are synced to backend (idempotent)
      try { await syncOllamaDefaultsToBackendIfNeeded(); } catch { /* non-critical */ }

        setProviders(
          providers.map((p: HenryProviderRecord) => ({
            id: p.id,
            name: p.name,
            apiKey: p.api_key || p.apiKey || '',
            enabled: Boolean(p.enabled),
            models: (() => {
              try {
                const m = p.models;
                if (Array.isArray(m)) return m;
                if (typeof m === 'string' && m) return JSON.parse(m);
                return [];
              } catch (e) {
                console.error('[Henry] Failed to parse models for provider', p.id, e);
                return [];
              }
            })(),
          }))
        );
      }
    } catch (err) {
      console.error('Failed to init app:', err);
    } finally {
      setLoading(false);
    }
  }

  function setupEventListeners() {
    const unsubEngine = window.henryAPI.onEngineStatus((data) => {
      if (data.engine === 'companion') {
        setCompanionStatus(data);
      } else if (data.engine === 'worker') {
        setWorkerStatus(data);
      }
    });

    const unsubTask = window.henryAPI.onTaskUpdate((data) => {
      updateTask(data.id, data);
    });

    const unsubResult = window.henryAPI.onTaskResult((data) => {
      updateTask(data.taskId, {
        id: data.taskId,
        ...(data.error !== undefined ? { error: data.error } : {}),
        ...(data.result !== undefined ? { result: typeof data.result === 'string' ? data.result : JSON.stringify(data.result) } : {}),
      } as Partial<Task>);

      if (!data.conversationId) return;

      if (data.error) {
        useStore.getState().addMessage({
          id: `task-result-${data.taskId}-error`,
          conversation_id: data.conversationId,
          role: 'assistant',
          content: `⚠️ *Worker task failed:*\n\n${data.error}`,
          engine: 'worker',
          created_at: new Date().toISOString(),
        });
        return;
      }

      const result = typeof data.result === 'string'
        ? data.result
        : data.result?.content || JSON.stringify(data.result ?? {});

      useStore.getState().addMessage({
        id: `task-result-${data.taskId}`,
        conversation_id: data.conversationId,
        role: 'assistant',
        content: `⚡ *Worker task completed:*\n\n${result}`,
        engine: 'worker',
        model: typeof data.result === 'object' && data.result ? data.result.model : undefined,
        cost: typeof data.result === 'object' && data.result ? data.result.cost : undefined,
        created_at: new Date().toISOString(),
      });
    });

    const unsubUpdateAvailable = window.henryAPI.onUpdateAvailable(() => {
      setUpdateState('available');
    });
    const unsubUpdateDownloaded = window.henryAPI.onUpdateDownloaded(() => {
      setUpdateState('downloaded');
    });

    return () => {
      unsubEngine();
      unsubTask();
      unsubResult();
      unsubUpdateAvailable();
      unsubUpdateDownloaded();
    };
  }

  // Splash is overlaid — no early return, layout always renders behind

  if (!setupComplete) {
    // In Electron: skip the wizard entirely — run auto-setup immediately
    const isElectron = typeof window.henryAPI?.ollamaIsInstalled === 'function';
    if (isElectron) {
      return <ElectronAutoSetup onComplete={() => setSetupComplete(true)} />;
    }
    return <SetupWizard />;
  }

  // Companion mode: render the lightweight companion shell on iPhone/iPad
  if (isCompanionMode()) {
    return (
      <ErrorBoundary>
        <div className="h-screen w-screen flex flex-col overflow-hidden bg-henry-bg">
          <CompanionApp />
          <ToastHost />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      {/* Groq key warning — shown until key is added or dismissed */}
      {!greetingDismissed && !(useStore.getState().providers || []).find((p: any) => p.id === 'groq' && p.apiKey?.startsWith('gsk_')) && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 flex-shrink-0">
          <p className="text-[11px] text-yellow-400">
            ⚠ No Groq API key — Henry AI won't respond without one.{' '}
            <button onClick={() => useStore.getState().setCurrentView('settings' as any)} className="underline hover:text-yellow-300">Add free key in Settings →</button>
          </p>
          <button onClick={() => { setGroqDismissed(true); sessionStorage.setItem('henry:groq_warn_dismissed','1'); }} className="text-yellow-400/50 hover:text-yellow-400 text-xs ml-3">✕</button>
        </div>
      )}

      {/* Splash screen — overlaid on top, closeable */}
      {showSplash && setupComplete && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(8,8,14,0.92)', backdropFilter: 'blur(12px)' }}
        >
          <div className="relative w-full max-w-md mx-4">
            {/* Close button */}
            <button
              onClick={() => { setShowSplash(false); sessionStorage.setItem('henry_splash_seen','1'); if (useStore.getState().currentView === 'today') useStore.getState().setCurrentView('chat'); }}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-henry-surface border border-henry-border/40 text-henry-text-muted hover:text-henry-text flex items-center justify-center text-sm transition-all z-10"
              title="Close"
            >✕</button>

            {/* Card */}
            <div className="rounded-2xl border border-henry-border/30 bg-henry-surface overflow-hidden">
              {/* Top bar */}
              <div className="px-6 pt-6 pb-5 border-b border-henry-border/20">
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-3xl">🧠</span>
                  <div>
                    <h1 className="text-lg font-bold text-henry-text tracking-tight">Henry AI</h1>
                    <p className="text-[11px] text-henry-text-muted">Your personal AI on your own machine</p>
                  </div>
                </div>
                <p className="text-sm text-henry-text-muted leading-relaxed">
                  Henry runs locally. Your data never leaves this computer. He can talk, think, write, automate your computer, generate images and video, run your business — all from one place.
                </p>
              </div>

              {/* Quick start items */}
              <div className="px-6 py-4 space-y-2.5">
                {[
                  { icon: '💬', label: 'Just start typing', desc: 'Henry is in Chat mode — ready now' },
                  { icon: '🖥️', label: 'Computer control', desc: 'Tell Henry to do things on your computer' },
                  { icon: '⚙️', label: 'Add your API keys', desc: 'Settings → AI Providers for image & video gen' },
                ].map(item => (
                  <div key={item.label} className="flex items-start gap-3">
                    <span className="text-base shrink-0 mt-0.5">{item.icon}</span>
                    <div>
                      <p className="text-[12px] font-medium text-henry-text">{item.label}</p>
                      <p className="text-[11px] text-henry-text-muted">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* CTA */}
              <div className="px-6 pb-6">
                <button
                  onClick={() => { setShowSplash(false); sessionStorage.setItem('henry_splash_seen','1'); if (useStore.getState().currentView === 'today') useStore.getState().setCurrentView('chat'); }}
                  className="w-full py-3 rounded-xl bg-henry-accent text-henry-bg font-semibold text-sm hover:bg-henry-accent/90 transition-all"
                >
                  Start talking to Henry →
                </button>
                <p className="text-center text-[10px] text-henry-text-muted mt-2">Press Esc or click anywhere outside to dismiss</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {updateState !== 'none' && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-henry-accent/15 border-b border-henry-accent/25 text-sm text-henry-text">
          <span>
            {updateState === 'downloaded'
              ? '✅ Henry update ready — restart to apply'
              : '⬇️ A Henry update is downloading in the background'}
          </span>
          <div className="flex items-center gap-3">
            {updateState === 'downloaded' && (
              <button
                onClick={() => void window.henryAPI.installUpdate()}
                className="text-xs px-3 py-1 rounded-lg bg-henry-accent text-white hover:bg-henry-accent/80 transition-colors font-medium"
              >
                Restart &amp; update
              </button>
            )}
            <button
              onClick={() => setUpdateState('none')}
              className="text-henry-text-muted hover:text-henry-text transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        <StartupFailureBanner />
        <div className="flex-1 min-h-0">
          <Layout />
        </div>
      </div>

      {/* Onboarding wizard — first launch + manual relaunch */}
      {showOnboarding && (
        <OnboardingWizard onComplete={() => setShowOnboarding(false)} />
      )}

      {/* Proactive nudge banner */}
      {nudge && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
          <div className="flex items-center gap-3 bg-henry-surface/95 border border-henry-border/60 backdrop-blur-xl rounded-2xl shadow-xl px-5 py-3.5 max-w-sm">
            <span className="text-xl shrink-0">{nudge.icon ?? '💡'}</span>
            <p className="text-sm text-henry-text leading-snug flex-1">{nudge.message}</p>
            <button
              onClick={() => {
                const view = (nudge as any).action?.view;
                if (view && view !== 'chat') {
                  useStore.getState().setCurrentView(view as any);
                } else {
                  useStore.getState().setCurrentView('chat');
                  if (nudge.cta ?? nudge.message) {
                    window.dispatchEvent(new CustomEvent('henry_inject_draft', { detail: { text: nudge.cta ?? nudge.message } }));
                  }
                }
                setNudge(null);
              }}
              className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold bg-henry-accent/15 text-henry-accent border border-henry-accent/20 hover:bg-henry-accent/25 transition-all"
            >
              Open
            </button>
            <button
              onClick={() => setNudge(null)}
              className="shrink-0 text-henry-text-muted hover:text-henry-text transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Self-repair notification — shown when Henry auto-fixes something */}
      {repair && (
        <div className="fixed bottom-6 right-6 z-50 animate-fade-in max-w-xs">
          <div className="flex items-start gap-3 bg-henry-surface/95 border border-emerald-500/30 backdrop-blur-xl rounded-2xl shadow-xl px-4 py-3.5">
            <span className="text-lg shrink-0 mt-0.5">🔧</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-emerald-400 mb-0.5">Henry self-repaired</p>
              <p className="text-xs text-henry-text-dim leading-snug">{repair.action}</p>
            </div>
            <button
              onClick={() => setRepair(null)}
              className="shrink-0 text-henry-text-muted hover:text-henry-text transition-colors mt-0.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* One-time guided tour, shown after onboarding completes. */}
      <ProductTour />

      {/* Clipboard AI toast */}
      <ClipboardAIToast />

      {/* R3-Fix 1: global toast + confirm-modal host. Components dispatch
          via the imperative `toast` / `confirmDialog` API exported from
          ui/Toast — no context plumbing needed. */}
      <ToastHost />

      {/* Agent confirmation gate — any confirm-tier tool (send message/email,
          create event, run command) raised by a chat turn or a scheduled
          Routine surfaces here for the user's approval. */}
      <ConfirmToolModal />
    </div>
    </ErrorBoundary>
  );
}
