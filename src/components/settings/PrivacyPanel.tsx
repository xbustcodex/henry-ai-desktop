/**
 * PrivacyPanel — what Henry keeps, and what it sends.
 *
 * Henry is local-first: there is no outbound analytics path in the product at
 * all. That is the right default, but "we built it that way" is not something a
 * user can check, so this panel states it and backs it with switches that gate
 * real writes in the main process (`securityPolicy.persist*`).
 *
 * Turning a persistence switch off means rows are not written at all. Clearing
 * data actually deletes it and reports the row counts back, so the user can see
 * what happened rather than trusting a toast.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '../ui/Toast';
import type { HenryClearScope, HenryPrivacyStatus } from '../../global';

const CLEARABLE: Array<{ scope: HenryClearScope; label: string; help: string }> = [
  { scope: 'conversations', label: 'Conversations', help: 'Every thread, including its messages.' },
  { scope: 'memory', label: 'Memory', help: 'Facts, summaries and personal memory Henry learned about you.' },
  { scope: 'attachments', label: 'Attachments', help: 'Files sent in conversations.' },
  { scope: 'media', label: 'Media library', help: 'Images, audio and documents you imported.' },
  { scope: 'analytics', label: 'Usage and health records', help: 'Cost log, health logs and routine run history.' },
  { scope: 'logs', label: 'Application log', help: 'Diagnostic log lines. Credentials are already stripped.' },
];

export default function PrivacyPanel() {
  const [status, setStatus] = useState<HenryPrivacyStatus | null>(null);
  const [busy, setBusy] = useState<HenryClearScope | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await window.henryAPI.privacyGet());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the privacy settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setFlag = useCallback(
    async (key: string, value: boolean) => {
      try {
        const res = await window.henryAPI.securitySet(key, value);
        if (!res.ok) {
          toast.error('Could not change that setting');
          await load();
          return;
        }
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not change that setting');
      }
    },
    [load],
  );

  const clear = useCallback(
    async (scope: HenryClearScope) => {
      setBusy(scope);
      try {
        const res = await window.henryAPI.privacyClear([scope]);
        const removed = res.removed[scope] ?? 0;
        toast.success(
          removed > 0 ? `Deleted ${removed} row${removed === 1 ? '' : 's'}` : 'Nothing was stored there',
        );
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not delete that data');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (!status) return null;
  const { policy, telemetry, storage } = status;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-henry-text">Privacy</h2>
        <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
          What Henry stores on this machine, and what it sends.
        </p>
      </div>

      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-henry-text">Data sent off this machine</h3>
          <span
            className={
              telemetry.transmitsAnything
                ? 'text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400'
                : 'text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400'
            }
          >
            {telemetry.transmitsAnything ? 'enabled' : 'never'}
          </span>
        </div>
        <p className="text-[11px] text-henry-text-muted leading-relaxed">
          Henry has no telemetry, no crash reporting and no analytics upload. The only data that
          leaves this machine is what you explicitly ask for: replies from the AI provider you have
          configured, and any companion connection you turn on in Security.
        </p>

        <label className="flex items-start gap-3 mt-3 pt-3 border-t border-henry-border/20 cursor-pointer">
          <input
            type="checkbox"
            checked={policy.diagnosticsMetadata}
            onChange={(e) => void setFlag('diagnosticsMetadata', e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-henry-accent"
          />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-henry-text">
              Include model and provider names in diagnostics
            </span>
            <span className="block text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
              Off by default. Turning it on makes bug reports easier to read by naming which model
              was in use, at the cost of revealing that information.
            </span>
          </span>
        </label>
      </div>

      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-henry-text mb-1">What is kept on disk</h3>
        <p className="text-[11px] text-henry-text-muted mb-2 leading-relaxed">
          Turning one off stops new records being written. It does not delete what is already there
          — use the buttons below for that.
        </p>

        {(
          [
            [
              'persistConversations',
              'Keep conversation history',
              'Chat messages written to the local database.',
              storage.conversations,
            ],
            [
              'persistMemory',
              'Keep memory',
              'Facts and summaries Henry remembers about you.',
              storage.memory,
            ],
            [
              'persistAnalytics',
              'Keep usage and health records',
              'Cost log, health logs and routine history. Off by default — nothing is collected until you ask.',
              storage.analytics,
            ],
          ] as const
        ).map(([key, label, help, on]) => (
          <label
            key={key}
            className="flex items-start gap-3 py-3 border-b border-henry-border/20 last:border-0 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => void setFlag(key, e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-henry-accent"
            />
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-henry-text">{label}</span>
              <span className="block text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
                {help}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-henry-text mb-1">Delete stored data</h3>
        <p className="text-[11px] text-henry-text-muted mb-3 leading-relaxed">
          This really deletes the rows, not just hides them. It cannot be undone.
        </p>
        <div className="space-y-2">
          {CLEARABLE.map(({ scope, label, help }) => (
            <div key={scope} className="flex items-center gap-3 py-1.5">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-henry-text">{label}</div>
                <div className="text-[10px] text-henry-text-muted">{help}</div>
              </div>
              <button
                onClick={() => void clear(scope)}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40 whitespace-nowrap"
              >
                {busy === scope ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}