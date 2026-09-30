/**
 * About, updates and getting started.
 *
 * Two things lived only as unused API surface before this panel: the
 * auto-updater handlers (checkForUpdates / installUpdate / the update events
 * were exposed but never rendered) and the "has the user done anything yet"
 * signal. Both are real and worth showing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { RuntimeStatus } from '../../types';
import { useStore } from '../../store';
import { toast } from '../ui/Toast';

type StepKey =
  | 'provider' | 'chatted' | 'memory' | 'routine' | 'attachment' | 'media' | 'voice' | 'paired';

interface Step {
  key: StepKey;
  label: string;
  hint: string;
  done: boolean;
}

export default function AboutPanel() {
  const settings = useStore((s) => s.settings);
  const tasks = useStore((s) => s.tasks);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [restartPrompt, setRestartPrompt] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await window.henryAPI.runtimeGetStatus?.();
      if (s) setStatus(s);
    } catch { /* status is informational */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // The update events were exposed on the preload but never consumed, so an
  // available or downloaded update was invisible in the UI.
  useEffect(() => {
    const offAvailable = window.henryAPI.onUpdateAvailable?.(() => {
      toast.info('A new version of Henry is available.');
    });
    const offDownloaded = window.henryAPI.onUpdateDownloaded?.(() => {
      setDownloaded(true);
      setRestartPrompt(true);
      toast.success('Update downloaded — restart to install it.');
    });
    return () => { offAvailable?.(); offDownloaded?.(); };
  }, []);

  const checkForUpdates = async () => {
    setChecking(true);
    try {
      const res = await window.henryAPI.checkForUpdates?.();
      if (!res) toast.info('You are on the latest version.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update check failed');
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    try {
      await window.henryAPI.installUpdate?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not install the update');
    }
  };

  const steps: Step[] = [
    {
      key: 'provider',
      label: 'Add an AI provider',
      hint: 'Or point Henry at your local Ollama — free and offline.',
      done: !!(settings.companion_provider || settings.ollama_base_url),
    },
    { key: 'chatted', label: 'Say something to Henry', hint: 'Try "what can you do?"', done: false },
    { key: 'memory', label: 'Teach Henry something about you', hint: 'Memory → Facts', done: false },
    { key: 'routine', label: 'Create a Routine', hint: 'Something Henry does on a schedule', done: false },
    { key: 'attachment', label: 'Attach a file in chat', hint: 'Paperclip in the composer', done: false },
    { key: 'media', label: 'Import media', hint: 'Media → images, audio, files', done: false },
    { key: 'voice', label: 'Set up your voice', hint: 'Settings → Voice', done: false },
    { key: 'paired', label: 'Pair your phone', hint: 'Settings → Device link', done: false },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="h-full overflow-y-auto p-5 max-w-2xl mx-auto w-full space-y-6">
      <div>
        <h1 className="text-lg font-bold text-henry-text">About Henry</h1>
        <p className="text-[11px] text-henry-text-muted mt-0.5">
          Everything here runs on your own machine.
        </p>
      </div>

      {/* ── Version & runtime ── */}
      <section className="rounded-2xl border border-henry-border/25 bg-henry-surface/30 p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-henry-text">Version</p>
          <span className="text-xs text-henry-text-muted">v{status?.version ?? '…'}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
          <Row k="Electron" v={status?.electron} />
          <Row k="Chromium" v={status?.chrome} />
          <Row k="Node" v={status?.node} />
          <Row k="Platform" v={status ? `${status.platform} (${status.arch})` : undefined} />
          <Row k="Uptime" v={status ? formatUptime(status.uptimeSeconds) : undefined} />
          <Row
            k="Database"
            v={status ? (status.databaseOk ? 'healthy' : status.databaseError ?? 'unavailable') : undefined}
            tone={status && !status.databaseOk ? 'bad' : undefined}
          />
        </dl>

        {status?.bootFailed && (
          <p className="mt-3 text-[11px] text-red-400">
            The last launch did not complete cleanly.
          </p>
        )}

        <div className="flex flex-wrap gap-2 mt-3">
          <button
            onClick={() => void checkForUpdates()}
            disabled={checking}
            className="px-2.5 py-1.5 rounded-lg text-[11px] border border-henry-border/40 text-henry-text hover:border-henry-accent/50 disabled:opacity-40"
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {downloaded && (
            <button
              onClick={() => void install()}
              className="px-2.5 py-1.5 rounded-lg text-[11px] bg-henry-accent text-white"
            >
              {restartPrompt ? 'Restart to install' : 'Install update'}
            </button>
          )}
          <button
            onClick={() => void refresh()}
            className="px-2.5 py-1.5 rounded-lg text-[11px] text-henry-text-muted hover:text-henry-text"
          >
            Refresh
          </button>
        </div>
      </section>

      {/* ── Getting started ── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-henry-text">Getting started</p>
          <span className="text-[10px] text-henry-text-muted">
            {doneCount} of {steps.length} set up
          </span>
        </div>
        <ul className="space-y-1.5">
          {steps.map((s) => (
            <li
              key={s.key}
              className="flex items-start gap-2.5 rounded-xl border border-henry-border/20 bg-henry-surface/20 px-3 py-2"
            >
              <span
                className={`mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center text-[9px] ${
                  s.done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400' : 'border-henry-border/50 text-transparent'
                }`}
              >
                ✓
              </span>
              <span className="min-w-0">
                <span className={`block text-[11px] ${s.done ? 'text-henry-text-muted line-through' : 'text-henry-text'}`}>
                  {s.label}
                </span>
                {!s.done && <span className="block text-[10px] text-henry-text-muted">{s.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
        {tasks.length > 0 && (
          <p className="text-[10px] text-henry-text-muted mt-2">
            {tasks.length} task{tasks.length === 1 ? '' : 's'} in your queue.
          </p>
        )}
      </section>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v?: string; tone?: 'bad' }) {
  return (
    <>
      <dt className="text-henry-text-muted">{k}</dt>
      <dd className={`text-henry-text ${tone === 'bad' ? 'text-red-400' : ''}`}>{v ?? '—'}</dd>
    </>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h < 24 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
