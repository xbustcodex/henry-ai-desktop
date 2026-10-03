/**
 * The assistant's own name — ONE authoritative resolver.
 *
 * There was no setting that drove it. `electron/voice/greeting.ts` read
 * `creator_orb`, which is an orb-appearance blob (skin / speed / accent), so
 * every install that never touched CreatorsPanel got the default and the
 * greeting could never say anything else. A `brand_name`-style key does not
 * exist in this app either, so setting it changed nothing at all.
 *
 * The name is now a first-class setting, `assistant_name`, declared in
 * `settingsContract.ts` with the default `Henry`. An unconfigured install
 * therefore behaves exactly as it always did.
 *
 * This module is deliberately dependency-free (no Electron, no Node built-ins,
 * no store) so BOTH processes can import it: the main process reads it out of
 * SQLite for the spoken greeting, the renderer reads it out of the settings
 * map for the wake word and the voice panel. Two copies of this logic is
 * exactly how the greeting and the wake word drifted apart before.
 */

/** The settings key. The single source of truth for the assistant's name. */
export const ASSISTANT_NAME_SETTING_KEY = 'assistant_name';

/** What an unconfigured install says, and what restoring the default means. */
export const DEFAULT_ASSISTANT_NAME = 'Henry';

/**
 * Cap on a configured name, in characters. Matches the limit CreatorsPanel
 * has always applied, so the same text typed in either place is accepted the
 * same way. Anything longer is a paste accident, not a name anyone wants said
 * aloud.
 */
export const MAX_ASSISTANT_NAME_LENGTH = 32;

/**
 * Normalise a configured name for display and speech.
 *
 * An absent, blank or whitespace-only name falls back to the default so a
 * default install is unchanged; internal runs of whitespace collapse because
 * they are never meaningful in a spoken name.
 */
export function normalizeAssistantName(raw: string | null | undefined): string {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_ASSISTANT_NAME_LENGTH).trim();
  return name || DEFAULT_ASSISTANT_NAME;
}

/**
 * Legacy source, read-only.
 *
 * Older builds stored the name inside the `creator_orb` JSON blob. Reading it
 * keeps an install that already named the assistant from silently reverting to
 * `Henry`. Nothing here ever WRITES the blob — it is orb appearance, and
 * overwriting it corrupts the orb.
 */
function legacyOrbName(creatorOrb: string | null | undefined): string {
  if (!creatorOrb) return '';
  try {
    const orb = JSON.parse(creatorOrb) as { assistantName?: unknown };
    return typeof orb.assistantName === 'string' ? orb.assistantName : '';
  } catch {
    return '';
  }
}

/**
 * The resolver. `assistant_name` is authoritative; the orb blob is consulted
 * only when `assistant_name` was never set, so an existing name survives the
 * move to the real setting.
 */
export function assistantNameFrom(settings: Record<string, string> | null | undefined): string {
  const stored = settings?.[ASSISTANT_NAME_SETTING_KEY] ?? '';
  if (stored.trim()) return normalizeAssistantName(stored);
  const legacy = legacyOrbName(settings?.creator_orb);
  return legacy.trim() ? normalizeAssistantName(legacy) : DEFAULT_ASSISTANT_NAME;
}