import { useState, useEffect, useRef } from 'react';
import PrinterDiscovery from './PrinterDiscovery';

interface PrinterPort {
  device: string;
  description: string;
  hwid: string;
}

interface PrinterLog {
  id: string;
  type: 'sent' | 'response' | 'error' | 'info' | 'disconnected';
  data: string;
  timestamp: number;
}

interface PrinterTemps {
  nozzle: number | null;
  nozzleTarget: number | null;
  bed: number | null;
  bedTarget: number | null;
}

const QUICK_ACTIONS = [
  { label: 'Check temps', code: 'M105', icon: '🌡️', desc: 'Read current temperatures' },
  { label: 'Home all', code: 'G28', icon: '🏠', desc: 'Home X, Y and Z axes' },
  { label: 'Preheat PLA', code: 'M104 S210\nM140 S60', icon: '🔥', desc: 'Nozzle 210 · Bed 60' },
  { label: 'Preheat PETG', code: 'M104 S235\nM140 S75', icon: '🔥', desc: 'Nozzle 235 · Bed 75' },
  { label: 'Cool down', code: 'M104 S0\nM140 S0\nM106 S0', icon: '❄️', desc: 'Turn off all heaters' },
  { label: 'Level bed', code: 'G29', icon: '⬛', desc: 'Auto bed leveling' },
  { label: 'Motors off', code: 'M18', icon: '⏹️', desc: 'Release stepper motors' },
  { label: 'Fan full', code: 'M106 S255', icon: '💨', desc: 'Part cooling fan 100%' },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Parse Marlin M105 response: T:210.5 /210.0 B:60.1 /60.0 */
function parseTemps(data: string): Partial<PrinterTemps> {
  const result: Partial<PrinterTemps> = {};
  const nozzle = data.match(/(?:T0?):(-?\d+\.?\d*)\s*\/(-?\d+\.?\d*)/);
  const bed    = data.match(/B:(-?\d+\.?\d*)\s*\/(-?\d+\.?\d*)/);
  if (nozzle) {
    result.nozzle       = parseFloat(nozzle[1]);
    result.nozzleTarget = parseFloat(nozzle[2]);
  }
  if (bed) {
    result.bed       = parseFloat(bed[1]);
    result.bedTarget = parseFloat(bed[2]);
  }
  return result;
}

function TempGauge({ label, current, target }: { label: string; current: number | null; target: number | null }) {
  const hasData = current !== null;
  const pct = target && target > 0 ? Math.min(100, ((current ?? 0) / target) * 100) : 0;
  const atTemp = hasData && target !== null && target > 0 && Math.abs((current ?? 0) - target) < 3;
  const heating = hasData && target !== null && target > 0 && !atTemp;

  return (
    <div className="rounded-xl bg-henry-bg/60 border border-henry-border/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wider">{label}</span>
        {heating && <span className="text-[10px] text-henry-warning animate-pulse font-medium">Heating…</span>}
        {atTemp   && <span className="text-[10px] text-henry-success font-medium">At temp ✓</span>}
      </div>
      <div className="flex items-end justify-between">
        <span className={`text-2xl font-bold tabular-nums ${hasData ? 'text-henry-text' : 'text-henry-text-muted/40'}`}>
          {hasData ? `${Math.round(current!)}°` : '—'}
        </span>
        {target !== null && target > 0 && (
          <span className="text-xs text-henry-text-muted">/ {Math.round(target)}°</span>
        )}
      </div>
      {target !== null && target > 0 && (
        <div className="h-1 rounded-full bg-henry-surface overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${atTemp ? 'bg-henry-success' : heating ? 'bg-henry-warning' : 'bg-henry-surface'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function PrinterPanel() {
  const [ports, setPorts] = useState<PrinterPort[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [depsOk, setDepsOk] = useState<boolean | null>(null);
  const [depsInstall, setDepsInstall] = useState('pip3 install pyserial');
  const [log, setLog] = useState<PrinterLog[]>([]);
  const [gcodeInput, setGcodeInput] = useState('');
  const [sending, setSending] = useState(false);
  const [printGcode, setPrintGcode] = useState('');
  const [printing, setPrinting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPrintJob, setShowPrintJob] = useState(false);
  const [connectedTab, setConnectedTab] = useState<'status' | 'actions' | 'console'>('status');
  const [temps, setTemps] = useState<PrinterTemps>({ nozzle: null, nozzleTarget: null, bed: null, bedTarget: null });
  const [printerInfo, setPrinterInfo] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The unsubscribe was discarded, so every mount (doubled under StrictMode)
    // left another live 'printer:data' listener behind.
    const unsubscribe = setupListener();
    checkDepsAndScan();
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  function addLog(type: PrinterLog['type'], data: string) {
    setLog((prev) => [...prev, { id: crypto.randomUUID(), type, data, timestamp: Date.now() }]);
    // Parse temperatures from M105 responses
    if (type === 'response') {
      const parsed = parseTemps(data);
      if (Object.keys(parsed).length > 0) {
        setTemps((prev) => ({ ...prev, ...parsed }));
      }
      // Capture firmware info from M115
      if (data.startsWith('FIRMWARE_NAME:') || data.includes('FIRMWARE_NAME')) {
        const name = data.match(/FIRMWARE_NAME:(.*?)(?:\s+FIRMWARE_VERSION|$)/)?.[1]?.trim() ?? null;
        if (name) setPrinterInfo(name);
      }
    }
  }

  function setupListener(): () => void {
    return window.henryAPI.onPrinterData((data: any) => {
      if (data.type === 'disconnected') {
        setConnected(false);
        addLog('disconnected', 'Printer disconnected.');
      } else if (data.type === 'response') {
        addLog('response', data.data || '');
      } else if (data.type === 'sent') {
        addLog('sent', `→ ${data.data}`);
      } else if (data.type === 'error') {
        addLog('error', data.data || 'Unknown error');
      }
    });
  }

  async function checkDepsAndScan() {
    try {
      const result = await window.henryAPI.printerCheckDeps();
      setDepsOk(result.available);
      if (!result.available && result.installCommand) setDepsInstall(result.installCommand);
    } catch {
      setDepsOk(false);
    }
    // Always scan for ports — the IPC handler uses a native ls fallback when pyserial is missing.
    // This lets the user see connected printers and get a clearer error if they try to connect.
    scanForPrinters();
  }

  async function checkDeps() {
    try {
      const result = await window.henryAPI.printerCheckDeps();
      setDepsOk(result.available);
      if (!result.available && result.installCommand) setDepsInstall(result.installCommand);
      if (result.available) scanForPrinters();
    } catch {
      setDepsOk(false);
    }
  }

  async function scanForPrinters() {
    setScanning(true);
    try {
      const result = await window.henryAPI.printerListPorts();
      if (result.ports) {
        setPorts(result.ports);
        if (result.ports.length >= 1) setSelectedPort(result.ports[0].device);
        addLog('info', result.ports.length === 0
          ? 'No printers found. Make sure your printer is plugged in via USB, then scan again.'
          : `Found ${result.ports.length} printer${result.ports.length !== 1 ? 's' : ''}. Ready to connect.`
        );
      }
    } catch (e: any) {
      addLog('error', e.message);
    } finally {
      setScanning(false);
    }
  }

  async function connectToPrinter(port?: string) {
    const targetPort = port || selectedPort;
    if (!targetPort) return;
    setSelectedPort(targetPort);
    setConnecting(true);
    addLog('info', 'Connecting to printer…');
    try {
      const result = await window.henryAPI.printerConnect({ port: targetPort, baudRate });
      if (result.success) {
        setConnected(true);
        setConnectedTab('status');
        addLog('info', 'Connected — checking printer…');
        await sendGcode('M115'); // firmware info
        await sendGcode('M105'); // temperatures
      } else {
        addLog('error', result.error || 'Connection failed. Try unplugging and replugging the USB cable.');
      }
    } catch (e: any) {
      addLog('error', e.message);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    try {
      await window.henryAPI.printerDisconnect();
      setConnected(false);
      setTemps({ nozzle: null, nozzleTarget: null, bed: null, bedTarget: null });
      setPrinterInfo(null);
      addLog('info', 'Disconnected.');
    } catch (e: any) {
      addLog('error', e.message);
    }
  }

  async function sendGcode(cmd?: string) {
    const command = (cmd ?? gcodeInput).trim();
    if (!command || sending) return;
    if (!cmd) setGcodeInput('');
    setSending(true);
    try {
      const lines = command.split('\n').filter(Boolean);
      for (const line of lines) {
        const result = await window.henryAPI.printerSendGcode(line);
        if (!result.success) addLog('error', result.error || 'Send failed.');
      }
    } catch (e: any) {
      addLog('error', e.message);
    } finally {
      setSending(false);
    }
  }

  async function startPrint() {
    if (!printGcode.trim()) return;
    setPrinting(true);
    addLog('info', 'Starting print job…');
    try {
      const result = await window.henryAPI.printerPrintGcode(printGcode);
      if (result.success) {
        addLog('info', `Print job started — ${result.sent}/${result.total} commands sent.`);
      } else {
        addLog('error', result.error || 'Print failed.');
      }
    } catch (e: any) {
      addLog('error', e.message);
    } finally {
      setPrinting(false);
    }
  }

  async function refreshTemps() {
    await sendGcode('M105');
  }

  return (
    <div className="h-full flex flex-col bg-henry-bg text-henry-text overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-henry-border/40 bg-henry-surface/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-2xl">🖨️</div>
            <div>
              <h2 className="text-base font-semibold text-henry-text">3D Printer</h2>
              <p className="text-xs text-henry-text-muted">
                {connected
                  ? (printerInfo ? printerInfo.slice(0, 40) : 'Connected and ready')
                  : 'Not connected'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected && (
              <>
                <span className="flex items-center gap-1.5 text-xs font-medium text-henry-success bg-henry-success/10 border border-henry-success/20 px-3 py-1 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-henry-success animate-pulse" />
                  Connected
                </span>
                <button
                  onClick={disconnect}
                  className="px-3 py-1.5 text-xs rounded-lg bg-henry-error/10 border border-henry-error/30 text-henry-error hover:bg-henry-error/20 transition-colors"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* ─── NOT CONNECTED: discovery wizard ─────────────────────────────── */}
          {!connected && (
            <div className="flex-1 overflow-y-auto">
              <div className="p-6 max-w-lg mx-auto space-y-5">

                {/* Network discovery — find printers on WiFi (build plan, 3D area). */}
                <PrinterDiscovery />

                {ports.length === 0 ? (
                  <div className="text-center py-8 space-y-4">
                    <div className="w-20 h-20 rounded-full bg-henry-surface/30 border border-henry-border/30 flex items-center justify-center text-4xl mx-auto">🖨️</div>
                    <div>
                      <p className="text-base font-semibold text-henry-text">Plug in your printer</p>
                      <p className="text-xs text-henry-text-muted mt-1 max-w-xs mx-auto">
                        Connect via USB. Works with Marlin, Klipper, Prusa, Bambu, Creality, and most USB printers.
                      </p>
                    </div>
                    <button
                      onClick={scanForPrinters}
                      disabled={scanning}
                      className="inline-flex items-center gap-2 px-6 py-3 bg-henry-accent text-white rounded-xl text-sm font-semibold hover:bg-henry-accent/90 transition-colors disabled:opacity-50"
                    >
                      {scanning ? (
                        <>
                          <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                          Scanning…
                        </>
                      ) : '🔍 Find my printer'}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-henry-text">
                          {ports.length === 1 ? 'Printer found' : `${ports.length} printers found`}
                        </p>
                        <p className="text-xs text-henry-text-muted">Select a printer to connect</p>
                      </div>
                      <button
                        onClick={scanForPrinters}
                        disabled={scanning}
                        className="text-xs text-henry-accent hover:underline"
                      >
                        {scanning ? 'Scanning…' : '↻ Scan again'}
                      </button>
                    </div>

                    {/* Pyserial soft warning — shown only when pyserial is missing */}
                    {depsOk === false && (
                      <div className="p-3 rounded-xl bg-henry-warning/5 border border-henry-warning/20 space-y-1">
                        <p className="text-xs font-medium text-henry-warning">One-time setup needed to connect</p>
                        <p className="text-[11px] text-henry-text-dim">Run in your terminal, then click check again:</p>
                        <code className="text-[11px] text-henry-accent bg-henry-bg px-2 py-1 rounded block">{depsInstall}</code>
                        <button onClick={checkDepsAndScan} className="text-[11px] text-henry-accent hover:underline">Check again →</button>
                      </div>
                    )}

                    <div className="space-y-2">
                      {ports.map((port) => (
                        <div
                          key={port.device}
                          className={`flex items-center gap-3 p-4 rounded-xl border transition-all ${
                            selectedPort === port.device
                              ? 'bg-henry-accent/5 border-henry-accent/30'
                              : 'bg-henry-surface/30 border-henry-border/30 hover:border-henry-border/50'
                          }`}
                        >
                          <div className="w-10 h-10 rounded-xl bg-henry-surface/60 flex items-center justify-center text-xl shrink-0">🖨️</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-henry-text truncate">
                              {port.description || 'USB Serial Device'}
                            </p>
                            <p className="text-xs text-henry-text-muted font-mono">{port.device}</p>
                          </div>
                          <button
                            onClick={() => depsOk ? connectToPrinter(port.device) : undefined}
                            disabled={connecting || depsOk === false}
                            title={depsOk === false ? `Install pyserial first: ${depsInstall}` : undefined}
                            className={`shrink-0 px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${
                              depsOk === false
                                ? 'bg-henry-surface border border-henry-border text-henry-text-muted cursor-not-allowed'
                                : 'bg-henry-accent text-white hover:bg-henry-accent/90'
                            }`}
                          >
                            {connecting && selectedPort === port.device ? (
                              <span className="flex items-center gap-1.5">
                                <div className="w-3 h-3 rounded-full border border-white/30 border-t-white animate-spin" />
                                Connecting…
                              </span>
                            ) : depsOk === false ? 'Setup needed' : 'Connect'}
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Advanced baud/port settings */}
                    <div>
                      <button
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="flex items-center gap-1.5 text-xs text-henry-text-muted hover:text-henry-text transition-colors"
                      >
                        <svg className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        Advanced settings
                      </button>
                      {showAdvanced && (
                        <div className="mt-3 pl-4 border-l border-henry-border/30 space-y-3">
                          <div>
                            <label className="block text-xs font-medium text-henry-text-dim mb-1">Port</label>
                            <select
                              value={selectedPort}
                              onChange={(e) => setSelectedPort(e.target.value)}
                              className="w-full bg-henry-bg border border-henry-border rounded-lg px-3 py-2 text-xs text-henry-text outline-none focus:border-henry-accent/50"
                            >
                              {ports.map((p) => (
                                <option key={p.device} value={p.device}>{p.device} — {p.description || 'Serial Device'}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-henry-text-dim mb-1">Baud rate</label>
                            <select
                              value={baudRate}
                              onChange={(e) => setBaudRate(Number(e.target.value))}
                              className="w-full bg-henry-bg border border-henry-border rounded-lg px-3 py-2 text-xs text-henry-text outline-none focus:border-henry-accent/50"
                            >
                              {[9600, 19200, 38400, 57600, 115200, 250000].map((b) => (
                                <option key={b} value={b}>{b}</option>
                              ))}
                            </select>
                            <p className="text-[11px] text-henry-text-muted mt-1">Most printers use 115200. Try 250000 for Prusa/Creality.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Error/info log — compact, below the wizard */}
                {log.some((e) => e.type === 'error' || e.type === 'info') && (
                  <div className="rounded-xl bg-henry-surface/20 border border-henry-border/20 p-3 font-mono text-xs space-y-0.5 max-h-24 overflow-y-auto">
                    {log.filter((e) => e.type === 'error' || e.type === 'info').slice(-6).map((entry) => (
                      <div key={entry.id} className={`leading-relaxed ${entry.type === 'error' ? 'text-henry-error' : 'text-henry-text-muted'}`}>
                        {entry.data}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── CONNECTED: status dashboard ─────────────────────────────────── */}
          {connected && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Sub-tabs */}
              <div className="shrink-0 flex gap-1 px-4 pt-3 pb-2 border-b border-henry-border/30">
                {([
                  { id: 'status',  label: '📊 Status' },
                  { id: 'actions', label: '⚡ Quick Actions' },
                  { id: 'console', label: '💻 Console' },
                ] as const).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setConnectedTab(t.id)}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-all ${
                      connectedTab === t.id
                        ? 'bg-henry-accent/10 text-henry-accent border border-henry-accent/20'
                        : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/50'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
                {/* Emergency stop always visible */}
                <button
                  onClick={() => sendGcode('M112')}
                  disabled={sending}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-henry-error/10 border border-henry-error/30 text-henry-error hover:bg-henry-error/20 transition-colors font-semibold disabled:opacity-40"
                >
                  ■ Emergency Stop
                </button>
              </div>

              {/* STATUS TAB */}
              {connectedTab === 'status' && (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-henry-text">Temperatures</p>
                    <button
                      onClick={refreshTemps}
                      disabled={sending}
                      className="flex items-center gap-1 text-xs text-henry-accent hover:underline disabled:opacity-40"
                    >
                      ↻ Refresh
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <TempGauge label="Nozzle" current={temps.nozzle} target={temps.nozzleTarget} />
                    <TempGauge label="Bed" current={temps.bed} target={temps.bedTarget} />
                  </div>

                  {temps.nozzle === null && temps.bed === null && (
                    <div className="rounded-xl bg-henry-surface/20 border border-henry-border/20 p-4 text-center">
                      <p className="text-xs text-henry-text-muted">Temperature data will appear here once it's received from the printer.</p>
                      <button onClick={refreshTemps} className="mt-2 text-xs text-henry-accent hover:underline">
                        Request temperatures →
                      </button>
                    </div>
                  )}

                  {/* Heater controls */}
                  <div>
                    <p className="text-xs font-semibold text-henry-text mb-2">Heater presets</p>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: 'Preheat PLA', code: 'M104 S210\nM140 S60', icon: '🔥', desc: '210° / 60°' },
                        { label: 'Preheat PETG', code: 'M104 S235\nM140 S75', icon: '🔥', desc: '235° / 75°' },
                        { label: 'Preheat ABS', code: 'M104 S245\nM140 S110', icon: '🔥', desc: '245° / 110°' },
                        { label: 'Cool down', code: 'M104 S0\nM140 S0\nM106 S0', icon: '❄️', desc: 'All heaters off' },
                      ].map((a) => (
                        <button
                          key={a.label}
                          onClick={() => sendGcode(a.code)}
                          disabled={sending}
                          className="text-left p-3 rounded-xl bg-henry-surface/30 border border-henry-border/30 hover:border-henry-accent/30 hover:bg-henry-surface/50 transition-all disabled:opacity-40 group"
                        >
                          <p className="text-sm">{a.icon} <span className="text-xs font-medium text-henry-text group-hover:text-henry-accent">{a.label}</span></p>
                          <p className="text-[10px] text-henry-text-muted mt-0.5">{a.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {printerInfo && (
                    <div className="rounded-xl bg-henry-surface/20 border border-henry-border/20 p-3">
                      <p className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wide mb-1">Firmware</p>
                      <p className="text-xs text-henry-text-dim font-mono">{printerInfo}</p>
                    </div>
                  )}
                </div>
              )}

              {/* ACTIONS TAB */}
              {connectedTab === 'actions' && (
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="grid grid-cols-2 gap-2">
                    {QUICK_ACTIONS.map((action) => (
                      <button
                        key={action.label}
                        onClick={() => sendGcode(action.code)}
                        disabled={sending}
                        className="text-left p-3 rounded-xl bg-henry-surface/30 border border-henry-border/30 hover:border-henry-accent/30 hover:bg-henry-surface/50 transition-all disabled:opacity-40 group"
                      >
                        <p className="text-sm">{action.icon} <span className="text-xs font-medium text-henry-text group-hover:text-henry-accent">{action.label}</span></p>
                        <p className="text-[10px] text-henry-text-muted mt-0.5">{action.desc}</p>
                      </button>
                    ))}
                  </div>

                  {/* Print job */}
                  <div className="mt-4">
                    <button
                      onClick={() => setShowPrintJob((v) => !v)}
                      className="text-xs text-henry-accent/70 hover:text-henry-accent transition-colors flex items-center gap-1"
                    >
                      {showPrintJob ? '▾' : '▸'} Start a print job
                    </button>
                    {showPrintJob && (
                      <div className="mt-3 space-y-2">
                        <textarea
                          value={printGcode}
                          onChange={(e) => setPrintGcode(e.target.value)}
                          disabled={printing}
                          placeholder={`; Paste your full G-code here\nG28 ; Home\nM104 S210\n...`}
                          rows={5}
                          className="w-full bg-henry-bg border border-henry-border rounded-xl px-3 py-2.5 text-xs text-henry-text font-mono outline-none focus:border-henry-accent/50 resize-none disabled:opacity-50"
                        />
                        <button
                          onClick={startPrint}
                          disabled={printing || !printGcode.trim()}
                          className="w-full py-2.5 bg-henry-success/80 text-white rounded-xl text-sm font-medium hover:bg-henry-success transition-colors disabled:opacity-50"
                        >
                          {printing ? 'Printing…' : '▶ Start print'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* CONSOLE TAB */}
              {connectedTab === 'console' && (
                <>
                  <div ref={logRef} className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs space-y-0.5">
                    {log.length === 0 && (
                      <p className="text-henry-text-muted/50 text-center pt-6">No console output yet.</p>
                    )}
                    {log.map((entry) => (
                      <div key={entry.id} className={`leading-relaxed flex items-start gap-2 ${
                        entry.type === 'sent'         ? 'text-henry-accent' :
                        entry.type === 'response'     ? 'text-henry-success' :
                        entry.type === 'error'        ? 'text-henry-error' :
                        entry.type === 'disconnected' ? 'text-henry-warning' :
                        'text-henry-text-muted'
                      }`}>
                        <span className="text-[10px] text-henry-text-muted/50 shrink-0 mt-0.5 tabular-nums">{formatTime(entry.timestamp)}</span>
                        <span>{entry.data}</span>
                      </div>
                    ))}
                    {(sending || printing) && <div className="text-henry-accent animate-pulse">▋</div>}
                  </div>

                  <div className="shrink-0 p-4 border-t border-henry-border/30">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={gcodeInput}
                        onChange={(e) => setGcodeInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && sendGcode()}
                        disabled={sending}
                        placeholder="G-code command (e.g. M105, G28)…"
                        className="flex-1 bg-henry-bg border border-henry-border rounded-xl px-4 py-2.5 text-sm text-henry-text font-mono outline-none focus:border-henry-accent/50 disabled:opacity-50"
                      />
                      <button
                        onClick={() => sendGcode()}
                        disabled={sending || !gcodeInput.trim()}
                        className="px-4 py-2.5 bg-henry-accent text-white rounded-xl text-sm font-medium hover:bg-henry-accent/90 transition-colors disabled:opacity-50"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
