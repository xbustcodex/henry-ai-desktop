import React, { useEffect, useState, useRef } from 'react';
import { useStore } from '../../store';
import { getDailyCost } from '../../henry/gateway';
import { getTodayBriefing, getTodayKey, saveBriefing, setGenerating, isGenerating, buildBriefingPrompt, buildLiveContext } from '../../henry/proactiveBriefing';
import type { DailyBriefing } from '../../henry/proactiveBriefing';
import { getDailyIntention, setDailyIntention, clearDailyIntention } from '../../henry/dailyIntention';
import { PANEL_QUICK_ASK } from '../../henry/henryQuickAsk';
import { isMacOS, isLinux, isWindows } from '../../utils/platform';

const HENRY_LAST_GREETING_KEY = 'henry:last_greeting_date';
const HENRY_OPERATING_MODE_KEY = 'henry_operating_mode';

function getGreeting(): { line1: string; line2: string } {
  const h = new Date().getHours();
  const name = localStorage.getItem('henry:owner_name')?.trim() || '';
  const n = name ? `, ${name}` : '';
  if (h < 12) return { line1: `Good morning${n}.`, line2: "Let's see what today looks like." };
  if (h < 17) return { line1: `Good afternoon${n}.`, line2: "How's the day going?" };
  return { line1: `Good evening${n}.`, line2: "Wrapping things up?" };
}

export default function TodayPanel() {
  const { setCurrentView } = useStore();
  const [quickAsk, setQuickAsk] = useState('');
  const [capture, setCapture] = useState('');
  const [quickTask, setQuickTask] = useState('');
  const [henryFocusQ, setHenryFocusQ] = useState('');
  const [henryFocusBusy, setHenryFocusBusy] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [todayHabits, setTodayHabits] = useState<{habit: any; done: boolean}[]>([]);
  const [henryStatus, setHenryStatus] = useState<'checking'|'ready'|'needs-key'|'ollama'|'proxy'>('checking');

  // Check Henry's AI readiness (run once on mount only)
  React.useEffect(() => {
    const api = (window as any).henryAPI;
    if (!api) { setHenryStatus('needs-key'); return; }
    Promise.all([
      api.getProviders().catch(() => []),
      api.getSettings().catch(() => ({})),
    ]).then(([providers, settings]: any[]) => {
      const hasGroqKey = (providers || []).some((p: any) =>
        p.id === 'groq' && (p.api_key || p.apiKey || '').length > 10
      );
      const isOllama = settings?.companion_provider === 'ollama';
      setHenryStatus(isOllama ? 'ollama' : hasGroqKey ? 'ready' : 'needs-key');
    }).catch(() => setHenryStatus('needs-key'));
  }, []); // ← [] = run once on mount, not on every render
  const [captureRoute, setCaptureRoute] = useState<'task'|'reminder'|'journal'|'auto'>('auto');
  const [captureSaving, setCaptureSaving] = useState(false);
  const [intention, setIntentionState] = useState(() => getDailyIntention()?.text ?? '');
  const [intentionDraft, setIntentionDraft] = useState(() => getDailyIntention()?.text ?? '');
  const [briefing, setBriefing] = useState<DailyBriefing | null>(() => getTodayBriefing());
  const [generatingBriefing, setGeneratingBriefing] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportText, setReportText] = useState('');
  const [verseOfDay, setVerseOfDay] = useState<{ref: string; text: string} | null>(null);
  const [nudge, setNudge] = useState<string | null>(null);
  const [henryWord, setHenryWord] = useState<string | null>(null);
  const [plannerResult, setPlannerResult] = useState('');

  // Cache helpers - saves AI quota (generate once per day, serve all day)
  const cacheKey = (key: string) => 'henry:cache:' + key + ':' + new Date().toISOString().slice(0,10);
  const getCached = (key: string): string | null => {
    try { return localStorage.getItem(cacheKey(key)); } catch { return null; }
  };
  const setCached = (key: string, val: string) => {
    try { localStorage.setItem(cacheKey(key), val); } catch { /* ignore */ }
  };
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [briefingExpanded, setBriefingExpanded] = useState(true);
  const [dailyCost] = useState(() => getDailyCost());
  const [liveData, setLiveData] = useState<{
    dueTasks: number; dueReminders: number; focusToday: number;
    income: number; expenses: number;
  }>({ dueTasks: 0, dueReminders: 0, focusToday: 0, income: 0, expenses: 0 });

  async function handleCapture(e: React.FormEvent) {
    e.preventDefault();
    const text = capture.trim();
    if (!text) return;
    setCaptureSaving(true);
    const api = (window as any).henryAPI;
    const lower = text.toLowerCase();

    // Auto-detect route if 'auto'
    let route = captureRoute;
    if (route === 'auto') {
      if (/remind|at \\d|tomorrow|tonight|pm|am|by |due/.test(lower)) route = 'reminder';
      else if (/feel|today was|morning|evening|grateful|prayer/.test(lower)) route = 'journal';
      else route = 'task';
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      if (route === 'task') {
        await api.tasksCreate?.({ id, title: text, status: 'todo', priority: 2, created_at: now });
      } else if (route === 'reminder') {
        // Default due tomorrow at 9am
        const due = new Date(); due.setDate(due.getDate()+1); due.setHours(9,0,0,0);
        await api.remindersSave?.({ id, title: text, dueAt: due.toISOString(), done: false, repeat: 'none' });
      } else {
        await api.journalSave?.({ id, date: now.slice(0,10), content: text });
      }
      // Log the capture
      await api.captureSave?.({ id, text, routedTo: route });
      setCapture('');
      // R3-Fix 2: refresh the daily enrichments. The blocks of code below
      // used to live inline here — which meant habits/verse/nudge/word
      // only loaded if the user submitted a capture first, and the panel
      // showed an "Add habits" placeholder on first visit. Extracted into
      // a single function called from both here and a mount useEffect.
      loadDailyEnrichments();
    void api.tasksList?.({ status: 'todo' }).then((t: any[]) => setLiveData(d => ({...d, dueTasks: (t||[]).length}))).catch(() => {});
    } catch { /* non-critical */ }
    setCaptureSaving(false);
  }

  // R3-Fix 2: daily enrichments — habits / verse / nudge / henry-word /
  // calendar. Previously buried inside the handleCapture submit handler,
  // which meant they NEVER loaded for users who didn't capture anything.
  function loadDailyEnrichments() {
    const api3 = (window as any).henryAPI;
    if (api3?.healthHabitList) {
      const today2 = new Date().toISOString().slice(0, 10);
      Promise.all([
        api3.healthHabitList().catch(() => []),
        api3.healthHabitLogsForDate?.(today2).catch(() => []),
      ]).then(([habits2, logs2]: any[]) => {
        setTodayHabits((habits2 || []).map((h: any) => ({
          habit: h,
          done: (logs2 || []).some((l: any) => l.habit_id === h.id && l.count >= h.target_per_day),
        })));
      }).catch(() => {});
    }

    // Verse of the day from local KJV DB
    const api4 = (window as any).henryAPI;
    if (api4?.scriptureSearch) {
      const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
      const classicVerses = ['John 3:16','Psalm 23:1','Romans 8:28','Proverbs 3:5','Jeremiah 29:11',
        'Philippians 4:13','Isaiah 40:31','Joshua 1:9','Matthew 6:33','Psalm 46:1'];
      const todayVerse = classicVerses[dayOfYear % classicVerses.length];
      api4.scriptureLookup?.(todayVerse).then((r: any) => {
        if (r?.text) setVerseOfDay({ ref: r.normalizedReference || todayVerse, text: r.text });
      }).catch(() => {});
    }

    // Proactive nudge — check for streaks and suggestions
    const api5 = (window as any).henryAPI;
    if (api5?.journalList && api5?.healthHabitList) {
      Promise.all([
        api5.journalList?.().catch(() => []),
        api5.healthHabitList?.().catch(() => []),
      ]).then(([jEntries]: any[]) => {
        const today5 = new Date().toISOString().slice(0,10);
        const yesterday5 = new Date(Date.now() - 86400000).toISOString().slice(0,10);
        const hasJournalToday = (jEntries||[]).some((e:any) => e.date === today5);
        const hasJournalYesterday = (jEntries||[]).some((e:any) => e.date === yesterday5);
        const hour5 = new Date().getHours();
        if (!hasJournalToday && !hasJournalYesterday && (jEntries||[]).length > 5 && hour5 >= 18) {
          setNudge("You haven't journaled in a few days. Even 2-3 sentences helps. ✍");
        }
      }).catch(() => {});
    }

    // Henry's word for today — generate once, cache all day
    const cachedWord = getCached('henry-word');
    if (cachedWord) {
      setHenryWord(cachedWord);
    } else {
      const ownerName = localStorage.getItem('henry:owner_name') || 'friend';
      const hour5 = new Date().getHours();
      const greeting = hour5 < 12 ? 'morning' : hour5 < 17 ? 'afternoon' : 'evening';
      const prompt = `Give ${ownerName} one short, genuine, encouraging word or thought for this ${greeting}. 1-2 sentences. No fluff — make it specific, real, worth reading. Can be practical wisdom, a challenge, or quiet encouragement.`;
      const deviceId5 = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
      fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId5 },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 80, stream: false }),
      }).then(r => r.json()).then((d: any) => {
        const word = d?.choices?.[0]?.message?.content?.trim() || '';
        if (word) { setHenryWord(word); setCached('henry-word', word); }
      }).catch(() => {});
    }

  }

  // R3-Fix 2: run the daily enrichments on mount as well, not only after
  // a capture submit. This was the panel's biggest first-impression bug.
  useEffect(() => {
    loadDailyEnrichments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull live data from SQLite (useEffect not useState — never call APIs in render)
  useEffect(() => {
    const api = (window as any).henryAPI;
    if (!api) return;
    Promise.all([
      api.tasksList?.({ status: 'todo' }).catch(() => []),
      api.remindersDue?.().catch(() => []),
      api.focusStats?.().catch(() => ({ todayMins: 0 })),
      api.financeSummary?.(new Date().toISOString().slice(0,7)).catch(() => ({ income: 0, expenses: 0 })),
    ]).then(([tasks, reminders, focus, finance]: any[]) => {
      setLiveData({
        dueTasks: (tasks || []).length,
        dueReminders: (reminders || []).length,
        focusToday: focus?.todayMins || 0,
        income: finance?.income || 0,
        expenses: finance?.expenses || 0,
      });
    }).catch(() => {});
  }, []); // run once on mount
  const [henryReply, setHenryReply] = useState('');
  const [henryStreaming, setHenryStreaming] = useState(false);
  const [lastQuestion, setLastQuestion] = useState('');
  const quickAskRef = useRef<HTMLInputElement>(null);
  const briefingStreamRef = useRef<any>(null);
  const replyStreamRef = useRef<any>(null);
  const greeting = getGreeting();

  useEffect(() => {
    const last = localStorage.getItem(HENRY_LAST_GREETING_KEY);
    const today = getTodayKey();
    if (last !== today) {
      localStorage.setItem(HENRY_LAST_GREETING_KEY, today);
      if (!isGenerating()) tryGenerateBriefing();
    }
  }, []);

  async function tryGenerateBriefing() {
    if (generatingBriefing || isGenerating()) return;
    const existing = getTodayBriefing();
    if (existing) { setBriefing(existing); return; }
    setGeneratingBriefing(true);
    setGenerating(true);
    try {
      const s = useStore.getState().settings;
      const providers = useStore.getState().providers;
      const provider = s.companion_provider || 'groq';
      const model = s.companion_model || 'llama-3.3-70b-versatile';
      const prov = providers.find((p: any) => p.id === provider);
      const apiKey = prov?.apiKey || (prov as any)?.api_key || '';
      const ownerName = localStorage.getItem('henry:owner_name') || 'there';

      const facts = (() => {
        try {
          const f = JSON.parse(localStorage.getItem('henry:facts') || '[]') as any[];
          return f.slice(0, 15).map((x: any) => x.content || x.fact || '').filter(Boolean).join('; ');
        } catch { return ''; }
      })();
      const liveCtx = await buildLiveContext().catch((e) => { console.warn('[TodayPanel] buildLiveContext failed:', e); return ''; });
      const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

      const prompt = `You are Henry, ${ownerName}'s personal AI. Write a brief morning briefing for ${ownerName} on this ${dayOfWeek}, ${dateStr}.

${liveCtx ? 'Context: ' + liveCtx : ''}
${facts ? 'Known about ' + ownerName + ': ' + facts : ''}

Write 2-4 short sentences covering: one encouraging opening, what to focus on today, and one practical nudge. Be personal, warm, and direct — not generic. End with one line about what matters most today. No headers, no bullets. Just a brief human message.`;

      let full = '';

      // Use cloud proxy if no personal API key
      const useProxy = !apiKey || apiKey.length < 10;

      if (useProxy) {
        const deviceId = (() => {
          let id = localStorage.getItem('henry:device_id');
          if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); }
          return id;
        })();
        const proxyUrl = (import.meta as any).env?.VITE_HENRY_PROXY_URL || 'https://henry-proxy.henryai.workers.dev';
        try {
          const r = await fetch(proxyUrl + '/v1/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 300, stream: false }),
          });
          if (r.ok) {
            const data = await r.json() as any;
            full = data?.choices?.[0]?.message?.content || '';
          }
        } catch { /* proxy unavailable */ }
        if (full) { saveBriefing(full); setBriefing(getTodayBriefing()); }
        setGeneratingBriefing(false);
        setGenerating(false);
        return;
      }

      const stream = window.henryAPI.streamMessage({ provider, model, apiKey, messages: [{ role: 'user', content: prompt }], temperature: 0.7, maxTokens: 300 });
      briefingStreamRef.current = stream;
      stream.onChunk((chunk: string) => { full += chunk; });
      stream.onDone(() => {
        const b = saveBriefing(full);
        setBriefing(b);
        setGeneratingBriefing(false);
        setGenerating(false);
      });
      stream.onError(() => { setGeneratingBriefing(false); setGenerating(false); });
    } catch { setGeneratingBriefing(false); setGenerating(false); }
  }

  async function askFocusNow() {
    if (henryFocusBusy) return;
    setHenryFocusBusy(true);
    setHenryFocusQ('');
    const api2 = (window as any).henryAPI;
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    let ctx = '';
    try {
      const [tasks, rems] = await Promise.all([
        api2.tasksList?.({ status: 'todo' }).catch(() => []),
        api2.remindersDue?.().catch(() => []),
      ]);
      const topTasks = (tasks||[]).slice(0,5).map((t:any)=>`• ${t.title} [${t.priority===3?'HIGH':t.priority===2?'MED':'LOW'}]`).join(', ');
      const dueRems = (rems||[]).slice(0,3).map((r:any)=>r.title).join(', ');
      ctx = [topTasks && `Tasks: ${topTasks}`, dueRems && `Due today: ${dueRems}`].filter(Boolean).join('. ');
    } catch { /* empty */ }
    const prompt = `${ownerName} is asking what to focus on right now (${timeOfDay}). ${ctx || 'No task data available.'} In 1-2 sentences, tell them the single most important thing to work on and why. Be direct and specific.`;
    const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
    try {
      const r = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
        signal: AbortSignal.timeout(25000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 120, stream: false }),
      });
      const d = await r.json() as any;
      setHenryFocusQ(d?.choices?.[0]?.message?.content || '');
    } catch { /* ignore */ }
    setHenryFocusBusy(false);
  }

  async function addQuickTask() {
    const title = quickTask.trim();
    if (!title) return;
    const api2 = (window as any).henryAPI;
    await api2.tasksCreate?.({
      id: crypto.randomUUID(),
      title,
      priority: 2,
      status: 'todo',
    }).catch(() => {});
    setQuickTask('');
    setAddingTask(false);
    // Refresh live data
    api2.tasksList?.({ status: 'todo' }).then((tasks: any[]) =>
      setLiveData(d => ({ ...d, dueTasks: (tasks||[]).length }))
    ).catch(() => {});
  }

  async function generateDailyPlan() {
    if (plannerBusy) return;
    // Check cache first (same plan all day = 1 quota/day not per-click)
    const cached = getCached('daily-plan');
    if (cached) { setPlannerResult(cached); setShowPlanner(true); return; }
    setPlannerBusy(true);
    setPlannerResult('');
    setShowPlanner(true);
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const api2 = (window as any).henryAPI;
    let context = '';
    try {
      const [tasks, rems, habits, habitLogs] = await Promise.all([
        api2.tasksList({ status: 'todo' }).catch(() => []),
        api2.remindersDue().catch(() => []),
        api2.healthHabitList?.().catch(() => []),
        api2.healthHabitLogsForDate?.(new Date().toISOString().slice(0,10)).catch(() => []),
      ]);
      const taskList = (tasks||[]).slice(0,8).map((t:any) => `- ${t.title} [${t.priority===3?'HIGH':t.priority===2?'MED':'LOW'}]`).join('\n');
      const remList = (rems||[]).slice(0,5).map((r:any) => `- ${r.title}${r.due_at?' at '+r.due_at.slice(11,16):''}`).join('\n');
      const habitList = (habits||[]).map((h:any) => {
        const done = (habitLogs||[]).some((l:any) => l.habit_id === h.id);
        return `- ${h.name}: ${done ? '✓ done' : 'not yet'}`;
      }).join('\n');
      context = [
        taskList ? `Tasks:\n${taskList}` : '',
        remList ? `Reminders today:\n${remList}` : '',
        habitList ? `Habits:\n${habitList}` : '',
      ].filter(Boolean).join('\n\n');
    } catch { /* use empty context */ }
    const planParts = [`You are Henry, ${ownerName}'s AI assistant. Today is ${todayStr}.`];
    if (context) planParts.push('Context:\n' + context);
    planParts.push(`Create a focused daily plan for ${ownerName}. Format:\n**Morning** (1-2 things)\n**Afternoon** (1-2 things)\n**This evening** (1 thing)\n\nBe specific to their actual tasks/reminders. Keep each line short. End with one sentence of encouragement.`);
    const prompt = planParts.join('\n\n');
    try {
      let d: any = null;
      try {
        const r = await fetch('http://127.0.0.1:4242/sync/prompt', {
          method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
          body: JSON.stringify({ text: prompt }),
        });
        const rd = await r.json() as any;
        d = { choices: [{ message: { content: rd?.reply || rd?.response || '' } }] };
      } catch {
        const deviceId = (() => { let id = localStorage.getItem('henry:device_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); } return id; })();
        const r = await fetch('https://henry-proxy.henryai.workers.dev/v1/chat', {
          signal: AbortSignal.timeout(25000), method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Henry-Device': deviceId },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 350, stream: false }),
        });
        d = await r.json() as any;
      }
      const planText = d?.choices?.[0]?.message?.content || 'No response';
      setPlannerResult(planText);
      if (planText && planText !== 'No response') setCached('daily-plan', planText);
    } catch { setPlannerResult('Could not reach Henry AI.'); }
    setPlannerBusy(false);
  }

  async function generateDailyReport() {
    if (reportBusy) return;
    setReportBusy(true);
    setReportText('');
    setShowReport(true);
    const api2 = (window as any).henryAPI;
    const ownerName = localStorage.getItem('henry:owner_name') || 'you';
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    let context = '';
    try {
      const [tasks, rems, habits, habitLogs, txns] = await Promise.all([
        api2.tasksList?.({ status: 'todo' }).catch(() => []),
        api2.remindersDue?.().catch(() => []),
        api2.healthHabitList?.().catch(() => []),
        api2.healthHabitLogsForDate?.(new Date().toISOString().slice(0,10)).catch(() => []),
        api2.financeList?.(new Date().toISOString().slice(0,7)).catch(() => []),
      ]);
      const doneHabits = (habits||[]).filter((h:any) => (habitLogs||[]).some((l:any) => l.habit_id === h.id)).map((h:any) => h.name).join(', ');
      const pendingTasks = (tasks||[]).slice(0,5).map((t:any) => '\u2022 ' + t.title).join('\n');
      const todayTxns = (txns||[]).filter((t:any) => t.date === new Date().toISOString().slice(0,10));
      context = [
        doneHabits ? `Habits completed: ${doneHabits}` : 'No habits completed yet',
        pendingTasks ? 'Open tasks:\n' + pendingTasks : 'No open tasks',
        todayTxns.length ? `Today's transactions: ${todayTxns.length}` : '',
        (rems||[]).length ? `Reminders due: ${(rems||[]).length}` : '',
      ].filter(Boolean).join('\n');
    } catch { /* use empty context */ }

    const prompt = `Write a brief end-of-day report for ${ownerName} — ${today}.

${context}

Format:
**Today's Summary**
[2-3 sentences about what was accomplished]

**Still Open**
[1-2 bullets for tomorrow]

**One takeaway**
[1 sentence reflection]

Keep it brief and encouraging.`;
    try {
      const api2 = (window as any).henryAPI;
      const result = await api2?.henryChat?.({ prompt, mode: 'companion' });
      setReportText(result?.reply || result?.text || result?.content || 'No response');
    } catch {
      // Fallback to sync bridge
      try {
        const r = await fetch('http://127.0.0.1:4242/sync/prompt', {
          method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
          body: JSON.stringify({ text: prompt }),
        });
        const d = await r.json() as any;
        setReportText(d?.reply || d?.response || 'Could not generate report');
      } catch { setReportText('Could not reach Henry AI. Make sure you have an AI key set up in Settings.'); }
    }
    setReportBusy(false);
  }

  async function askHenryInline(text: string) {
    if (!text.trim() || henryStreaming) return;
    setLastQuestion(text);
    setHenryReply('');
    setHenryStreaming(true);

    try {
      const s = useStore.getState().settings;
      const providers = useStore.getState().providers;
      const provider = s.companion_provider || 'groq';
      const model = s.companion_model || 'llama-3.3-70b-versatile';
      const prov = providers.find((p) => p.id === provider);
      const apiKey = prov?.apiKey || '';
      if (!apiKey) {
        setHenryReply('No API key found. Add one in Settings.');
        setHenryStreaming(false);
        return;
      }

      const stream = window.henryAPI.streamMessage({
        provider, model, apiKey,
        messages: [{ role: 'user', content: text }],
        temperature: 0.7,
        maxTokens: 1500,
      });
      replyStreamRef.current = stream;

      let full = '';
      stream.onChunk((c: string) => {
        full += c;
        setHenryReply(full);
      });
      stream.onDone(() => { setHenryStreaming(false); });
      stream.onError((e: string) => {
        setHenryReply('Something went wrong: ' + e);
        setHenryStreaming(false);
      });
    } catch (e) {
      setHenryReply('Error: ' + String(e));
      setHenryStreaming(false);
    }
  }

  function goToChat(text?: string) {
    if (text) {
      try { localStorage.setItem('henry:pending_inject', text); } catch { /* ignore */ }
    }
    setCurrentView('chat');
    if (text) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('henry_inject_draft', { detail: { text } }));
      }, 150);
    }
  }

  function launchMode(mode: string, prompt?: string) {
    try { localStorage.setItem(HENRY_OPERATING_MODE_KEY, mode); } catch { /* ignore */ }
    if (prompt && prompt.trim()) {
      try { localStorage.setItem('henry:pending_inject', prompt.trim()); } catch { /* ignore */ }
    }
    setCurrentView('chat');
    if (prompt && prompt.trim()) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode, prompt: prompt.trim() } }));
        window.dispatchEvent(new CustomEvent('henry_inject_draft', { detail: { text: prompt.trim() } }));
      }, 150);
    } else {
      window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode, prompt: '' } }));
    }
  }

  return (
    <div className="h-full flex flex-col bg-henry-bg overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 max-w-2xl mx-auto w-full">

        {/* Greeting */}
        <div className="w-full mb-8 text-center">
          <h1 className="text-3xl font-semibold text-henry-text tracking-tight mb-1">{greeting.line1}</h1>
          <p className="text-henry-text-muted text-base">{greeting.line2}</p>
        </div>

        {/* Main ask input */}
        <div className="w-full mb-6">
          <div className="relative">
            <input
              ref={quickAskRef}
              type="text"
              value={quickAsk}
              onChange={(e) => setQuickAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && quickAsk.trim()) {
                  const q = quickAsk.trim();
                  setQuickAsk('');
                  askHenryInline(q);
                }
              }}
              placeholder="Ask Henry anything…"
              className="w-full bg-henry-surface/60 border border-henry-border/40 rounded-2xl px-5 py-4 text-base text-henry-text placeholder-henry-text-muted outline-none focus:border-henry-accent/50 focus:bg-henry-surface/80 transition-all"
              autoComplete="off"
            />
            {quickAsk.trim() && (
              <button
                onClick={() => { const q = quickAsk.trim(); setQuickAsk(''); askHenryInline(q); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-xl bg-henry-accent text-henry-bg hover:bg-henry-accent/90 transition-colors"
              >↑</button>
            )}
          </div>
        </div>

        {/* Henry's inline reply — no navigation needed */}
        {(henryReply || henryStreaming) && (
          <div className="w-full mb-6">
            {lastQuestion && (
              <p className="text-[11px] text-henry-text-muted mb-2 italic">"{lastQuestion}"</p>
            )}
            <div className="rounded-2xl bg-henry-surface/40 border border-henry-border/25 px-5 py-4">
              {henryReply ? (
                <p className="text-sm text-henry-text leading-relaxed whitespace-pre-wrap">{henryReply}</p>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-henry-accent/30 border-t-henry-accent rounded-full animate-spin" />
                  <p className="text-sm text-henry-text-muted">Henry is thinking…</p>
                </div>
              )}
              {henryReply && !henryStreaming && (
                <div className="flex gap-3 mt-3 pt-3 border-t border-henry-border/15">
                  <button
                    onClick={() => goToChat(henryReply ? `${lastQuestion}\n\n${henryReply}` : lastQuestion)}
                    className="text-[11px] text-henry-accent hover:underline"
                  >Continue in chat →</button>
                  <button
                    onClick={() => { setHenryReply(''); setLastQuestion(''); quickAskRef.current?.focus(); }}
                    className="text-[11px] text-henry-text-muted hover:text-henry-text"
                  >Clear</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cost dashboard — shows today's AI spending vs GPT-4 */}
        {/* Henry AI Status + hotkey reference */}
        {henryStatus !== 'checking' && (
          <div className="w-full mb-3 space-y-1.5">
            <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium ${
              henryStatus === 'ready' ? 'bg-green-400/5 border-green-400/20 text-green-400' :
              henryStatus === 'ollama' ? 'bg-blue-400/5 border-blue-400/20 text-blue-400' :
              henryStatus === 'proxy' ? 'bg-purple-400/5 border-purple-400/20 text-purple-400' :
              'bg-yellow-400/5 border-yellow-400/20 text-yellow-400'
            }`}>
              <span className="text-sm">{henryStatus === 'ready' ? '✓' : henryStatus === 'ollama' ? '⚡' : henryStatus === 'proxy' ? '◉' : '⚠'}</span>
              <span className="flex-1">
                {henryStatus === 'ready' ? 'Henry is ready — Groq AI connected' :
                 henryStatus === 'ollama' ? 'Henry is ready — running on local Ollama' :
                 'Henry needs a Groq API key to respond'}
              </span>
              {henryStatus === 'needs-key' && (
                <button onClick={() => (window as any).useStore?.getState?.()?.setCurrentView?.('settings')}
                  className="underline hover:opacity-80 transition-all flex-shrink-0">
                  Add key →
                </button>
              )}
            </div>
            {/* Hotkey reference card */}
            <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-henry-surface/50 border border-henry-border/15">
              <div className="flex items-center gap-2">
                <kbd className="bg-henry-surface border border-henry-border/40 text-henry-accent font-mono text-[10px] px-2 py-0.5 rounded-md">{isMacOS() ? '⌥Space' : 'Alt+C'}</kbd>
                <span className="text-[11px] text-henry-text-muted">Capture anything</span>
              </div>
              <div className="w-px h-3 bg-henry-border/30" />
              <div className="flex items-center gap-2">
                <kbd className="bg-henry-surface border border-henry-border/40 text-henry-text-muted font-mono text-[10px] px-2 py-0.5 rounded-md">{isMacOS() ? '⌥H' : 'Alt+H'}</kbd>
                <span className="text-[11px] text-henry-text-muted">Open / hide</span>
              </div>
              <div className="w-px h-3 bg-henry-border/30" />
              <div className="flex items-center gap-2">
                <kbd className="bg-henry-surface border border-henry-border/40 text-henry-text-muted font-mono text-[10px] px-2 py-0.5 rounded-md">{isMacOS() ? '⌘⇧H' : (isWindows() ? 'Ctrl+Shift+H' : 'Ctrl+Shift+H')}</kbd>
                <span className="text-[11px] text-henry-text-muted">Capture (backup)</span>
              </div>
            </div>
          </div>
        )}

        {/* Quick Capture */}
        <form onSubmit={handleCapture} className="w-full mb-3">
          <div className="flex gap-2 items-center">
            <input
              value={capture}
              onChange={e => setCapture(e.target.value)}
              placeholder="Capture anything — task, reminder, or note…"
              className="flex-1 bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all min-w-0"
            />
            <select value={captureRoute} onChange={e => setCaptureRoute(e.target.value as any)}
              className="bg-henry-surface border border-henry-border/30 rounded-xl px-2 py-2 text-xs text-henry-text-muted outline-none cursor-pointer flex-shrink-0">
              <option value="auto">Auto</option>
              <option value="task">Task</option>
              <option value="reminder">Remind</option>
              <option value="journal">Journal</option>
            </select>
            <button type="submit" disabled={!capture.trim() || captureSaving}
              className="px-3 py-2 rounded-xl bg-henry-accent text-white text-sm font-bold disabled:opacity-40 hover:bg-henry-accent/80 transition-all flex-shrink-0">
              {captureSaving ? '…' : '→'}
            </button>
          </div>
        </form>

        {/* Live Data Strip */}
        {/* Today's habits quick view */}
        {todayHabits.length === 0 && (
          <div className="w-full mb-3 px-1">
            <button onClick={() => setCurrentView('health' as any)}
              className="w-full py-2 rounded-xl border border-dashed border-henry-border/30 text-henry-text-muted text-xs hover:border-henry-accent/30 hover:text-henry-accent transition-all">
              + Add habits to track daily — prayer, water, exercise, reading…
            </button>
          </div>
        )}
        {todayHabits.length > 0 && (
          <div className="w-full mb-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {todayHabits.map(({ habit, done }) => (
                <div key={habit.id}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all ${done ? 'bg-green-400/10 border-green-400/25 text-green-400' : 'bg-henry-surface border-henry-border/25 text-henry-text-muted'}`}>
                  <span className="text-sm">{done ? '✓' : habit.icon}</span>
                  <span>{habit.name.split(' ')[0]}</span>
                </div>
              ))}
              <button onClick={() => setCurrentView('health' as any)}
                className="text-[10px] text-henry-text-muted hover:text-henry-accent transition-all px-1">
                {todayHabits.filter(h => h.done).length}/{todayHabits.length} →
              </button>
            </div>
          </div>
        )}

        {/* Proactive nudge */}
        {nudge && (
          <div className="w-full mb-2 flex items-start gap-2 p-2.5 bg-henry-surface/40 border border-henry-border/20 rounded-xl">
            <span className="text-henry-accent text-xs mt-0.5 flex-shrink-0">◉</span>
            <p className="text-xs text-henry-text-muted flex-1 leading-snug">{nudge}</p>
            <button onClick={() => setNudge(null)} className="text-henry-text-muted hover:text-henry-text text-xs flex-shrink-0">✕</button>
          </div>
        )}

        {/* Henry's word for today */}
        {henryWord && (
          <div className="w-full mb-2 flex items-start gap-2">
            <span className="text-henry-accent text-sm flex-shrink-0 mt-0.5">◉</span>
            <p className="text-xs text-henry-text leading-snug italic flex-1">{henryWord}</p>
          </div>
        )}

        {/* Verse of the day */}
        {verseOfDay && (
          <div className="w-full mb-3 p-3 bg-henry-accent/5 border border-henry-accent/15 rounded-xl">
            <p className="text-[9px] uppercase tracking-widest text-henry-accent/70 mb-1.5 font-semibold">✝ Verse of the Day</p>
            <p className="text-xs text-henry-text leading-relaxed italic">"{verseOfDay.text.slice(0, 120)}{verseOfDay.text.length > 120 ? '…' : ''}"</p>
            <p className="text-[10px] text-henry-text-muted mt-1 font-medium">— {verseOfDay.ref}</p>
          </div>
        )}

        {/* Henry focus nudge */}
        <div className="w-full mb-2">
          <button onClick={() => void askFocusNow()} disabled={henryFocusBusy}
            className="w-full py-1.5 rounded-xl border border-dashed border-henry-accent/30 text-henry-accent/70 text-xs hover:border-henry-accent/60 hover:text-henry-accent disabled:opacity-40 transition-all">
            {henryFocusBusy ? '⚡ Thinking…' : '⚡ What should I work on right now?'}
          </button>
          {henryFocusQ && (
            <div className="mt-1.5 flex items-start gap-2 p-2.5 bg-henry-accent/5 border border-henry-accent/15 rounded-xl">
              <span className="text-henry-accent text-xs flex-shrink-0 mt-0.5">◉</span>
              <p className="text-xs text-henry-text leading-snug flex-1">{henryFocusQ}</p>
              <button onClick={() => setHenryFocusQ('')} className="text-henry-text-muted hover:text-henry-text text-xs flex-shrink-0 transition-all">✕</button>
            </div>
          )}
        </div>

        {/* Quick add task */}
        <div className="w-full mb-2">
          {addingTask ? (
            <div className="flex gap-2">
              <input value={quickTask} onChange={e => setQuickTask(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void addQuickTask(); if (e.key === 'Escape') setAddingTask(false); }}
                placeholder="New task…" autoFocus
                className="flex-1 bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50" />
              <button onClick={() => void addQuickTask()}
                className="px-3 py-2 bg-henry-accent text-white text-sm rounded-xl font-semibold hover:bg-henry-accent/80 transition-all">Add</button>
              <button onClick={() => setAddingTask(false)}
                className="px-3 py-2 border border-henry-border/30 text-henry-text-muted text-sm rounded-xl hover:text-henry-text transition-all">✕</button>
            </div>
          ) : (
            <button onClick={() => setAddingTask(true)}
              className="w-full py-2 rounded-xl border border-dashed border-henry-border/40 text-henry-text-muted text-xs hover:border-henry-accent/40 hover:text-henry-accent transition-all">
              + Quick task
            </button>
          )}
        </div>

        {(liveData.dueTasks > 0 || liveData.dueReminders > 0 || liveData.focusToday > 0) && (
          <div className="w-full mb-3 flex gap-2 flex-wrap">
            {liveData.dueTasks > 0 && (
              <div onClick={() => useStore.getState().setCurrentView('tasks')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-henry-accent/10 border border-henry-accent/20 cursor-pointer hover:bg-henry-accent/20 transition-all">
                <span className="text-henry-accent text-sm">☐</span>
                <span className="text-xs text-henry-text">{liveData.dueTasks} tasks</span>
              </div>
            )}
            {liveData.dueReminders > 0 && (
              <div onClick={() => useStore.getState().setCurrentView('reminders')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-400/10 border border-red-400/20 cursor-pointer hover:bg-red-400/20 transition-all">
                <span className="text-red-400 text-sm">🔔</span>
                <span className="text-xs text-henry-text">{liveData.dueReminders} due</span>
              </div>
            )}
            {(liveData.income > 0 || liveData.expenses > 0) && (
              <div onClick={() => useStore.getState().setCurrentView('finance')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-henry-surface border border-henry-border/20 cursor-pointer hover:bg-henry-surface/80 transition-all">
                <span className="text-henry-text-muted text-sm">◆</span>
                <span className="text-xs text-henry-text">
                  ${(liveData.income - liveData.expenses).toFixed(0)} net
                </span>
              </div>
            )}
          </div>
        )}

        {dailyCost.tokens > 0 && (
          <div className="w-full mb-4 px-4 py-3 rounded-xl bg-henry-surface/30 border border-henry-border/20">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wide">Today's AI Cost</p>
              <p className="text-[11px] text-green-400 font-medium">
                Saved ${dailyCost.savedVsGpt4.toFixed(4)} vs GPT-4
              </p>
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-lg font-bold text-henry-text">
                ${dailyCost.costUsd < 0.0001 ? '< $0.0001' : `$${dailyCost.costUsd.toFixed(4)}`}
              </p>
              <p className="text-[11px] text-henry-text-muted">{dailyCost.tokens.toLocaleString()} tokens · {dailyCost.topModel.replace('llama-','').replace('-versatile','').replace('-instant','')}</p>
            </div>
          </div>
        )}

        {/* Quick chips — minimal, subtle */}
        <div className="w-full flex flex-wrap gap-2 mb-8 justify-center">
          {[
            { label: 'What to focus on?', fn: () => PANEL_QUICK_ASK.focus() },
            { label: 'Bible study', fn: () => PANEL_QUICK_ASK.bible() },
            { label: 'Catch me up', fn: () => PANEL_QUICK_ASK.today() },
            { label: 'Finance check', fn: () => PANEL_QUICK_ASK.finance() },
          ].map(chip => (
            <button
              key={chip.label}
              onClick={chip.fn}
              className="text-[12px] px-4 py-2 rounded-full border border-henry-border/25 text-henry-text-muted hover:text-henry-text hover:border-henry-accent/30 hover:bg-henry-accent/5 transition-all"
            >{chip.label}</button>
          ))}
        </div>

        {/* Intention — only if set, subtle */}
        {intention && (
          <div className="w-full mb-6 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-henry-accent/5 border border-henry-accent/15">
            <span className="text-henry-accent text-sm">🎯</span>
            <p className="text-sm text-henry-text-muted flex-1 italic">"{intention}"</p>
            <button onClick={() => { clearDailyIntention(); setIntentionState(''); setIntentionDraft(''); }} className="text-henry-text-muted hover:text-henry-text text-xs transition-colors">✕</button>
          </div>
        )}

        {/* Set intention — only shown when not set */}
        {!intention && (
          <div className="w-full mb-6">
            <div className="flex gap-2">
              <input
                type="text"
                value={intentionDraft}
                onChange={(e) => setIntentionDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && intentionDraft.trim()) {
                    setDailyIntention(intentionDraft.trim());
                    setIntentionState(intentionDraft.trim());
                  }
                }}
                placeholder="Set today's intention…"
                className="flex-1 bg-transparent border border-henry-border/20 rounded-xl px-4 py-2.5 text-sm text-henry-text-muted placeholder-henry-text-muted/50 outline-none focus:border-henry-border/40 transition-all"
              />
              {intentionDraft.trim() && (
                <button
                  onClick={() => { setDailyIntention(intentionDraft.trim()); setIntentionState(intentionDraft.trim()); }}
                  className="px-4 py-2 rounded-xl bg-henry-surface border border-henry-border/30 text-henry-text-muted text-sm hover:text-henry-text transition-all"
                >Set</button>
              )}
            </div>
          </div>
        )}

        {/* Briefing — collapsed by default, expandable */}
        {(briefing || generatingBriefing) && (
          <div className="w-full rounded-xl border border-henry-border/20 bg-henry-surface/20 overflow-hidden">
            <button
              onClick={() => setBriefingExpanded(!briefingExpanded)}
              className="w-full flex items-center justify-between px-4 py-3 text-left"
            >
              <div className="flex items-center gap-2">
                <span className="text-base">📋</span>
                <span className="text-sm font-medium text-henry-text">Morning Briefing</span>
                {generatingBriefing && <span className="text-[10px] text-henry-text-muted animate-pulse">generating…</span>}
              </div>
              <div className="flex items-center gap-2">
                {briefing && (
                  <button
                    onClick={(e) => { e.stopPropagation(); localStorage.removeItem('henry:briefing:' + getTodayKey()); setBriefing(null); tryGenerateBriefing(); }}
                    className="text-henry-text-muted hover:text-henry-text text-xs px-2 py-0.5 rounded transition-colors"
                  >↺</button>
                )}
                <svg className={`w-4 h-4 text-henry-text-muted transition-transform ${briefingExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <polyline points="6,9 12,15 18,9" />
                </svg>
              </div>
            </button>
            {briefingExpanded && briefing && (
              <div className="px-4 pb-4 border-t border-henry-border/15">
                <p className="text-sm text-henry-text-dim leading-relaxed mt-3 whitespace-pre-wrap">{briefing.content}</p>
                <button
                  onClick={() => { setCurrentView('chat'); }}
                  className="mt-3 text-[11px] text-henry-accent hover:underline"
                >Continue in chat →</button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
