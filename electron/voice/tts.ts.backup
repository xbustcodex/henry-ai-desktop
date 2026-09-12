/**
 * Voice TTS — Henry's speaking voice, with an engine ladder.
 *
 *   1. ElevenLabs — auto-enabled when an ElevenLabs API key is saved (providers
 *      table, encrypted like every other provider key) and the request succeeds.
 *      Returns an mp3 Buffer the renderer plays through an <audio> element.
 *   2. macOS `say` — the FREE offline default. Speaks straight from the main
 *      process (no audio round-trip); supports voice + rate settings and stop.
 *
 * Channels (uniform `{ ok, result | error }` envelope, matching machines/ipc.ts):
 *   voice:speak        — { text, engine?: 'auto'|'local'|'elevenlabs' }
 *                        local → speaks + resolves when done ({ engine:'local', spoke:true })
 *                        elevenlabs → { engine:'elevenlabs', audio: Buffer }
 *                        elevenlabs failure falls back to local ({ fellBack:true })
 *   voice:stopSpeaking — kills any in-flight `say` process
 *   voice:ttsStatus    — active engine, key presence, configured voices, `say -v ?` list
 *
 * Settings keys: voice_tts_engine (auto|local|elevenlabs), voice_tts_voice
 * (ElevenLabs voice id), voice_say_voice, voice_say_rate.
 */

import { ipcMain } from 'electron';
import { spawn, execFile, type ChildProcess } from 'child_process';
import type Database from 'better-sqlite3';
import { decryptKey } from '../ipc/_keyStorage';
import { prepareSpeechText } from './_speechText';
import { parseSayVoices, type SayVoice } from './_sayVoices';

type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

async function envelope<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type TtsEngineSetting = 'auto' | 'local' | 'elevenlabs';
export type TtsActiveEngine = 'local' | 'elevenlabs';

/** ElevenLabs "Rachel" — the default speaking voice when a key is present. */
const DEFAULT_ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM';
const ELEVEN_MODEL = 'eleven_turbo_v2_5';
const DEFAULT_SAY_VOICE = 'Samantha';
const DEFAULT_SAY_RATE = 175;

export interface TtsStatus {
  engine: TtsEngineSetting;
  active: TtsActiveEngine;
  elevenLabsKeyPresent: boolean;
  elevenVoiceId: string;
  sayVoice: string;
  sayRate: number;
  sayVoices: SayVoice[];
}

export interface TtsSpeakResult {
  engine: TtsActiveEngine | 'none';
  spoke?: boolean;
  /** ElevenLabs mp3 bytes for renderer-side playback. */
  audio?: Buffer;
  /** True when ElevenLabs was tried but the local voice spoke instead. */
  fellBack?: boolean;
}

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
  return (readSetting(db, 'voice_say_voice') || DEFAULT_SAY_VOICE).trim() || DEFAULT_SAY_VOICE;
}

function sayRateSetting(db: Database.Database): number {
  const n = Number(readSetting(db, 'voice_say_rate'));
  return Number.isFinite(n) && n >= 90 && n <= 400 ? Math.round(n) : DEFAULT_SAY_RATE;
}

// ── macOS `say` engine ──────────────────────────────────────────────────────

let sayProcess: ChildProcess | null = null;
let sayVoicesCache: SayVoice[] | null = null;

async function listSayVoices(): Promise<SayVoice[]> {
  if (sayVoicesCache) return sayVoicesCache;
  if (process.platform !== 'darwin') return [];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('say', ['-v', '?'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    sayVoicesCache = parseSayVoices(out);
    return sayVoicesCache;
  } catch {
    return [];
  }
}

export function stopSpeaking(): boolean {
  if (sayProcess && !sayProcess.killed) {
    try { sayProcess.kill('SIGTERM'); } catch { /* already gone */ }
    sayProcess = null;
    return true;
  }
  return false;
}

/** Speak via `say`, resolving when playback finishes (or the process is killed). */
function speakLocal(text: string, voice: string, rate: number): Promise<void> {
  stopSpeaking();
  return new Promise<void>((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error('Local speech uses the macOS say command — not available on this platform.'));
      return;
    }
    // Text goes over stdin so long replies never hit argv limits.
    const child = spawn('say', ['-v', voice, '-r', String(rate)], { stdio: ['pipe', 'ignore', 'ignore'] });
    sayProcess = child;
    child.on('error', (err) => {
      if (sayProcess === child) sayProcess = null;
      reject(new Error(`say failed: ${err.message}`));
    });
    child.on('close', () => {
      if (sayProcess === child) sayProcess = null;
      resolve(); // a killed (stopped) say still resolves — stopping isn't an error
    });
    child.stdin?.write(text);
    child.stdin?.end();
  });
}

// ── ElevenLabs engine ───────────────────────────────────────────────────────

async function fetchElevenLabsAudio(text: string, apiKey: string, voiceId: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs ${res.status}${body ? ': ' + body.slice(0, 150) : ''}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
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

export async function speak(
  db: Database.Database,
  params: { text: string; engine?: string },
): Promise<TtsSpeakResult> {
  const clean = prepareSpeechText(params?.text ?? '');
  if (!clean) return { engine: 'none', spoke: false };

  const engine = resolveEngine(db, params?.engine);

  if (engine === 'elevenlabs') {
    const apiKey = getElevenLabsKey(db);
    const voiceId = (readSetting(db, 'voice_tts_voice') || DEFAULT_ELEVEN_VOICE).trim() || DEFAULT_ELEVEN_VOICE;
    if (apiKey) {
      try {
        const audio = await fetchElevenLabsAudio(clean, apiKey, voiceId);
        return { engine: 'elevenlabs', audio };
      } catch (e) {
        console.warn('[Henry voice] ElevenLabs failed, falling back to local say:', e instanceof Error ? e.message : e);
      }
    }
    // No key (explicit elevenlabs pick) or request failed → free local voice.
    await speakLocal(clean, sayVoiceSetting(db), sayRateSetting(db));
    return { engine: 'local', spoke: true, fellBack: true };
  }

  await speakLocal(clean, sayVoiceSetting(db), sayRateSetting(db));
  return { engine: 'local', spoke: true };
}

// ── IPC registration ────────────────────────────────────────────────────────

export function registerVoiceTtsHandlers(db: Database.Database): void {
  ipcMain.handle('voice:speak', (_e, params: { text: string; engine?: string }) =>
    envelope(() => speak(db, params)),
  );

  ipcMain.handle('voice:stopSpeaking', () => envelope(() => ({ stopped: stopSpeaking() })));

  ipcMain.handle('voice:ttsStatus', () =>
    envelope(async (): Promise<TtsStatus> => ({
      engine: readEngineSetting(db),
      active: resolveEngine(db),
      elevenLabsKeyPresent: Boolean(getElevenLabsKey(db)),
      elevenVoiceId: (readSetting(db, 'voice_tts_voice') || DEFAULT_ELEVEN_VOICE).trim() || DEFAULT_ELEVEN_VOICE,
      sayVoice: sayVoiceSetting(db),
      sayRate: sayRateSetting(db),
      sayVoices: await listSayVoices(),
    })),
  );
}
