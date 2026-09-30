/**
 * Lightweight companion session snapshot for restart recovery — not full replay, not hidden prompts.
 */

import type { HenryOperatingMode } from './charter';
import { isHenryOperatingMode } from './charter';
import type { WriterDocumentTypeId } from './documentTypes';
import { DEFAULT_WRITER_DOCUMENT_TYPE_ID, isWriterDocumentTypeId } from './documentTypes';
import type { Design3DWorkflowTypeId } from './design3dTypes';
import { DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID, isDesign3DWorkflowTypeId } from './design3dTypes';
import type { ActiveWorkspaceContext } from './workspaceContext';

export const HENRY_SESSION_RESUME_KEY = 'henry_session_resume_v1';

export const HENRY_SESSION_RECOVERY_DISMISSED_KEY = 'henry_session_recovery_banner_dismissed';

export interface SavedSessionStateV1 {
  v: 1;
  savedAt: string;
  lastConversationId: string | null;
  operatingMode: HenryOperatingMode;
  writerDocumentTypeId: WriterDocumentTypeId;
  design3dWorkflowTypeId: Design3DWorkflowTypeId;
  writerActiveDraftPath: string | null;
  design3dReferencePath: string | null;
  activeWorkspaceContext: ActiveWorkspaceContext | null;
  lastExportPackRelativeDir: string | null;
}

export interface SessionSnapshotInput {
  lastConversationId: string | null;
  operatingMode: HenryOperatingMode;
  writerDocumentTypeId: WriterDocumentTypeId;
  design3dWorkflowTypeId: Design3DWorkflowTypeId;
  writerActiveDraftPath: string | null;
  design3dReferencePath: string | null;
  activeWorkspaceContext: ActiveWorkspaceContext | null;
  lastExportPackRelativeDir?: string | null;
}

function normalizeMode(raw: unknown): HenryOperatingMode {
  return raw && isHenryOperatingMode(String(raw)) ? (raw as HenryOperatingMode) : 'companion';
}

function normalizeWriterDoc(raw: unknown): WriterDocumentTypeId {
  return raw && isWriterDocumentTypeId(String(raw))
    ? (raw as WriterDocumentTypeId)
    : DEFAULT_WRITER_DOCUMENT_TYPE_ID;
}

function normalizeDesign3d(raw: unknown): Design3DWorkflowTypeId {
  return raw && isDesign3DWorkflowTypeId(String(raw))
    ? (raw as Design3DWorkflowTypeId)
    : DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID;
}

function normalizeWorkspaceContext(raw: unknown): ActiveWorkspaceContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === 'string' ? o.path.trim().replace(/\\/g, '/') : '';
  const kind = o.kind === 'folder' || o.kind === 'file' ? o.kind : null;
  if (!path || !kind) return null;
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : path.split('/').pop() || path;
  return { path, kind, label };
}

/** Parse and coerce saved JSON; returns null if missing or unusable. */
export function readSavedSessionResume(): SavedSessionStateV1 | null {
  try {
    const raw = localStorage.getItem(HENRY_SESSION_RESUME_KEY)?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null;
    const savedAt = typeof o.savedAt === 'string' && o.savedAt ? o.savedAt : new Date().toISOString();
    const lastConversationId =
      typeof o.lastConversationId === 'string' && o.lastConversationId.trim()
        ? o.lastConversationId.trim()
        : null;
    const lastExport =
      typeof o.lastExportPackRelativeDir === 'string' && o.lastExportPackRelativeDir.trim()
        ? o.lastExportPackRelativeDir.trim()
        : null;
    return {
      v: 1,
      savedAt,
      lastConversationId,
      operatingMode: normalizeMode(o.operatingMode),
      writerDocumentTypeId: normalizeWriterDoc(o.writerDocumentTypeId),
      design3dWorkflowTypeId: normalizeDesign3d(o.design3dWorkflowTypeId),
      writerActiveDraftPath:
        typeof o.writerActiveDraftPath === 'string' && o.writerActiveDraftPath.trim()
          ? o.writerActiveDraftPath.trim()
          : null,
      design3dReferencePath:
        typeof o.design3dReferencePath === 'string' && o.design3dReferencePath.trim()
          ? o.design3dReferencePath.trim()
          : null,
      activeWorkspaceContext: normalizeWorkspaceContext(o.activeWorkspaceContext),
      lastExportPackRelativeDir: lastExport,
    };
  } catch {
    return null;
  }
}

/** Persist current snapshot (intentional, small — no transcripts). */
export function saveSessionResumeSnapshot(input: SessionSnapshotInput): void {
  const prev = readSavedSessionResume();
  const next: SavedSessionStateV1 = {
    v: 1,
    savedAt: new Date().toISOString(),
    lastConversationId: input.lastConversationId,
    operatingMode: input.operatingMode,
    writerDocumentTypeId: input.writerDocumentTypeId,
    design3dWorkflowTypeId: input.design3dWorkflowTypeId,
    writerActiveDraftPath: input.writerActiveDraftPath,
    design3dReferencePath: input.design3dReferencePath,
    activeWorkspaceContext: input.activeWorkspaceContext,
    lastExportPackRelativeDir:
      input.lastExportPackRelativeDir !== undefined
        ? input.lastExportPackRelativeDir
        : (prev?.lastExportPackRelativeDir ?? null),
  };
  try {
    localStorage.setItem(HENRY_SESSION_RESUME_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function clearSavedSessionResume(): void {
  try {
    localStorage.removeItem(HENRY_SESSION_RESUME_KEY);
  } catch {
    /* ignore */
  }
}

export interface SessionPathStaleReport {
  writerDraftStale: boolean;
  design3dRefStale: boolean;
  workspaceContextStale: boolean;
  exportPackStale: boolean;
}

/** Returns which referenced paths are missing in the workspace (requires henryAPI.pathExists). */
export async function checkSessionPathsStale(
  state: SavedSessionStateV1,
  pathExists: (relPath: string) => Promise<boolean>
): Promise<SessionPathStaleReport> {
  const report: SessionPathStaleReport = {
    writerDraftStale: false,
    design3dRefStale: false,
    workspaceContextStale: false,
    exportPackStale: false,
  };
  try {
    if (state.writerActiveDraftPath) {
      report.writerDraftStale = !(await pathExists(state.writerActiveDraftPath));
    }
    if (state.design3dReferencePath) {
      report.design3dRefStale = !(await pathExists(state.design3dReferencePath));
    }
    if (state.activeWorkspaceContext?.path) {
      report.workspaceContextStale = !(await pathExists(state.activeWorkspaceContext.path));
    }
    if (state.lastExportPackRelativeDir) {
      const manifest = `${state.lastExportPackRelativeDir.replace(/\/+$/, '')}/manifest.md`;
      report.exportPackStale = !(await pathExists(manifest));
    }
  } catch {
    report.writerDraftStale = !!state.writerActiveDraftPath;
    report.design3dRefStale = !!state.design3dReferencePath;
    report.workspaceContextStale = !!state.activeWorkspaceContext?.path;
    report.exportPackStale = !!state.lastExportPackRelativeDir;
  }
  return report;
}

/** Returns a YYYY-MM-DD key for today, used to make dismissal persist for the day. */
function getTodayDismissalKey(): string {
  const today = new Date().toISOString().slice(0, 10); // e.g. "2026-04-15"
  return `${HENRY_SESSION_RECOVERY_DISMISSED_KEY}:${today}`;
}

export function recoveryBannerDismissedThisAppSession(): boolean {
  try {
    // Check both localStorage (persists through refresh) and sessionStorage (legacy)
    const dailyKey = getTodayDismissalKey();
    return (
      localStorage.getItem(dailyKey) === '1' ||
      sessionStorage.getItem(HENRY_SESSION_RECOVERY_DISMISSED_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function setRecoveryBannerDismissedThisSession(): void {
  try {
    // Persist in localStorage with a daily key so refresh doesn't re-show the banner
    localStorage.setItem(getTodayDismissalKey(), '1');
    sessionStorage.setItem(HENRY_SESSION_RECOVERY_DISMISSED_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function clearRecoveryBannerDismissedThisSession(): void {
  try {
    localStorage.removeItem(getTodayDismissalKey());
    sessionStorage.removeItem(HENRY_SESSION_RECOVERY_DISMISSED_KEY);
  } catch {
    /* ignore */
  }
}
