/**
 * Build follow-up Worker tasks from chat messages — workspace bridge (path hints only).
 */

import type { HenryOperatingMode } from './charter';
import type { Message } from '../types';

export type TaskOriginMode = HenryOperatingMode;

export interface WorkspaceLinkageForTask {
  /** Workspace-relative path when relevant (Writer draft, Design3D ref, etc.). */
  relatedFilePath: string | null;
}

export interface SuggestedTaskFromMessageInput {
  message: Message;
  operatingMode: HenryOperatingMode;
  linkage: WorkspaceLinkageForTask;
}

export interface SuggestedTaskFromMessage {
  /** Short line for the task queue list (DB `description`). */
  title: string;
  /** Full instructions for the Worker (`payload.prompt`). */
  description: string;
  sourceMode: TaskOriginMode;
  relatedFilePath?: string;
  relatedConversationId: string;
  createdFromMessageId: string;
  /** Default Worker task type for follow-ups from chat. */
  taskType: 'ai_generate';
}

const ACTION_RE =
  /\b(next steps?|action items?|todo|follow[- ]?up|implement|schedule|deadline|deliverable|checklist|milestone|ship|roll ?out)\b/i;

function firstMeaningfulLine(text: string, maxLen: number): string {
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines) {
    const t = line.replace(/^#+\s*/, '').replace(/^\*\s+/, '').trim();
    if (t.length >= 8) {
      return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
    }
  }
  const one = text.trim().replace(/\s+/g, ' ');
  return one.length > maxLen ? `${one.slice(0, maxLen - 1)}…` : one || 'Follow-up from Henry chat';
}

function clipBody(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Prefill title + Worker prompt body from an assistant message (no file read).
 */
export function buildSuggestedTaskFromMessage(input: SuggestedTaskFromMessageInput): SuggestedTaskFromMessage {
  const { message, operatingMode, linkage } = input;
  const raw = (message.content || '').trim();
  const title = firstMeaningfulLine(raw, 120);
  const path = linkage.relatedFilePath?.trim();
  const pathNote = path
    ? `\n\n---\nWorkspace link (path only; file not auto-loaded): \`${path}\``
    : '';
  const description = clipBody(
    `Follow up on this Henry ${operatingMode} reply and carry it forward in the workspace.\n\n---\n\n${raw}${pathNote}`,
    12000
  );

  return {
    title,
    description,
    sourceMode: operatingMode,
    ...(path ? { relatedFilePath: path } : {}),
    relatedConversationId: message.conversation_id,
    createdFromMessageId: message.id,
    taskType: 'ai_generate',
  };
}

export function shouldOfferCreateTaskFromMessage(
  operatingMode: HenryOperatingMode,
  message: Message,
  isErrorBubble: boolean
): boolean {
  if (message.role !== 'assistant' || isErrorBubble) return false;
  if (message.engine === 'worker') return false;
  const c = (message.content || '').trim();
  if (!c) return false;

  if (operatingMode === 'writer' || operatingMode === 'design3d') {
    return true;
  }
  if (operatingMode === 'companion' || operatingMode === 'developer') {
    return c.length >= 280 || ACTION_RE.test(c);
  }
  return false;
}

export function resolveWorkspaceLinkageForTask(
  operatingMode: HenryOperatingMode,
  paths: { writerActiveDraftPath: string | null; design3dRefPath: string | null }
): WorkspaceLinkageForTask {
  if (operatingMode === 'writer' && paths.writerActiveDraftPath?.trim()) {
    return { relatedFilePath: paths.writerActiveDraftPath.trim() };
  }
  if (operatingMode === 'design3d' && paths.design3dRefPath?.trim()) {
    return { relatedFilePath: paths.design3dRefPath.trim() };
  }
  return { relatedFilePath: null };
}
