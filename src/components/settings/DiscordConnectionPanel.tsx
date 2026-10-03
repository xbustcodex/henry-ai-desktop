/**
 * Discord connection panel.
 *
 * Discord issues bot tokens by copy-paste from the Developer Portal — there is
 * no refresh token to refresh, and no refresh flow to drive. So the panel takes
 * the token, hands it to the main process over `integration:setToken`, and the
 * main process encrypts it with safeStorage and stores it in the same settings
 * row every other OAuth credential uses.
 *
 * The token is typed into a password field, sent once, cleared from component
 * state immediately, and never read back. Nothing in this panel can display a
 * stored credential, which is deliberate: `integration:status` returns
 * connection facts (connected / expired / scope) and no token material.
 */
import { useCallback, useEffect, useState } from 'react';

const cardCls = 'bg-henry-surface border border-henry-border/20 rounded-2xl p-4';
const inputCls =
  'w-full bg-henry-bg border border-henry-border/40 rounded-lg px-3 py-1.5 text-sm text-henry-text focus:outline-none focus:border-henry-accent/60';

interface DiscordStatus {
  id: string;
  label: string;
  setupHint: string;
  connected: boolean;
  expired?: boolean;
  scope?: string | null;
}

/**
 * The preload methods this panel needs.
 *
 * They are read through this narrow interface rather than by widening the
 * shared `Window` type here: the preload surface is applied centrally, so
 * keeping the panel's own contract local avoids two declarations of the same
 * channel drifting apart.
 */
interface DiscordBridge {
  integrationStatus: () => Promise<DiscordStatus[]>;
  integrationSetToken: (payload: {
    providerId: string;
    token: string;
    label?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  integrationDisconnect: (
    providerId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onIntegrationChanged?: (
    cb: (changed: { providerId?: string }) => void,
  ) => () => void;
}

function bridge(): DiscordBridge {
  return (window as unknown as { henryAPI: DiscordBridge }).henryAPI;
}

export default function DiscordConnectionPanel() {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showSetup, setShowSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const all = await bridge().integrationStatus();
      setStatus(all.find((p) => p.id === 'discord') ?? null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = bridge().onIntegrationChanged?.((changed: { providerId?: string }) => {
      if (!changed?.providerId || changed.providerId === 'discord') void refresh();
    });
    return () => {
      off?.();
      // A pasted bot token is a live credential. It has no reason to outlive
      // the panel, so unmounting wipes it from component state rather than
      // leaving it in a React tree that may be re-rendered or snapshotted.
      setToken('');
    };
  }, [refresh]);

  const connect = async () => {
    if (!token.trim()) {
      setMsg('Paste a bot token first.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      // Deliberately not logged, not stashed, and not put in `msg`: once this
      // call returns the only copy lives in the OS keystore.
      const r = await bridge().integrationSetToken({
        providerId: 'discord',
        token: token.trim(),
      });
      // Wipe the typed token from component state the moment it has been
      // handed off, success or failure — on failure the user may well close
      // the panel and come back, and it must not still be sitting in state.
      setToken('');
      if (r?.ok === false) setMsg(String(r.error ?? 'Could not connect Discord.'));
      else {
        setMsg('Connected.');
        setShowSetup(false);
        await refresh();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not connect Discord.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await bridge().integrationDisconnect('discord');
      // Report what actually happened: the handler says whether the stored
      // row was really deleted.
      setMsg(
        r?.ok === false
          ? String(r.error ?? 'Disconnect failed — the token may still be stored.')
          : 'Disconnected. The stored token was removed from this machine.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected === true;

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-henry-text">Discord</h3>
          <p className="text-[11px] text-henry-text-muted mt-0.5">
            Send and read Discord messages on servers Henry has been invited to, using Discord&apos;s
            own API. The token is kept in the OS keystore and never reaches this window.
          </p>
        </div>
        <span
          className={`text-[10px] px-2 py-1 rounded-full shrink-0 ${
            connected
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-henry-border/30 text-henry-text-muted'
          }`}
        >
          {!status ? 'checking…' : connected ? 'connected' : 'not connected'}
        </span>
      </div>

      {msg && <p className="text-[11px] text-henry-accent mt-2">{msg}</p>}

      {!connected && (
        <div className="mt-3">
          {!showSetup ? (
            <button
              onClick={() => setShowSetup(true)}
              className="px-3 py-1.5 rounded-lg border border-henry-border/40 text-xs text-henry-text hover:border-henry-accent/50"
            >
              Connect Discord
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-henry-text-muted leading-relaxed">
                In Discord → <b>Developer Portal</b> → your application → <b>Bot</b>, press{' '}
                <b>Reset Token</b> and paste it here. For the bot to read a server, invite it to that
                server with the <b>Message Content</b> intent enabled.
              </p>
              <input
                className={inputCls}
                placeholder="Bot token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void connect()}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-henry-accent text-white text-xs font-medium disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Connect'}
                </button>
                <button
                  onClick={() => {
                    setToken('');
                    setShowSetup(false);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-henry-border/40 text-xs text-henry-text-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {connected && (
        <div className="mt-3">
          {status?.expired && (
            <p className="text-[11px] text-henry-warning mb-2">
              The stored token has been rejected by Discord. Disconnect and paste a fresh one.
            </p>
          )}
          <button
            onClick={() => void disconnect()}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-henry-border/40 text-xs text-henry-text-muted hover:text-henry-error disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}