/**
 * Lightweight export pack model — manifest + optional small-file copies (workspace-relative paths).
 */

import type { HenryOperatingMode } from './charter';
import type { ActiveWorkspaceContext } from './workspaceContext';
import type { Task } from '../types';

export const HENRY_EXPORTS_SUBDIR = 'Henry-Exports';

/** UTF-8 byte length for copy guardrails. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const EXPORT_SMALL_FILE_MAX_BYTES = 48 * 1024;

export type ExportPresetId = 'writer_handoff' | 'design3d_handoff' | 'mixed_workspace';

export interface ExportPresetMeta {
  id: ExportPresetId;
  label: string;
  description: string;
  defaultTitlePrefix: string;
}

export const EXPORT_PRESETS: readonly ExportPresetMeta[] = [
  {
    id: 'writer_handoff',
    label: 'Writer handoff',
    description: 'Active Writer draft + workspace selection when set.',
    defaultTitlePrefix: 'Writer handoff',
  },
  {
    id: 'design3d_handoff',
    label: 'Design3D handoff',
    description: 'Design3D reference + workspace selection when set.',
    defaultTitlePrefix: 'Design3D handoff',
  },
  {
    id: 'mixed_workspace',
    label: 'Mixed workspace bundle',
    description: 'All current paths: Writer, Design3D, workspace context.',
    defaultTitlePrefix: 'Workspace export pack',
  },
] as const;

export function getExportPresetMeta(id: ExportPresetId): ExportPresetMeta {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS[3];
}

/** How the item appears in the pack. */
export type ExportInclusion = 'referenced' | 'included';

export interface ExportArtifactItem {
  /** Stable id for UI (usually path). */
  id: string;
  /** Workspace-relative path; empty for synthetic rows. */
  path: string;
  label: string;
  category: string;
  inclusion: ExportInclusion;
  /** If copied into pack subfolder, relative path inside the export directory. */
  copiedTo?: string;
  /** User-facing note (e.g. copy failure). */
  note?: string;
}

export interface ExportBundleModel {
  title: string;
  preset: ExportPresetId;
  operatingMode: HenryOperatingMode;
  createdAt: string;
  artifacts: ExportArtifactItem[];
  relatedTaskIds: string[];
  relatedConversationId: string | null;
  /** Embedded in manifest (always “included” as text). */
  userNotes: string;
}

export const EXPORT_PATH_HONESTY =
  'Unless marked **Included (copied)**, artifacts are **path references only** — the bundle folder does not contain those files by default. Recipients need workspace access at those paths or separate delivery.';

export interface CollectArtifactsContext {
  preset: ExportPresetId;
  writerActiveDraftPath: string | null;
  design3dRefPath: string | null;
  activeWorkspaceContext: ActiveWorkspaceContext | null;
}

function pushArtifact(
  out: ExportArtifactItem[],
  path: string | null | undefined,
  label: string,
  category: string
) {
  const p = path?.trim();
  if (!p) return;
  if (out.some((x) => x.path === p)) return;
  out.push({
    id: p,
    path: p,
    label,
    category,
    inclusion: 'referenced',
  });
}

/**
 * Build default artifact list from live UI context (all referenced until optional copy step).
 */
export function collectArtifactsFromContext(ctx: CollectArtifactsContext): ExportArtifactItem[] {
  const out: ExportArtifactItem[] = [];
  switch (ctx.preset) {
    case 'writer_handoff':
      pushArtifact(out, ctx.writerActiveDraftPath, 'Active Writer draft', 'writer');
      if (ctx.activeWorkspaceContext) {
        pushArtifact(out, ctx.activeWorkspaceContext.path, 'Workspace context selection', 'workspace');
      }
      break;
    case 'design3d_handoff':
      pushArtifact(out, ctx.design3dRefPath, 'Design3D reference file', 'design3d');
      if (ctx.activeWorkspaceContext) {
        pushArtifact(out, ctx.activeWorkspaceContext.path, 'Workspace context selection', 'workspace');
      }
      break;
    case 'mixed_workspace':
    default:
      pushArtifact(out, ctx.writerActiveDraftPath, 'Writer draft', 'writer');
      pushArtifact(out, ctx.design3dRefPath, 'Design3D reference', 'design3d');
      if (ctx.activeWorkspaceContext) {
        pushArtifact(out, ctx.activeWorkspaceContext.path, 'Workspace context selection', 'workspace');
      }
      break;
  }
  return out;
}

export function suggestDefaultTitle(preset: ExportPresetId, d = new Date()): string {
  const meta = getExportPresetMeta(preset);
  const stamp = d.toISOString().slice(0, 16).replace('T', ' ');
  return `${meta.defaultTitlePrefix} — ${stamp}`;
}

export function suggestRelatedTaskIds(tasks: readonly Task[], artifactPaths: ReadonlySet<string>): string[] {
  if (artifactPaths.size === 0) return [];
  const paths = [...artifactPaths];
  const out: string[] = [];
  for (const t of tasks) {
    const rp = t.related_file_path?.trim();
    if (!rp) continue;
    const match = paths.some(
      (ap) => rp === ap || rp.startsWith(`${ap}/`) || ap.startsWith(`${rp}/`)
    );
    if (match) {
      out.push(t.id);
      if (out.length >= 12) break;
    }
  }
  return out;
}

export function sanitizeExportFolderSegment(title: string): string {
  const t = title
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return t || 'export-pack';
}

export function buildExportRelativeDir(title: string, createdAt: string): string {
  const folder = sanitizeExportFolderSegment(title);
  const stamp = createdAt.slice(0, 10).replace(/-/g, '');
  return `${HENRY_EXPORTS_SUBDIR}/${folder}-${stamp}`;
}

export function safeCopyFileName(category: string, relativePath: string): string {
  const base = relativePath.split('/').pop() || 'file';
  const safe = base.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
  const prefix = category.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 20) || 'file';
  return `${prefix}-${safe}`;
}
