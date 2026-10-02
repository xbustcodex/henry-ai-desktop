/**
 * Activation for the scripted demo mode.
 *
 * Three ways in, all portable:
 *   - Ctrl+Shift+J (paid 1.7.0 uses ⌘⇧J, which is macOS-only)
 *   - a trigger phrase typed or spoken
 *   - the Preview buttons on the Creators panel
 *
 * Deliberately NOT implemented: clap-to-wake. Paid 1.7.0 shipped it and then
 * force-disabled it — "ambient false positives were replaying the greeting at
 * random" (contracts.ts:305-309). Reproducing a mechanism the reference itself
 * switched off would reintroduce the same defect.
 */

let matchers: string[] = [];
let enabled = false;
let launched = false;

async function refresh(): Promise<void> {
  try {
    const demo = await window.henryAPI.creatorsGetDemo();
    matchers = (demo.triggerPhrases ?? [])
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 2);
    enabled = demo.enabled;
  } catch {
    matchers = [];
    enabled = false;
  }
}

/** Does this text start one of the trigger phrases? */
export function matchesTriggerPhrase(text: string): boolean {
  if (!enabled || matchers.length === 0) return false;
  const t = (text ?? '').trim().toLowerCase().replace(/[.?!]+$/, '');
  if (t.length === 0) return false;
  return matchers.some((m) => t === m || t.startsWith(`${m} `) || t.startsWith(`${m}?`));
}

export async function launchDemo(mode: 'voice' | 'chat' = 'voice'): Promise<void> {
  if (launched) return;
  launched = true;
  try {
    await window.henryAPI.creatorsLaunchStage(mode);
  } finally {
    launched = false;
  }
}

/** Install the global keyboard shortcut and keep trigger phrases fresh. */
export function installCreatorsActivation(): () => void {
  void refresh();

  const onKey = (e: KeyboardEvent) => {
    // Ctrl+Shift+J on Windows/Linux, Cmd+Shift+J on macOS.
    if (e.shiftKey && (e.ctrlKey || e.metaKey) && (e.key === 'J' || e.key === 'j')) {
      e.preventDefault();
      void launchDemo('voice');
    }
    if (e.key === 'Escape') void window.henryAPI.creatorsCloseStage();
  };

  window.addEventListener('keydown', onKey);
  // The creator may edit phrases while the app is running.
  const poll = window.setInterval(() => void refresh(), 30_000);

  return () => {
    window.removeEventListener('keydown', onKey);
    window.clearInterval(poll);
  };
}
