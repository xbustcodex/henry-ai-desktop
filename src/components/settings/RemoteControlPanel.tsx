/**
 * Remote Control Panel — Desktop side
 *
 * Surfaces the data needed to pair an iPad/iPhone with Henry's remote-control
 * feature: 9-digit Henry ID, 6-digit rotating PIN, LAN pair URL, QR code.
 *
 * Backed by GET /sync/pairing-info (loopback-only) and POST /sync/pin/rotate.
 *
 * Without this panel, the /companion/pair page tells the user to "Open Henry →
 * Companion → Remote Access" but no such UI existed — the whole pairing flow
 * was uncompletable except via curl on the Mac.
 */

import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useEffect, useState, useCallback } from 'react';
import { isMacOS, isLinux, isWindows } from '../../utils/platform';
import QrCodeImage from '../common/QrCodeImage';

interface PairingInfo {
  henryId: string;
  pin: string;
  pinExpiresAt: number; // ms epoch
  pairedDevices: Array<{ id: string; name: string; lastSeen?: string; scope?: string[] }>;
  activeSession: { deviceName: string; deviceId: string } | null;
  recentSessions: Array<{ deviceName?: string; startedAt?: string; endedAt?: string; reason?: string }>;
}

const H_LOOPBACK = { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' };

function loopbackFetch<T = unknown>(path: string, body?: object): Promise<T | null> {
  return fetch('http://127.0.0.1:4242' + path, {
    method: body ? 'POST' : 'GET',
    headers: H_LOOPBACK,
    body: body ? JSON.stringify(body) : undefined,
  })
    .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
    .catch(() => null);
}

export default function RemoteControlPanel() {
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [localIp, setLocalIp] = useState<string>('');
  const [pinSecondsLeft, setPinSecondsLeft] = useState<number>(0);
  const [rotating, setRotating] = useState(false);
  const [showPin, setShowPin] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await loopbackFetch<PairingInfo>('/sync/pairing-info');
    if (data) setInfo(data);
  }, []);

  // Initial load + poll every 10s so paired-device list & active-session
  // indicator stay fresh without needing push.
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  // LAN IP for the pairing URL. Take it from the sync server, which resolves
  // it cross-platform — `ipconfig getifaddr en0` is macOS-only and left this
  // panel showing 127.0.0.1 on Linux, so the scanned QR never worked.
  useEffect(() => {
    let cancelled = false;
    loopbackFetch<{ localIp?: string }>('/sync/state-internal').then((r) => {
      if (cancelled) return;
      setLocalIp((r?.localIp || '').trim() || '127.0.0.1');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live countdown to the next PIN rotation. PIN rotates every 30 min on
  // the server; if pinExpiresAt has passed, the server has already issued
  // a new one — refresh() will pick it up on the next poll.
  useEffect(() => {
    if (!info?.pinExpiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((info.pinExpiresAt - Date.now()) / 1000));
      setPinSecondsLeft(left);
      if (left === 0) void refresh();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [info?.pinExpiresAt, refresh]);

  async function rotateNow() {
    setRotating(true);
    try {
      await loopbackFetch('/sync/pin/rotate', {});
      await refresh();
    } finally {
      setRotating(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await safeCopyToClipboard(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* user can still see and read the value */
    }
  }

  if (!info) {
    return (
      <div className="bg-henry-surface rounded-2xl border border-henry-border/20 p-4">
        <p className="text-sm font-semibold text-henry-text">Remote Control (Android / Browser)</p>
        <p className="text-xs text-henry-text-muted mt-1">Loading…</p>
      </div>
    );
  }

  const platform = isMacOS() ? 'Mac' : isLinux() ? 'computer' : isWindows() ? 'computer' : 'device';
  const pairUrl = `http://${localIp || '127.0.0.1'}:4242/companion/pair`;
  // R3-Fix 4: encode credentials in the URL fragment (#id=...&pin=...). The
  // fragment never travels to the server (browsers don't send it in HTTP),
  // and the pair page's autofill picks it up and auto-submits. iPad camera
  // scan → Safari → pair → consent → done. No typing.
  const pairUrlWithCreds = `${pairUrl}#id=${encodeURIComponent(info.henryId)}&pin=${encodeURIComponent(info.pin)}`;

  const mins = Math.floor(pinSecondsLeft / 60);
  const secs = pinSecondsLeft % 60;

  return (
    <div className="bg-henry-surface rounded-2xl border border-henry-border/20 p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-henry-text">Remote Control (Android / Browser)</p>
        <p className="text-xs text-henry-text-muted mt-0.5">
          Control this {platform} from an Android phone, tablet, or another browser on your LAN.
        </p>
      </div>

      {/* Active session banner */}
      {info.activeSession && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          <p className="text-xs text-red-300 flex-1">
            <span className="font-semibold">{info.activeSession.deviceName}</span> is controlling this {platform}
          </p>
        </div>
      )}

      {/* IP / PIN / QR */}
      <div className="grid grid-cols-[1fr_auto] gap-4 items-start">
        <div className="space-y-3 min-w-0">
          {/* Henry ID */}
          <div>
            <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-1">
              Henry ID
            </p>
            <div className="flex items-center gap-2">
              <code className="text-base font-mono text-henry-accent tabular-nums select-all">
                {info.henryId}
              </code>
              <button
                type="button"
                onClick={() => void copy(info.henryId, 'id')}
                className="text-[10px] px-2 py-0.5 rounded bg-henry-bg border border-henry-border/30 text-henry-text-muted hover:text-henry-text"
              >
                {copied === 'id' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* PIN */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider">
                Pairing PIN
              </p>
              <button
                type="button"
                onClick={() => setShowPin((v) => !v)}
                className="text-[10px] text-henry-text-muted hover:text-henry-text"
              >
                {showPin ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-2xl font-mono font-semibold text-henry-accent tabular-nums select-all tracking-widest">
                {showPin ? info.pin : '••••••'}
              </code>
              <button
                type="button"
                onClick={() => void copy(info.pin, 'pin')}
                className="text-[10px] px-2 py-0.5 rounded bg-henry-bg border border-henry-border/30 text-henry-text-muted hover:text-henry-text"
              >
                {copied === 'pin' ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => void rotateNow()}
                disabled={rotating}
                className="text-[10px] px-2 py-0.5 rounded bg-henry-bg border border-henry-border/30 text-henry-text-muted hover:text-henry-text disabled:opacity-50"
              >
                {rotating ? 'Rotating…' : 'Rotate'}
              </button>
            </div>
            <p className="text-[10px] text-henry-text-muted mt-1 tabular-nums">
              Next rotation in {mins}:{String(secs).padStart(2, '0')}
            </p>
          </div>

          {/* LAN URL */}
          <div>
            <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-1">
              Pair URL (open this on your Android device or browser)
            </p>
            <div className="flex items-center gap-2">
              <code className="text-[11px] font-mono text-henry-text bg-henry-bg px-2 py-1 rounded border border-henry-border/30 flex-1 truncate select-all">
                {pairUrl}
              </code>
              <button
                type="button"
                onClick={() => void copy(pairUrl, 'url')}
                className="text-[10px] px-2 py-0.5 rounded bg-henry-bg border border-henry-border/30 text-henry-text-muted hover:text-henry-text shrink-0"
              >
                {copied === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>

        {/* QR */}
        <div className="shrink-0">
          {/* Rendered locally — the QR carries the pairing PIN, which must not
              be sent to a third-party image service. */}
          <QrCodeImage value={pairUrlWithCreds} size={160} className="border border-henry-border/30" />
          <p className="text-[9px] text-henry-text-muted text-center mt-1">Scan with your phone camera</p>
        </div>
      </div>

      {/* Paired devices */}
      {info.pairedDevices.length > 0 && (
        <div className="pt-2 border-t border-henry-border/20">
          <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-2">
            Paired devices ({info.pairedDevices.length})
          </p>
          <div className="space-y-1.5">
            {info.pairedDevices.map((d) => (
              <div key={d.id} className="flex items-center justify-between text-xs">
                <span className="text-henry-text truncate flex-1">{d.name || d.id}</span>
                <span className="text-[10px] text-henry-text-muted ml-2 shrink-0">
                  {d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never seen'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent sessions */}
      {info.recentSessions.length > 0 && (
        <div className="pt-2 border-t border-henry-border/20">
          <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-2">
            Recent sessions
          </p>
          <div className="space-y-1">
            {info.recentSessions.slice(0, 5).map((s, i) => (
              <div key={i} className="text-[10px] text-henry-text-muted tabular-nums flex gap-2">
                <span className="text-henry-text-muted/60">
                  {s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : '—'}
                </span>
                <span className="flex-1 truncate">{s.deviceName || 'device'}</span>
                {s.reason && <span className="text-henry-text-muted/60">{s.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* How-to */}
      <div className="pt-2 border-t border-henry-border/20">
        <p className="text-[10px] font-medium text-henry-text-muted uppercase tracking-wider mb-1">
          How to use
        </p>
        <ol className="text-[11px] text-henry-text-muted leading-relaxed space-y-0.5 list-decimal list-inside">
          <li>On your Android device or another browser, open the Pair URL above (same WiFi as this {platform}).</li>
          <li>Enter the 6-digit PIN. The device will remember the pairing.</li>
          <li>Tap "Start Remote Control" — Henry will ask you here for permission.</li>
          <li>View, click, scroll, and draw with touch/stylus. End anytime from the red banner.</li>
        </ol>
      </div>
    </div>
  );
}
