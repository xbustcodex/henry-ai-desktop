import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import type { MemoryContext } from '../../types';
import {
  buildHenryMemoryContextBlock,
  dedupeFactsTop,
  HENRY_MEMORY_CAPS,
} from '@/henry/memoryContext';
import type { HenryOperatingMode } from '@/henry/charter';
import { getWriterDocumentType } from '@/henry/documentTypes';
import { getDesign3DWorkflowType } from '@/henry/design3dTypes';
import {
  buildDesign3dReferenceFilesNote,
  readLastWorkspaceFilePath,
} from '@/henry/design3dReferenceContext';
import {
  buildLeanThreadSummaryFromMessages,
  recentTranscriptWindowSize,
} from '@/henry/threadSummaryHeuristic';
import type { ActiveWorkspaceContext } from '@/henry/workspaceContext';

const DISPLAY_FACTS = 6;

interface MemoryAwarenessPanelProps {
  operatingMode: HenryOperatingMode;
  writerDocumentTypeId: string;
  design3dWorkflowTypeId: string;
  /** Synced Design3D reference (falls back to localStorage if omitted). */
  design3dReferencePath?: string | null;
  /** Active Writer draft path for continuity (path only). */
  writerActiveDraftPath?: string | null;
  activeWorkspaceContext?: ActiveWorkspaceContext | null;
  /** Shown once after a saved session snapshot was applied on chat mount. */
  sessionContextRestored?: boolean;
  disabled?: boolean;
}

function modeLabel(mode: HenryOperatingMode): string {
  if (mode === 'design3d') return '3D / design';
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export default function MemoryAwarenessPanel({
  operatingMode,
  writerDocumentTypeId,
  design3dWorkflowTypeId,
  design3dReferencePath,
  writerActiveDraftPath,
  activeWorkspaceContext,
  sessionContextRestored,
  disabled,
}: MemoryAwarenessPanelProps) {
  const messages = useStore((s) => s.messages);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const conversations = useStore((s) => s.conversations);
  const settings = useStore((s) => s.settings);

  const [ctx, setCtx] = useState<MemoryContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);

  const convId = activeConversationId;
  const convTitle = conversations.find((c) => c.id === convId)?.title ?? null;
  const workspacePath = settings.workspace_path?.trim() || null;
  const threadMessages = convId ? messages.filter((m) => m.conversation_id === convId) : [];

  const loadContext = useCallback(async () => {
    if (!convId) {
      setCtx(null);
      return;
    }
    try {
      const c = await window.henryAPI.buildContext({
        conversationId: convId,
        maxFactsFetch: 40,
      });
      setCtx(c);
    } catch {
      setCtx(null);
    }
  }, [convId]);

  useEffect(() => {
    void loadContext();
  }, [loadContext, threadMessages.length]);

  const writerType = getWriterDocumentType(writerDocumentTypeId);
  const design3dType = getDesign3DWorkflowType(design3dWorkflowTypeId);
  const lastFile =
    operatingMode === 'design3d'
      ? (design3dReferencePath ?? readLastWorkspaceFilePath())
      : null;
  const design3dRefNote =
    operatingMode === 'design3d' && lastFile
      ? buildDesign3dReferenceFilesNote([lastFile])
      : null;

  const memoryBlock =
    ctx?.lean != null
      ? buildHenryMemoryContextBlock({
          mode: operatingMode,
          lean: ctx.lean,
          workspacePathHint: workspacePath,
          conversationTitle: convTitle,
          writerDocumentTypeLabel:
            operatingMode === 'writer' ? writerType?.label ?? null : null,
          design3dWorkflowLabel:
            operatingMode === 'design3d' ? design3dType?.label ?? null : null,
          design3dReferenceNote: design3dRefNote,
        })
      : '';

  const factsForDisplay = ctx?.lean?.facts
    ? dedupeFactsTop(ctx.lean.facts, DISPLAY_FACTS)
    : [];

  async function handleRefreshMemory() {
    if (!convId || disabled || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const { summary, messageCount, tokenCount } = buildLeanThreadSummaryFromMessages(
        threadMessages.map((m) => ({ role: m.role, content: m.content }))
      );
      const saved = await window.henryAPI.saveSummary({
        conversationId: convId,
        summary,
        messageCount,
        tokenCount,
      });
      if (saved.error || !saved.id) {
        setStatus(saved.error ?? 'Summary could not be saved.');
        return;
      }
      setStatus('Summary rebuilt from recent thread.');
      await loadContext();
    } catch (e: unknown) {
      setStatus(`Could not rebuild: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    const text = memoryBlock.trim();
    if (!text) return;
    try {
      await safeCopyToClipboard(text);
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1500);
    } catch {
      setStatus('Copy failed.');
    }
  }

  const win = recentTranscriptWindowSize();

  return (
    <aside
      className="w-[min(100%,18rem)] shrink-0 border-l border-henry-border/25 bg-henry-surface/15 flex flex-col overflow-hidden"
      aria-label="Thread memory and context"
    >
      <div className="px-3 py-2 border-b border-henry-border/20">
        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-henry-text-muted">
          Thread memory
        </h2>
        <p className="text-[10px] text-henry-text-dim mt-1 leading-relaxed">
          Henry uses summary memory, anchors, and a small window of recent messages — not a full replay
          of everything.
        </p>
        <p className="text-[10px] text-henry-text-muted mt-1.5 leading-relaxed">
          Continuity comes from the stored rollup, key facts, and the last {win} transcript turns sent with
          each reply.
        </p>
        {sessionContextRestored && (
          <p className="text-[10px] text-henry-text-dim/90 mt-1.5 leading-relaxed border-t border-henry-border/15 pt-1.5">
            Session context restored from last use — modes and paths you had selected are back; Henry still
            uses lean memory, not a full transcript replay.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 text-[11px] text-henry-text leading-snug">
        {!convId && (
          <p className="text-henry-text-dim">Open or start a conversation to see thread memory.</p>
        )}

        {convId && (
          <>
            <section>
              <h3 className="text-[10px] font-medium text-henry-text-muted uppercase mb-1">
                Active context
              </h3>
              <ul className="space-y-0.5 text-henry-text-dim">
                <li>
                  <span className="text-henry-text-muted">Mode:</span> {modeLabel(operatingMode)}
                </li>
                {operatingMode === 'writer' && writerType && (
                  <li>
                    <span className="text-henry-text-muted">Document type:</span> {writerType.label}
                  </li>
                )}
                {operatingMode === 'writer' && writerActiveDraftPath?.trim() && (
                  <li className="break-all">
                    <span className="text-henry-text-muted">Writer draft context:</span>{' '}
                    {writerActiveDraftPath.trim()}
                  </li>
                )}
                {operatingMode === 'design3d' && design3dType && (
                  <li>
                    <span className="text-henry-text-muted">Design3D workflow:</span> {design3dType.label}
                  </li>
                )}
                {operatingMode === 'design3d' && lastFile && (
                  <li className="break-all">
                    <span className="text-henry-text-muted">Reference file:</span> {lastFile}
                  </li>
                )}
                {convTitle && (
                  <li>
                    <span className="text-henry-text-muted">Thread:</span> {convTitle}
                  </li>
                )}
                {workspacePath && (
                  <li className="break-all">
                    <span className="text-henry-text-muted">Workspace:</span> {workspacePath}
                  </li>
                )}
                {activeWorkspaceContext && (
                  <li className="break-all">
                    <span className="text-henry-text-muted">Files context:</span>{' '}
                    {activeWorkspaceContext.kind} —{' '}
                    <code className="text-henry-text-dim">{activeWorkspaceContext.path}</code>
                  </li>
                )}
                <li>
                  <span className="text-henry-text-muted">Messages in thread:</span> {threadMessages.length}
                </li>
                {ctx != null && (
                  <li>
                    <span className="text-henry-text-muted">Facts loaded:</span> {ctx.factCount} (top{' '}
                    {Math.min(DISPLAY_FACTS, factsForDisplay.length)} shown)
                  </li>
                )}
              </ul>
            </section>

            <section>
              <h3 className="text-[10px] font-medium text-henry-text-muted uppercase mb-1">
                Conversation rollup
              </h3>
              {ctx?.lean.conversationSummary?.trim() ? (
                <p className="whitespace-pre-wrap text-henry-text-dim border-l-2 border-henry-accent/30 pl-2">
                  {ctx.lean.conversationSummary.length > 900
                    ? `${ctx.lean.conversationSummary.slice(0, 900)}…`
                    : ctx.lean.conversationSummary}
                </p>
              ) : (
                <p className="text-henry-text-dim italic">No stored summary yet. Rebuild to capture themes from recent turns.</p>
              )}
            </section>

            <section>
              <h3 className="text-[10px] font-medium text-henry-text-muted uppercase mb-1">
                Key facts & anchors
              </h3>
              {factsForDisplay.length > 0 ? (
                <ul className="space-y-1.5">
                  {factsForDisplay.map((f, i) => {
                    const catColors: Record<string, string> = {
                      person:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
                      project:    'bg-purple-500/10 text-purple-400 border-purple-500/20',
                      preference: 'bg-green-500/10 text-green-400 border-green-500/20',
                      goal:       'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                      fact:       'bg-henry-surface border-henry-border/30 text-henry-text-muted',
                      conversation: 'bg-henry-surface border-henry-border/20 text-henry-text-muted',
                    };
                    const color = catColors[f.category] ?? catColors.fact;
                    return (
                      <li key={`${f.fact.slice(0, 40)}-${i}`} className="flex items-start gap-1.5">
                        <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide mt-0.5 ${color}`}>
                          {f.category}
                        </span>
                        <span className="text-[11px] text-henry-text-dim leading-snug">{f.fact}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-henry-text-dim italic">No facts in store for this thread yet.</p>
              )}
              {/* Auto-extracted facts from this session */}
              {(() => {
                try {
                  const autoFacts = JSON.parse(localStorage.getItem('henry:facts') || '[]') as Array<{id: string; content: string; category: string; confidence: string; source: string}>;
                  const sessionFacts = autoFacts.filter(f => f.source === 'auto').slice(-5);
                  if (sessionFacts.length === 0) return null;
                  const catColors: Record<string, string> = {
                    person:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
                    project:    'bg-purple-500/10 text-purple-400 border-purple-500/20',
                    preference: 'bg-green-500/10 text-green-400 border-green-500/20',
                    goal:       'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                    fact:       'bg-henry-surface border-henry-border/30 text-henry-text-muted',
                  };
                  return (
                    <div className="mt-2 pt-2 border-t border-henry-border/20">
                      <p className="text-[9px] font-medium text-henry-accent/60 uppercase tracking-wide mb-1.5">Auto-extracted this session</p>
                      <ul className="space-y-1">
                        {sessionFacts.map(f => (
                          <li key={f.id} className="flex items-start gap-1.5">
                            <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide mt-0.5 ${catColors[f.category] ?? catColors.fact}`}>{f.category}</span>
                            <span className="text-[11px] text-henry-text-dim leading-snug">{f.content}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                } catch { return null; }
              })()}
            </section>

            {ctx?.lean.workspaceHints && ctx.lean.workspaceHints.length > 0 && (
              <section>
                <h3 className="text-[10px] font-medium text-henry-text-muted uppercase mb-1">
                  Indexed workspace (from last lookup query)
                </h3>
                <ul className="space-y-1 text-henry-text-dim break-all">
                  {ctx.lean.workspaceHints.slice(0, HENRY_MEMORY_CAPS.maxWorkspaceHints).map((h) => (
                    <li key={h.file_path}>
                      <code className="text-[10px]">{h.file_path}</code>
                      {h.summary ? ` — ${h.summary.slice(0, 120)}${h.summary.length > 120 ? '…' : ''}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-henry-border/20 px-3 py-2 space-y-2">
        {status && <p className="text-[10px] text-henry-text-dim">{status}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!convId || disabled || busy}
            onClick={() => void loadContext()}
            className="px-2 py-1 rounded-lg border border-henry-border/45 bg-henry-surface/35 text-[10px] hover:bg-henry-surface/55 disabled:opacity-40"
          >
            Refresh view
          </button>
          <button
            type="button"
            disabled={!convId || disabled || busy || threadMessages.length === 0}
            onClick={() => void handleRefreshMemory()}
            className="px-2 py-1 rounded-lg border border-henry-border/45 bg-henry-accent/85 text-white text-[10px] hover:bg-henry-accent disabled:opacity-40"
          >
            Rebuild summary
          </button>
          <button
            type="button"
            disabled={!memoryBlock.trim()}
            onClick={() => void handleCopy()}
            className="px-2 py-1 rounded-lg border border-henry-border/35 text-[10px] text-henry-text-muted hover:text-henry-text disabled:opacity-40"
          >
            {copyFlash ? 'Copied' : 'Copy memory block'}
          </button>
        </div>
      </div>
    </aside>
  );
}
