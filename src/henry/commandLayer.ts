/**
 * Lightweight slash-style command detection — additive to normal chat.
 */

import type { HenryOperatingMode } from './charter';
import { isHenryOperatingMode } from './charter';

export type HenryCommand =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'mode'; mode: HenryOperatingMode }
  | { kind: 'mode-invalid'; arg: string }
  | { kind: 'memory' }
  | { kind: 'clear-context' }
  | { kind: 'use-workspace-context' }
  | { kind: 'start-design-plan' }
  | { kind: 'start-draft' }
  | { kind: 'export-pack' };

function normalizeModeArg(arg: string): HenryOperatingMode | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  if (a === '3d' || a === 'design3d' || a === 'design-3d') return 'design3d';
  if (isHenryOperatingMode(a)) return a;
  return null;
}

/**
 * If the trimmed input is a Henry command, return its structured form.
 * Returns null for normal chat (including unknown `/foo` — sent to the model as usual).
 */
export function parseUserCommandLine(raw: string): HenryCommand | null {
  const t = raw.trim();
  if (!t.startsWith('/')) return null;

  const parts = t.split(/\s+/).map((p) => p.trim()).filter(Boolean);
  const head = parts[0].toLowerCase();

  switch (head) {
    case '/help':
    case '/?':
      return { kind: 'help' };
    case '/new':
      return { kind: 'new' };
    case '/memory':
      return { kind: 'memory' };
    case '/clear-context':
    case '/clearcontext':
      return { kind: 'clear-context' };
    case '/use-workspace-context':
    case '/useworkspacecontext':
      return { kind: 'use-workspace-context' };
    case '/start-design-plan':
    case '/startdesignplan':
      return { kind: 'start-design-plan' };
    case '/start-draft':
    case '/startdraft':
      return { kind: 'start-draft' };
    case '/export-pack':
    case '/exportpack':
      return { kind: 'export-pack' };
    case '/mode': {
      const sub = parts[1] ?? '';
      const mode = normalizeModeArg(sub);
      if (!mode) {
        return { kind: 'mode-invalid', arg: sub };
      }
      return { kind: 'mode', mode };
    }
    default:
      return null;
  }
}
