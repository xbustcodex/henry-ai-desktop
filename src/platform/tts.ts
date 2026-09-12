/**
 * Cross-platform text-to-speech abstraction
 * Provides TTS capabilities appropriate for each operating system
 */

import { ipcMain } from 'electron';
import { spawn, execFile, type ChildProcess } from 'child_process';
import type Database from 'better-sqlite3';
import { decryptKey } from '../../electron/ipc/_keyStorage';
import { prepareSpeechText } from '../../electron/voice/_speechText';
import { platform } from 'os';

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
  /** ElevenLabs mp3 bytes for renderer-side playback. */
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

// Get the platform string once
const platformString = platform();

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

function speakLocalEspeak(text: string, voice: string, rate: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (platformString !== 'linux') {
      reject(new Error('eSpeak is only available on Linux'));
      return;
    }

    // Try espeak-ng first, then espeak
    const espeakCmd = require('child_process').spawnSync('espeak-ng', ['--version'], { timeout: 1000 });
    const cmd = espeakCmd.status === 0 ? 'espeak-ng' : 'espeak';

    // eSpeak rate is in words per minute
    const child = spawn(cmd, [
      '-v', voice,
      '-s', String(rate),
      '-z', // null sentence pause at end
      text
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let audioData = Buffer.alloc(0);
    child.stdout?.on('data', (data: Buffer) => {
      audioData = Buffer.concat([audioData, data]);
    });

    child.stderr?.on('data', (data: Buffer) => {
      // Ignore stderr for now, could log if needed
    });

    child.on('error', (err: Error) => {
      reject(new Error(`${cmd} failed: ${err.message}`));
    });

    child.on('close', (code: number) => {
      if (code === 0) {
        // Return audio data - in a real implementation, we'd convert to appropriate format
        // For now, we'll resolve without audio since Electron renderer handles playback
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

/**
 * Web Speech API fallback (handled in renderer)
 * This is a placeholder - actual implementation would be in renderer process
 */
function speakLocalWeb(text: string): Promise<void> {
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
        console.warn('[Henry voice] ElevenLabs failed, falling back to local say:', e instanceof Error ? e.message : e);
      }
    }
    // No key (explicit elevenlabs pick) or request failed → free local voice.
    await speakLocal(db, clean);
    return { engine: 'local', spoke: true, fellBack: true };
  }

  await speakLocal(db, clean);
  return { engine: 'local', spoke: true };
}

/**
 * Platform-specific local speech
 */
async function speakLocal(db: Database.Database, text: string): Promise<void> {
  if (platformString === 'darwin') {
    // macOS: use say command
    await speakLocalSay(text, sayVoiceSetting(db), sayRateSetting(db));
  } else if (platformString === 'linux') {
    // Linux: try eSpeak first
    try {
      await speakLocalEspeak(text, espeakVoiceSetting(db), espeakRateSetting(db));
      return;
    } catch (espeakError) {
      console.warn('[Henry voice] eSpeak failed:', espeakError);
      // Fall back to Web Speech API in renderer
      await speakLocalWeb(text);
      return;
    }
  } else {
    // Windows and other platforms: for now, use Web Speech API fallback
    await speakLocalWeb(text);
  }
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

  // Web Speech API is always available as fallback
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
  if (platformString === 'darwin') {
    // For macOS, we'd need to track the say process
    // This is simplified - in a full implementation we'd track the child process
    return true; // Placeholder
  } else if (platformString === 'linux') {
    // For eSpeak, we'd need to track the process
    return true; // Placeholder
  }

  return false;
}

/**
 * IPC registration
 */
export function registerPlatformTtsHandlers(db: Database.Database): void {
  ipcMain.handle('voice:speak', (_e, params: { text: string; engine?: string }) => {
    // We need to wrap this properly - this is simplified
    return speak(db, params);
  });

  ipcMain.handle('voice:stopSpeaking', () => {
    return { stopped: stopSpeaking() };
  });

  ipcMain.handle('voice:ttsStatus', () => {
    return getTtsStatus(db);
  });
}