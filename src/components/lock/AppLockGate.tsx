/**
 * AppLockGate — the lock screen `LOCK_EXEMPT_CHANNELS` was reserved for.
 *
 * ## The defect this exists to close
 *
 * `main.ts` refuses every non-exempt channel while `isLocked()`, and
 * `security:unlock` sits in `LOCK_EXEMPT_CHANNELS` specifically so that a lock
 * screen *can* be built. It never was: there was no caller of
 * `securityUnlock` anywhere in `src/`. So a user who turned on "Require a PIN
 * to unlock Henry" locked themselves out of their own app, permanently, with no
 * error and no way back — the worst failure mode a security feature can have,
 * because it looks like the feature working.
 *
 * ## Why this polls rather than being pushed to
 *
 * Lock state lives in the main process (`unlocked` is a module-level flag in
 * `securityPolicy.ts`, and `relock()` runs at quit). There is no
 * `security:locked-changed` event, and adding one would mean editing
 * `electron/preload.ts` — a file outside this task's ownership. So the gate
 * polls `security:get`, which is lock-exempt by design. The interval is short
 * because the cost is one IPC round trip on an already-idle channel, and
 * re-reading on `focus` catches a lock taken while the window was in the
 * background — which is exactly the case where a stale "unlocked" screen would
 * leave the app looking open to someone who just walked up to it.
 *
 * `security:get` is also what tells us whether a PIN even exists. If it says
 * locked, the main process's `isLocked()` has already confirmed both
 * `appLock && hasPin() && !unlocked`, so this component never renders a PIN
 * prompt for a lock that has no PIN behind it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How often the lock state is re-read while the gate is mounted. */
const POLL_MS = 2_000;

type LockState = 'unknown' | 'unlocked' | 'locked';

export default function AppLockGate() {
  const [lockState, setLockState] = useState<LockState>('unknown');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [lockedOutUntil, setLockedOutUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await window.henryAPI.securityGet();
      setLockState(status?.locked === true ? 'locked' : 'unlocked');
    } catch {
      // `security:get` is lock-exempt, so a failure here is a broken bridge
      // rather than a lock. Treating it as "unlocked" would let a locked app
      // look open; treating it as "locked" would let a bridge blip look like
      // an attack. Neither is honest, so say so rather than guess.
      setLockState((current) => (current === 'unknown' ? 'unlocked' : current));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // The countdown has to tick on its own: the main process only reports
  // `retryInMs` once, at the moment of the refusal.
  useEffect(() => {
    if (lockedOutUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [lockedOutUntil]);

  useEffect(() => {
    if (lockState === 'locked') inputRef.current?.focus();
  }, [lockState]);

  const retrySeconds = Math.max(0, Math.ceil((lockedOutUntil - now) / 1000));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || retrySeconds > 0 || pin.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.henryAPI.securityUnlock(pin);
      setPin('');
      if (result?.ok) {
        // Trust the read-back rather than the answer: `unlock` clears its own
        // failure counters, and a subsequent `security:get` is what the rest of
        // the app's behaviour is keyed on.
        await refresh();
        setAttemptsLeft(null);
        setLockedOutUntil(0);
        return;
      }
      if (result?.lockedOut) {
        setLockedOutUntil(Date.now() + (result.retryInMs ?? 30_000));
        setNow(Date.now());
        setError(null);
      } else {
        setError('That PIN is not right.');
        setAttemptsLeft(typeof result?.attemptsRemaining === 'number' ? result.attemptsRemaining : null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check that PIN.');
    } finally {
      setBusy(false);
    }
  }

  if (lockState !== 'locked') return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-henry-bg px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
    >
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-henry-border/40 bg-henry-surface/40 p-6 text-henry-text shadow-2xl">
        <h1 id="app-lock-title" className="text-base font-semibold mb-1">
          Henry is locked
        </h1>
        <p className="text-xs text-henry-text-muted leading-relaxed mb-4">
          Enter your PIN to unlock. Until you do, Henry will not run anything.
        </p>

        <label htmlFor="app-lock-pin" className="sr-only">
          PIN
        </label>
        <input
          id="app-lock-pin"
          ref={inputRef}
          type="password"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          disabled={busy || retrySeconds > 0}
          placeholder="PIN"
          className="w-full rounded-xl border border-henry-border/40 bg-henry-bg px-3 py-2.5 text-center text-lg tracking-[0.4em] text-henry-text outline-none focus:border-henry-accent/60 disabled:opacity-50"
        />

        {error && (
          <p role="alert" className="mt-2 text-xs text-red-400">
            {error}
            {attemptsLeft !== null && attemptsLeft > 0 && (
              <span className="text-henry-text-muted"> {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left.</span>
            )}
          </p>
        )}

        {retrySeconds > 0 && (
          <p role="alert" className="mt-2 text-xs text-amber-400">
            Too many attempts. Try again in {retrySeconds}s.
          </p>
        )}

        <button
          type="submit"
          disabled={busy || retrySeconds > 0 || pin.length < 4}
          className="mt-4 w-full rounded-xl bg-henry-accent/25 px-3 py-2.5 text-sm font-medium text-henry-accent hover:bg-henry-accent/35 disabled:opacity-40 transition-colors"
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>

        {/*
          A forgotten PIN cannot be recovered — it is stored as a scrypt hash
          and never written down. Without a way out, enabling the lock would be
          a one-way door, so the honest options are offered rather than a dead
          end. `app:quit` is lock-exempt, which is why this button works here.
        */}
        <div className="mt-5 border-t border-henry-border/20 pt-3 space-y-1">
          <p className="text-[11px] text-henry-text-muted leading-relaxed">
            Forgotten your PIN? It cannot be recovered. Quit Henry and remove the PIN from the
            settings database to get back in.
          </p>
          <button
            type="button"
            onClick={() => void window.henryAPI.quitApp({ force: true })}
            className="text-[11px] text-henry-text-muted hover:text-red-400 transition-colors"
          >
            Quit Henry
          </button>
        </div>
      </form>
    </div>
  );
}