/**
 * Google connection — the missing surface.
 *
 * `electron/ipc/googleAuth.ts` has implemented a correct PKCE + loopback +
 * safeStorage flow with Gmail / Calendar / Drive scopes, refresh and
 * revocation, since before this existed. Nothing in the renderer called it:
 * `googleStartAuth` had zero references. The whole capability was present and
 * unreachable.
 *
 * Google requires the user to bring their own OAuth client (Google Cloud
 * project → OAuth client → Desktop app), which is Google's flow for desktop
 * apps and is not something to work around. So this panel asks for the two
 * values, stores them in the OS keystore via the existing encrypted key
 * storage, and runs the real flow.
 *
 * Tokens stay in the main process. The renderer never holds a refresh token.
 */
import { useCallback, useEffect, useState } from 'react';

// Henry asks for exactly these. They must match the scope list in
// `electron/integrations/oauth/registry.ts` — a panel that under-reports what
// it requests is a consent screen that lies, and the agent tools would then
// 403 on a scope the user believes was granted.
const SCOPES = [
  { id: 'https://www.googleapis.com/auth/gmail.readonly', label: 'Read Gmail' },
  { id: 'https://www.googleapis.com/auth/gmail.compose', label: 'Create Gmail drafts' },
  { id: 'https://www.googleapis.com/auth/gmail.send', label: 'Send email' },
  { id: 'https://www.googleapis.com/auth/calendar.readonly', label: 'Read Calendar' },
  { id: 'https://www.googleapis.com/auth/calendar.events', label: 'Create and update Calendar events' },
  { id: 'https://www.googleapis.com/auth/drive.readonly', label: 'Read Drive' },
  { id: 'https://www.googleapis.com/auth/drive.file', label: 'Upload files to Drive' },
];

const cardCls = 'bg-henry-surface border border-henry-border/20 rounded-2xl p-4';
const inputCls =
  'w-full bg-henry-bg border border-henry-border/40 rounded-lg px-3 py-1.5 text-sm text-henry-text focus:outline-none focus:border-henry-accent/60';

export default function GoogleConnectionPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showSetup, setShowSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const has = await window.henryAPI.googleHasCredentials();
      setConnected(typeof has === 'boolean' ? has : Boolean(has?.hasCredentials));
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setMsg('Both the client ID and client secret are required.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await window.henryAPI.googleStartAuth({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        scopes: SCOPES.map((s) => s.id),
      });
      if (r?.ok === false) {
        setMsg(String(r.error ?? 'Could not connect.'));
      } else {
        setMsg('Connected.');
        setClientId('');
        setClientSecret('');
        setShowSetup(false);
        await refresh();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await window.henryAPI.googleDisconnect();
      await refresh();
      setMsg('Disconnected. The stored token was removed from this machine.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-henry-text">Google</h3>
          <p className="text-[11px] text-henry-text-muted mt-0.5">
            Gmail, Calendar and Drive, using your own Google account. Tokens are kept in the OS
            keystore and never reach this window.
          </p>
        </div>
        <span
          className={`text-[10px] px-2 py-1 rounded-full shrink-0 ${
            connected
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-henry-border/30 text-henry-text-muted'
          }`}
        >
          {connected === null ? 'checking…' : connected ? 'connected' : 'not connected'}
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
              Connect Google
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-henry-text-muted leading-relaxed">
                Create an OAuth client in Google Cloud → APIs &amp; Services → Credentials, choose
                <b> Desktop app</b>, then paste the ID and secret here. Google requires the app to
                bring its own client for desktop apps — there is no shared client to use instead.
              </p>
              <input
                className={inputCls}
                placeholder="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <input
                className={inputCls}
                placeholder="Client secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <div>
                <p className="text-[10px] text-henry-text-muted mb-1">Henry will ask for:</p>
                <ul className="text-[10px] text-henry-text-muted space-y-0.5">
                  {SCOPES.map((s) => (
                    <li key={s.id}>· {s.label}</li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void connect()}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-henry-accent text-white text-xs font-medium disabled:opacity-50"
                >
                  {busy ? 'Waiting for Google…' : 'Connect'}
                </button>
                <button
                  onClick={() => setShowSetup(false)}
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
        <button
          onClick={() => void disconnect()}
          disabled={busy}
          className="mt-3 px-3 py-1.5 rounded-lg border border-henry-border/40 text-xs text-henry-text-muted hover:text-henry-error disabled:opacity-50"
        >
          Disconnect
        </button>
      )}
    </div>
  );
}