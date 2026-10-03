/**
 * ElevenLabs adapter — the hosted, paid voice engine.
 *
 * Row 6.9 is credential-blocked on this machine: no ElevenLabs key exists, so
 * the engine can be implemented and unit-tested but NOT live-verified here.
 * What that means concretely is spelled out in `elevenLabsStatus()` rather
 * than papered over:
 *
 *   - with no key, every function returns `reason: 'no-credential'` and an
 *     empty voice list. It never invents a voice and never reports readiness.
 *   - with a key, the voice list comes from the real account, so the picker
 *     shows what the user actually owns instead of a hardcoded default.
 *
 * The key itself is never handled here: it is read through the existing
 * `_keyStorage`/`safeStorage` provider store, exactly like every other provider
 * key, and never logged or echoed back.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { decryptKey } from '../ipc/_keyStorage';

const ELEVEN_API = 'https://api.elevenlabs.io/v1';

/** TwelveLabs' default "Rachel" voice — the fallback id when none is chosen. */
export const DEFAULT_ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM';
export const ELEVEN_MODEL = 'eleven_turbo_v2_5';

export interface ElevenVoice {
  voiceId: string;
  name: string;
  category: string;
}

/**
 * Why the hosted engine is or is not usable. `no-credential` is the honest
 * answer on a machine with no key saved — distinct from `key-rejected`, which
 * means a key exists but the API refused it.
 */
export type ElevenUnavailableReason = 'no-credential' | 'key-rejected' | 'network' | 'not-allowed';

export interface ElevenStatus {
  /** True only when a key is stored AND the account answered. */
  available: boolean;
  keyPresent: boolean;
  reason: ElevenUnavailableReason | null;
  /** Human-readable, safe to show in the UI. Never contains the key. */
  detail: string;
  voiceCount: number;
}

/**
 * Read the ElevenLabs key from the providers table via the secure store.
 *
 * Returns '' when absent, disabled, or undecryptable — all of which mean the
 * same thing to a caller: this engine cannot run.
 */
export function getElevenLabsKey(db: Database.Database): string {
  try {
    const row = db
      .prepare("SELECT api_key FROM providers WHERE id = 'elevenlabs' AND enabled = 1")
      .get() as { api_key: string } | undefined;
    return decryptKey(row?.api_key ?? '');
  } catch {
    return '';
  }
}

type ElevenVoicesResponse = {
  voices?: { voice_id?: string; name?: string; category?: string }[];
};

/**
 * Fetch the account's voice list.
 *
 * Rejects rather than returning an empty list on failure: an empty list and an
 * unreachable API look identical in the UI, and only one of them is a real
 * "this account has no voices".
 */
export async function listElevenVoices(apiKey: string): Promise<ElevenVoice[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${ELEVEN_API}/voices`, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // The body can echo nothing useful and must never reach a log verbatim.
      throw new Error(`ElevenLabs ${res.status}${body ? `: ${body.slice(0, 150)}` : ''}`);
    }
    const data = (await res.json()) as ElevenVoicesResponse;
    return (data.voices ?? [])
      .filter((v): v is { voice_id: string; name?: string; category?: string } => Boolean(v.voice_id))
      .map((v) => ({ voiceId: v.voice_id, name: v.name ?? v.voice_id, category: v.category ?? '' }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status for the settings panel.
 *
 * With no key this is a definite, explainable answer, not an error and not a
 * false positive: `available: false`, `keyPresent: false`, and a `detail` that
 * says exactly what to do.
 */
export async function getElevenLabsStatus(db: Database.Database): Promise<ElevenStatus> {
  const key = getElevenLabsKey(db);
  if (!key) {
    return {
      available: false,
      keyPresent: false,
      reason: 'no-credential',
      detail:
        'No ElevenLabs API key is saved, so the hosted voice cannot run. ' +
        'Add a key under AI Providers to enable it. Everything else in the app works without one.',
      voiceCount: 0,
    };
  }
  try {
    const voices = await listElevenVoices(key);
    return {
      available: true,
      keyPresent: true,
      reason: null,
      detail: `${voices.length} voice${voices.length === 1 ? '' : 's'} available on this account.`,
      voiceCount: voices.length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const rejected = /ElevenLabs (401|403)/.test(message);
    return {
      available: false,
      keyPresent: true,
      reason: rejected ? 'key-rejected' : 'network',
      detail: rejected
        ? 'The saved ElevenLabs key was rejected (401/403). Re-enter it under AI Providers.'
        : `Could not reach ElevenLabs: ${message.slice(0, 150)}`,
      voiceCount: 0,
    };
  }
}

export function registerElevenLabsHandlers(db: Database.Database): void {
  const envelope = <T>(fn: () => T | Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .then((result) => ({ ok: true as const, result }))
      .catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));

  ipcMain.handle('voice:elevenlabsStatus', () => envelope(() => getElevenLabsStatus(db)));

  ipcMain.handle('voice:elevenlabsVoices', () =>
    envelope(async () => {
      const key = getElevenLabsKey(db);
      if (!key) {
        // Explicit, so the picker can show "add a key" instead of an empty list.
        throw new Error('No ElevenLabs API key is saved. Add one under AI Providers first.');
      }
      return listElevenVoices(key);
    }),
  );
}