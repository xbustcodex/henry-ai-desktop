import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useState } from 'react';
import type { Design3DWorkflowTypeId } from '@/henry/design3dTypes';
import { getDesign3DWorkflowType } from '@/henry/design3dTypes';
import {
  buildDesign3dReferenceSummaryPlain,
  classifyReferencePath,
  clearDesign3dReferencePath,
  DESIGN3D_REFERENCE_LIMITATIONS_LINE,
  referenceKindLabel,
} from '@/henry/design3dReferenceContext';
import { DESIGN3D_QUICK_ACTIONS } from '@/henry/design3dQuickActions';

interface Design3DReferencePanelProps {
  referencePath: string | null;
  workflowTypeId: Design3DWorkflowTypeId;
  onWorkflowChange: (id: Design3DWorkflowTypeId) => void;
  onInjectChat: (text: string) => void;
  onRequestExportPack?: () => void;
  disabled?: boolean;
}

export default function Design3DReferencePanel({
  referencePath,
  workflowTypeId,
  onWorkflowChange,
  onInjectChat,
  onRequestExportPack,
  disabled,
}: Design3DReferencePanelProps) {
  const [copyFlash, setCopyFlash] = useState(false);
  const wf = getDesign3DWorkflowType(workflowTypeId);

  async function copySummary() {
    const text = buildDesign3dReferenceSummaryPlain(referencePath, wf?.label ?? workflowTypeId);
    try {
      await safeCopyToClipboard(text);
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="rounded-xl border border-henry-border/35 bg-henry-surface/20 px-4 py-3 mb-3 text-xs text-henry-text">
      <div className="font-semibold text-[10px] uppercase tracking-wide text-henry-text-muted mb-2">
        Design3D reference
      </div>

      {referencePath ? (
        <div className="space-y-1 mb-2">
          <p className="text-[11px] text-henry-text break-all">
            <span className="text-henry-text-muted">Path: </span>
            <code className="text-henry-text-dim">{referencePath}</code>
          </p>
          <p className="text-[10px] text-henry-text-dim">
            {referenceKindLabel(classifyReferencePath(referencePath))} (from filename — not content
            analysis)
          </p>
        </div>
      ) : (
        <p className="text-[10px] text-henry-text-dim mb-2">
          No reference set. In <span className="text-henry-text-muted">Files</span>, use{' '}
          <span className="text-henry-text">Ref</span> on a file to attach it for Design3D planning.
        </p>
      )}

      <p className="text-[10px] text-henry-text-muted leading-relaxed mb-3">{DESIGN3D_REFERENCE_LIMITATIONS_LINE}</p>

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => void copySummary()}
          className="px-2 py-1 rounded-lg border border-henry-border/45 bg-henry-surface/35 text-[10px] hover:bg-henry-surface/55 disabled:opacity-40"
        >
          {copyFlash ? 'Copied' : 'Copy reference summary'}
        </button>
        {referencePath && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => clearDesign3dReferencePath()}
            className="px-2 py-1 rounded-lg border border-henry-border/35 text-[10px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
          >
            Clear reference
          </button>
        )}
      </div>

      {onRequestExportPack && (
        <div className="mb-2">
          <button
            type="button"
            disabled={disabled}
            onClick={onRequestExportPack}
            className="text-[10px] text-henry-accent hover:underline disabled:opacity-40"
          >
            Create export pack
          </button>
        </div>
      )}

      <div className="text-[10px] font-medium text-henry-text-muted uppercase mb-1.5">Quick starts</div>
      <div className="flex flex-wrap gap-2">
        {DESIGN3D_QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={disabled}
            onClick={() => {
              onWorkflowChange(a.workflowId);
              onInjectChat(a.buildPrompt(referencePath));
            }}
            className="px-2 py-1 rounded-lg border border-henry-border/50 bg-henry-bg/50 text-[10px] hover:bg-henry-surface/50 disabled:opacity-40"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
