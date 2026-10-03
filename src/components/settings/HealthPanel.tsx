import { useState, useEffect } from 'react';
import { isMacOS, isLinux, isWindows } from '../../utils/platform';

interface CheckEntry {
  id: string;
  name: string;
  category: string;
  status: 'ok' | 'warning' | 'error' | 'fixed' | 'fix_failed';
  detail?: string;
  version?: string;
  fixMessage?: string;
}

interface DiagnosticReport {
  timestamp: string;
  checks: CheckEntry[];
  summary: { ok: number; fixed: number; failed: number; warnings: number };
}

interface RegisteredHotkey {
  accelerator: string;
  label: string;
  description: string;
}

interface CapabilityStatus {
  status: 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable';
  backend?: string;
  details?: string;
  regionCapture?: boolean;
  windowCapture?: boolean;
}

interface CapabilitiesReport {
  platform: string;
  session?: { type: string; isWayland: boolean; isWSL: boolean };
  clipboard: CapabilityStatus;
  selectedText: CapabilityStatus;
  screenCapture: CapabilityStatus;
  inputAutomation: CapabilityStatus;
}

const getApi = () => (window as any).henryAPI as any;

const STATUS_ICON: Record<string, string> = {
  ok: '✓',
  fixed: '⚡',
  warning: '⚠',
  error: '✗',
  fix_failed: '✗',
};
const STATUS_COLOR: Record<string, string> = {
  ok: 'text-green-400',
  fixed: 'text-henry-accent',
  warning: 'text-yellow-400',
  error: 'text-red-400',
  fix_failed: 'text-red-400',
};
const CAT_LABEL: Record<string, string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional',
};

const CAP_STATUS_ICON: Record<string, string> = {
  ready: '✓',
  degraded: '⚠',
  'dependency-missing': '✗',
  'unsupported-session': '⚠',
  unavailable: '✗',
};
const CAP_STATUS_COLOR: Record<string, string> = {
  ready: 'text-green-400',
  degraded: 'text-yellow-400',
  'dependency-missing': 'text-red-400',
  'unsupported-session': 'text-yellow-400',
  unavailable: 'text-red-400',
};

const CAP_LABEL: Record<string, string> = {
  clipboard: 'Clipboard',
  selectedText: 'Selected Text Capture',
  screenCapture: 'Screen Capture',
  inputAutomation: 'Input Automation',
};

function renderCapability(cap: CapabilityStatus, label: string) {
  const icon = CAP_STATUS_ICON[cap.status] || '?';
  const color = CAP_STATUS_COLOR[cap.status] || 'text-gray-400';
  return (
    <div key={label} className="flex items-center gap-3 p-2 rounded-lg bg-henry-bg/50 border border-henry-border/10">
      <span className={`text-sm font-bold flex-shrink-0 ${color}`}>{icon}</span>
      <span className="text-sm font-medium text-henry-text w-48">{label}</span>
      <span className={`text-xs ${color} font-mono px-2 py-0.5 rounded bg-henry-bg/30`}>{cap.status}</span>
      {cap.backend && (
        <span className="text-xs text-henry-text-muted font-mono flex-1 truncate">{cap.backend}</span>
      )}
      {cap.details && (
        <span className="text-[10px] text-henry-text-muted/70 flex-1 truncate">{cap.details}</span>
      )}
      {cap.regionCapture !== undefined && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded ${cap.regionCapture ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          Region: {cap.regionCapture ? '✓' : '✗'}
        </span>
      )}
      {cap.windowCapture !== undefined && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded ${cap.windowCapture ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          Window: {cap.windowCapture ? '✓' : '✗'}
        </span>
      )}
    </div>
  );
}

export default function HealthPanel() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [hotkeys, setHotkeys] = useState<RegisteredHotkey[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilitiesReport | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);

  useEffect(() => {
    // Load last report on mount
    void (async () => {
      try {
        const last = await getApi()?.getLastDiagnostic();
        if (last) { setReport(last); setLastRun(last.timestamp); }
      } catch { /* no report yet */ }
    })();

    // Load registered hotkeys
    void (async () => {
      try {
        const hk = await getApi()?.getRegisteredHotkeys?.();
        if (hk) setHotkeys(hk);
      } catch { /* ignore */ }
    })();

    // Load capabilities
    void (async () => {
      setCapsLoading(true);
      try {
        const caps = await getApi()?.computerCheckCapabilities?.();
        if (caps) setCapabilities(caps);
      } catch { /* ignore */ }
      finally { setCapsLoading(false); }
    })();

    // Listen for background diagnostic completion
    const handler = (_: any, r: DiagnosticReport) => { setReport(r); setLastRun(r.timestamp); };
    window.addEventListener('henry:diagnostic:complete', (e: any) => handler(null, e.detail));
    return () => window.removeEventListener('henry:diagnostic:complete', handler as any);
  }, []);

  async function runNow() {
    setRunning(true);
    try {
      const r = await getApi()?.runDiagnostic();
      setReport(r); setLastRun(r.timestamp);
    } catch { /* ignore */ }
    setRunning(false);
  }

  const grouped = report ? {
    required: report.checks.filter(c => c.category === 'required'),
    recommended: report.checks.filter(c => c.category === 'recommended'),
    optional: report.checks.filter(c => c.category === 'optional'),
  } : null;

  return (
    <div className="flex flex-col h-full bg-henry-bg overflow-y-auto">
      <div className="px-6 pt-5 pb-4 border-b border-henry-border/20 flex items-start justify-between flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-henry-text">Henry Health</h1>
          <p className="text-[11px] text-henry-text-muted mt-0.5">
            {lastRun ? `Last checked ${new Date(lastRun).toLocaleTimeString()}` : 'Henry checks himself on every launch and fixes what he can.'}
          </p>
        </div>
        <button
          onClick={runNow}
          disabled={running}
          className="text-[12px] px-4 py-2 rounded-xl bg-henry-accent/10 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/20 transition-all disabled:opacity-40 font-semibold"
        >{running ? 'Checking…' : '↻ Run Check'}</button>
      </div>

      {!report && !running && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-4xl mb-3">🔧</p>
            <p className="text-henry-text-muted text-sm">Henry checks himself every launch.</p>
            <p className="text-henry-text-muted text-xs mt-1">Click "Run Check" to see status now.</p>
            <button onClick={runNow} className="mt-4 text-[12px] px-5 py-2 rounded-xl bg-henry-accent text-white font-semibold hover:bg-henry-accent/80 transition-all">
              Run Diagnostic
            </button>
          </div>
        </div>
      )}

      {running && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-henry-accent text-sm animate-pulse">Henry is checking and fixing…</p>
          </div>
        </div>
      )}

      {report && !running && (
        <div className="px-6 py-4 space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Healthy', value: report.summary.ok, color: 'text-green-400' },
              { label: 'Auto-Fixed', value: report.summary.fixed, color: 'text-henry-accent' },
              { label: 'Warnings', value: report.summary.warnings, color: 'text-yellow-400' },
              { label: 'Needs Attention', value: report.summary.failed, color: 'text-red-400' },
            ].map(s => (
              <div key={s.label} className="bg-henry-surface rounded-xl border border-henry-border/20 p-3 text-center">
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-henry-text-muted mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Global Hotkeys — shows actually registered shortcuts */}
          {hotkeys.length > 0 && (
            <div className="bg-henry-surface rounded-xl border border-henry-border/20 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-text-muted mb-3">Global Hotkeys</p>
              <div className="space-y-2">
                {hotkeys.map((hk, i) => (
                  <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-henry-bg/50 border border-henry-border/10">
                    <span className="font-mono text-xs bg-henry-accent/20 border border-henry-accent/30 text-henry-accent px-2 py-0.5 rounded">{hk.label}</span>
                    <span className="text-sm text-henry-text">{hk.description}</span>
                    <span className="text-[10px] text-henry-text-muted font-mono ml-auto">{hk.accelerator}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Desktop Capabilities — cross-platform capability status */}
          {capabilities && (
            <div className="bg-henry-surface rounded-xl border border-henry-border/20 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-text-muted">Desktop Capabilities</p>
                {capabilities?.session && (
                  <span className="text-[9px] text-henry-text-muted font-mono">
                    {capabilities.session.type} {capabilities.session.isWayland ? '(Wayland)' : ''} {capabilities.session.isWSL ? '(WSL)' : ''}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {renderCapability(capabilities.clipboard, 'Clipboard')}
                {renderCapability(capabilities.selectedText, 'Selected Text')}
                {renderCapability(capabilities.screenCapture, 'Screen Capture')}
                {renderCapability(capabilities.inputAutomation, 'Input Automation')}
              </div>
            </div>
          )}
          {capsLoading && !capabilities && (
            <div className="bg-henry-surface rounded-xl border border-henry-border/20 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-text-muted">Desktop Capabilities</p>
                <span className="text-[10px] text-henry-accent animate-pulse">Checking…</span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-3 p-2 rounded-lg bg-henry-bg/50 border border-henry-border/10 animate-pulse">
                  <span className="text-sm font-bold flex-shrink-0 text-gray-400">⟳</span>
                  <span className="text-sm font-medium text-henry-text w-48">Clipboard</span>
                  <span className="text-xs text-gray-400 font-mono px-2 py-0.5 rounded bg-henry-bg/30">loading</span>
                </div>
                <div className="flex items-center gap-3 p-2 rounded-lg bg-henry-bg/50 border border-henry-border/10 animate-pulse">
                  <span className="text-sm font-bold flex-shrink-0 text-gray-400">⟳</span>
                  <span className="text-sm font-medium text-henry-text w-48">Selected Text</span>
                  <span className="text-xs text-gray-400 font-mono px-2 py-0.5 rounded bg-henry-bg/30">loading</span>
                </div>
                <div className="flex items-center gap-3 p-2 rounded-lg bg-henry-bg/50 border border-henry-border/10 animate-pulse">
                  <span className="text-sm font-bold flex-shrink-0 text-gray-400">⟳</span>
                  <span className="text-sm font-medium text-henry-text w-48">Screen Capture</span>
                  <span className="text-xs text-gray-400 font-mono px-2 py-0.5 rounded bg-henry-bg/30">loading</span>
                </div>
                <div className="flex items-center gap-3 p-2 rounded-lg bg-henry-bg/50 border border-henry-border/10 animate-pulse">
                  <span className="text-sm font-bold flex-shrink-0 text-gray-400">⟳</span>
                  <span className="text-sm font-medium text-henry-text w-48">Input Automation</span>
                  <span className="text-xs text-gray-400 font-mono px-2 py-0.5 rounded bg-henry-bg/30">loading</span>
                </div>
              </div>
            </div>
          )}

          {/* Check groups */}
          {(['required', 'recommended', 'optional'] as const).map(cat => {
            const checks = grouped![cat];
            if (checks.length === 0) return null;
            return (
              <div key={cat}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-henry-text-muted mb-2">{CAT_LABEL[cat]}</p>
                <div className="space-y-1.5">
                  {checks.map(c => (
                    <div key={c.id} className={`flex items-start gap-3 p-3 rounded-xl border ${
                      c.status === 'ok' ? 'bg-henry-surface/20 border-henry-border/10'
                      : c.status === 'fixed' ? 'bg-henry-accent/5 border-henry-accent/20'
                      : c.status === 'warning' ? 'bg-yellow-400/5 border-yellow-400/20'
                      : 'bg-red-400/5 border-red-400/20'
                    }`}>
                      <span className={`text-sm font-bold flex-shrink-0 mt-0.5 ${STATUS_COLOR[c.status]}`}>
                        {STATUS_ICON[c.status]}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-henry-text">{c.name}</p>
                          {c.version && <span className="text-[10px] text-henry-text-muted font-mono">{c.version.slice(0, 20)}</span>}
                        </div>
                        {c.detail && <p className="text-[11px] text-henry-text-muted mt-0.5">{c.detail}</p>}
                        {c.fixMessage && (
                          <p className={`text-[11px] mt-0.5 ${c.status === 'fixed' ? 'text-henry-accent' : 'text-red-400'}`}>
                            {c.status === 'fixed' ? '⚡ ' : '✗ '}{c.fixMessage}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
