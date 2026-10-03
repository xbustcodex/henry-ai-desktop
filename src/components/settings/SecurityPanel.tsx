/**
 * SecurityPanel — the user-facing surface for `electron/ipc/securityPolicy.ts`.
 *
 * Every switch here writes a row the main process reads on the NEXT ipc call —
 * none of them is local component state. `securitySet` is the only way a value
 * changes, and the panel re-reads `security:get` after each write so what is
 * displayed is what the main process actually holds, not what we optimistically
 * rendered.
 *
 * The switches are grouped by what they protect rather than alphabetically,
 * because a user scanning this is asking "what stops Henry doing X to me".
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '../ui/Toast';
import type { HenrySecurityPolicy, HenrySecurityStatus } from '../../global';

interface SwitchRow {
  key: keyof HenrySecurityPolicy;
  label: string;
  /** Static explanation. */
  help: string;
  /**
   * Overrides `help` with text derived from live state. Used where a hardcoded
   * number would go stale — the Security panel must never claim a tool count
   * that no longer matches the registry.
   */
  dynamicHelp?: (s: HenrySecurityStatus) => string | null;
  /** Rendered instead of a toggle when the switch cannot be armed as-is. */
  needsPin?: boolean;
}

const CONFIRMATION: SwitchRow[] = [
  {
    key: 'confirmShell',
    label: 'Ask before running shell commands',
    help: 'Covers Henry running a terminal command, a computer-control shell, or sending G-code. Turning this off does not disable command blocking — destructive commands stay refused either way.',
  },
  {
    key: 'confirmSilentTools',
    label: 'Ask before silent-tier tools run',
    help: 'Off by default, and the default is deliberate — see below.',
    // Names the consequence in both states, and counts the tools live rather
    // than hardcoding a number that someone will forget to update.
    dynamicHelp: (s) => {
      const n = s.tools?.silent ?? 0;
      if (n === 0) return 'No silent-tier tools are registered right now.';
      const on = s.policy.confirmSilentTools;
      return on
        ? `On — Henry will ask before each of the ${n} silent-tier tools runs.`
        : `Off — ${n} tools run without asking. Turn this on to be asked every time.`;
    },
  },
];

/*
 * Why `confirmSilentTools` defaults off — repeated here because the panel is
 * where a user meets the switch, and a switch nobody understands is worse than
 * either default. The full reasoning lives on DEFAULT_POLICY in
 * electron/ipc/securityPolicy.ts.
 */


const NETWORK: SwitchRow[] = [
  {
    key: 'allowLanSync',
    label: 'Allow companion devices on this network',
    help: 'Off by default. The companion server binds to 127.0.0.1 only unless you turn this on, which exposes Henry to every other device on the network.',
  },
  {
    key: 'allowNetworkShare',
    label: 'Allow sharing this machine over the internet',
    help: 'Off by default. Required before a cloud tunnel can expose Henry outside your network. Leave this off unless you are deliberately pairing a remote device.',
  },
];

const LOCKS: SwitchRow[] = [
  {
    key: 'redactLogs',
    label: 'Hide credentials in the application log',
    help: 'Recommended on. Provider keys, tokens and passwords are stripped as each line is written, so they are never stored in the first place.',
  },
  {
    key: 'appLock',
    label: 'Require a PIN to unlock Henry',
    help: 'Needs a PIN set below. The PIN is stored as a scrypt hash, never as text.',
    needsPin: true,
  },
];

function Toggle({
  row,
  value,
  status,
  disabled,
  onChange,
}: {
  row: SwitchRow;
  value: boolean;
  /** Supplied so `dynamicHelp` can read live counts; omitted for static rows. */
  status: HenrySecurityStatus;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  // `dynamicHelp` returning null means "I have nothing truthful to say right
  // now" — fall back to the static copy rather than rendering an empty gap.
  const help = row.dynamicHelp?.(status) ?? row.help;
  return (
    <label className="flex items-start gap-3 py-3 border-b border-henry-border/20 last:border-0 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-henry-accent disabled:opacity-40"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-henry-text">{row.label}</span>
        <span className="block text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
          {help}
        </span>
      </span>
    </label>
  );
}

export default function SecurityPanel() {
  const [status, setStatus] = useState<HenrySecurityStatus | null>(null);
  const [pin, setPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await window.henryAPI.securityGet());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the security policy');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = useCallback(
    async (key: keyof HenrySecurityPolicy, value: boolean) => {
      try {
        const res = await window.henryAPI.securitySet(key, value);
        if (!res.ok) {
          // The main process refuses arming a lock with no PIN; surface that
          // rather than flipping the checkbox back silently.
          toast.error(
            res.error === 'pin_required'
              ? 'Set a PIN first — an unlocked app cannot be locked.'
              : 'Could not change that setting',
          );
          await load();
          return;
        }
        if (res.policy) setStatus((s) => (s ? { ...s, policy: res.policy as HenrySecurityPolicy } : s));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not change that setting');
      }
    },
    [load],
  );

  const savePin = useCallback(async () => {
    setPinBusy(true);
    try {
      const res = await window.henryAPI.securitySetPin(pin);
      if (res.ok) {
        toast.success('PIN saved');
        setPin('');
        await load();
      } else {
        toast.error('PIN must be at least 4 characters');
      }
    } finally {
      setPinBusy(false);
    }
  }, [pin, load]);

  if (!status) return null;
  const policy = status.policy;

  const section = (title: string, sub: string, rows: SwitchRow[]) => (
    <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-henry-text">{title}</h2>
        <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">{sub}</p>
      </div>
      <div>
        {rows.map((row) => (
          <Toggle
            key={row.key}
            row={row}
            value={policy[row.key]}
            status={status}
            disabled={row.needsPin && !status.hasPin}
            onChange={(v) => void set(row.key, v)}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-henry-text">Security</h2>
        <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
          These take effect immediately — Henry does not need restarting.
        </p>
      </div>

      <div
        className={
          status.encryptionAvailable
            ? 'text-[11px] text-henry-text-muted'
            : 'text-[11px] text-amber-400'
        }
      >
        {status.encryptionAvailable
          ? 'API keys are encrypted at rest using your operating system keychain.'
          : 'Your system keychain is unavailable, so API keys are stored unencrypted on this machine.'}
      </div>

      {section(
        'Confirmations',
        'What Henry asks before it acts.',
        CONFIRMATION,
      )}

      {section(
        'Network access',
        'Who can reach Henry. Both are off until you turn them on.',
        NETWORK,
      )}

      {section('Logging and lock', 'What Henry records, and who gets in.', LOCKS)}

      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-henry-text">App PIN</h2>
        <p className="text-[11px] text-henry-text-muted mt-0.5 mb-3 leading-relaxed">
          {status.hasPin
            ? 'A PIN is set. Enter a new one to replace it.'
            : 'No PIN set yet. Set one before turning the lock on.'}
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={status.hasPin ? 'New PIN…' : 'Choose a PIN…'}
            className="flex-1 bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text outline-none focus:border-henry-accent/50"
          />
          <button
            onClick={() => void savePin()}
            disabled={pinBusy || pin.length < 4}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40"
          >
            {status.hasPin ? 'Replace' : 'Set PIN'}
          </button>
          {status.hasPin && (
            <button
              onClick={async () => {
                await window.henryAPI.securityClearPin();
                await load();
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-henry-text-muted hover:text-red-400"
            >
              Remove
            </button>
          )}
        </div>
        <p className="text-[10px] text-henry-text-muted mt-2">
          Stored as a scrypt hash. Henry cannot show it back to you, and we cannot recover it
          for you — if you forget it, remove it from here and set a new one.
        </p>
      </div>
    </div>
  );
}