import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../store';
import { buildPairCodePayload } from '../../sync/deviceLink';
import { isMacOS, isLinux, isWindows, getPlatformName } from '../../utils/platform';

export const ONBOARDING_DONE_KEY = 'henry:onboarding_v1_complete';
export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem(ONBOARDING_DONE_KEY);
}

interface Props { onComplete: () => void }

type StepId =
  | 'welcome'
  | 'howItWorks'
  | 'accessibility'
  | 'screen'
  | 'ai'
  | 'companion'
  | 'panels'
  | 'memory'
  | 'done';

const STEP_ORDER: StepId[] = [
  'welcome', 'howItWorks', 'accessibility', 'screen',
  'ai', 'companion', 'panels', 'memory', 'done',
];

function getApi(): any {
  return (typeof window !== 'undefined') ? (window as any).henryAPI : undefined;
}

const SYNC_HEADERS = { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' };
async function syncFetch<T = any>(path: string, body?: object): Promise<T | null> {
  try {
    const res = await fetch('http://127.0.0.1:4242' + path, {
      method: body ? 'POST' : 'GET', headers: SYNC_HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
}

function AutoAdvance({ onAdvance }: { onAdvance: () => void }) {
  useEffect(() => {
    const t = setTimeout(onAdvance, 1200);
    return () => clearTimeout(t);
  }, [onAdvance]);
  return null;
}

export default function OnboardingWizard({ onComplete }: Props) {
  const { setProviders, providers } = useStore();
  const [step, setStep] = useState<StepId>('welcome');
  const [acc, setAcc] = useState<boolean | null>(null);
  const [scr, setScr] = useState<boolean | null>(null);
  const [memName, setMemName] = useState('');
  const [memJob, setMemJob] = useState('');
  const [memGoal, setMemGoal] = useState('');
  const [memSaved, setMemSaved] = useState(false);
  const [groqKey, setGroqKey] = useState('');
  const [groqError, setGroqError] = useState('');
  const [groqSaving, setGroqSaving] = useState(false);
  const [hasAi, setHasAi] = useState(false);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairCountdown, setPairCountdown] = useState(0);
  const [pairExpiry, setPairExpiry] = useState<number | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [linkedDevices, setLinkedDevices] = useState<Array<{ id: string; name?: string }>>([]);
  const [panelIdx, setPanelIdx] = useState(0);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [iosInstallDone, setIosInstallDone] = useState(false);

  const stepIdx = STEP_ORDER.indexOf(step);
  const visibleStepCount = STEP_ORDER.length - 1;

  // ── Permissions poll ──────────────────────────────────────────────────────
  const checkPerms = useCallback(async () => {
    try {
      const a = await getApi()?.checkAccessibility?.();
      const s = await getApi()?.checkScreenRecording?.();
      setAcc(!!a?.granted);
      setScr(!!s?.granted);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void checkPerms();
    const t = setInterval(() => { void checkPerms(); }, 2000);
    return () => clearInterval(t);
  }, [checkPerms]);

  // ── AI provider ───────────────────────────────────────────────────────────
  const refreshAiState = useCallback(() => {
    try {
      const lsProviders = JSON.parse(localStorage.getItem('henry:providers') || '[]') as Array<any>;
      const groq = lsProviders.find((p: any) => p.id === 'groq');
      setHasAi(!!groq && (groq.apiKey || groq.api_key || '').length > 10);
    } catch { setHasAi(false); }
  }, []);
  useEffect(() => { refreshAiState(); }, [refreshAiState, providers]);

  // ── Mobile pairing ────────────────────────────────────────────────────────
  // R3-Fix 7: rewritten to use the new PIN-based pair flow with credentials
  // embedded in the URL fragment. The legacy pairToken handler was removed in
  // Phase 2 (it had a duplicate /sync/pair route and the consumer side was
  // never wired up), so the old `buildPairCodePayload(pairToken)` QR was
  // structurally dead. The new pattern matches RemoteControlPanel: the QR
  // encodes `http://<lan-ip>:<port>/companion/pair#id=...&pin=...`, the pair
  // page autofills both fields from the fragment and submits — iPad camera
  // scan → instant pair, no typing.
  const generatePair = useCallback(async () => {
    setGenerating(true);
    try {
      const state = await syncFetch<any>('/sync/state-internal');
      if (!state?.running) await syncFetch('/sync/start-internal', {});
      const info = await syncFetch<{ henryId: string; pin: string; pinExpiresAt: number }>('/sync/pairing-info');
      if (!info?.henryId || !info?.pin) return;
      const fresh = await syncFetch<any>('/sync/state-internal');
      if (fresh?.tunnelUrl) setTunnelUrl(fresh.tunnelUrl);
      const ipRes = await syncFetch<{ output?: string }>('/computer/shell',
        { command: 'ipconfig getifaddr en0 || ipconfig getifaddr en1' });
      const localIp = ipRes?.output?.trim() || '192.168.1.x';
      const port = fresh?.port || 4242;
      setLanUrl(`http://${localIp}:${port}`);
      const payload = `http://${localIp}:${port}/companion/pair#id=${encodeURIComponent(info.henryId)}&pin=${encodeURIComponent(info.pin)}`;
      setPairCode(payload);
      // PIN rotates every 30 min on the server; align our local countdown
      // with the actual expiry returned by /sync/pairing-info so we don't
      // show stale data after rotation.
      setPairExpiry(info.pinExpiresAt || (Date.now() + 30 * 60 * 1000));
    } finally { setGenerating(false); }
  }, []);

  useEffect(() => {
    if (step !== 'companion' || pairCode || generating) return;
    void generatePair();
  }, [step, pairCode, generating, generatePair]);

  useEffect(() => {
    if (!pairExpiry) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((pairExpiry - Date.now()) / 1000));
      setPairCountdown(remaining);
      if (remaining === 0) { setPairCode(null); setPairExpiry(null); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairExpiry]);

  useEffect(() => {
    const refresh = () => {
      void syncFetch<any>('/sync/state-internal').then(s => {
        const list = Array.isArray(s?.linkedDevices) ? s.linkedDevices : [];
        setLinkedDevices(list.filter((d: any) => !d.linkStatus || d.linkStatus === 'linked'));
      });
    };
    refresh();
    window.addEventListener('henry_companion_devices_changed', refresh);
    const poll = setInterval(refresh, 3000);
    return () => { window.removeEventListener('henry_companion_devices_changed', refresh); clearInterval(poll); };
  }, []);


  // ── Navigation ────────────────────────────────────────────────────────────
  function next() {
    const i = STEP_ORDER.indexOf(step);
    if (i >= STEP_ORDER.length - 1) return;
    let nextStep = STEP_ORDER[i + 1];
    // On non-macOS, skip macOS-only permission steps (they're capability-checked).
    // The 'done' step shows a capability summary instead of macOS permission status.
    if (!isMacOS() && (nextStep === 'accessibility' || nextStep === 'screen')) {
      // Skip straight past macOS permission steps on Linux/Windows
      const j = STEP_ORDER.indexOf(nextStep);
      nextStep = STEP_ORDER[j + 1] ?? 'done';
    }
    setStep(nextStep);
  }
  function back() {
    const i = STEP_ORDER.indexOf(step);
    if (i <= 0) return;
    let prevStep = STEP_ORDER[i - 1];
    // On non-macOS, skip macOS-only permission steps when going back too.
    if (!isMacOS() && (prevStep === 'accessibility' || prevStep === 'screen')) {
      const j = STEP_ORDER.indexOf(prevStep);
      prevStep = STEP_ORDER[j - 1] ?? STEP_ORDER[0];
    }
    setStep(prevStep);
  }
  async function finish() {
    localStorage.setItem(ONBOARDING_DONE_KEY, 'true');
    // Save any personal info the user filled in during the memory step
    if (!memSaved) {
      const api = getApi();
      const facts: {fact:string;category:string;importance:number}[] = [];
      if (memName.trim()) facts.push({ fact: `User's name is ${memName.trim()}`, category: 'personal', importance: 3 });
      if (memJob.trim())  facts.push({ fact: `User works as: ${memJob.trim()}`, category: 'personal', importance: 3 });
      if (memGoal.trim()) facts.push({ fact: `User's main goal right now: ${memGoal.trim()}`, category: 'personal', importance: 3 });
      for (const f of facts) {
        try { await api?.saveMemoryFact?.(f); } catch { /* ignore */ }
      }
      setMemSaved(true);
    }
    onComplete();
  }

  async function saveGroqKey() {
    const key = groqKey.trim();
    if (!key.startsWith('gsk_') || key.length < 30) {
      setGroqError('Groq keys start with gsk_ — double-check you copied the whole thing');
      return;
    }
    setGroqSaving(true); setGroqError('');
    try {
      const api = getApi();
      try { await api?.saveProvider?.({ id: 'groq', name: 'Groq', api_key: key, apiKey: key, enabled: 1, models: '[]' }); } catch { /* */ }
      try { await api?.saveSetting?.('companion_provider', 'groq'); } catch { /* */ }
      try { await api?.saveSetting?.('companion_model', 'llama-3.3-70b-versatile'); } catch { /* */ }
      try { await api?.saveSetting?.('worker_provider', 'groq'); } catch { /* */ }
      try { await api?.saveSetting?.('worker_model', 'llama-3.3-70b-versatile'); } catch { /* */ }
      const updated = (providers || []).filter((p: any) => p.id !== 'groq');
      updated.push({ id: 'groq', name: 'Groq', apiKey: key, enabled: true, models: ['llama-3.3-70b-versatile'] } as any);
      setProviders(updated as any);
      try {
        const ex = JSON.parse(localStorage.getItem('henry:providers') || '[]');
        const fil = ex.filter((p: any) => p.id !== 'groq');
        fil.push({ id: 'groq', name: 'Groq', api_key: key, apiKey: key, enabled: true, models: '[]' });
        localStorage.setItem('henry:providers', JSON.stringify(fil));
      } catch { /* */ }
      setHasAi(true);
      next();
    } finally { setGroqSaving(false); }
  }

  function openSettings(uri: string, ipcName: 'openPermissions' | 'openScreenRecording') {
    // Only attempt to open system preferences on macOS. This must use the
    // preload-backed helper: the Node global `process` does not exist in this
    // renderer (nodeIntegration:false, sandbox:true) and threw a ReferenceError
    // the moment a user clicked the button.
    if (!isMacOS()) {
      // Show appropriate message for non-macOS platforms
      window.confirm('Permission management is handled automatically on this platform. Please check your system settings manually if needed.');
      return;
    }

    const api = getApi();
    let opened = false;
    if (api && typeof api[ipcName] === 'function') { try { api[ipcName](); opened = true; } catch { /* */ } }
    try { if (typeof api?.computerRunShell === 'function') api.computerRunShell({ command: 'open -R "/Applications/Henry AI.app"', timeout: 3000 }); } catch { /* */ }
    if (!opened) { try { window.open(uri, '_blank'); } catch { /* */ } }
  }
  const openAccessibilitySettings = () => openSettings('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', 'openPermissions');
  const openScreenRecordingSettings = () => openSettings('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', 'openScreenRecording');

  // Platform-aware shortcut labels
  const captureShortcut = isMacOS() ? '⌥ Space' : 'Alt+C';
  const captureShortcutLabel = isMacOS() ? 'Option + Space' : 'Alt+C';
  const captureShortcutDesc = isMacOS()
    ? 'Works in any app, any screen. Selected text is automatically pasted in so Henry can read it. This is the fastest way — select something, press ⌥Space, ask about it.'
    : 'Works in any app, any screen. Selected text is automatically pasted in so Henry can read it. This is the fastest way — select something, press Alt+C, ask about it.';
  const openShortcut = isMacOS() ? '⌘⇧H' : 'Alt+H';
  const openShortcutLabel = isMacOS() ? 'Cmd + Shift + H' : 'Alt+H';
  const openShortcutDesc = isMacOS()
    ? 'Opens the full Henry window from anywhere on your Mac.'
    : 'Opens the full Henry window from anywhere on your computer.';
  const dockShortcutDesc = isMacOS()
    ? "Henry lives in your Mac's dock. Click anytime to open the full app."
    : "Henry lives in your app launcher. Click anytime to open the full app.";

  function openUrl(url: string) {
    const api = getApi();
    try { if (typeof api?.computerRunShell === 'function') { api.computerRunShell({ command: `open "${url}"`, timeout: 3000 }); return; } } catch { /* */ }
    try { window.open(url, '_blank'); } catch { /* */ }
  }

  async function copyToClipboard(text: string) {
    try { await navigator.clipboard.writeText(text); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000); } catch { /* */ }
  }

  // ── Shared styles ─────────────────────────────────────────────────────────
  const primary = 'w-full py-3.5 rounded-xl bg-henry-accent text-white font-bold text-sm hover:bg-henry-accent/85 transition-all disabled:opacity-40 disabled:cursor-not-allowed';
  const secondary = 'w-full py-3 rounded-xl border border-white/15 text-white/70 font-medium text-sm hover:border-white/30 hover:text-white transition-all';
  const ghost = 'text-white/35 text-xs hover:text-white/60 transition-all';
  const step3 = (n: number, t: string, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-henry-accent/20 border border-henry-accent/40 text-henry-accent flex items-center justify-center text-[11px] font-bold mt-0.5">{n}</span>
      <div className="text-sm text-white/80 leading-relaxed"><b className="text-white">{t}</b> {body}</div>
    </li>
  );

  // ── Panels tour data ──────────────────────────────────────────────────────
  const PANELS = [
    { icon: '💬', name: 'Chat',      desc: 'Talk to Henry. Ask anything — he knows your tasks, reminders, habits, calendar, and memory. Every message is private on your Mac.' },
    { icon: '☀️', name: 'Today',     desc: 'Your daily launchpad. Habits to check in, your schedule, Henry\'s word of the day, a one-tap daily plan, and an end-of-day summary.' },
    { icon: '✓',  name: 'Tasks',     desc: 'Full task list with AI triage. Henry can add, complete, and prioritize your tasks from chat. Also available on your phone.' },
    { icon: '⏰', name: 'Reminders', desc: 'Time-based reminders with snooze. Henry shows a red badge on the sidebar when anything is due. Add from phone too.' },
    { icon: '◎',  name: 'Goals',     desc: 'Long-term goals with AI coaching. Set a target date — Henry nags you with an orange badge when it\'s overdue.' },
    { icon: '📔', name: 'Journal',   desc: 'Daily journal with mood tracker, AI reflection prompts, and a streak counter. Saved to your local SQLite — fully private.' },
    { icon: '❤️', name: 'Health',    desc: 'Log water, steps, sleep, exercise, and calories. Quick-tap buttons on your phone too. Charts show trends over time.' },
    { icon: '💰', name: 'Finance',   desc: 'Income, expenses, budgets. Import bank CSV. Henry spots patterns and alerts when you overspend a category.' },
    { icon: '🗓️', name: 'Weekly',    desc: 'Weekly review wizard — what got done, what didn\'t, what needs to move. Takes 5 minutes, keeps you honest.' },
    { icon: '📄', name: 'Quoting',   desc: 'Create quotes and invoices for clients. Line items, totals, client management, and PDF export.' },
    { icon: '🎙', name: 'Recorder',  desc: 'Voice memos with transcription. Transcripts are saved and searchable.' },
    { icon: '🖨', name: 'Print Studio', desc: 'For makers: generate print-ready files, manage print queues and jobs.' },
    { icon: '🏭', name: 'Maker Studio', desc: 'Machines, materials, production runs, waste tracking, maintenance logs. For small manufacturing.' },
    { icon: '🖼', name: 'Image Gen', desc: 'Generate images via DALL-E or other providers. Describe what you want.' },
    { icon: '🎬', name: 'Video Gen', desc: 'Generate short video clips via Runway. Great for social content.' },
    { icon: '🧠', name: 'Memory',    desc: 'See and edit everything Henry remembers about you. Facts are injected into every conversation so Henry always has context.' },
    { icon: '🌐', name: 'HQ',        desc: 'Command center: active automations, recent captures, ambient brain status.' },
    { icon: '⚙️', name: 'Settings',  desc: 'AI providers, accent colors, smart coder routing, Cerebras fallback, backup/export, license key.' },
  ];


  return (
    <div className="fixed inset-0 z-[200] bg-henry-bg flex flex-col items-center justify-center p-6 overflow-y-auto">
      {/* Progress dots */}
      <div className="flex gap-1.5 mb-8">
        {STEP_ORDER.slice(0, visibleStepCount).map((_s, i) => (
          <div key={i} className={'h-1 rounded-full transition-all ' +
            (i < stepIdx ? 'w-8 bg-henry-accent' : i === stepIdx ? 'w-10 bg-white' : 'w-4 bg-white/20')} />
        ))}
      </div>

      <div className="w-full max-w-md space-y-0">

        {/* ════════════════ WELCOME ════════════════ */}
        {step === 'welcome' && (
          <div className="space-y-6 text-center">
            <div>
              <p className="text-6xl mb-4">◉</p>
              <h1 className="text-3xl font-black text-white tracking-tight">Welcome to Henry</h1>
              <p className="text-white/55 text-sm mt-2 leading-relaxed max-w-xs mx-auto">
                Your personal AI — runs entirely on your {isMacOS() ? 'Mac' : isLinux() ? 'Linux' : 'computer'}, works on your phone, almost free.
              </p>
            </div>

            {/* Cost model — this is the #1 question */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 text-left space-y-3">
              <p className="text-[10px] uppercase tracking-widest text-white/40">What does it cost?</p>
              <div className="space-y-2.5">
                <div className="flex items-start gap-3">
                  <span className="text-green-400 text-base flex-shrink-0">✓</span>
                  <div>
                    <p className="text-white text-sm font-semibold">50 free AI requests per day</p>
                    <p className="text-white/50 text-xs leading-snug">Included. No card required. Resets at midnight. Enough for light daily use.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-henry-accent text-base flex-shrink-0">⚡</span>
                  <div>
                    <p className="text-white text-sm font-semibold">Unlimited with a free Groq key</p>
                    <p className="text-white/50 text-xs leading-snug">Groq is free to sign up. Paste your key and Henry uses their servers — no monthly cost.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-white/30 text-base flex-shrink-0">∞</span>
                  <div>
                    <p className="text-white/60 text-sm font-semibold">Some things never cost a request</p>
                    <p className="text-white/40 text-xs leading-snug">Checking habits, viewing tasks, journal entries, health logs — all free.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-left">
              {([
                ['⌨️', 'Permissions', isMacOS() ? '2 Mac settings — takes 60 sec' : isLinux() ? 'Linux capabilities — auto-checked' : 'System settings — auto-checked'],
                ['⚡', 'Free AI key', 'Groq — unlimited, no card'],
                ['📱', 'Phone app', 'Install as an app from Safari'],
                ['🧠', 'Memory', 'Teach Henry about yourself'],
              ] as [string,string,string][]).map(([icon, t, d]) => (
                <div key={t} className="bg-white/5 border border-white/8 rounded-xl p-3">
                  <p className="text-xl mb-1">{icon}</p>
                  <p className="text-white text-xs font-semibold">{t}</p>
                  <p className="text-white/40 text-[10px] mt-0.5 leading-snug">{d}</p>
                </div>
              ))}
            </div>

            <button onClick={next} className={primary}>Let's set Henry up →</button>
            <button onClick={finish} className={ghost + ' block w-full text-center mt-2'}>Skip — I'll figure it out myself</button>
          </div>
        )}


        {/* ════════════════ HOW IT WORKS ════════════════ */}
        {step === 'howItWorks' && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">⌨️</p>
              <h2 className="text-2xl font-bold text-white">How to use Henry</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">Three ways to open him. Use whichever feels natural.</p>
            </div>

            <div className="space-y-3">
              {([
                { key: captureShortcut, label: captureShortcutLabel, desc: captureShortcutDesc },
                { key: openShortcut, label: openShortcutLabel, desc: openShortcutDesc },
                { key: '🖱', label: 'Click the app icon', desc: dockShortcutDesc },
              ] as { key: string; label: string; desc: string }[]).map(item => (
                <div key={item.key} className="bg-white/5 border border-white/10 rounded-xl p-4 flex gap-4 items-start">
                  <div className="bg-henry-accent/20 border border-henry-accent/40 rounded-lg px-2.5 py-1.5 text-henry-accent font-mono font-bold text-sm flex-shrink-0 min-w-[52px] text-center">{item.key}</div>
                  <div>
                    <p className="text-white text-sm font-semibold">{item.label}</p>
                    <p className="text-white/50 text-xs mt-0.5 leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Capture shortcut demo */}
            <div className="bg-henry-accent/8 border border-henry-accent/20 rounded-xl p-4 space-y-2">
              <p className="text-henry-accent text-xs font-bold uppercase tracking-wider">{captureShortcutLabel} tip — try this right now</p>
              <p className="text-white/70 text-sm leading-relaxed">
                Find any text on your screen — an email, a website, anything. <b className="text-white">Select it</b>, then press <b className="text-white">{captureShortcutLabel}</b>. Henry opens with that text already loaded. Ask him to summarize, reply, explain, or act on it.
              </p>
            </div>

            {/* Sidebar overview */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2">
              <p className="text-white/40 text-[10px] uppercase tracking-wider">The sidebar</p>
              <p className="text-white/70 text-sm leading-relaxed">
                The left sidebar has 20+ panels — Chat, Today, Tasks, Reminders, Goals, Journal, Health, Finance, Memory, and more. We'll tour them in a couple of steps.
              </p>
            </div>

            <button onClick={next} className={primary}>Got it — continue →</button>
          </div>
        )}


        {/* ════════════════ ACCESSIBILITY ════════════════ */}
        {step === 'accessibility' && isMacOS() && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">🔐</p>
              <h2 className="text-2xl font-bold text-white">Accessibility access</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">
                Required for ⌥Space capture and letting Henry control your Mac when you ask.
              </p>
            </div>

            {acc === true ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 text-center space-y-3">
                <p className="text-4xl">✓</p>
                <p className="text-green-400 font-semibold text-lg">Accessibility enabled</p>
                <p className="text-white/50 text-xs">Detected. Moving on automatically…</p>
                <AutoAdvance onAdvance={next} />
              </div>
            ) : (
              <>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-4">
                  <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Step by step</p>
                  <ol className="space-y-4">
                    {step3(1, 'Click "Open Settings" below.',
                      <>A Finder window opens showing Henry AI in your Applications folder, and System Settings opens to the Accessibility list.</>)}
                    {step3(2, 'Click the + button',
                      <>at the bottom of the Accessibility list. A file picker opens.</>)}
                    {step3(3, 'Select Henry AI',
                      <>from the /Applications folder that\'s already open in Finder. Click Open.</>)}
                    {step3(4, 'Toggle Henry AI ON.',
                      <>Enter your Mac password if prompted. <span className="text-henry-accent">This wizard detects it automatically</span> — you won\'t need to click anything.</>)}
                  </ol>
                </div>

                <button onClick={openAccessibilitySettings} className={primary}>
                  Open Settings + show Henry in Finder →
                </button>

                <div className="flex items-center justify-center gap-2 text-xs text-white/40 py-1">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
                  <span>Watching for the permission… auto-advances when detected</span>
                </div>

                <div className="bg-white/3 border border-white/8 rounded-xl p-3">
                  <p className="text-white/40 text-[11px] leading-relaxed">
                    <b className="text-white/60">Already granted but nothing happened?</b> macOS sometimes lies to apps that aren't notarized. Try the button below.
                  </p>
                </div>

                <button onClick={next} className={secondary}>I enabled it — move on →</button>
                <button onClick={next} className={ghost + ' block w-full text-center'}>Skip for now</button>
              </>
            )}
          </div>
        )}


        {/* ════════════════ SCREEN RECORDING ════════════════ */}
        {step === 'screen' && isMacOS() && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">📸</p>
              <h2 className="text-2xl font-bold text-white">Screen Recording</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">
                Lets Henry see your screen when you say "look at this" or "take a screenshot."
                He never records without you asking.
              </p>
            </div>

            {scr === true ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 text-center space-y-3">
                <p className="text-4xl">✓</p>
                <p className="text-green-400 font-semibold text-lg">Screen Recording enabled</p>
                <p className="text-white/50 text-xs">Detected. Moving on automatically…</p>
                <AutoAdvance onAdvance={next} />
              </div>
            ) : (
              <>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-4">
                  <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Same process — different list</p>
                  <ol className="space-y-4">
                    {step3(1, 'Click "Open Settings" below.',
                      <>The Screen & System Audio Recording pane opens in System Settings.</>)}
                    {step3(2, 'Click + → select Henry AI',
                      <>from /Applications → click Open.</>)}
                    {step3(3, 'Toggle ON.',
                      <><span className="text-henry-accent">Auto-advances</span> when Henry detects the permission.</>)}
                  </ol>
                </div>

                <button onClick={openScreenRecordingSettings} className={primary}>
                  Open Screen Recording Settings →
                </button>

                <div className="flex items-center justify-center gap-2 text-xs text-white/40 py-1">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
                  <span>Watching… auto-advances when detected</span>
                </div>

                <button onClick={next} className={secondary}>I enabled it — move on →</button>
                <button onClick={next} className={ghost + ' block w-full text-center'}>Skip for now</button>
              </>
            )}
          </div>
        )}


        {/* ════════════════ AI PROVIDER ════════════════ */}
        {step === 'ai' && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">⚡</p>
              <h2 className="text-2xl font-bold text-white">Get unlimited AI — free</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">
                Henry comes with 50 free requests/day. Add a Groq key for unlimited — takes 90 seconds and Groq is free to sign up.
              </p>
            </div>

            {hasAi ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 text-center space-y-3">
                <p className="text-4xl">✓</p>
                <p className="text-green-400 font-semibold text-lg">Groq key saved</p>
                <p className="text-white/50 text-xs">Unlimited AI responses. Qwen Coder activates automatically for code questions.</p>
                <button onClick={next} className={primary}>Continue →</button>
              </div>
            ) : (
              <>
                {/* What counts as a request */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
                  <p className="text-[10px] uppercase tracking-widest text-white/40">What uses a request?</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-red-500/8 border border-red-500/20 rounded-xl p-2.5">
                      <p className="text-red-400 text-[10px] font-bold uppercase tracking-wider mb-1.5">Uses 1 request</p>
                      {['Chat message', 'Daily plan', 'Daily report', 'AI reflection', 'Task triage'].map(i => (
                        <p key={i} className="text-white/60 text-[11px]">• {i}</p>
                      ))}
                    </div>
                    <div className="bg-green-500/8 border border-green-500/20 rounded-xl p-2.5">
                      <p className="text-green-400 text-[10px] font-bold uppercase tracking-wider mb-1.5">Always free</p>
                      {['Habits & tasks', 'Journal entries', 'Health logging', 'Reminders'].map(i => (
                        <p key={i} className="text-white/60 text-[11px]">• {i}</p>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Groq walkthrough */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-4">
                  <p className="text-[10px] uppercase tracking-widest text-white/40">Get your free key</p>
                  <ol className="space-y-3.5">
                    {step3(1, 'Click "Open Groq" below.',
                      <>Sign up for free — just email + password. No card needed ever.</>)}
                    {step3(2, 'Go to API Keys in the left sidebar.',
                      <>Click Create API Key → give it any name → click Submit.</>)}
                    {step3(3, 'Copy the key.',
                      <>It starts with <code className="text-henry-accent bg-henry-accent/10 px-1 rounded">gsk_</code> — copy the whole thing.</>)}
                    {step3(4, 'Paste it below.',
                      <>Henry saves it to your Mac only. It never goes to any Henry server.</>)}
                  </ol>
                  <button onClick={() => openUrl('https://console.groq.com/keys')}
                    className="w-full py-2.5 rounded-xl border border-henry-accent/30 bg-henry-accent/10 text-henry-accent text-xs font-bold hover:bg-henry-accent/20 transition-all">
                    Open console.groq.com/keys ↗
                  </button>
                </div>

                {/* Key input */}
                <div className="space-y-2">
                  <input type="password" value={groqKey}
                    onChange={e => { setGroqKey(e.target.value); if (groqError) setGroqError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter' && groqKey.trim()) void saveGroqKey(); }}
                    placeholder="gsk_…"
                    className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder:text-white/30 outline-none focus:border-henry-accent/60 transition-all font-mono text-sm"
                    autoFocus />
                  {groqError && <p className="text-red-400 text-xs px-1">{groqError}</p>}
                </div>

                <button onClick={() => void saveGroqKey()} disabled={!groqKey.trim() || groqSaving} className={primary}>
                  {groqSaving ? 'Saving…' : 'Save key + continue →'}
                </button>

                {/* Smart coder routing note */}
                <div className="bg-henry-accent/5 border border-henry-accent/15 rounded-xl p-3">
                  <p className="text-white/60 text-[11px] leading-relaxed">
                    <span className="text-henry-accent font-semibold">Smart coder routing:</span> When you ask code questions, Henry automatically switches to Qwen 2.5 Coder 32B — a model specifically trained for programming. You don't do anything differently. Toggle it off in Settings → AI Providers anytime.
                  </p>
                </div>

                <button onClick={next} className={ghost + ' block w-full text-center'}>Skip — add a key later in Settings</button>
              </>
            )}
          </div>
        )}


        {/* ════════════════ COMPANION (iPhone/iPad) ════════════════ */}
        {step === 'companion' && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">📱</p>
              <h2 className="text-2xl font-bold text-white">Henry on your phone</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">
                Henry installs as a real app on your iPhone or iPad — no App Store, no TestFlight.
                Open a URL in Safari and tap Add to Home Screen. Done.
              </p>
            </div>

            {/* Step-by-step install */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-4">
              <p className="text-[10px] uppercase tracking-widest text-white/40">Install on iPhone or iPad</p>
              <ol className="space-y-4">
                {step3(1, 'Make sure your phone is on the same Wi-Fi as this computer.',
                  <>Both need to be on the same network.</>)}
                {step3(2, 'Open Safari on your phone (iOS) or Chrome on Android.',
                  <>On iOS, must be Safari — Chrome and Firefox can't install PWA apps.</>)}
                {lanUrl
                  ? step3(3, 'Type this URL in Safari (iOS) or Chrome (Android):',
                      <div className="mt-1.5 space-y-1.5">
                        <div className="flex items-center gap-2 bg-henry-bg border border-henry-accent/30 rounded-lg px-3 py-2">
                          <code className="text-henry-accent text-sm flex-1 break-all">{lanUrl}</code>
                          <button onClick={() => void copyToClipboard(lanUrl)}
                            className="text-[10px] text-henry-accent hover:underline flex-shrink-0 font-bold">
                          {copiedUrl ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                        <p className="text-white/40 text-[10px]">Or scan the QR code below — same URL.</p>
                      </div>)
                  : step3(3, 'Wait — generating your URL…', <span className="text-white/40">This takes a second.</span>)}
                {step3(4, 'Tap the Share button (□↑) at the bottom of the browser.',
                  <>It looks like a box with an arrow pointing up.</>)}
                {step3(5, 'Scroll down and tap "Add to Home Screen".',
                  <>Then tap Add in the top-right corner. Henry AI appears on your home screen.</>)}
                {step3(6, 'Open Henry AI from your home screen.',
                  <>It launches full-screen with no browser bar — like a native app.</>)}
              </ol>
            </div>

            {/* QR code */}
            {pairCode && (
              <div className="bg-white rounded-2xl p-4 flex flex-col items-center gap-2">
                <p className="text-black/60 text-xs font-medium">Scan with phone camera</p>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=8&data=${encodeURIComponent(pairCode)}`}
                  alt="QR code" width={200} height={200} className="rounded-lg" />
                <p className="text-black/40 text-[10px]">
                  Expires in {Math.floor(pairCountdown / 60)}:{String(pairCountdown % 60).padStart(2, '0')}
                </p>
              </div>
            )}
            {generating && !pairCode && (
              <div className="bg-white/5 border border-white/10 rounded-2xl h-24 flex items-center justify-center text-white/40 text-sm">
                Generating QR…
              </div>
            )}

            {/* PWA install tip for Android */}
            <div className="bg-white/3 border border-white/8 rounded-xl p-3">
              <p className="text-white/40 text-[11px] leading-relaxed">
                <b className="text-white/60">Android?</b> Open the URL in Chrome. Tap the ⋮ menu → "Add to Home Screen" or wait for the install banner to appear at the bottom of the screen.
              </p>
            </div>

            {linkedDevices.length > 0 && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 flex items-center gap-3">
                <span className="text-2xl">✓</span>
                <div>
                  <p className="text-green-400 font-semibold text-sm">{linkedDevices.length} device{linkedDevices.length > 1 ? 's' : ''} connected</p>
                  <p className="text-white/50 text-xs">{linkedDevices.map(d => d.name || 'Phone').join(', ')}</p>
                </div>
              </div>
            )}

            <div className="flex items-center justify-center gap-2 text-xs text-white/35 py-1">
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
              <span>Watching for connection… auto-advances when phone pairs</span>
            </div>

            <button onClick={next} className={secondary}>Done — or I'll pair my phone later →</button>
          </div>
        )}


        {/* ════════════════ PANELS TOUR ════════════════ */}
        {step === 'panels' && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">🗂</p>
              <h2 className="text-2xl font-bold text-white">Everything in the sidebar</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">
                Henry has {PANELS.length} panels. Here's what each one does. Swipe or tap the arrows.
              </p>
            </div>

            {/* Swipeable panel cards */}
            <div className="relative">
              <div className="bg-white/5 border border-white/10 rounded-2xl p-5 min-h-[140px] flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">{PANELS[panelIdx].icon}</span>
                    <div>
                      <p className="text-white font-bold text-base">{PANELS[panelIdx].name}</p>
                      <p className="text-white/40 text-[10px]">{panelIdx + 1} of {PANELS.length}</p>
                    </div>
                  </div>
                  <p className="text-white/70 text-sm leading-relaxed">{PANELS[panelIdx].desc}</p>
                </div>
              </div>

              {/* Navigation */}
              <div className="flex items-center justify-between mt-3 px-1">
                <button onClick={() => setPanelIdx(i => Math.max(0, i - 1))}
                  disabled={panelIdx === 0}
                  className="w-9 h-9 rounded-full border border-white/15 text-white/60 hover:border-white/30 hover:text-white disabled:opacity-20 transition-all text-sm">
                  ←
                </button>

                {/* Dot indicators — show 5 at a time */}
                <div className="flex gap-1 items-center">
                  {PANELS.map((_, i) => (
                    <button key={i} onClick={() => setPanelIdx(i)}
                      className={'rounded-full transition-all ' +
                        (i === panelIdx ? 'w-4 h-2 bg-henry-accent' : 'w-2 h-2 bg-white/20 hover:bg-white/40')} />
                  ))}
                </div>

                <button onClick={() => setPanelIdx(i => Math.min(PANELS.length - 1, i + 1))}
                  disabled={panelIdx === PANELS.length - 1}
                  className="w-9 h-9 rounded-full border border-white/15 text-white/60 hover:border-white/30 hover:text-white disabled:opacity-20 transition-all text-sm">
                  →
                </button>
              </div>
            </div>

            {/* Quick grid of all icons for at-a-glance */}
            <div className="bg-white/3 border border-white/8 rounded-xl p-3">
              <p className="text-white/30 text-[10px] uppercase tracking-wider mb-2">All panels at a glance</p>
              <div className="flex flex-wrap gap-2">
                {PANELS.map((p, i) => (
                  <button key={p.name} onClick={() => setPanelIdx(i)}
                    title={p.name}
                    className={'text-lg transition-all ' + (i === panelIdx ? 'scale-125' : 'opacity-50 hover:opacity-100')}>
                    {p.icon}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={next} className={primary}>Got it — continue →</button>
            <button onClick={next} className={ghost + ' block w-full text-center'}>Skip tour</button>
          </div>
        )}


        {/* ════════════════ MEMORY ════════════════ */}
        {step === 'memory' && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-5xl mb-3">🧠</p>
              <h2 className="text-2xl font-bold text-white">Teach Henry about you</h2>
              <p className="text-white/55 text-sm mt-2 leading-relaxed">
                Henry's memory makes him genuinely useful instead of generic. The more he knows, the better every response gets.
              </p>
            </div>

            <div className="space-y-3">
              {/* Quick personal info capture */}
              <div className="bg-henry-accent/10 border border-henry-accent/25 rounded-2xl p-4 space-y-3">
                <p className="text-[10px] uppercase tracking-widest text-henry-accent/80">Tell Henry about yourself right now</p>
                {[
                  { label: 'Your name', placeholder: 'Topher', value: memName, set: setMemName },
                  { label: 'What you do', placeholder: 'Laser cutting business owner', value: memJob, set: setMemJob },
                  { label: 'Biggest goal right now', placeholder: 'Grow sales by 30% this year', value: memGoal, set: setMemGoal },
                ].map(({ label, placeholder, value, set }) => (
                  <div key={label}>
                    <label className="text-[10px] text-white/50 uppercase tracking-wider block mb-1">{label}</label>
                    <input
                      value={value}
                      onChange={e => set(e.target.value)}
                      placeholder={placeholder}
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-henry-accent/50 transition-all"
                    />
                  </div>
                ))}
                <p className="text-[10px] text-white/35 leading-relaxed">These save to Henry's memory now. You can add more anytime — say "remember that..." in chat or open the 🧠 Memory panel.</p>
              </div>

              {/* How memory works */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
                <p className="text-[10px] uppercase tracking-widest text-white/40">How it works</p>
                <p className="text-white/70 text-sm leading-relaxed">
                  Facts you save go into the <b className="text-white">Memory panel</b> (🧠 in the sidebar). Henry injects the most relevant ones into every conversation — so he always has context without you repeating yourself.
                </p>
              </div>

              {/* 3 ways to add memories */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-4">
                <p className="text-[10px] uppercase tracking-widest text-white/40">3 ways to save a memory</p>
                <ol className="space-y-4">
                  {step3(1, 'Pin any AI response.',
                    <>Every response has a 📌 button. Tap it to save what Henry said directly to memory.</>)}
                  {step3(2, 'Tell Henry in chat.',
                    <><i className="text-white/60">"Remember that I work at night and prefer direct answers"</i> — Henry will save it.</>)}
                  {step3(3, 'Open the Memory panel',
                    <>and add facts directly. You can also edit or delete anything Henry remembers.</>)}
                </ol>
              </div>

              {/* Examples */}
              <div className="bg-henry-accent/8 border border-henry-accent/20 rounded-xl p-4 space-y-2">
                <p className="text-henry-accent text-[10px] uppercase tracking-wider font-bold">Good things to tell Henry</p>
                {[
                  '"I\'m a freelance designer. My main client is Acme Corp."',
                  '"I work from 10am to midnight. I\'m a night owl."',
                  '"My wife\'s name is Sarah. We have two kids, ages 5 and 8."',
                  '"I use React and TypeScript. I prefer functional components."',
                  '"I\'m trying to hit 10,000 steps a day and cut sugar."',
                ].map(e => (
                  <p key={e} className="text-white/60 text-xs">{e}</p>
                ))}
              </div>

              {/* Backup reminder */}
              <div className="bg-white/3 border border-white/8 rounded-xl p-3">
                <p className="text-white/50 text-[11px] leading-relaxed">
                  <b className="text-white/70">Back up your data:</b> All of Henry's data — memories, tasks, journal, health, finance — lives in a SQLite database on your {isMacOS() ? 'Mac' : 'computer'}. Go to <b className="text-white/70">Settings → General → Export Backup</b> to save a zip to your Desktop anytime.
                </p>
              </div>
            </div>

            <button onClick={next} className={primary}>All set — let's go →</button>
          </div>
        )}


        {/* ════════════════ DONE ════════════════ */}
        {step === 'done' && (
          <div className="space-y-5">
            <div className="text-center">
              <p className="text-6xl mb-3">✓</p>
              <h2 className="text-3xl font-black text-white">Henry is ready</h2>
              <p className="text-white/55 text-sm mt-2">Here's your setup summary and first steps.</p>
            </div>

            {/* Status summary — platform-aware labels */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-2">
              {([
                ['🔐', isMacOS() ? 'Accessibility' : 'Computer Control', isMacOS() ? acc === true : true],
                ['📸', isMacOS() ? 'Screen Recording' : 'Screen Capture', isMacOS() ? scr === true : true],
                ['⚡', 'Groq AI key (unlimited)', hasAi],
                ['📱', 'Phone companion paired', linkedDevices.length > 0],
              ] as [string, string, boolean][]).map(([icon, label, ok]) => (
                <div key={label} className="flex items-center justify-between text-sm py-0.5">
                  <div className="flex items-center gap-2">
                    <span>{icon}</span>
                    <span className="text-white/70">{label}</span>
                  </div>
                  <span className={ok ? 'text-green-400 font-semibold text-xs' : 'text-white/30 text-xs'}>
                    {ok ? '✓ Ready' : '— Skipped'}
                  </span>
                </div>
              ))}
            </div>

            {/* First steps guide */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
              <p className="text-[10px] uppercase tracking-widest text-white/40">Try these first</p>
              <div className="space-y-2.5">
                {([
                  ['💬', '"What should I focus on today?"', 'Ask Henry for a daily plan'],
                  [isMacOS() ? '⌥⎵' : 'Alt+C', 'Select text → press ' + (isMacOS() ? '⌥Space' : 'Alt+C'), 'Capture anything — emails, articles, notes'],
                  ['📔', 'Open the Journal panel', 'Write your first entry. Try the AI reflection button'],
                  ['🧠', '"Remember I prefer concise answers"', 'Teach Henry something about you'],
                  ['📱', 'Open the companion on your phone', 'Tap Tasks, add something, see it on your computer'],
                  ['⚙️', 'Settings → AI Providers', 'Add Cerebras for a rate-limit fallback (free)'],
                ] as [string, string, string][]).map(([icon, action, note]) => (
                  <div key={action} className="flex items-start gap-3">
                    <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
                    <div>
                      <p className="text-white text-sm font-medium leading-snug">{action}</p>
                      <p className="text-white/40 text-[11px] mt-0.5">{note}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Skipped-step reminders — platform-aware */}
            {(!acc || !scr || !hasAi || linkedDevices.length === 0) && (
              <div className="bg-yellow-500/8 border border-yellow-500/20 rounded-xl p-3 space-y-1">
                <p className="text-yellow-400 text-[10px] uppercase tracking-wider font-bold">Complete these anytime</p>
                {isMacOS() && !acc && <p className="text-white/60 text-xs">• Accessibility — Settings → Privacy → Accessibility → add Henry AI</p>}
                {isMacOS() && !scr && <p className="text-white/60 text-xs">• Screen Recording — Settings → Privacy → Screen & System Audio Recording</p>}
                {!isMacOS() && <p className="text-white/60 text-xs">• Computer Control — install xdotool/wmctrl (keyboard/mouse) and xclip (clipboard)</p>}
                {!hasAi && <p className="text-white/60 text-xs">• Groq key — console.groq.com/keys → Henry Settings → AI Providers</p>}
                {linkedDevices.length === 0 && <p className="text-white/60 text-xs">• Phone app — open the companion URL from Settings → Companion in your browser</p>}
              </div>
            )}

            <button onClick={finish} className={primary}>Open Henry →</button>
            <button onClick={() => setStep('welcome')} className={ghost + ' block w-full text-center'}>← Restart wizard</button>
          </div>
        )}

      </div>{/* end max-w-md */}

      {/* Back link */}
      {stepIdx > 0 && step !== 'done' && (
        <button onClick={back} className="text-white/25 text-xs hover:text-white/50 transition-all mt-6">← Back</button>
      )}
    </div>
  );
}
