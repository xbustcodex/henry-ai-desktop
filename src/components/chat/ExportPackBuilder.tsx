import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../types';
import type { HenryOperatingMode } from '@/henry/charter';
import type { ActiveWorkspaceContext } from '@/henry/workspaceContext';
import {
  buildExportRelativeDir,
  collectArtifactsFromContext,
  EXPORT_PRESETS,
  EXPORT_SMALL_FILE_MAX_BYTES,
  type ExportArtifactItem,
  type ExportPresetId,
  safeCopyFileName,
  suggestDefaultTitle,
  suggestRelatedTaskIds,
  utf8ByteLength,
} from '@/henry/exportBundle';
import { buildExportManifestMarkdown } from '@/henry/exportManifest';

export interface ExportPackBuilderContext {
  operatingMode: HenryOperatingMode;
  writerActiveDraftPath: string | null;
  design3dRefPath: string | null;
  activeWorkspaceContext: ActiveWorkspaceContext | null;
  activeConversationId: string | null;
  tasks: Task[];
}

interface ExportPackBuilderProps {
  open: boolean;
  initialPreset: ExportPresetId;
  context: ExportPackBuilderContext;
  workspaceReady: boolean;
  onClose: () => void;
  /** Fired after manifest is written; relative dir is e.g. Henry-Exports/Title-20250404 */
  onExportCreated?: (relativeDir: string) => void;
}

export default function ExportPackBuilder({
  open,
  initialPreset,
  context,
  workspaceReady,
  onClose,
  onExportCreated,
}: ExportPackBuilderProps) {
  const [preset, setPreset] = useState<ExportPresetId>(initialPreset);
  const [title, setTitle] = useState('');
  const [artifacts, setArtifacts] = useState<ExportArtifactItem[]>([]);
  const [userNotes, setUserNotes] = useState('');
  const [relatedTaskIdsText, setRelatedTaskIdsText] = useState('');
  const [copySmallFiles, setCopySmallFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const collectCtx = useMemo(
    () => ({
      preset,
      writerActiveDraftPath: context.writerActiveDraftPath,
      design3dRefPath: context.design3dRefPath,
      activeWorkspaceContext: context.activeWorkspaceContext,
    }),
    [preset, context.writerActiveDraftPath, context.design3dRefPath, context.activeWorkspaceContext]
  );

  useEffect(() => {
    if (!open) return;
    setPreset(initialPreset);
  }, [open, initialPreset]);

  useEffect(() => {
    if (!open) return;
    setTitle(suggestDefaultTitle(preset));
    const arts = collectArtifactsFromContext(collectCtx);
    setArtifacts(arts);
    const paths = new Set(arts.map((a) => a.path).filter(Boolean));
    setRelatedTaskIdsText(suggestRelatedTaskIds(context.tasks, paths).join(', '));
    setError(null);
  }, [open, preset, collectCtx, context.tasks]);

  function removeArtifact(id: string) {
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleCreate() {
    if (!workspaceReady) {
      setError('Set a workspace folder in Settings first.');
      return;
    }
    const t = title.trim();
    if (!t) {
      setError('Title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    const createdAt = new Date().toISOString();
    const baseDir = buildExportRelativeDir(t, createdAt);
    const finalArtifacts: ExportArtifactItem[] = artifacts.map((a) => ({ ...a }));

    try {
      if (copySmallFiles) {
        for (let i = 0; i < finalArtifacts.length; i++) {
          const a = finalArtifacts[i];
          if (!a.path || a.inclusion !== 'referenced') continue;
          try {
            const content = await window.henryAPI.readFile(a.path);
            const bytes = utf8ByteLength(content);
            if (bytes > EXPORT_SMALL_FILE_MAX_BYTES) {
              finalArtifacts[i] = {
                ...a,
                note: `${a.note ? `${a.note} ` : ''}Copy skipped (>${EXPORT_SMALL_FILE_MAX_BYTES} bytes).`,
              };
              continue;
            }
            const name = safeCopyFileName(a.category, a.path);
            const dest = `${baseDir}/copies/${name}`;
            await window.henryAPI.writeFile(dest, content);
            finalArtifacts[i] = {
              ...a,
              inclusion: 'included',
              copiedTo: `copies/${name}`,
            };
          } catch (e: unknown) {
            finalArtifacts[i] = {
              ...a,
              note: `${a.note ? `${a.note} ` : ''}Copy failed: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        }
      }

      const relatedTaskIds = relatedTaskIdsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const bundle = {
        title: t,
        preset,
        operatingMode: context.operatingMode,
        createdAt,
        artifacts: finalArtifacts,
        relatedTaskIds,
        relatedConversationId: context.activeConversationId,
        userNotes,
      };

      const md = buildExportManifestMarkdown(bundle);
      await window.henryAPI.writeFile(`${baseDir}/manifest.md`, md);
      onExportCreated?.(baseDir);
      window.alert(`Export pack saved:\n${baseDir}/manifest.md`);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-pack-title"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-henry-border/40 bg-henry-bg shadow-xl p-4 text-henry-text"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="export-pack-title" className="text-sm font-semibold mb-1">
          Create export pack
        </h2>
        <p className="text-[10px] text-henry-text-muted leading-relaxed mb-3">
          Export packs can include direct artifacts and path-only references; both are labeled clearly in the
          manifest.
        </p>

        <div className="space-y-3 text-xs">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Preset
            </label>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as ExportPresetId)}
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2 py-1.5"
            >
              {EXPORT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-henry-text-dim mt-1">
              {EXPORT_PRESETS.find((p) => p.id === preset)?.description}
            </p>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Bundle title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2 py-1.5"
            />
          </div>

          <div>
            <span className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Artifacts (review)
            </span>
            {artifacts.length === 0 ? (
              <p className="text-[10px] text-henry-text-dim italic">No paths for this preset yet — add notes below or switch preset.</p>
            ) : (
              <ul className="space-y-1.5 border border-henry-border/25 rounded-lg p-2 max-h-40 overflow-y-auto">
                {artifacts.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start justify-between gap-2 text-[10px] border-b border-henry-border/15 last:border-0 pb-1.5 last:pb-0"
                  >
                    <div className="min-w-0">
                      <span className="text-henry-text-muted">{a.category}</span> · {a.label}
                      <div className="text-henry-text-dim break-all font-mono">{a.path || '—'}</div>
                      <span className="text-amber-400/90">Referenced (path only)</span>
                      {copySmallFiles && (
                        <span className="text-henry-text-muted"> — will try copy if ≤ {EXPORT_SMALL_FILE_MAX_BYTES / 1024} KB</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeArtifact(a.id)}
                      className="shrink-0 text-henry-text-muted hover:text-henry-error text-[10px]"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex items-center gap-2 text-[10px] text-henry-text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={copySmallFiles}
              onChange={(e) => setCopySmallFiles(e.target.checked)}
            />
            Copy small referenced files into the pack (≤ {EXPORT_SMALL_FILE_MAX_BYTES / 1024} KB each)
          </label>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Related task IDs (optional)
            </label>
            <input
              value={relatedTaskIdsText}
              onChange={(e) => setRelatedTaskIdsText(e.target.value)}
              placeholder="uuid, uuid…"
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2 py-1.5 font-mono text-[10px]"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-henry-text-muted block mb-1">
              Notes (embedded in manifest)
            </label>
            <textarea
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-henry-border/40 bg-henry-surface/30 px-2 py-1.5 text-[11px]"
              placeholder="Handoff intent, next steps, recipient…"
            />
          </div>

          {error && <p className="text-[10px] text-henry-error">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-henry-border/40 text-henry-text-muted hover:text-henry-text disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !workspaceReady}
              onClick={() => void handleCreate()}
              className="px-3 py-1.5 text-xs rounded-lg bg-henry-accent/90 text-white hover:bg-henry-accent disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Create bundle'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
