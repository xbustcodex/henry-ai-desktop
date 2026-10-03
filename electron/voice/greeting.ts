/**
 * Spoken startup greeting.
 *
 * The text is generated locally (time of day, the owner's name, and the
 * configured assistant name) and the synthesized audio is cached on disk, so
 * it is produced once per variant instead of on every launch. No network call
 * and no AI inference: a greeting is a fixed phrase, and paying for an LLM to
 * generate it would be wasteful.
 *
 * `{address}` is the OWNER (`owner_name`); `{name}` is the ASSISTANT, resolved
 * by `assistantNameFrom` in `src/henry/assistantName.ts` from the
 * `assistant_name` setting. That module is the only place the assistant's own
 * name is decided — this file used to read `creator_orb`, which is an orb
 * appearance blob, so no setting ever actually reached the greeting.
 */

import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { speak } from '../../src/platform/tts';
import { withSpokenName } from '../../src/henry/spokenName';
import { assistantNameFrom, normalizeAssistantName } from '../../src/henry/assistantName';

/** Time-of-day buckets. */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'lateNight';

export interface GreetingText {
  text: string;
  period: GreetingPeriod;
}

/**
 * Re-exported so a caller already holding this module does not need a second
 * import just to compare against the default.
 */
export { DEFAULT_ASSISTANT_NAME } from '../../src/henry/assistantName';

/**
 * Twelve variants, three per period. `{address}` is the OWNER (the person
 * being spoken to); `{name}` is the ASSISTANT's own name.
 *
 * Seven of the twelve name the assistant in the third person and so carry
 * `{name}`. The other five are self-referential in the first person ("I am
 * up", "All systems online") and carry neither, which is what keeps them
 * correct for any name without editing the copy.
 */
export const GREETING_VARIANTS: Record<GreetingPeriod, readonly string[]> = {
  morning: [
    'Good morning{address}. {name} is up and ready.',
    'Morning{address}. All systems online and ready when you are.',
    'Good morning{address}. The day is yours — what are we doing?',
  ],
  afternoon: [
    'Good afternoon{address}. {name} here, ready to help.',
    'Afternoon{address}. Systems are online.',
    'Hey{address} — {name} is up and listening.',
  ],
  evening: [
    'Good evening{address}. {name} is at your service.',
    'Evening{address}. All systems online — what do you need?',
    'Good evening{address}. {name} here, ready to get things done.',
  ],
  lateNight: [
    'Burning the midnight oil{address}. {name} is here with you.',
    'Late night{address}. I am up — what shall we do?',
    'Still going{address}. {name} is awake and ready.',
  ],
};

/** Every variant, flattened, for tests and for anything that enumerates them. */
export const ALL_GREETING_VARIANTS: readonly string[] = Object.values(GREETING_VARIANTS).flat();

export function greetingPeriod(date = new Date()): GreetingPeriod {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'lateNight';
}

/** Pick a stable variant for today so the greeting doesn't change every launch. */
function pickVariant(period: GreetingPeriod, date: Date): string {
  const pool = GREETING_VARIANTS[period];
  const seed = Number(`${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`);
  return pool[seed % pool.length];
}

/** "Good morning Henry." — the trailing comma in the template handles pause. */
function addressFor(ownerName: string | null | undefined): string {
  const name = (ownerName || '').trim();
  if (!name) return '';
  return `, ${name}`;
}

/** Render one variant template. Both placeholders are always resolved. */
export function renderGreeting(
  template: string,
  ownerName: string | null | undefined,
  assistantName: string | null | undefined,
): string {
  return template
    .replace('{address}', addressFor(ownerName))
    .replace(/\{name\}/g, normalizeAssistantName(assistantName));
}

export function buildGreetingText(
  ownerName: string | null | undefined,
  date = new Date(),
  assistantName: string | null | undefined = null,
): GreetingText {
  const period = greetingPeriod(date);
  const template = pickVariant(period, date);
  return { text: renderGreeting(template, ownerName, assistantName), period };
}

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache', 'greetings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Content-addressed by everything that affects the rendered audio: the text,
 * the engine setting, and the selected voice. Keying on the engine setting
 * alone meant changing the voice kept serving the OLD voice from cache.
 */
function cacheFileFor(text: string, engine: string, voice: string): string {
  const key = crypto
    .createHash('sha256')
    .update(`${engine}\u0000${voice}\u0000${text}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(cacheDir(), `${key}.audio`);
}

function readSetting(db: Database.Database, key: string): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * The authoritative assistant name, straight out of the settings table.
 *
 * Reads `assistant_name` — the key declared in `settingsContract.ts` and
 * written by the voice settings panel — and hands the whole settings map to
 * the one resolver in `src/henry/assistantName.ts`. Nothing here parses a
 * blob or guesses a key: that is exactly what went wrong before, when the
 * greeting consulted `creator_orb` and no setting could ever reach it.
 */
export function readAssistantName(db: Database.Database): string {
  return assistantNameFrom({
    assistant_name: readSetting(db, 'assistant_name'),
    creator_orb: readSetting(db, 'creator_orb'),
  });
}

/** Read a cache file, treating a missing OR empty file as a miss. */
async function readCacheFile(file: string): Promise<Buffer | null> {
  try {
    const buf = await fs.promises.readFile(file);
    // A zero-length cache file (a write interrupted by ENOSPC, say) would
    // otherwise be served forever and the greeting would never re-synthesise.
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Write via a temp file + rename so a partial write is never left behind. */
async function writeCacheFile(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

export function registerVoiceGreetingHandlers(db: Database.Database): void {
  const envelope = <T>(fn: () => T | Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .then((result) => ({ ok: true as const, result }))
      .catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));

  /**
   * Returns the greeting text plus a path to cached audio. Synthesis happens
   * at most once per (engine, text) pair; afterwards the cached file is reused.
   */
  ipcMain.handle(
    'voice:greeting',
    (_e, opts: { speak?: boolean } = {}) =>
      envelope(async () => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('owner_name') as
          | { value: string }
          | undefined;
        const assistantName = readAssistantName(db);
        const { text, period } = buildGreetingText(row?.value, new Date(), assistantName);

        const engine = readSetting(db, 'voice_tts_engine') || 'auto';

        const voice = readSetting(db, 'voice_tts_voice');
        const file = cacheFileFor(text, engine, voice);
        const shouldSpeak = opts?.speak !== false;

        // Only synthesize when it is actually needed. Previously speak() ran
        // even for speak:false, so merely *asking* for the greeting text made
        // the assistant say it out loud.
        if (shouldSpeak) {
          const cached = await readCacheFile(file);
          if (!cached) {
            // Speech synthesis reads "H.E.N.R.Y" as five letters. Normalise
            // the spoken form so the greeting says the name rather than
            // spelling it. The displayed text is left alone.
            const spokenText = withSpokenName(text, assistantName);
            const res = await speak(db, { text: spokenText, engine: engine === 'auto' ? undefined : engine });
            // A macOS `say` (or any device-rendering engine) returns no buffer:
            // it already spoke. That is success, not an error — it used to
            // throw "No speech engine is available" on every macOS launch.
            if (res.audio && res.audio.byteLength > 0) {
              await writeCacheFile(file, res.audio);
            }
          }
        }

        const audio = shouldSpeak ? await readCacheFile(file) : null;
        return {
          text,
          period,
          speak: shouldSpeak,
          // Derived from the engine that produced the bytes: ElevenLabs
          // returns mp3, espeak returns WAV. Hardcoding WAV mislabelled the
          // mp3 cache and the renderer then replayed a mislabelled file.
          mimeType: engine === 'elevenlabs' ? 'audio/mpeg' : 'audio/wav',
          audio: audio ? new Uint8Array(audio) : new Uint8Array(),
        };
      }),
  );

  /** Forget cached greetings — e.g. after changing the voice or owner name. */
  ipcMain.handle('voice:greeting:clearCache', () => {
    try {
      fs.rmSync(cacheDir(), { recursive: true, force: true });
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
