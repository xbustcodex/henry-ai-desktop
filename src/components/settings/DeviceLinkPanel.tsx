/**
 * Device Link Panel — Desktop side
 *
 * Shows in Henry Settings → "Companion Devices".
 * Lets the user:
 *   - Start the sync server
 *   - Generate a pairing QR / code for iPhone/iPad
 *   - See linked devices
 *   - Unlink devices
 */

import QrCodeImage from '../common/QrCodeImage';
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store';
import type { CompanionDeviceCapability, SyncServerState } from '../../sync/types';
import { buildPairCodePayload } from '../../sync/deviceLink';
import { toast } from '../ui/Toast';
import { isMacOS, isLinux, isWindows } from '../../utils/platform';

// Detect Electron by checking if the sync server is reachable
// (window.__ELECTRON__ and __isElectron are unreliable due to contextBridge sandbox)
// We always render in Electron — the sync server being up confirms it
const isElectron = true; // Always true in the desktop app

export default function DeviceLinkPanel() {
  const platformName = isMacOS() ? 'iPhone or iPad' : isLinux() ? 'Android device or browser' : isWindows() ? 'Android device or browser' : 'mobile device or browser';

  const [serverState, setServerState] = useState<SyncServerState | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [codeExpiry, setCodeExpiry] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const H = {'Content-Type':'application/json','X-Henry-Internal':'true'};
  const syncFetch = (path: string, body?: object) =>
    fetch('http://127.0.0.1:4242' + path, {
      method: body ? 'POST' : 'GET', headers: H,
      body: body ? JSON.stringify(body) : undefined
    }).then(r => r.json()).catch(() => null);

  const loadState = useCallback(async () => {
    try {
      const state = await syncFetch('/sync/state-internal');
      if (!state) return;
      setServerState(state);
      if (state.tunnelUrl) setTunnelUrl(state.tunnelUrl);
      if (state.pairToken && state.pairTokenExpiry) {
        // Use the LAN IP the sync server already reports. This shelled out to
        // `ipconfig getifaddr en0`, which is macOS-only — on Linux it failed
        // and fell back to the literal 192.168.1.1, so the pairing code
        // pointed the phone at the wrong address.
        const localIp = (state as { localIp?: string }).localIp || 'localhost';
        const payload = buildPairCodePayload(localIp, state.port, state.pairToken);
        setPairCode(payload);
        setCodeExpiry(state.pairTokenExpiry);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    const onDevices = () => {
      void loadState();
    };
    window.addEventListener('henry_companion_devices_changed', onDevices);
    return () => window.removeEventListener('henry_companion_devices_changed', onDevices);
  }, [loadState]);

  // Countdown timer for pair code
  useEffect(() => {
    if (!codeExpiry) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((codeExpiry - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining === 0) {
        setPairCode(null);
        setCodeExpiry(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [codeExpiry]);

  async function startServer() {
    setLoading(true);
    try {
      await syncFetch('/sync/start-internal', {});
      await loadState();
    } finally { setLoading(false); }
  }

  async function handleStartTunnel() {
    setTunnelLoading(true);
    try {
      const result = await syncFetch('/sync/start-tunnel', {});
      if (result?.url) setTunnelUrl(result.url);
      else toast.error('cloudflared not installed.\nRun: brew install cloudflared\nThen restart Henry.');
    } catch { toast.error('Failed to start tunnel'); }
    finally { setTunnelLoading(false); }
  }

  async function handleStopTunnel() {
    await syncFetch('/sync/stop-tunnel', {});
    setTunnelUrl(null);
  }

  async function generateCode() {
    setLoading(true);
    try {
      if (!serverState?.running) await syncFetch('/sync/start-internal', {});
      const result = await syncFetch('/sync/generate-pair-internal', {});
      if (!result?.token) return;
      const state = await syncFetch('/sync/state-internal');
      setServerState(state);
      // Same fix as loadState: take the server-reported LAN IP.
      const localIp = (state as { localIp?: string } | null)?.localIp || 'localhost';
      const payload = buildPairCodePayload(localIp, state?.port || 4242, result.token);
      setPairCode(payload);
      setCodeExpiry(Date.now() + 5 * 60 * 1000);
    } finally { setLoading(false); }
  }

  async function revokeCode() {
    await syncFetch('/sync/revoke-pair-internal', {});
    setPairCode(null);
    setCodeExpiry(null);
  }

  async function unlinkDevice(deviceId: string) {
    await syncFetch('/sync/unlink-device-internal', {id: deviceId});
    await loadState();
  }

  const shortCode = pairCode
    ? (() => {
        try {
          const parsed = JSON.parse(pairCode);
          return `${parsed.h}:${parsed.p}:${parsed.t}`;
        } catch {
          return pairCode;
        }
      })()
    : null;

  if (!isElectron) {
    return (
      <div className="p-4 rounded-2xl bg-henry-surface border border-henry-border/20 text-center">
        <p className="text-sm text-henry-text-muted">
          Companion device linking is only available in the desktop (Electron) app.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Server status */}
      <div className="bg-henry-surface rounded-2xl border border-henry-border/20 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-henry-text">Companion Sync Server</p>
            <p className="text-xs text-henry-text-muted mt-0.5">
              {serverState?.running
                ? `Running on ${serverState.localIp}:${serverState.port}`
                : 'Not running'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full ${
                serverState?.running ? 'bg-henry-success' : 'bg-henry-text-muted'
              }`}
            />
            {!serverState?.running && (
              <button
                onClick={() => void startServer()}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg bg-henry-accent text-white text-xs font-medium active:bg-henry-accent/80 transition-colors disabled:opacity-50"
              >
                Start
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Add device */}
      <div className="bg-henry-surface rounded-2xl border border-henry-border/20 p-4 space-y-4">
        <div>
          <p className="text-sm font-semibold text-henry-text">Add {platformName}</p>
          <p className="text-xs text-henry-text-muted mt-0.5">
            Generate a pairing code, then enter it in Henry on your {platformName.toLowerCase()}.
          </p>
        </div>

        {pairCode ? (
          <div className="space-y-3">
            {/* Rendered locally — see QrCodeImage: the payload carries pairing
                credentials and must not go to a third-party image service. */}
            <div className="flex justify-center">
              <QrCodeImage value={pairCode} size={176} className="border border-henry-border/20" />
            </div>

            {/* Manual code */}
            <div className="bg-henry-bg rounded-xl px-4 py-3 space-y-1">
              <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider">
                Manual entry code
              </p>
              <p className="text-sm font-mono text-henry-accent break-all select-all">
                {shortCode}
              </p>
            </div>

            {/* Expiry countdown */}
            <div className="flex items-center justify-between">
              <p className="text-xs text-henry-text-muted">
                Code expires in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
              </p>
              <button
                onClick={() => void revokeCode()}
                className="text-xs text-henry-error active:opacity-60 transition-opacity"
              >
                Revoke
              </button>
            </div>

            <div className="bg-henry-accent/10 border border-henry-accent/20 rounded-xl px-3 py-2.5">
              <p className="text-xs text-henry-accent leading-relaxed">
                On your {platformName.toLowerCase()}: open Henry → use pairing / connect flow → enter the code above (or scan the QR).
                Both devices must be on the same Wi‑Fi network.
              </p>
            </div>
          </div>
        ) : (
          <button
            onClick={() => void generateCode()}
            disabled={loading}
            className="w-full py-3.5 rounded-xl bg-henry-accent text-white text-sm font-semibold active:bg-henry-accent/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Generating…
              </>
            ) : (
              'Generate Pairing Code'
            )}
          </button>
        )}
      </div>

      {/* Remote Access — works from anywhere */}
      <div className="mt-4 pt-4 border-t border-henry-border/20">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-henry-text-muted uppercase tracking-wider">Remote Access</p>
          {tunnelUrl && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 font-medium">● Active</span>
          )}
        </div>

        {/* Auto-tunnel toggle */}
        <label className="flex items-center gap-2 cursor-pointer mb-3">
          <input
            type="checkbox"
            className="w-3.5 h-3.5 accent-henry-accent"
            defaultChecked={false}
            onChange={async (e) => {
              // Persist through the real settings IPC. This used to shell out to
              // the sqlite3 CLI with a macOS-only path, so the toggle silently
              // failed to save on Windows and Linux.
              await window.henryAPI.saveSetting?.('auto_tunnel_enabled', String(e.target.checked));
              useStore.getState().updateSetting('auto_tunnel_enabled', String(e.target.checked));
              if (e.target.checked && !tunnelUrl) handleStartTunnel();
            }}
          />
          <span className="text-[11px] text-henry-text-muted">Auto-start tunnel on launch</span>
        </label>

        {/* Named tunnel tip */}
        <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-3 mb-3">
          <p className="text-[10px] font-semibold text-henry-text-muted uppercase tracking-wider mb-1">Same URL Every Time (Named Tunnel)</p>
          <p className="text-[10px] text-henry-text-muted leading-relaxed mb-2">
            Free tunnels get a new URL each restart. To get a permanent URL, create a free Cloudflare account and run:
          </p>
          <code className="text-[10px] text-henry-accent bg-black/20 px-2 py-1 rounded block font-mono">
            cloudflared tunnel login
          </code>
          <code className="text-[10px] text-henry-accent bg-black/20 px-2 py-1 rounded block font-mono mt-1">
            cloudflared tunnel create henry
          </code>
          <p className="text-[10px] text-henry-text-muted mt-1">Then restart Henry — it will use the named tunnel automatically.</p>
        </div>

        {!tunnelUrl ? (
          <div>
            <p className="text-[11px] text-henry-text-muted mb-2">
              Start a secure tunnel so your phone works from anywhere — cellular, other WiFi, anywhere.
            </p>
            <button
              onClick={handleStartTunnel}
              disabled={tunnelLoading || !serverState?.running}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 border border-henry-accent/30 text-henry-accent hover:bg-henry-accent/20 transition-all disabled:opacity-40"
            >{tunnelLoading ? 'Starting…' : '🌐 Start Remote Tunnel'}</button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-henry-text-muted">Open this URL on any device, anywhere:</p>
            <div className="flex items-center gap-2">
              <code className="text-[11px] text-henry-accent bg-henry-surface px-3 py-1.5 rounded-lg border border-henry-border/30 flex-1 truncate">{tunnelUrl}</code>
              <button
                onClick={() => navigator.clipboard?.writeText(tunnelUrl!)}
                className="text-[11px] px-2 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-text shrink-0"
              >Copy</button>
            </div>
            <button onClick={handleStopTunnel} className="text-[10px] text-henry-text-muted hover:text-henry-error transition-colors">Stop tunnel</button>
          </div>
        )}
      </div>

      {/* Linked devices */}
      {serverState?.linkedDevices && serverState.linkedDevices.length > 0 && (
        <div className="bg-henry-surface rounded-2xl border border-henry-border/20 p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-henry-text">
              Linked devices ({serverState.linkedDevices.length})
            </p>
            <p className="text-[10px] text-henry-text-muted text-right max-w-[12rem] leading-snug">
              To add again after unlink, generate a new pairing code.
            </p>
          </div>
          {serverState.linkedDevices.map((device) => (
            <div
              key={device.id}
              className="flex flex-col gap-2 bg-henry-bg rounded-xl px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                <span className="text-xl shrink-0">
                  {device.platform === 'ios'
                    ? device.appleProduct === 'ipad'
                      ? '📋'
                      : '📱'
                    : device.platform === 'android'
                      ? '🤖'
                      : '💻'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-henry-text truncate">{device.name}</p>
                  <p className="text-[10px] text-henry-text-muted">
                    {device.platform}
                    {device.appleProduct && device.appleProduct !== 'unknown'
                      ? ` · ${device.appleProduct}`
                      : ''}{' '}
                    · Linked {new Date(device.linkedAt).toLocaleDateString()}
                    {device.lastSeen && (
                      Date.now() - new Date(device.lastSeen).getTime() < 60_000
                        ? <span className="text-green-400 font-medium"> · Online now</span>
                        : ` · Seen ${formatAge(Date.now() - new Date(device.lastSeen).getTime())} ago`
                    )}
                    {device.lastSyncAt &&
                      ` · Sync ${formatAge(Date.now() - new Date(device.lastSyncAt).getTime())} ago`}
                  </p>
                  {device.linkStatus && (
                    <p className="text-[10px] text-green-400 mt-0.5 capitalize">
                      {device.linkStatus}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void unlinkDevice(device.id)}
                  className="text-xs text-henry-error active:opacity-60 transition-opacity shrink-0"
                >
                  Unlink
                </button>
              </div>
              {device.capabilities && device.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1 pl-11">
                  {device.capabilities.map((c) => (
                    <CapabilityChip key={c} cap={c} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Cloud relay note */}
      <div className="bg-henry-surface rounded-2xl border border-henry-border/20 p-4 space-y-2">
        <p className="text-sm font-semibold text-henry-text">Cloud Relay (Phase 2)</p>
        <p className="text-xs text-henry-text-muted leading-relaxed">
          Currently, sync requires your {platformName.toLowerCase()} and this {isMacOS() ? 'Mac' : 'computer'} to be on the same WiFi network.
          Cloud relay support (allowing sync from anywhere) is coming in the next update.
        </p>
      </div>
    </div>
  );
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const CAP_LABELS: Record<CompanionDeviceCapability, string> = {
  chat_summaries: 'Chat summaries',
  tasks: 'Tasks',
  approvals: 'Approvals',
  captures: 'Captures',
  notifications: 'Notifications',
};

function CapabilityChip({ cap }: { cap: CompanionDeviceCapability }) {
  return (
    <span className="text-[9px] px-2 py-0.5 rounded-md bg-henry-surface border border-henry-border/40 text-henry-text-muted">
      {CAP_LABELS[cap] ?? cap}
    </span>
  );
}
