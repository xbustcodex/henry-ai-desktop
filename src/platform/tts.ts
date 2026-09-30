/**
 * Cross-platform text-to-speech abstraction
 * Provides TTS capabilities appropriate for each operating system
 */

import { ipcMain } from 'electron';
import { spawn, execFile, type ChildProcess } from 'child_process';
import type Database from 'better-sqlite3';
import { decryptKey } from '../../electron/ipc/_keyStorage';
import { prepareSpeechText } from '../../electron/voice/_speechText';

/**
 * Available TTS engines
 */
export type TtsEngineSetting = 'auto' | 'local' | 'elevenlabs';
export type TtsActiveEngine = 'local' | 'elevenlabs' | 'web';

/**
 * TTS status information
 */
export interface TtsStatus {
  engine: TtsEngineSetting;
  active: TtsActiveEngine;
  elevenLabsKeyPresent: boolean;
  elevenVoiceId: string;
  sayVoice: string;
  sayRate: number;
  availableEngines: string[];
}

/**
 * TTS speak result
 */
export interface TtsSpeakResult {
  engine: TtsActiveEngine | 'none';
  spoke?: boolean;
  /**
   * Encoded speech for renderer-side playback: mp3 from ElevenLabs, WAV from
   * the local eSpeak engine on Linux.
   */
  audio?: Buffer;
  /** True when ElevenLabs was tried but the local voice spoke instead. */
  fellBack?: boolean;
}

// Default voices and rates
const DEFAULT_ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM';
const ELEVEN_MODEL = 'eleven_turbo_v2_5';
const DEFAULT_SAY_VOICE = 'Samantha';
const DEFAULT_SAY_RATE = 175;
const DEFAULT_ESPEAK_VOICE = 'en';
const DEFAULT_ESPEAK_RATE = 175; // words per minute

// Get the platform string once.
/**
 * In the renderer, use the preload-exposed process.platform.
 * In the main process, use Node's os.platform directly.
 */
let platformString: string;
if (typeof window !== 'undefined') {
  // Renderer: use the value exposed by the preload contextBridge
  platformString = window.henryAPI.platform();
} else {
  // Main process: use Node's os.platform directly
  const os = require('os');
  platformString = os.platform();
}

// ElevenLabs key helper
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

function sayVoiceSetting(db: Database.Database): string {
  return (readSetting(db, 'voice_say_voice') || DEFAULT_SAY_VOICE).trim() || DEFAULT_SAY_VOICE;
}

function sayRateSetting(db: Database.Database): number {
  const n = Number(readSetting(db, 'voice_say_rate'));
  return Number.isFinite(n) && n >= 90 && n <= 400 ? Math.round(n) : DEFAULT_SAY_RATE;
}

function espeakVoiceSetting(db: Database.Database): string {
  return (readSetting(db, 'voice_espeak_voice') || DEFAULT_ESPEAK_VOICE).trim() || DEFAULT_ESPEAK_VOICE;
}

function espeakRateSetting(db: Database.Database): number {
  const n = Number(readSetting(db, 'voice_espeak_rate'));
  return Number.isFinite(n) && n >= 80 && n <= 450 ? Math.round(n) : DEFAULT_ESPEAK_RATE;
}

/**
 * macOS `say` engine implementation
 */
async function listSayVoices(): Promise<Array<{ name: string; language: string }>> {
  if (platformString !== 'darwin') return [];

  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('say', ['-v', '?'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    return parseSayVoices(out);
  } catch {
    return [];
  }
}

function parseSayVoices(output: string): Array<{ name: string; language: string }> {
  const voices: Array<{ name: string; language: string }> = [];
  for (const line of output.split('\n')) {
    // Format: "Agnes    en_US # Agnes isnt it lovely to have a cup of..."
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const name = parts[0];
      const languageWithComment = parts[1];
      const language = languageWithComment.split('#')[0].trim();
      if (name && language) {
        voices.push({ name, language });
      }
    }
  }
  return voices;
}

function speakLocalSay(text: string, voice: string, rate: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (platformString !== 'darwin') {
      reject(new Error('Local speech uses the macOS say command — not available on this platform.'));
      return;
    }

    // Text goes over stdin so long replies never hit argv limits.
    const child = spawn('say', ['-v', voice, '-r', String(rate)], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', (err) => {
      reject(new Error(`say failed: ${err.message}`));
    });
    child.on('close', () => {
      resolve(); // a killed (stopped) say still resolves — stopping isn't an error
    });
    child.stdin?.write(text);
    child.stdin?.end();
  });
}

/**
 * eSpeak engine implementation for Linux
 */
async function listEspeakVoices(): Promise<Array<{ name: string; language: string }>> {
  if (platformString !== 'linux') return [];

  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('espeak-ng', ['--voices'], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    const voices: Array<{ name: string; language: string }> = [];
    // Skip header lines
    const lines = out.split('\n').slice(1);
    for (const line of lines) {
      if (line.trim()) {
        // Format: "  en   english     en-us   french     fr-fr   #  Language"
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const name = parts[0];
          const language = parts[1];
          if (name && language) {
            voices.push({ name, language });
          }
        }
      }
    }
    return voices;
  } catch {
    // Try espeak if espeak-ng not found
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile('espeak', ['--voices'], { timeout: 5000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });

      const voices: Array<{ name: string; language: string }> = [];
      const lines = out.split('\n').slice(1);
      for (const line of lines) {
        if (line.trim()) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const name = parts[0];
            const language = parts[1];
            if (name && language) {
              voices.push({ name, language });
            }
          }
        }
      }
      return voices;
    } catch {
      return [];
    }
  }
}

/** Currently-speaking local child, so stopSpeaking() can actually interrupt it. */
let espeakProcess: ChildProcess | null = null;

/** espeak-ng is preferred, espeak is the older fallback. Probed once. */
let espeakBin: string | null = null;
let espeakProbe: Promise<string> | null = null;

function resolveEspeakBinary(): Promise<string> {
  if (espeakBin) return Promise.resolve(espeakBin);
  if (espeakProbe) return espeakProbe;
  // Asynchronous probe: a spawnSync here ran on the Electron main thread and
  // froze the whole UI (including Stop) for up to a second on every utterance.
  espeakProbe = new Promise<string>((resolve, reject) => {
    const child = spawn('espeak-ng', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const fallback = (reason: string) => {
      if (settled) return;
      settled = true;
      if (reason) {
        // espeak-ng absent — fall back to the older binary, but only if it
        // actually exists, rather than blindly falling through to a spawn
        // error for a command that is not installed.
        const alt = spawn('espeak', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
        alt.on('error', () => { espeakProbe = null; reject(new Error('Neither espeak-ng nor espeak is installed.')); });
        alt.on('close', (code) => {
          if (code === 0) { espeakBin = 'espeak'; resolve('espeak'); }
          else { espeakProbe = null; reject(new Error('Neither espeak-ng nor espeak is installed.')); }
        });
        return;
      }
      espeakBin = 'espeak-ng';
      resolve('espeak-ng');
    };
    const timer = setTimeout(() => fallback('timeout'), 2000);
    child.on('error', () => { clearTimeout(timer); fallback('missing'); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) fallback(''); else fallback('missing'); });
  });
  return espeakProbe;
}

/** Cap on captured audio, so a runaway child cannot exhaust memory. */
const MAX_SPEECH_BYTES = 24 * 1024 * 1024;

async function speakLocalEspeak(text: string, voice: string, rate: number): Promise<Buffer> {
  if (platformString !== 'linux') {
    throw new Error('eSpeak is only available on Linux');
  }
  const cmd = await resolveEspeakBinary();

  // `--stdout` makes espeak emit a WAV on stdout instead of trying to open the
  // audio device itself. Without it espeak speaks nothing on a headless or
  // device-less session and the captured buffer was discarded anyway.
  //
  // The text goes in on stdin rather than argv: long replies can exceed the
  // per-argument limit (E2BIG) and fail the spawn outright.
  const child = spawn(cmd, ['--stdout', '-v', voice, '-s', String(rate), '-z'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  espeakProcess = child;

  const chunks: Buffer[] = [];
  let captured = 0;
  child.stdout?.on('data', (data: Buffer) => {
    if (captured >= MAX_SPEECH_BYTES) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      return;
    }
    captured += data.byteLength;
    chunks.push(data);
  });
  child.stderr?.on('data', () => { /* espeak chatters on stderr even on success */ });
  // Feed the text and close stdin so espeak starts rendering.
  child.stdin?.on('error', () => { /* child died first */ });
  child.stdin?.end(`${text}\n`);

  return new Promise<Buffer>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (espeakProcess === child) espeakProcess = null;
      fn();
    };
    child.on('error', (err: Error) => settle(() => reject(new Error(`${cmd} failed: ${err.message}`))));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // A signal here means stopSpeaking() killed it — that is a clean stop,
      // not a failure to report as an error.
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        settle(() => resolve(Buffer.alloc(0)));
        return;
      }
      if (code === 0) {
        const audio = Buffer.concat(chunks);
        if (audio.byteLength === 0) settle(() => reject(new Error(`${cmd} produced no audio — is espeak installed?`)));
        else settle(() => resolve(audio));
      } else {
        settle(() => reject(new Error(`${cmd} exited with code ${code}`)));
      }
    });
  });
}

/**
 * Web Speech API fallback (handled in the renderer).
 *
 * This deliberately does nothing in the main process: SpeechSynthesis only
 * exists in a renderer, and the renderer already falls back to it when no
 * engine returns audio.
 */
function speakLocalWeb(_text: string): Promise<void> {
  // This would be implemented in the renderer using Web Speech API
  // For now, we'll just resolve immediately as a placeholder
  return Promise.resolve();
}

/**
 * ElevenLabs engine (same as original implementation)
 */
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

/**
 * Engine resolution logic
 */
function resolveEngine(
  db: Database.Database,
  requested?: string
): TtsActiveEngine {
  const choice: TtsEngineSetting =
    requested === 'local' || requested === 'elevenlabs' || requested === 'auto'
      ? requested
      : readEngineSetting(db);
  if (choice === 'local') return 'local';
  if (choice === 'elevenlabs') return 'elevenlabs';
  // auto: ElevenLabs only when a key is saved — otherwise free local voice.
  return getElevenLabsKey(db) ? 'elevenlabs' : 'local';
}

/**
 * Main speak function
 */
export async function speak(
  db: Database.Database,
  params: { text: string; engine?: string }
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
        console.warn('[Henry voice] ElevenLabs failed, falling back to local voice:', e instanceof Error ? e.message : e);
      }
    }
    // No key (explicit elevenlabs pick) or request failed → free local voice.
    const fellBackAudio = await speakLocal(db, clean);
    return fellBackAudio
      ? { engine: 'local', spoke: true, audio: fellBackAudio, fellBack: true }
      : { engine: 'local', spoke: false, fellBack: true };
  }

  const localAudio = await speakLocal(db, clean);
  return localAudio
    ? { engine: 'local', spoke: true, audio: localAudio }
    : { engine: 'local', spoke: false };
}

/**
 * Platform-specific local speech
 */
async function speakLocal(db: Database.Database, text: string): Promise<Buffer | null> {
  if (platformString === 'darwin') {
    // macOS: `say` renders straight to the device, so there is no buffer.
    await speakLocalSay(text, sayVoiceSetting(db), sayRateSetting(db));
    return null;
  }
  if (platformString === 'linux') {
    try {
      const audio = await speakLocalEspeak(text, espeakVoiceSetting(db), espeakRateSetting(db));
      // An empty buffer means stopSpeaking() cut the utterance short. Report
      // that as "did not speak" rather than handing the renderer a 0-byte blob
      // to try to play.
      return audio.byteLength > 0 ? audio : null;
    } catch (espeakError) {
      console.warn('[Henry voice] eSpeak failed:', espeakError);
      return null;
    }
  }
  // Windows and anything else have no local engine — the renderer falls back
  // to the Web Speech API. Return null instead of claiming we spoke.
  return null;
}

/**
 * Get TTS status
 */
export async function getTtsStatus(db: Database.Database): Promise<TtsStatus> {
  const status: TtsStatus = {
    engine: readEngineSetting(db),
    active: resolveEngine(db),
    elevenLabsKeyPresent: Boolean(getElevenLabsKey(db)),
    elevenVoiceId: (readSetting(db, 'voice_tts_voice') || DEFAULT_ELEVEN_VOICE).trim() || DEFAULT_ELEVEN_VOICE,
    sayVoice: sayVoiceSetting(db),
    sayRate: sayRateSetting(db),
    availableEngines: []
  };

  // Add available engines based on platform
  if (platformString === 'darwin') {
    status.availableEngines.push('say');
    const sayVoices = await listSayVoices();
    // In a full implementation, we'd add voice details to status
  } else if (platformString === 'linux') {
    status.availableEngines.push('espeak');
    const espeakVoices = await listEspeakVoices();
    // In a full implementation, we'd add voice details to status
  }

  // Web Speech is a RENDERER fallback (src/henry/ttsService.ts), not a main
  // process engine. It is listed so the UI can offer it, but it only works in
  // a renderer context.
  status.availableEngines.push('web-speech');

  if (getElevenLabsKey(db)) {
    status.availableEngines.push('elevenlabs');
  }

  return status;
}

/**
 * Stop speaking (platform-specific)
 */
export function stopSpeaking(): boolean {
  if (!espeakProcess) return false;
  try { espeakProcess.kill('SIGTERM'); } catch { /* already gone */ }
  espeakProcess = null;
  return true;
}

/**
 * IPC registration
 */
export function registerPlatformTtsHandlers(db: Database.Database): void {
  // The renderer checks `res.ok` and reads `res.result` for all three channels
  // (see src/henry/voice.ts and HenryVoiceResult in src/global.d.ts). These
  // handlers used to return the raw value, so every call saw `ok === undefined`
  // and threw — Henry could never speak.
  const envelope = <T>(fn: () => T | Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .then((result) => ({ ok: true as const, result }))
      .catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));

  ipcMain.handle('voice:speak', (_e, params: { text: string; engine?: string }) =>
    envelope(() => speak(db, params)));

  ipcMain.handle('voice:stopSpeaking', () =>
    envelope(() => ({ stopped: stopSpeaking() })));

  ipcMain.handle('voice:ttsStatus', () =>
    envelope(() => getTtsStatus(db)));
}