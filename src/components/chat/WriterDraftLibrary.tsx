import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import type { WriterDocumentTypeId } from '@/henry/documentTypes';
import { getWriterDocumentType } from '@/henry/documentTypes';
import {
  listRecentWriterDrafts,
  writerDraftDirForPath,
  type WriterDraftListEntry,
} from '@/henry/writerDraftIndex';
import { requestFilesTabOpenRelativeDir, setWriterActiveDraftPath } from '@/henry/writerDraftContext';

function buildUseDraftComposerPrompt(
  entry: WriterDraftListEntry,
  currentDocTypeLabel: string
): string {
  const savedType = entry.documentTypeLabel || 'unknown type';
  return `I'm continuing a saved Writer draft at workspace path \`${entry.relativePath}\` (saved as **${savedType}**). You do **not** have the file body in system context unless I paste it — work from my instructions and chat history. Current UI document type: **${currentDocTypeLabel}**.

Help me continue this draft (structure, tone, missing sections). If I want to reshape it into a roadmap, memo, or checklist, say so and we'll reframe explicitly.`;
}

function buildStartFreshPrompt(currentDocTypeLabel: string): string {
  return `Starting a **fresh** Writer draft. Document type: **${currentDocTypeLabel}**.

Goal: `;
}

interface WriterDraftLibraryProps {
  writerDocumentTypeId: WriterDocumentTypeId;
  onInjectChat: (text: string) => void;
  activeDraftPath: string | null;
  onRequestExportPack?: () => void;
  disabled?: boolean;
}

function formatModified(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

export default function WriterDraftLibrary({
  writerDocumentTypeId,
  onInjectChat,
  activeDraftPath,
  onRequestExportPack,
  disabled,
}: WriterDraftLibraryProps) {
  const settings = useStore((s) => s.settings);
  const setCurrentView = useStore((s) => s.setCurrentView);
  const workspaceReady = !!settings.workspace_path?.trim();

  const [drafts, setDrafts] = useState<WriterDraftListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentLabel = getWriterDocumentType(writerDocumentTypeId)?.label ?? writerDocumentTypeId;

  const load = useCallback(async () => {
    if (!workspaceReady) {
      setDrafts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await listRecentWriterDrafts({ limit: 12 });
      setDrafts(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceReady]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyAsContext(entry: WriterDraftListEntry) {
    setWriterActiveDraftPath(entry.relativePath);
    onInjectChat(buildUseDraftComposerPrompt(entry, currentLabel));
  }

  function openInFiles(entry: WriterDraftListEntry) {
    requestFilesTabOpenRelativeDir(writerDraftDirForPath(entry.relativePath));
    setCurrentView('files');
  }

  async function copyPath(path: string) {
    try {
      await safeCopyToClipboard(path);
    } catch {
      /* ignore */
    }
  }

  function startFresh() {
    setWriterActiveDraftPath(null);
    onInjectChat(buildStartFreshPrompt(currentLabel));
  }

  return (
    <div className="rounded-xl border border-henry-border/35 bg-henry-surface/20 px-4 py-3 mb-3 text-xs text-henry-text">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="font-semibold text-[10px] uppercase tracking-wide text-henry-text-muted">
          Draft library
        </span>
        <div className="flex items-center gap-2">
          {onRequestExportPack && (
            <button
              type="button"
              disabled={disabled || !workspaceReady}
              onClick={onRequestExportPack}
              className="text-[10px] text-henry-accent hover:underline disabled:opacity-40"
            >
              Export pack
            </button>
          )}
          <button
            type="button"
            disabled={disabled || !workspaceReady || loading}
            onClick={() => void load()}
            className="text-[10px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>

      <p className="text-[10px] text-henry-text-muted leading-relaxed mb-2">
        Writer drafts can be reused as explicit context without replaying everything. Active draft:{' '}
        {activeDraftPath ? (
          <code className="text-henry-text-dim break-all">{activeDraftPath}</code>
        ) : (
          <span className="text-henry-text-dim">none</span>
        )}
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          disabled={disabled}
          onClick={startFresh}
          className="px-2 py-1 rounded-lg border border-henry-accent/60 bg-henry-accent/15 text-[10px] hover:bg-henry-accent/25 disabled:opacity-40"
        >
          Start fresh draft
        </button>
        {activeDraftPath && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setWriterActiveDraftPath(null)}
            className="px-2 py-1 rounded-lg border border-henry-border/40 text-[10px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
          >
            Clear draft context
          </button>
        )}
      </div>

      {!workspaceReady && (
        <p className="text-[10px] text-henry-text-dim">Set a workspace in Settings to list drafts.</p>
      )}

      {workspaceReady && error && (
        <p className="text-[10px] text-henry-error mb-2">{error}</p>
      )}

      {workspaceReady && loading && <p className="text-[10px] text-henry-text-dim mb-2">Loading…</p>}

      {workspaceReady && !loading && drafts.length === 0 && !error && (
        <p className="text-[10px] text-henry-text-dim">
          No markdown drafts in <code className="text-henry-text-muted">Henry-Drafts/</code> yet. Save a
          reply with &quot;Save draft&quot;.
        </p>
      )}

      {drafts.length > 0 && (
        <ul className="space-y-2 max-h-52 overflow-y-auto">
          {drafts.map((d) => {
            const active = d.relativePath === activeDraftPath;
            return (
              <li
                key={d.relativePath}
                className={`rounded-lg border px-2 py-1.5 ${
                  active ? 'border-henry-accent/50 bg-henry-accent/10' : 'border-henry-border/30 bg-henry-bg/30'
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-1">
                  <span className="text-[11px] font-medium truncate max-w-[14rem]" title={d.filename}>
                    {d.filename}
                  </span>
                  <span className="text-[9px] text-henry-text-muted shrink-0">{formatModified(d.modified)}</span>
                </div>
                <div className="text-[10px] text-henry-text-dim mt-0.5">
                  {d.documentTypeLabel ? (
                    <span>Type: {d.documentTypeLabel}</span>
                  ) : (
                    <span>Type: unknown</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => applyAsContext(d)}
                    className="px-1.5 py-0.5 rounded border border-henry-border/45 text-[9px] hover:bg-henry-surface/50 disabled:opacity-40"
                  >
                    Use as context
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void copyPath(d.relativePath)}
                    className="px-1.5 py-0.5 rounded border border-henry-border/35 text-[9px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
                  >
                    Copy path
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => openInFiles(d)}
                    className="px-1.5 py-0.5 rounded border border-henry-border/35 text-[9px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
                  >
                    Open in Files
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
