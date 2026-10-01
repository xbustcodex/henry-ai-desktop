import React, { useState, useCallback } from 'react';
import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import TitleBar from './TitleBar';
import PresenceBar from './PresenceBar';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import ChatView from '../chat/ChatView';
import TaskQueueView from '../queue/TaskQueueView';
import ApprovalQueuePanel from '../queue/ApprovalQueuePanel';
import HealthPanel from '../health/HealthPanel';
import TasksPanel from '../tasks/TasksPanel';
import SettingsView from '../settings/SettingsView';
import FileBrowser from '../files/FileBrowser';
import WorkspaceView from '../workspace/WorkspaceView';
import TerminalView from '../terminal/TerminalView';
import CostDashboard from '../costs/CostDashboard';
import ComputerPanel from '../computer/ComputerPanel';
import DeviceLinkPanel from '../settings/DeviceLinkPanel';
import MemoryPanel from '../memory/MemoryPanel';
import RecorderPanel from '../recorder/RecorderPanel';
import { HenrySelfRepairBoundary as PanelBoundary } from '../HenrySelfRepairBoundary';
import PrinterPanel from '../computer/PrinterPanel';
import GoalsPanel from '../goals/GoalsPanel';
import HQPanel from '../hq/HQPanel';
import AutoSetupPanel from '../setup/AutoSetupPanel';
import TodayPanel from '../today/TodayPanel';
import CommandPalette from '../chat/CommandPalette';
import JournalPanel from '../journal/JournalPanel';
import MeetingRecorderPanel from '../recorder/MeetingRecorderPanel';
import ModesPanel from '../modes/ModesPanel';
import RemindersPanel from '../reminders/RemindersPanel';
import FinancePanel from '../finance/FinancePanel';
import PrintStudioPanel from '../printstudio/PrintStudioPanel';
import MachinesPanel from '../maker/MachinesPanel';
import MaterialsPanel from '../maker/MaterialsPanel';
import ProductionRunsPanel from '../maker/ProductionRunsPanel';
import WastePanel from '../maker/WastePanel';
import MaintenancePanel from '../maker/MaintenancePanel';
import QuotingPanel from '../quoting/QuotingPanel';
import RoutinesPanel from '../routines/RoutinesPanel';
import MediaLibraryPanel from '../media/MediaLibraryPanel';
import MarketplacePanel from '../marketplace/MarketplacePanel';
import AboutPanel from '../settings/AboutPanel';
import AuditLogPanel from '../agent/AuditLogPanel';
import BookEnginePanel from '../book/BookEnginePanel';
import SlicerPanel from '../slicer/SlicerPanel';
import ImageGenPanel from '../imagegen/ImageGenPanel';
import VideoGenPanel from '../videogen/VideoGenPanel';
import CapturesPanel from '../ambient/CapturesPanel';
import WeeklyReviewPanel from '../weekly/WeeklyReviewPanel';
import { useStore } from '../../store';
import { isHenryOperatingMode, type HenryOperatingMode } from '../../henry/charter';
import { useEffect } from 'react';

function CompanionUrlCard() {
  const [state, setState] = React.useState<{localIp?: string; tunnelUrl?: string; running?: boolean} | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    fetch('http://127.0.0.1:4242/sync/state-internal', { headers: {'X-Henry-Internal':'true'} })
      .then(r => r.json())
      .then((d: any) => setState({ localIp: d.localIp, tunnelUrl: d.tunnelUrl, running: d.running }))
      .catch(() => {});
  }, []);

  const localUrl = state?.localIp ? `http://${state.localIp}:4242` : 'http://192.168.x.x:4242';
  const tunnelUrl = state?.tunnelUrl || null;

  async function copy(url: string) {
    // writeText rejects with "Document is not focused" whenever the Henry
    // window is in the background, and this .then() had no .catch().
    if (await safeCopyToClipboard(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function openInBrowser(url: string) {
    // Copy to clipboard first (always works)
    navigator.clipboard?.writeText(url).catch(() => {});
    // Open through the main process. This used to shell out to
    // `open -a Safari "<url>"` over the loopback sync API, which is a
    // macOS-only command and silently did nothing on Linux and Windows.
    const api = (window as any).henryAPI;
    const opened = api?.computerOpenUrl ? api.computerOpenUrl(url) : Promise.resolve(null);
    Promise.resolve(opened)
      .then((r: { success?: boolean } | null) => {
        if (r && r.success === false) throw new Error('open failed');
        // Fallback: open in whatever browser the OS has
        if (!r) window.open(url, '_blank');
      })
      .catch(() => { window.open(url, '_blank'); });
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  }

  return (
    <div className="space-y-3">
      <div className="bg-henry-surface border border-henry-border/20 rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-green-400 text-sm">●</span>
          <p className="text-sm font-semibold text-henry-text">Open on same WiFi</p>
        </div>
        <div className="bg-henry-bg rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <p className="font-mono text-henry-accent text-sm font-bold">{localUrl}</p>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => copy(localUrl)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/15 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/25 transition-all">
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button onClick={() => openInBrowser(localUrl)}
              className="text-[11px] px-3 py-1.5 rounded-lg border border-henry-accent/30 bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all font-medium">
              📱 Open in Safari
            </button>
          </div>
        </div>
        <p className="text-[11px] text-henry-text-muted leading-relaxed">
          📱 iPhone/iPad: Open Safari (not Chrome), type this URL, then tap Share (□↑) → "Add to Home Screen" to install as an app.
        </p>
      </div>
      {tunnelUrl && (
        <div className="bg-henry-surface border border-henry-border/20 rounded-2xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-blue-400 text-sm">●</span>
            <p className="text-sm font-semibold text-henry-text">From anywhere</p>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-400/10 border border-blue-400/20 text-blue-400">Tunnel active</span>
          </div>
          <div className="bg-henry-bg rounded-xl px-3 py-2.5 flex items-center justify-between gap-2">
            <p className="font-mono text-henry-accent text-xs truncate">{tunnelUrl}</p>
            <button onClick={() => copy(tunnelUrl)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/15 border border-henry-accent/30 text-henry-accent flex-shrink-0">Copy</button>
          </div>
          <p className="text-[11px] text-henry-text-muted">Works over cellular. URL changes each restart.</p>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const currentView = useStore((s) => s.currentView);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    function openPalette() { setPaletteOpen(true); }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('henry:open-palette', openPalette);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('henry:open-palette', openPalette);
    };
  }, []);

  const handlePaletteSetMode = useCallback((mode: HenryOperatingMode) => {
    try { localStorage.setItem('henry_operating_mode', mode); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode, prompt: '' } }));
    useStore.getState().setCurrentView('chat');
  }, []);

  const handlePaletteNewChat = useCallback(() => {
    window.dispatchEvent(new CustomEvent('henry_new_chat', {}));
    useStore.getState().setCurrentView('chat');
  }, []);

  const handlePaletteInject = useCallback((mode: HenryOperatingMode, text: string) => {
    if (isHenryOperatingMode(mode)) {
      try { localStorage.setItem('henry_operating_mode', mode); } catch { /* ignore */ }
    }
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode, prompt: text } }));
    useStore.getState().setCurrentView('chat');
  }, []);

  return (
    <div className="h-full w-full flex flex-col bg-henry-bg overflow-hidden">
      <TitleBar />
      <PresenceBar />

      {/* Main body: sidebar (desktop) + content */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Sidebar: only visible on md+ */}
        <div className="hidden md:block">
          <Sidebar />
        </div>

        {/* Content — panel transition on view change */}
        <main key={currentView} className="flex-1 overflow-hidden min-h-0 henry-panel-enter">
          {currentView === 'today' && <PanelBoundary><TodayPanel /></PanelBoundary>}
          {currentView === 'chat' && <ChatView />}
          {currentView === 'journal' && <PanelBoundary><JournalPanel /></PanelBoundary>}
          {currentView === 'recorder' && <PanelBoundary><MeetingRecorderPanel /></PanelBoundary>}
          {currentView === 'modes' && <PanelBoundary><ModesPanel /></PanelBoundary>}
          {currentView === 'tasks' && <PanelBoundary><TasksPanel /></PanelBoundary>}
          {currentView === 'files' && <PanelBoundary><FileBrowser /></PanelBoundary>}
          {currentView === 'workspace' && <PanelBoundary><WorkspaceView /></PanelBoundary>}
          {currentView === 'terminal' && <PanelBoundary><TerminalView /></PanelBoundary>}
          {currentView === 'computer' && <PanelBoundary><ComputerPanel /></PanelBoundary>}
          {currentView === 'printer' && <PanelBoundary><PrinterPanel /></PanelBoundary>}
          {currentView === 'costs' && <PanelBoundary><CostDashboard /></PanelBoundary>}
          {currentView === 'settings' && <PanelBoundary><SettingsView /></PanelBoundary>}
          {currentView === 'health' && <PanelBoundary><HealthPanel /></PanelBoundary>}
          {currentView === 'companion' && (
            <div className="h-full overflow-y-auto px-5 py-5 max-w-lg space-y-5">
              <div>
                <h2 className="text-lg font-bold text-henry-text">Henry AI — Phone &amp; Tablet</h2>
                <p className="text-xs text-henry-text-muted mt-1">Henry AI works as a standalone app on your iPhone and iPad. No App Store needed.</p>
              </div>

              {/* Step 1: Open on phone */}
              <div className="bg-henry-surface/40 border border-henry-border/15 rounded-2xl p-4 space-y-3">
                <p className="text-xs font-semibold text-henry-text uppercase tracking-wider">Step 1 — Open on your iPhone or iPad</p>
                <CompanionUrlCard />
                <p className="text-[11px] text-henry-text-muted leading-relaxed">
                  Both devices must be on the same WiFi. Open the URL above in Safari (not Chrome).
                </p>
              </div>

              {/* Step 2: Install as app */}
              <div className="bg-henry-accent/8 border border-henry-accent/20 rounded-2xl p-4 space-y-3">
                <p className="text-xs font-semibold text-henry-accent uppercase tracking-wider">Step 2 — Install as an App</p>
                <div className="space-y-2.5">
                  {[
                    { icon: '1', text: 'Tap the Share button (□↑) at the bottom of Safari' },
                    { icon: '2', text: 'Scroll down and tap "Add to Home Screen"' },
                    { icon: '3', text: 'Tap "Add" — Henry AI appears on your home screen' },
                    { icon: '4', text: 'Open it from your home screen — runs full-screen like a native app' },
                  ].map(step => (
                    <div key={step.icon} className="flex items-start gap-3">
                      <span className="w-5 h-5 rounded-full bg-henry-accent text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{step.icon}</span>
                      <p className="text-xs text-henry-text leading-relaxed">{step.text}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* QR code */}
              <details className="group">
                <summary className="text-xs text-henry-text-muted cursor-pointer hover:text-henry-text transition-all list-none flex items-center gap-1">
                  <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                  Scan QR code instead of typing the URL
                </summary>
                <div className="mt-3">
                  <DeviceLinkPanel />
                </div>
              </details>

              {/* What's available */}
              <div className="bg-henry-surface/30 border border-henry-border/10 rounded-2xl p-4">
                <p className="text-xs font-semibold text-henry-text mb-2">What's in the app</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {['💬 Chat with Henry','☀️ Today & Habits','✓ Tasks (add/complete)','⏰ Reminders','📔 Journal entries','❤️ Health logging','◎ Goals','💰 Finance','⊕ Smart capture'].map(f => (
                    <p key={f} className="text-[11px] text-henry-text-muted">{f}</p>
                  ))}
                </div>
              </div>
            </div>
          )}
          {currentView === 'reminders' && <PanelBoundary><RemindersPanel /></PanelBoundary>}
          {currentView === 'finance' && <PanelBoundary><FinancePanel /></PanelBoundary>}
          {currentView === 'goals' && <PanelBoundary><GoalsPanel /></PanelBoundary>}
          {currentView === 'hq' && <PanelBoundary><HQPanel /></PanelBoundary>}
          {currentView === 'setup' && <PanelBoundary><AutoSetupPanel /></PanelBoundary>}
          {currentView === 'printstudio' && <PanelBoundary><PrintStudioPanel /></PanelBoundary>}
          {currentView === 'machines' && <PanelBoundary><MachinesPanel /></PanelBoundary>}
          {currentView === 'materials' && <PanelBoundary><MaterialsPanel /></PanelBoundary>}
          {currentView === 'production' && <PanelBoundary><ProductionRunsPanel /></PanelBoundary>}
          {currentView === 'waste' && <PanelBoundary><WastePanel /></PanelBoundary>}
          {currentView === 'maintenance' && <PanelBoundary><MaintenancePanel /></PanelBoundary>}
          {currentView === 'quoting' && <PanelBoundary><QuotingPanel /></PanelBoundary>}
          {currentView === 'routines' && <PanelBoundary><RoutinesPanel /></PanelBoundary>}
          {currentView === 'media' && <PanelBoundary><MediaLibraryPanel /></PanelBoundary>}
          {currentView === 'marketplace' && <PanelBoundary><MarketplacePanel /></PanelBoundary>}
          {currentView === 'about' && <PanelBoundary><AboutPanel /></PanelBoundary>}
          {currentView === 'audit' && <PanelBoundary><AuditLogPanel /></PanelBoundary>}
          {currentView === 'book' && <PanelBoundary><BookEnginePanel /></PanelBoundary>}
          {currentView === 'slicer' && <PanelBoundary><SlicerPanel /></PanelBoundary>}
          {currentView === 'imagegen' && <PanelBoundary><ImageGenPanel /></PanelBoundary>}
      {currentView === 'videogen' && <PanelBoundary><VideoGenPanel /></PanelBoundary>}
          {currentView === 'captures' && <PanelBoundary><CapturesPanel /></PanelBoundary>}
          {currentView === 'memory' && <PanelBoundary><MemoryPanel /></PanelBoundary>}
          {/* Fix H: 'recorder' is already taken by MeetingRecorderPanel above.
              SQLite-backed RecorderPanel (voice memos) gets its own route. */}
          {currentView === 'memos' && <PanelBoundary><RecorderPanel /></PanelBoundary>}
          {/* Fix H: TaskQueueView was imported but had no render branch — exposed under 'queue'. */}
          {currentView === 'queue' && <PanelBoundary><TaskQueueView /></PanelBoundary>}
          {currentView === 'approvals' && <PanelBoundary><ApprovalQueuePanel /></PanelBoundary>}
          {currentView === 'weekly' && <PanelBoundary><WeeklyReviewPanel /></PanelBoundary>}
        </main>
      </div>

      {/* Mobile bottom nav — in-flow so content naturally sits above it */}
      <MobileNav />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSetMode={handlePaletteSetMode}
        onNewChat={handlePaletteNewChat}
        onInjectPrompt={handlePaletteInject}
      />
    </div>
  );
}
