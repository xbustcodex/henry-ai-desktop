/**
 * Spoken startup greeting.
 *
 * The text is generated locally (time of day + the owner's name) and the
 * synthesized audio is cached on disk, so it is produced once per variant
 * instead of on every launch. No network call and no AI inference: a greeting
 * is a fixed phrase, and paying for an LLM to generate it would be wasteful.
 */

import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { speak } from '../../src/platform/tts';

/** Time-of-day buckets. */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'lateNight';

export interface GreetingText {
  text: string;
  period: GreetingPeriod;
}

const VARIANTS: Record<GreetingPeriod, string[]> = {
  morning: [
    'Good morning{address}. Henry is up and ready.',
    'Morning{address}. All systems online and ready when you are.',
    'Good morning{address}. The day is yours — what are we doing?',
  ],
  afternoon: [
    'Good afternoon{address}. Henry here, ready to help.',
    'Afternoon{address}. Systems are online.',
    'Hey{address} — Henry is up and listening.',
  ],
  evening: [
    'Good evening{address}. Henry is at your service.',
    'Evening{address}. All systems online — what do you need?',
    'Good evening{address}. Henry here, ready to get things done.',
  ],
  lateNight: [
    'Burning the midnight oil{address}. Henry is here with you.',
    'Late night{address}. I am up — what shall we do?',
    'Still going{address}. Henry is awake and ready.',
  ],
};

export function greetingPeriod(date = new Date()): GreetingPeriod {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'lateNight';
}

/** Pick a stable variant for today so the greeting doesn't change every launch. */
function pickVariant(period: GreetingPeriod, date: Date): string {
  const pool = VARIANTS[period];
  const seed = Number(`${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`);
  return pool[seed % pool.length];
}

/** "Henry" becomes "Henry" and "Chris" becomes "Mr. Chris"? No — keep it simple. */
function addressFor(ownerName: string | null | undefined): string {
  const name = (ownerName || '').trim();
  if (!name) return '';
  // "Good morning Henry." — the trailing comma in the template handles pause.
  return `, ${name}`;
}

export function buildGreetingText(
  ownerName: string | null | undefined,
  date = new Date(),
): GreetingText {
  const period = greetingPeriod(date);
  const template = pickVariant(period, date);
  return { text: template.replace('{address}', addressFor(ownerName)), period };
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
        const { text, period } = buildGreetingText(row?.value);

        const engine = readSetting(db, 'voice_tts_engine') || 'auto';

        const voice = readSetting(db, 'voice_tts_voice');
        const file = cacheFileFor(text, engine, voice);
        const shouldSpeak = opts?.speak !== false;

        // Only synthesize when it is actually needed. Previously speak() ran
        // even for speak:false, so merely *asking* for the greeting text made
        // Henry say it out loud.
        if (shouldSpeak) {
          const cached = await readCacheFile(file);
          if (!cached) {
            // Speech synthesis reads "H.E.N.R.Y" as five letters. Normalise
            // the spoken form so the greeting says the name rather than
            // spelling it. The displayed text is left alone.
            const { withSpokenName } = await import('../../src/henry/spokenName') as typeof import('../../src/henry/spokenName');
            const spokenText = withSpokenName(text, row?.value);
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
