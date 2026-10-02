/**
 * Henry HQ — Full-screen computer control hub.
 * System stats · AI chat · App launcher · Process manager · Automations
 * Desktop background mode · Do ANYTHING from one place.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../store';
import { isMacOS, isLinux, isWindows } from '../../utils/platform';

const getApi = () => (window as any).henryAPI as any;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SystemStats {
  cpu: { percent: number; cores: number; model: string };
  memory: { total: number; free: number; used: number; percent: number };
  battery: { percent: number | null; charging: boolean; time: string };
  network: { interface: string; ip: string };
  disk: { total: number; free: number };
  uptime: number;
  runningApps: string[];
  hostname: string;
}

interface ScheduledTask { id: string; label: string; command: string; intervalMs: number; }

interface DiscoveredApp {
  id: string;
  name: string;
  displayName: string;
  executable: string;
  icon?: string;
  categories?: string[];
  isTerminal?: boolean;
  isFileManager?: boolean;
  isBrowser?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + 'GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + 'MB';
  return (bytes / 1e3).toFixed(0) + 'KB';
}
function fmtUptime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Stat ring ─────────────────────────────────────────────────────────────────
function Ring({ pct, label, value, color = '#7c3aed' }: { pct: number; label: string; value: string; color?: string }) {
  const r = 28, circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const warn = pct > 85;
  const c = warn ? '#f87171' : color;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-16 h-16">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
          <circle cx="32" cy="32" r={r} fill="none" stroke={c} strokeWidth="5"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[13px] font-bold" style={{ color: c }}>{pct}%</span>
        </div>
      </div>
      <p className="text-[10px] text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-[10px] text-gray-500 font-mono">{value}</p>
    </div>
  );
}

export default function HQPanel() {
  const { setCurrentView } = useStore();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [time, setTime] = useState(new Date());
  const [chatInput, setChatInput] = useState('');
  const [chatLog, setChatLog] = useState<{role: string; text: string}[]>([
    { role: 'henry', text: 'HQ online. I can control your computer, run commands, open apps, check anything, and automate your workflow. What do you need?' }
  ]);
  const [chatBusy, setChatBusy] = useState(false);
  const [shellInput, setShellInput] = useState('');
  const [shellLog, setShellLog] = useState<{cmd: string; out: string; err?: boolean}[]>([]);
  const [volume, setVolume] = useState(50);
  const [desktopMode, setDesktopMode] = useState(false);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [newTask, setNewTask] = useState({ label: '', command: '', interval: '60' });
  const [showScheduler, setShowScheduler] = useState(false);
  const [selectedTab, setSelectedTab] = useState<'chat'|'shell'|'apps'|'processes'|'automate'>('chat');
  const [discoveredApps, setDiscoveredApps] = useState<DiscoveredApp[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load discovered apps
  useEffect(() => {
    const loadApps = async () => {
      try {
        const r = await getApi()?.invoke('computer:listApps').catch(() => null);
        if (r?.apps) setDiscoveredApps(r.apps);
      } catch {}
    };
    loadApps();
  }, []);

  // System stats polling
  const loadStats = useCallback(async () => {
    if (!getApi()?.computerSystemStats) return;
    const s = await getApi()?.computerSystemStats().catch(() => null);
    if (s && !s.error) setStats(s);
  }, []);

  useEffect(() => {
    loadStats();
    const t = setInterval(loadStats, 5000);
    return () => clearInterval(t);
  }, [loadStats]);

  // Volume
  useEffect(() => {
    getApi()?.computerGetVolume?.().then((r: any) => { if (r?.volume !== undefined) setVolume(r.volume); }).catch(() => {});
  }, []);

  // Scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatLog]);

  // Launching an app must go through the main process. Building a shell string
  // here meant the Linux branch interpolated a raw executable and the free-text
  // box interpolated unquoted user input, so either path could run arbitrary
  // commands. `computerOpenApp` is platform-aware on the main side.
  async function launchAppByName(name: string) {
    const api = getApi();
    if (!api?.computerOpenApp) return;
    try {
      const r = await api.computerOpenApp(name);
      if (r && r.success === false) console.warn('[HQ] launch failed:', r.error);
    } catch (e) {
      console.warn('[HQ] launch failed:', e);
    }
  }

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || chatBusy) return;
    setChatInput('');
    setChatLog(l => [...l, { role: 'user', text: msg }]);
    setChatBusy(true);

    // Build a rich context message
    const systemContext = stats ? `System: CPU ${stats.cpu.percent}%, RAM ${stats.memory.percent}%, ${stats.runningApps.slice(0,5).join(', ')} running. ` : '';
    const platformName = isMacOS() ? 'Mac' : isLinux() ? 'Linux' : isWindows() ? 'Windows' : 'computer';
    const systemPrompt = `You are Henry HQ — Topher's ${platformName} control hub. ${systemContext}You can: run shell commands, open apps, control system settings, automate tasks, answer questions, process anything. Be direct and execute when asked. If running a command, show what you ran and its output.`;

    // Get providers from store
    const providers = useStore.getState().providers;
    const s = useStore.getState().settings;
    const provider = providers?.find((p: any) => p.id === (s.companion_provider || 'groq')) || providers?.[0];
    const apiKey = provider?.apiKey || (provider as any)?.api_key || '';

    if (!apiKey && s.companion_provider !== 'ollama') {
      setChatLog(l => [...l, { role: 'henry', text: 'No AI key configured. Go to **Settings → AI Providers** to add your Groq key.' }]);
      setChatBusy(false);
      return;
    }

    let fullText = '';
    const stream = getApi()?.streamMessage({
      provider: s.companion_provider || 'groq',
      model: s.companion_model || 'llama-3.3-70b-versatile',
      apiKey,
      messages: [
        { role: 'system', content: systemPrompt },
        ...chatLog.slice(-6).map(m => ({ role: m.role === 'henry' ? 'assistant' : 'user', content: m.text })),
        { role: 'user', content: msg },
      ],
      maxTokens: 1024,
      temperature: 0.5,
    });

    setChatLog(l => [...l, { role: 'henry', text: '…' }]);
    stream.onChunk((chunk: string) => {
      fullText += chunk;
      setChatLog(l => [...l.slice(0, -1), { role: 'henry', text: fullText }]);
    });
    stream.onDone(() => {
      // Auto-execute any shell commands Henry suggests
      const cmdMatch = fullText.match(/```(?:bash|sh|shell|zsh)?\s*\n([\s\S]+?)```/);
      if (cmdMatch && getApi()?.computerRunShell) {
        getApi()?.computerRunShell({ command: cmdMatch[1].trim(), timeout: 15000 }).then((r: any) => {
          // The handler returns `output` (computer.ts:203). This read `stdout`,
          // which the handler never returns, so auto-run from a code fence never
          // showed its result even when the command worked.
          const text = r?.output ?? r?.stdout;
          if (text) {
            setChatLog(l => [...l, { role: 'system', text: '⚙️ Result: ' + String(text).trim().slice(0, 500) }]);
          } else if (r && r.success === false) {
            setChatLog(l => [...l, { role: 'system', text: '⚙️ Failed: ' + String(r.error || 'no output').slice(0, 300) }]);
          }
        }).catch(() => {});
      }
      setChatBusy(false);
    });
    stream.onError((err: string) => {
      setChatLog(l => [...l.slice(0,-1), { role: 'henry', text: '⚠ ' + err }]);
      setChatBusy(false);
    });
  }

  async function runShell() {
    const cmd = shellInput.trim();
    if (!cmd) return;
    setShellInput('');
    setShellLog(l => [...l, { cmd, out: '…' }]);
    try {
      const r = await getApi()?.computerRunShell({ command: cmd, timeout: 30000 });
      setShellLog(l => [...l.slice(0,-1), { cmd, out: (r.stdout || r.output || '').trim() || r.error || 'done' }]);
    } catch (e) {
      setShellLog(l => [...l.slice(0,-1), { cmd, out: String(e), err: true }]);
    }
  }

  async function toggleDesktopMode() {
    const next = !desktopMode;
    setDesktopMode(next);
    await getApi()?.computerDesktopMode?.({ enable: next, fullscreen: next }).catch(() => {});
  }

  async function scheduleTask() {
    if (!newTask.label || !newTask.command) return;
    const task: ScheduledTask = {
      id: 'task_' + Date.now(),
      label: newTask.label,
      command: newTask.command,
      intervalMs: parseInt(newTask.interval) * 1000,
    };
    await getApi()?.computerScheduleTask(task).catch(() => {});
    setScheduledTasks(t => [...t, task]);
    setNewTask({ label: '', command: '', interval: '60' });
  }

  async function unscheduleTask(id: string) {
    await getApi()?.computerUnscheduleTask(id).catch(() => {});
    setScheduledTasks(t => t.filter(x => x.id !== id));
  }

  const inpCls = "bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-purple-500/60 w-full transition-all";
  const tabCls = (t: string) => `px-3 py-1.5 text-xs rounded-lg font-medium transition-all ` +
    (selectedTab === t ? 'bg-purple-600 text-white' : 'text-white/50 hover:text-white/80 hover:bg-white/5');

  return (
    <div className="flex flex-col h-full bg-[#06060e] text-white overflow-hidden select-none">
      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black tracking-tight text-purple-400">◉ HENRY HQ</span>
          {stats && <span className="text-xs text-white/30 font-mono">{stats.hostname}</span>}
        </div>

        <div className="flex items-center gap-6">
          {/* System rings */}
          {stats && (
            <div className="flex items-center gap-4">
              <Ring pct={stats.cpu.percent} label="CPU" value={`${stats.cpu.cores} cores`} color="#7c3aed" />
              <Ring pct={stats.memory.percent} label="RAM" value={fmt(stats.memory.used)} color="#2563eb" />
              {stats.disk.total > 0 && (
                <Ring pct={Math.round((1 - stats.disk.free/stats.disk.total)*100)} label="DISK" value={fmt(stats.disk.free) + ' free'} color="#059669" />
              )}
              {stats.battery.percent !== null && (
                <Ring pct={stats.battery.percent} label="BATT" value={stats.battery.charging ? '⚡ charging' : stats.battery.time} color={stats.battery.charging ? '#16a34a' : '#d97706'} />
              )}
            </div>
          )}

          {/* Volume */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/30">🔊</span>
            <input type="range" min={0} max={100} value={volume}
              onChange={e => { setVolume(Number(e.target.value)); getApi()?.computerSetVolume?.(Number(e.target.value)); }}
              className="w-20 accent-purple-500 cursor-pointer" />
            <span className="text-xs text-white/30 w-7">{volume}%</span>
          </div>

          {/* Clock */}
          <div className="text-right">
            <p className="text-xl font-mono font-bold text-white">{time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
            <p className="text-[10px] text-white/30">{time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
          </div>

          {/* Desktop mode */}
          <button onClick={toggleDesktopMode}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${desktopMode ? 'border-purple-500/60 text-purple-400 bg-purple-500/10' : 'border-white/10 text-white/40 hover:border-white/20'}`}>
            {desktopMode ? '⬡ Desktop' : '⬡ Desktop'}
          </button>

          {/* Back to normal */}
          <button onClick={() => setCurrentView('today')}
            className="text-xs px-3 py-1.5 rounded-lg border border-white/10 text-white/40 hover:text-white hover:border-white/20 transition-all">
            ← Exit HQ
          </button>
        </div>
      </div>

      {/* ── MAIN CONTENT ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: quick app launcher */}
        <div className="w-48 border-r border-white/5 p-3 flex-shrink-0 overflow-y-auto">
          <p className="text-[9px] uppercase tracking-widest text-white/20 mb-2 px-1">Quick Launch</p>
          <div className="grid grid-cols-2 gap-1.5">
            {discoveredApps.slice(0, 10).map(app => (
              <button key={app.id} onClick={() => void launchAppByName(app.displayName)}
                className="flex flex-col items-center gap-1 p-2 rounded-xl bg-white/3 hover:bg-white/8 border border-white/5 hover:border-purple-500/30 transition-all group">
                <span className="text-xl">{app.icon || (app.isTerminal ? '⌨️' : app.isFileManager ? '📁' : app.isBrowser ? '🌐' : '📦')}</span>
                <span className="text-[9px] text-white/40 group-hover:text-white/70 transition-all">{app.displayName}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-white/5">
            <p className="text-[9px] uppercase tracking-widest text-white/20 mb-2 px-1">Open App</p>
            <div className="flex gap-1">
              <input id="app-input" placeholder="App name…" className={inpCls + ' text-xs'} onKeyDown={e => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) {
                    void launchAppByName(v);
                    (e.target as HTMLInputElement).value = '';
                  }
                }
              }} />
            </div>
          </div>

          {stats && stats.uptime > 0 && (
            <div className="mt-4 pt-3 border-t border-white/5">
              <p className="text-[9px] uppercase tracking-widest text-white/20 mb-2 px-1">Uptime</p>
              <p className="text-xs text-white/40 font-mono px-1">{fmtUptime(stats.uptime)}</p>
              {stats.network.ip && (
                <p className="text-[10px] text-white/30 font-mono px-1 mt-1">{stats.network.ip}</p>
              )}
            </div>
          )}
        </div>

        {/* Center: main panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-white/5 flex-shrink-0">
            {(['chat','shell','apps','processes','automate'] as const).map(t => (
              <button key={t} onClick={() => setSelectedTab(t)} className={tabCls(t)}>
                {t === 'chat' ? '◉ Chat' : t === 'shell' ? '⌨ Shell' : t === 'apps' ? '⊞ Apps' : t === 'processes' ? '⊡ Processes' : '⚙ Automate'}
              </button>
            ))}
          </div>

          {/* Chat Tab */}
          {selectedTab === 'chat' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {chatLog.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      m.role === 'user' ? 'bg-purple-600 text-white' :
                      m.role === 'system' ? 'bg-green-900/40 border border-green-500/20 text-green-300 font-mono text-xs' :
                      'bg-white/5 border border-white/8 text-white/85'
                    }`}>
                      <span className="whitespace-pre-wrap">{m.text}</span>
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="p-4 border-t border-white/5">
                <div className="flex gap-2">
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void sendChat())}
                    placeholder="Tell Henry to do anything… open apps, run commands, analyze, automate, search"
                    className={inpCls} autoFocus />
                  <button onClick={() => void sendChat()} disabled={chatBusy || !chatInput.trim()}
                    className="px-5 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40 hover:bg-purple-500 transition-all flex-shrink-0">
                    {chatBusy ? '…' : '→'}
                  </button>
                </div>
                <div className="flex gap-2 mt-2 flex-wrap">
                  {(() => {
                    const base = ['What apps are running?', 'Show disk space', 'Take a screenshot'];
                    if (isMacOS()) return [...base, 'Open Finder + Terminal', 'Mute the Mac', 'Run a backup of my Desktop'];
                    if (isLinux()) return [...base, 'Open Files + Terminal', 'Mute audio', 'Run a backup of my home folder'];
                    if (isWindows()) return [...base, 'Open Explorer + Terminal', 'Mute audio', 'Run a backup of my Documents'];
                    return base;
                  })().map(q => (
                    <button key={q} onClick={() => { setChatInput(q); }}
                      className="text-[10px] px-2 py-1 rounded-lg bg-white/5 border border-white/8 text-white/40 hover:text-white/70 hover:border-purple-500/30 transition-all">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Shell Tab */}
          {selectedTab === 'shell' && (
            <div className="flex-1 flex flex-col overflow-hidden font-mono">
              <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-black/40">
                {shellLog.length === 0 && (
                  <p className="text-white/20 text-xs">Henry Shell — run any command on your Mac</p>
                )}
                {shellLog.map((entry, i) => (
                  <div key={i}>
                    <p className="text-purple-400 text-xs">$ {entry.cmd}</p>
                    <p className={`text-xs whitespace-pre-wrap ${entry.err ? 'text-red-400' : 'text-green-300'}`}>{entry.out}</p>
                  </div>
                ))}
              </div>
              <div className="p-4 border-t border-white/5 flex gap-2">
                <span className="text-purple-400 text-sm font-mono self-center">$</span>
                <input value={shellInput} onChange={e => setShellInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void runShell()}
                  placeholder="Any shell command…" className={inpCls} autoFocus />
                <button onClick={() => void runShell()} className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-white/60 hover:text-white hover:border-white/20 transition-all flex-shrink-0">Run</button>
              </div>
              <div className="px-4 pb-3 flex gap-2 flex-wrap">
                {(() => {
                  if (isMacOS()) return ['ls ~/Desktop','df -h','top -l 1 | head -20','open .','sudo lsof -i :3000','ps aux | grep node','networksetup -listallnetworkservices'];
                  if (isLinux()) return ['ls ~/Desktop','df -h','htop | head -20','xdg-open .','sudo ss -tlnp | head -20','ps aux | grep node','nmcli device show'];
                  if (isWindows()) return ['dir %USERPROFILE%\\Desktop','wmic logicaldisk get size,freespace','tasklist | head -20','explorer .','netstat -an | findstr :3000','tasklist | findstr node','ipconfig /all'];
                  return [];
                })().map(cmd => (
                  <button key={cmd} onClick={() => setShellInput(cmd)}
                    className="text-[10px] px-2 py-1 rounded-lg bg-white/3 border border-white/5 text-white/30 hover:text-white/60 hover:border-white/15 transition-all font-mono">
                    {cmd}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Running Apps Tab */}
          {selectedTab === 'apps' && (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-white/40">{stats?.runningApps.length || 0} apps running</p>
                <button onClick={loadStats} className="text-xs text-purple-400 hover:text-purple-300">Refresh</button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(stats?.runningApps || []).map(app => (
                  <div key={app} className="flex items-center justify-between p-2.5 rounded-xl bg-white/3 border border-white/5 hover:border-white/10 group">
                    <span className="text-sm text-white/70">{app}</span>
                    <button onClick={() => getApi()?.computerRunShell?.({ command: isMacOS() ? `osascript -e 'quit application "${app}"'` : isLinux() ? `pkill -f "${app}"` : `taskkill /f /im "${app}.exe"`, timeout: 3000 })}
                      className="text-[10px] text-red-400/40 group-hover:text-red-400/80 transition-all">✕</button>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-white/5">
                <p className="text-xs text-white/30 mb-3">Launch any app</p>
                <div className="grid grid-cols-4 gap-2">
                  {discoveredApps.slice(0, 16).map(app => (
                    <button key={app.id} onClick={() => void launchAppByName(app.displayName)}
                      className="flex items-center gap-2 p-2.5 rounded-xl bg-white/3 border border-white/5 hover:bg-purple-500/10 hover:border-purple-500/30 transition-all">
                      <span className="text-xl">{app.icon || (app.isTerminal ? '⌨️' : app.isFileManager ? '📁' : app.isBrowser ? '🌐' : '📦')}</span>
                      <span className="text-xs text-white/60">{app.displayName}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Processes Tab */}
          {selectedTab === 'processes' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4">
                <ProcessList />
              </div>
            </div>
          )}

          {/* Automate Tab */}
          {selectedTab === 'automate' && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="bg-purple-900/20 border border-purple-500/20 rounded-2xl p-4">
                <p className="text-sm font-semibold text-purple-300 mb-1">Scheduled Automations</p>
                <p className="text-xs text-white/30 mb-3">Run any shell command on a schedule. Perfect for monitoring, backups, notifications.</p>

                {scheduledTasks.length === 0 && (
                  <p className="text-xs text-white/20 mb-3">No automations running. Add one below.</p>
                )}
                {scheduledTasks.map(task => (
                  <div key={task.id} className="flex items-center justify-between p-3 rounded-xl bg-black/30 border border-white/5 mb-2">
                    <div>
                      <p className="text-sm text-white font-medium">{task.label}</p>
                      <p className="text-xs text-white/30 font-mono">{task.command} · every {task.intervalMs/1000}s</p>
                    </div>
                    <button onClick={() => void unscheduleTask(task.id)} className="text-xs text-red-400/60 hover:text-red-400 transition-all">Stop</button>
                  </div>
                ))}

                <div className="space-y-2 mt-3">
                  <input value={newTask.label} onChange={e => setNewTask(t => ({...t, label: e.target.value}))}
                    placeholder="Task name (e.g. Backup reminder)" className={inpCls} />
                  <input value={newTask.command} onChange={e => setNewTask(t => ({...t, command: e.target.value}))}
                    placeholder="Shell command (e.g. say 'Time to back up')" className={inpCls + ' font-mono'} />
                  <div className="flex gap-2">
                    <input value={newTask.interval} onChange={e => setNewTask(t => ({...t, interval: e.target.value}))}
                      placeholder="Every N seconds" className={inpCls + ' w-40'} type="number" />
                    <button onClick={() => void scheduleTask()} disabled={!newTask.label || !newTask.command}
                      className="flex-1 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40 hover:bg-purple-500 transition-all">
                      + Schedule
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-white/3 border border-white/5 rounded-2xl p-4">
                <p className="text-sm font-semibold text-white/70 mb-3">One-click Automations</p>
                <div className="grid grid-cols-2 gap-2">
                  {(() => {
                    if (isMacOS()) return [
                      { label: '🔇 Mute Mac', cmd: "osascript -e 'set volume output muted true'" },
                      { label: '🔊 Unmute', cmd: "osascript -e 'set volume output muted false'" },
                      { label: '🛑 Sleep now', cmd: "pmset sleepnow" },
                      { label: '📸 Screenshot', cmd: "screencapture -i ~/Desktop/HenryCapture_$(date +%Y%m%d_%H%M%S).png" },
                      { label: '🧹 Empty Trash', cmd: "osascript -e 'tell application \"Finder\" to empty trash'" },
                      { label: '📋 Clear Clipboard', cmd: "pbcopy < /dev/null" },
                      { label: '🔄 Restart Dock', cmd: "killall Dock" },
                      { label: '📡 Show IP', cmd: "curl -s ifconfig.me" },
                      { label: '🔒 Lock Screen', cmd: "/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend" },
                      { label: '🌐 Network info', cmd: "networksetup -getinfo Wi-Fi" },
                    ];
                    if (isLinux()) return [
                      { label: '🔇 Mute audio', cmd: "amixer -D pulse sset Master mute" },
                      { label: '🔊 Unmute', cmd: "amixer -D pulse sset Master unmute" },
                      { label: '🛑 Sleep now', cmd: "systemctl suspend" },
                      { label: '📸 Screenshot', cmd: "scrot ~/Desktop/HenryCapture_$(date +%Y%m%d_%H%M%S).png" },
                      { label: '🧹 Empty Trash', cmd: "gio trash --empty" },
                      { label: '📋 Clear Clipboard', cmd: "xclip -i /dev/null" },
                      { label: '🔄 Restart Shell', cmd: "killall -SIGUSR1 gnome-shell || true" },
                      { label: '📡 Show IP', cmd: "curl -s ifconfig.me" },
                      { label: '🔒 Lock Screen', cmd: "loginctl lock-session" },
                      { label: '🌐 Network info', cmd: "nmcli device show" },
                    ];
                    if (isWindows()) return [
                      { label: '🔇 Mute audio', cmd: "powershell -Command \"(New-Object -ComObject WScript.Shell).SendKeys([char]173)\"" },
                      { label: '🔊 Unmute', cmd: "powershell -Command \"(New-Object -ComObject WScript.Shell).SendKeys([char]173)\"" },
                      { label: '🛑 Sleep now', cmd: "rundll32.exe powrprof.dll,SetSuspendState 0,1,0" },
                      { label: '📸 Screenshot', cmd: "powershell -Command \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { \$bmp = New-Object System.Drawing.Bitmap(\$_.Bounds.Width, \$_.Bounds.Height); \$g = [System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen(\$_.Bounds.Location, [System.Drawing.Point]::Empty, \$_.Bounds.Size); \$bmp.Save('~/Desktop/HenryCapture_$(date +%Y%m%d_%H%M%S).png') }\"" },
                      { label: '🧹 Empty Recycle Bin', cmd: "powershell -Command \"& { \$shell = New-Object -ComObject Shell.Application; \$shell.Namespace(0xA).Items() | ForEach-Object { \$_.InvokeVerb('Delete') } }\"" },
                      { label: '📋 Clear Clipboard', cmd: "powershell -Command \"Set-Clipboard -Value ''\"" },
                      { label: '🔄 Restart Explorer', cmd: "taskkill /f /im explorer.exe && start explorer.exe" },
                      { label: '📡 Show IP', cmd: "curl -s ifconfig.me" },
                      { label: '🔒 Lock Screen', cmd: "rundll32.exe user32.dll,LockWorkStation" },
                      { label: '🌐 Network info', cmd: "ipconfig /all" },
                    ];
                    return [];
                  })().map(a => (
                    <button key={a.label} onClick={async () => {
                      const r = await getApi()?.computerRunShell({ command: a.cmd, timeout: 10000 }).catch(() => null);
                      if (r?.stdout?.trim()) setChatLog(l => [...l, { role: 'system', text: a.label + ': ' + r.stdout.trim() }]);
                    }} className="flex items-center gap-2 p-2.5 rounded-xl bg-black/20 border border-white/5 hover:bg-purple-500/10 hover:border-purple-500/30 transition-all text-sm text-white/60 hover:text-white text-left">
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Process list ───────────────────────────────────────────────────────────────
function ProcessList() {
  const [procs, setProcs] = useState<{pid:number;name:string;cpu:string;mem:string}[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const load = async () => {
      // The handler returns `{ processes: string[] }` (computer.ts:294). This
      // did Array.isArray(r), which is always false for an object, so the
      // process list never populated and computerKillProcess was unreachable.
      const r: any = await (window as any).henryAPI?.computerListProcesses?.().catch(() => null);
      const list = Array.isArray(r) ? r : Array.isArray(r?.processes) ? r.processes : [];
      if (list.length) setProcs(list.slice(0, 80));
    };
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const filtered = procs.filter(p => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter processes…"
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-purple-500/40" />
        <span className="text-xs text-white/30">{filtered.length} procs</span>
      </div>
      <div className="space-y-1">
        <div className="grid grid-cols-4 text-[9px] uppercase tracking-wider text-white/20 px-3 pb-1">
          <span>PID</span><span className="col-span-2">Name</span><span>CPU / Mem</span>
        </div>
        {filtered.map(p => (
          <div key={p.pid} className="grid grid-cols-4 items-center px-3 py-2 rounded-lg hover:bg-white/3 group text-xs">
            <span className="text-white/30 font-mono">{p.pid}</span>
            <span className="col-span-2 text-white/70 truncate">{p.name}</span>
            <div className="flex items-center justify-between">
              <span className="text-white/30 font-mono">{p.cpu}% {p.mem}</span>
              <button onClick={async () => {
                await (window as any).henryAPI?.computerKillProcess?.(p.pid).catch(() => {});
                setProcs(ps => ps.filter(x => x.pid !== p.pid));
              }} className="text-red-400/0 group-hover:text-red-400/60 hover:text-red-400 transition-all ml-2">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
