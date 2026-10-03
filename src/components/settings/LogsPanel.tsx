/**
 * LogsPanel — a general application log viewer.
 *
 * Before this, the only log surface was health-scoped: weight and water entries
 * written by a panel. There was no way to answer "what happened at 3pm" from
 * inside the app, which is the question a log exists to answer.
 *
 * Nothing here does its own redaction. Credentials are stripped as each line is
 * written to disk (see electron/ipc/appLog.ts), so this panel — and the export —
 * only ever reads the already-redacted form. Rendering a redacted line is
 * therefore safe by construction rather than by a filter applied at display
 * time, which is what a future endpoint would forget to do.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '../ui/Toast';
import type { HenryLogEntry, HenryLogLevel, HenryLogStats } from '../../global';

const LEVELS: Array<{ value: HenryLogLevel | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
];

const LEVEL_COLOR: Record<HenryLogLevel, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  info: 'text-sky-400',
  debug: 'text-henry-text-muted',
};

export default function LogsPanel() {
  const [entries, setEntries] = useState<HenryLogEntry[]>([]);
  const [stats, setStats] = useState<HenryLogStats | null>(null);
  const [level, setLevel] = useState<HenryLogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const [retention, setRetention] = useState(14);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rows, s, r] = await Promise.all([
        window.henryAPI.logsQuery({ level, search: search || undefined, limit: 500 }),
        window.henryAPI.logsStats(),
        window.henryAPI.logsGetRetention(),
      ]);
      setEntries(rows);
      setStats(s);
      setRetention(r.days);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the log');
    }
  }, [level, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportLog = useCallback(async () => {
    setBusy(true);
    try {
      const { text } = await window.henryAPI.logsExport({ level, search: search || undefined });
      if (!text) {
        toast.error('Nothing to export with those filters');
        return;
      }
      // A plain-text blob the user saves themselves, rather than a path we pick
      // for them — Henry must not choose where a copy of the log lands.
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `henry-log-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }, [level, search]);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-henry-text">Application log</h2>
        <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
          What Henry has been doing on this machine. API keys, tokens and passwords are stripped as
          each line is written, so they are not in this log in the first place.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              onClick={() => setLevel(l.value)}
              className={
                'px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ' +
                (level === l.value
                  ? 'bg-henry-accent/20 text-henry-accent'
                  : 'text-henry-text-muted hover:text-henry-text')
              }
            >
              {l.label}
              {l.value !== 'all' && stats?.byLevel[l.value] ? ` (${stats.byLevel[l.value]})` : ''}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          className="flex-1 min-w-[120px] bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-1.5 text-xs text-henry-text outline-none focus:border-henry-accent/50"
        />
        <button
          onClick={() => void exportLog()}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 disabled:opacity-40"
        >
          {busy ? 'Exporting…' : 'Export'}
        </button>
        <button
          onClick={async () => {
            const n = await window.henryAPI.logsClear();
            toast.success(n.removed ? `Cleared ${n.removed} lines` : 'Log was already empty');
            await load();
          }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10"
        >
          Clear
        </button>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-henry-text-muted">
        <span>{stats?.total ?? 0} lines kept</span>
        <span>·</span>
        <label className="flex items-center gap-1.5">
          keep
          <input
            type="number"
            min={1}
            max={365}
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
            onBlur={async () => {
              const r = await window.henryAPI.logsSetRetention(retention);
              setRetention(r.days);
              await load();
            }}
            className="w-16 bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1 text-xs text-henry-text"
          />
          days
        </label>
      </div>

      <div className="bg-henry-bg border border-henry-border/30 rounded-2xl max-h-96 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {entries.length === 0 ? (
          <div className="p-4 text-henry-text-muted">No log lines match those filters.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="px-3 py-1 border-b border-henry-border/10 last:border-0 flex gap-2">
              <span className="text-henry-text-muted shrink-0">{e.ts.slice(11, 19)}</span>
              <span className={`shrink-0 w-11 ${LEVEL_COLOR[e.level]}`}>{e.level}</span>
              {e.scope && <span className="text-henry-accent shrink-0">{e.scope}</span>}
              <span className="text-henry-text break-all">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}