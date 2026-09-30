/**
 * Startup failure banner.
 *
 * If a previous launch died during boot, Henry records why. Showing it here —
 * instead of leaving a silent zombie process — is the difference between "the
 * app is broken" and "here is what broke and a button to fix it".
 */

import { useEffect, useState } from 'react';
import type { StartupFailure } from '../../types';

export default function StartupFailureBanner() {
  const [failure, setFailure] = useState<StartupFailure | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    void window.henryAPI
      .startupGetFailure?.()
      .then((f) => { if (f?.message) setFailure(f); })
      .catch(() => { /* nothing to show */ });
  }, []);

  if (!failure || dismissed) return null;

  const firstLine = failure.message.split('\n')[0];

  return (
    <div className="mx-5 mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-red-300">Henry didn&apos;t start cleanly last time</p>
          <p className="text-[11px] text-henry-text-muted mt-1 break-words">
            {firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine}
          </p>
          <p className="text-[10px] text-henry-text-muted/70 mt-1">
            {new Date(failure.at).toLocaleString()}
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-henry-text-muted hover:text-henry-text shrink-0"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>

      {showDetail && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-henry-bg/70 p-2 text-[10px] text-henry-text-muted whitespace-pre-wrap break-words">
          {failure.message}
        </pre>
      )}

      <div className="flex gap-2 mt-3">
        <button
          onClick={() => { setShowDetail((v) => !v); }}
          className="px-2.5 py-1.5 rounded-lg text-[11px] border border-henry-border/40 text-henry-text hover:border-henry-accent/50"
        >
          {showDetail ? 'Hide details' : 'Details'}
        </button>
        <button
          onClick={() => void window.henryAPI.runtimeRestart?.()}
          disabled={restarting}
          className="px-2.5 py-1.5 rounded-lg text-[11px] bg-henry-accent text-white disabled:opacity-40"
        >
          {restarting ? 'Restarting…' : 'Restart Henry'}
        </button>
        <button
          onClick={() => {
            setDismissed(true);
            void window.henryAPI.startupClearFailure?.();
          }}
          className="px-2.5 py-1.5 rounded-lg text-[11px] text-henry-text-muted hover:text-henry-text"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
