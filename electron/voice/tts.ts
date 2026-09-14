/**
 * Voice TTS — Henry's speaking voice, with an engine ladder.
 *
 *   1. ElevenLabs — auto-enabled when an ElevenLabs API key is saved (providers
 *      table, encrypted like every other provider key) and the request succeeds.
 *      Returns an mp3 Buffer the renderer plays through an <audio> element.
 *   2. Platform-specific local voice — macOS `say`, Linux eSpeak, or Web Speech API fallback
 *
 * Channels (uniform `{ ok, result | error }` envelope, matching machines/ipc.ts):
 *   voice:speak        — { text, engine?: 'auto'|'local'|'elevenlabs' }
 *                        local → speaks + resolves when done ({ engine:'local', spoke:true })
 *                        elevenlabs → { engine:'elevenlabs', audio: Buffer }
 *                        elevenlabs failure falls back to local ({ fellBack:true })
 *   voice:stopSpeaking — kills any in-flight speech process
 *   voice:ttsStatus    — active engine, key presence, configured voices, available engines
 *
 * Settings keys: voice_tts_engine (auto|local|elevenlabs), voice_tts_voice
 * (ElevenLabs voice id), voice_say_voice, voice_say_rate, voice_espeak_voice, voice_espeak_rate.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { decryptKey } from '../ipc/_keyStorage';
import { prepareSpeechText } from './_speechText';
import { TtsEngineSetting, TtsActiveEngine, TtsStatus, TtsSpeakResult, speak as platformSpeak, getTtsStatus, stopSpeaking, registerPlatformTtsHandlers } from '../../src/platform/tts';

type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

async function envelope<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ElevenLabs "Rachel" — the default speaking voice when a key is present. */
const DEFAULT_ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM';
const ELEVEN_MODEL = 'eleven_turbo_v2_5';

// ── Settings / key helpers ──────────────────────────────────────────────────

function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function readEngineSetting(db: Database.Database): TtsEngineSetting {
  const raw = readSetting(db, 'voice_tts_engine');
  return raw === 'local' || raw === 'elevenlabs' ? raw : 'auto';
}

/** ElevenLabs key — stored in the providers table like every other provider key. */
function getElevenLabsKey(db: Database.Database): string {
  try {
    const row = db
      .prepare("SELECT api_key FROM providers WHERE id = 'elevenlabs' AND enabled = 1")
      .get() as { api_key: string } | undefined;
    return decryptKey(row?.api_key ?? '');
  } catch {
    return '';
  }
}

function sayVoiceSetting(db: Database.Database): string {
  return (readSetting(db, 'voice_say_voice') || DEFAULT_ELEVEN_VOICE).trim() || DEFAULT_ELEVEN_VOICE;
}

function sayRateSetting(db: Database.Database): number {
  const n = Number(readSetting(db, 'voice_say_rate'));
  return Number.isFinite(n) && n >= 90 && n <= 400 ? Math.round(n) : 175; // DEFAULT_SAY_RATE from platform/tts
}

function espeakVoiceSetting(db: Database.Database): string {
  return (readSetting(db, 'voice_espeak_voice') || 'en').trim() || 'en';
}

function espeakRateSetting(db: Database.Database): number {
  const n = Number(readSetting(db, 'voice_espeak_rate'));
  return Number.isFinite(n) && n >= 80 && n <= 450 ? Math.round(n) : 175; // DEFAULT_ESPEAK_RATE from platform/tts
}

// ── Engine ladder ───────────────────────────────────────────────────────────

function resolveEngine(db: Database.Database, requested?: string): TtsActiveEngine {
  const choice: TtsEngineSetting =
    requested === 'local' || requested === 'elevenlabs' || requested === 'auto'
      ? requested
      : readEngineSetting(db);
  if (choice === 'local') return 'local';
  if (choice === 'elevenlabs') return 'elevenlabs';
  // auto: ElevenLabs only when a key is saved — otherwise free local voice.
  return getElevenLabsKey(db) ? 'elevenlabs' : 'local';
}

// ── Main speak function ─────────────────────────────────────────────────────

export async function speak(
  db: Database.Database,
  params: { text: string; engine?: string }
): Promise<TtsSpeakResult> {
  // Call the platform speak function, not ourselves
  return await platformSpeak(db, params);
}

// ── IPC registration ────────────────────────────────────────────────────────

export function registerVoiceTtsHandlers(db: Database.Database): void {
  registerPlatformTtsHandlers(db);
}