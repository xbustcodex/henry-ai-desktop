import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useState } from 'react';
import type { ActiveWorkspaceContext } from '@/henry/workspaceContext';
import {
  buildUseWorkspaceContextComposerSeed,
  buildWorkspaceContextSummaryPlain,
  clearActiveWorkspaceContext,
} from '@/henry/workspaceContext';

interface WorkspaceContextStripProps {
  context: ActiveWorkspaceContext | null;
  /** Optional hint text shown when copying (e.g. from last memory query). */
  indexHintForCopy?: string | null;
  onInjectChat: (text: string) => void;
  disabled?: boolean;
}

export default function WorkspaceContextStrip({
  context,
  indexHintForCopy,
  onInjectChat,
  disabled,
}: WorkspaceContextStripProps) {
  const [copyFlash, setCopyFlash] = useState(false);

  async function handleCopy() {
    if (!context) return;
    try {
      await safeCopyToClipboard(
        buildWorkspaceContextSummaryPlain(context, indexHintForCopy ?? null)
      );
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="rounded-xl border border-henry-border/30 bg-henry-surface/15 px-3 py-2 mb-3 text-[11px] text-henry-text">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-henry-text-muted">
          Workspace context
        </span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={disabled || !context}
            onClick={() => void handleCopy()}
            className="px-2 py-0.5 rounded-md border border-henry-border/40 text-[10px] hover:bg-henry-surface/40 disabled:opacity-40"
          >
            {copyFlash ? 'Copied' : 'Copy summary'}
          </button>
          {context && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => clearActiveWorkspaceContext()}
              className="px-2 py-0.5 rounded-md border border-henry-border/30 text-[10px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
            >
              Clear
            </button>
          )}
          {context && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onInjectChat(buildUseWorkspaceContextComposerSeed(context))}
              className="px-2 py-0.5 rounded-md border border-henry-accent/35 bg-henry-accent/10 text-[10px] text-henry-accent hover:bg-henry-accent/20 disabled:opacity-40"
            >
              Use in chat
            </button>
          )}
        </div>
      </div>

      {context ? (
        <>
          <p className="text-xs break-all">
            <span className="text-henry-text-muted">{context.kind === 'folder' ? 'Folder' : 'File'}: </span>
            <code className="text-henry-text-dim">{context.path}</code>
            <span className="text-henry-text-muted"> · {context.label}</span>
          </p>
          <p className="text-[10px] text-henry-text-muted leading-relaxed mt-1.5">
            This context is a selected workspace reference. Henry may know the path and any explicitly loaded
            hints, not the full contents by default. Selected workspace context guides Henry without replaying
            entire files.
          </p>
        </>
      ) : (
        <p className="text-[10px] text-henry-text-dim">
          No file or folder selected. In <span className="text-henry-text-muted">Files</span> or{' '}
          <span className="text-henry-text-muted">Workspace</span>, use <span className="text-henry-text">Use as context</span>{' '}
          on a row.
        </p>
      )}
    </div>
  );
}
