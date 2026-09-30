/**
 * Maps parsed Henry commands to acknowledgement copy and side-effect hints for the chat shell.
 */

import type { HenryOperatingMode } from './charter';
import type { WriterDocumentTypeId } from './documentTypes';
import type { Design3DWorkflowTypeId } from './design3dTypes';
import type { ActiveWorkspaceContext } from './workspaceContext';
import { buildUseWorkspaceContextComposerSeed } from './workspaceContext';
import { getDocumentScaffoldMarkdown } from './formatDocumentDraft';
import { getDesign3DPlanScaffoldMarkdown } from './formatDesign3DPlan';
import type { HenryCommand } from './commandLayer';
import type { ExportPresetId } from './exportBundle';

export interface CommandContextSnapshot {
  operatingMode: HenryOperatingMode;
  writerDocumentTypeId: WriterDocumentTypeId;
  design3dWorkflowTypeId: Design3DWorkflowTypeId;
  workspaceReady: boolean;
  activeWorkspaceContext: ActiveWorkspaceContext | null;
}

export interface CommandEffects {
  setOperatingMode?: HenryOperatingMode;
  newChat?: boolean;
  clearWriterDraft?: boolean;
  clearDesign3dRef?: boolean;
  clearWorkspaceContext?: boolean;
  /** Injected into the composer via parent state (chat inject). */
  composerSeed?: string;
  openExportPackPreset?: ExportPresetId;
}

export interface CommandOutcome {
  acknowledgement: string;
  effects: CommandEffects;
}

const MODE_LABEL: Record<HenryOperatingMode, string> = {
  companion: 'Companion',
  writer: 'Writer / document',
  developer: 'Developer',
  builder: 'App Builder',
  design3d: '3D / design',
  secretary: 'Secretary',
  computer: 'Computer control',
  coach: 'Coach',
  strategic: 'Strategic',
  business: 'Business Builder',
};

/** Markdown list for /help and command errors. */
export function buildHenryCommandHelpText(): string {
  return [
    '**Henry commands** (lightweight operator shortcuts):',
    '',
    '- `/help` — this list',
    '- `/new` — fresh thread (same window; modes unchanged)',
    '- `/mode companion` | `writer` | `design3d` | `developer` — switch operating mode',
    '- `/memory` — where lean thread memory lives (right panel)',
    '- `/clear-context` — clear Writer draft, Design3D reference, and workspace selection',
    '- `/use-workspace-context` — seed composer from the active workspace context (if any)',
    '- `/start-design-plan` — Design3D mode + plan scaffold in composer',
    '- `/start-draft` — Writer mode + document scaffold in composer',
    '- `/export-pack` — open export pack builder',
    '',
    'Plain messages still go to Henry as usual.',
  ].join('\n');
}

export function resolveHenryCommand(cmd: HenryCommand, ctx: CommandContextSnapshot): CommandOutcome {
  const effects: CommandEffects = {};

  switch (cmd.kind) {
    case 'help':
      return { acknowledgement: buildHenryCommandHelpText(), effects };

    case 'new':
      effects.newChat = true;
      return {
        acknowledgement:
          '**New thread.** Conversation cleared. Modes and settings are unchanged — say what you want to work on next.',
        effects,
      };

    case 'mode-invalid':
      return {
        acknowledgement: `Unknown mode \`${cmd.arg || '(missing)'}\`. Use \`/mode companion\`, \`/mode writer\`, \`/mode design3d\`, or \`/mode developer\`. Try \`/help\` for the full list.`,
        effects,
      };

    case 'mode': {
      effects.setOperatingMode = cmd.mode;
      return {
        acknowledgement: `**Mode:** ${MODE_LABEL[cmd.mode]} (\`${cmd.mode}\`).`,
        effects,
      };
    }

    case 'memory':
      return {
        acknowledgement:
          '**Thread memory** lives in the right-hand **Thread memory** panel — lean summary, facts, and a small recent window. Henry does not replay your full history into every request.',
        effects,
      };

    case 'clear-context': {
      effects.clearWriterDraft = true;
      effects.clearDesign3dRef = true;
      effects.clearWorkspaceContext = true;
      return {
        acknowledgement:
          '**Context cleared.** Writer draft selection, Design3D reference path, and workspace context selection are reset (paths only — no files deleted).',
        effects,
      };
    }

    case 'use-workspace-context': {
      if (!ctx.activeWorkspaceContext) {
        return {
          acknowledgement:
            '**No workspace context selected.** Pick a file or folder in the workspace strip (when a workspace is set), then run this again or use **Use in chat**.',
          effects,
        };
      }
      effects.composerSeed = buildUseWorkspaceContextComposerSeed(ctx.activeWorkspaceContext);
      return {
        acknowledgement:
          '**Composer seeded** with a line that references your active workspace context. Finish the sentence and send when ready.',
        effects,
      };
    }

    case 'start-design-plan': {
      effects.setOperatingMode = 'design3d';
      effects.composerSeed = [
        'Outline a Design3D plan for: ',
        '',
        'Use measured vs estimated dimensions honestly. Scaffold:',
        '```markdown',
        getDesign3DPlanScaffoldMarkdown(ctx.design3dWorkflowTypeId),
        '```',
      ].join('\n');
      return {
        acknowledgement:
          '**Design3D mode** on. **Composer** seeded with a plan scaffold — describe the part after the colon, then send.',
        effects,
      };
    }

    case 'start-draft': {
      effects.setOperatingMode = 'writer';
      effects.composerSeed = [
        'Draft the following in structured markdown:',
        '',
        getDocumentScaffoldMarkdown(ctx.writerDocumentTypeId),
      ].join('\n');
      return {
        acknowledgement:
          '**Writer mode** on. **Composer** seeded with a document scaffold — fill in the goal, then send.',
        effects,
      };
    }

    case 'export-pack': {
      let preset: ExportPresetId = 'mixed_workspace';
      if (ctx.operatingMode === 'writer') preset = 'writer_handoff';
      else if (ctx.operatingMode === 'design3d') preset = 'design3d_handoff';
      effects.openExportPackPreset = preset;
      if (!ctx.workspaceReady) {
        return {
          acknowledgement:
            '**Export pack** opened. Set a **workspace folder** in Settings if you want to save the manifest; you can still review paths.',
          effects,
        };
      }
      return {
        acknowledgement: `**Export pack** builder opened (preset: **${preset.replace(/_/g, ' ')}**). Review artifacts and save when ready.`,
        effects,
      };
    }

  }
}
