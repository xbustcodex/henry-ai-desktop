/**
 * Henry AI — Voice layer (renderer side).
 *
 * Talk-and-listen wrapper over the Electron voice IPC:
 *   - Listening: MediaRecorder → voice:transcribe (FREE local whisper.cpp).
 *   - Speaking: voice:speak — macOS `say` by default (speaks from the main
 *     process), ElevenLabs mp3 buffer (played here via an Audio element) when
 *     a key is saved. Everything works offline at $0.
 *
 * Also owns the shared voice UI state (zustand): idle / listening /
 * transcribing / speaking, plus the persisted "voice replies" + hands-free
 * toggles. Web mode (no Electron IPC) degrades to the legacy ttsService.
 */

import { create } from 'zustand';
import { speak as legacySpeak, cancelTTS as legacyCancel } from './ttsService';
import { useStore } from '../store';

export type VoiceUiState = 'idle' | 'listening' | 'transcribing' | 'speaking';

export const VOICE_REPLIES_SETTING_KEY = 'voice_replies';

interface VoiceStore {
  state: VoiceUiState;
  /** Persisted: speak each completed assistant reply aloud. */
  voiceReplies: boolean;
  /** Session-only: mic auto-sends the transcript and the reply is spoken. */
  handsFree: boolean;
  /** True once the user typed manually — skip auto-speaking that reply. */
  userTypedSinceReply: boolean;
  /** Local whisper readiness (null = not probed yet / not Electron). */
  sttReady: boolean | null;

  setState: (s: VoiceUiState) => void;
  setVoiceReplies: (on: boolean) => void;
  setHandsFree: (on: boolean) => void;
  setUserTyped: (typed: boolean) => void;
  setSttReady: (ready: boolean | null) => void;
}

function readInitialVoiceReplies(): boolean {
  try {
    const settings = JSON.parse(localStorage.getItem('henry:settings') || '{}');
    if (settings[VOICE_REPLIES_SETTING_KEY] != null) {
      return settings[VOICE_REPLIES_SETTING_KEY] === 'true';
    }
    // Legacy toggle from the Groq-era TTS button.
    return localStorage.getItem('henry_tts_enabled') === 'true';
  } catch {
    return false;
  }
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  state: 'idle',
  voiceReplies: readInitialVoiceReplies(),
  handsFree: false,
  userTypedSinceReply: false,
  sttReady: null,

  setState: (state) => set({ state }),
  setVoiceReplies: (voiceReplies) => {
    set({ voiceReplies });
    try { localStorage.setItem('henry_tts_enabled', String(voiceReplies)); } catch { /* ignore */ }
    void window.henryAPI?.saveSetting?.(VOICE_REPLIES_SETTING_KEY, String(voiceReplies));
  },
  setHandsFree: (handsFree) => set({ handsFree }),
  setUserTyped: (userTypedSinceReply) => set({ userTypedSinceReply }),
  setSttReady: (sttReady) => set({ sttReady }),
}));

/** True when the Electron voice IPC is available (desktop app, not web mode). */
export function voiceIpcAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.henryAPI?.voiceTranscribe === 'function';
}

// ── STT: status + one-time setup ────────────────────────────────────────────

export async function getVoiceSttStatus(refresh = false): Promise<HenryVoiceSttStatus | null> {
  if (!window.henryAPI?.voiceSttStatus) return null;
  try {
    const res = await window.henryAPI.voiceSttStatus({ refresh });
    if (res.ok) {
      useVoiceStore.getState().setSttReady(res.result.ready);
      return res.result;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * One-time free-voice setup: installs whisper-cpp (brew) if missing, then
 * downloads the ~148MB base.en model. Progress arrives via onProgress.
 */
export async function runVoiceSetup(
  onProgress?: (p: HenryVoiceSetupProgress) => void,
): Promise<HenryVoiceSttStatus> {
  if (!window.henryAPI?.voiceSttSetup) throw new Error('Voice setup needs the desktop app.');
  const unsub = onProgress ? window.henryAPI.onVoiceSttSetupProgress?.(onProgress) : undefined;
  try {
    const res = await window.henryAPI.voiceSttSetup();
    if (!res.ok) throw new Error(res.error);
    useVoiceStore.getState().setSttReady(res.result.ready);
    return res.result;
  } finally {
    unsub?.();
  }
}

// ── STT: record + transcribe ────────────────────────────────────────────────

let activeRecorder: MediaRecorder | null = null;
let activeStream: MediaStream | null = null;
let recordedChunks: Blob[] = [];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}

/**
 * Fire the macOS mic prompt from the main process and throw a clear,
 * user-facing message if access isn't granted. MUST run before ANY
 * getUserMedia call — packaged apps fail silently without the OS grant.
 */
export async function ensureMicAccess(): Promise<void> {
  if (!window.henryAPI?.voiceMicAccess) return; // web/mobile — browser handles it
  const access = await window.henryAPI.voiceMicAccess();
  if (!access.granted) {
    throw new Error(
      access.status === 'not-determined' || access.status === 'unknown'
        ? 'Microphone permission was not granted — try the mic button again and click OK on the system prompt.'
        : 'Microphone access is off for Henry. I opened System Settings → Privacy & Security → Microphone — flip Henry AI on, then try again.',
    );
  }
}

/** Start capturing mic audio. Throws a clear, user-facing message on denial. */
export async function startVoiceRecording(): Promise<void> {
  if (activeRecorder) return; // already listening
  await ensureMicAccess();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      throw new Error(
        'Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone → Henry AI.',
      );
    }
    if (name === 'NotFoundError') {
      throw new Error('No microphone found — plug one in or check your input device.');
    }
    throw new Error('Could not start the microphone: ' + (err instanceof Error ? err.message : String(err)));
  }

  const mimeType = pickMimeType();
  const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  recordedChunks = [];
  mr.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mr.start();
  activeRecorder = mr;
  activeStream = stream;
  useVoiceStore.getState().setState('listening');
}

/** Stop recording and hand back the captured audio blob (null if nothing usable). */
export function stopVoiceRecording(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const mr = activeRecorder;
    const stream = activeStream;
    activeRecorder = null;
    activeStream = null;
    if (!mr || mr.state === 'inactive') {
      stream?.getTracks().forEach((t) => t.stop());
      useVoiceStore.getState().setState('idle');
      resolve(null);
      return;
    }
    mr.onstop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: mr.mimeType || 'audio/webm' });
      recordedChunks = [];
      resolve(blob.size >= 1000 ? blob : null);
    };
    mr.stop();
  });
}

/** Abort a recording without transcribing. */
export function cancelVoiceRecording(): void {
  try { activeRecorder?.stop(); } catch { /* ignore */ }
  activeStream?.getTracks().forEach((t) => t.stop());
  activeRecorder = null;
  activeStream = null;
  recordedChunks = [];
  useVoiceStore.getState().setState('idle');
}

/** Transcribe a blob through the FREE local whisper.cpp pipeline. */
export async function transcribeLocal(blob: Blob): Promise<string> {
  if (!window.henryAPI?.voiceTranscribe) throw new Error('Local transcription needs the desktop app.');
  useVoiceStore.getState().setState('transcribing');
  try {
    const res = await window.henryAPI.voiceTranscribe(await blob.arrayBuffer());
    if (!res.ok) throw new Error(res.error);
    return res.result.text;
  } finally {
    useVoiceStore.getState().setState('idle');
  }
}

// ── TTS: speak / stop ───────────────────────────────────────────────────────

let currentAudio: HTMLAudioElement | null = null;

function stopAudioElement(): void {
  if (currentAudio) {
    try {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
    } catch { /* ignore */ }
    currentAudio = null;
  }
}

/**
 * Speak text through the engine ladder (ElevenLabs when a key is saved,
 * otherwise the free macOS voice). Resolves when speech finishes.
 */
export async function speak(text: string, engine?: 'auto' | 'local' | 'elevenlabs'): Promise<void> {
  if (!text?.trim()) return;
  if (!window.henryAPI?.voiceSpeak) {
    // Web mode — legacy browser/Groq path.
    const settings = ((): Record<string, string> => {
      try { return JSON.parse(localStorage.getItem('henry:settings') || '{}'); } catch { return {}; }
    })();
    await legacySpeak(text, settings, []);
    return;
  }

  await stopSpeaking();
  useVoiceStore.getState().setState('speaking');
  try {
    const res = await window.henryAPI.voiceSpeak({ text, engine });
    if (!res.ok) throw new Error(res.error);

    // ElevenLabs sends mp3; the local eSpeak engine sends WAV. Both are played
    // here in the renderer — the main process no longer plays to the device.
    if (res.result.audio) {
      const mime = res.result.engine === 'elevenlabs' ? 'audio/mpeg' : 'audio/wav';
      const blob = new Blob([new Uint8Array(res.result.audio)], { type: mime });
      const url = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const audio = new Audio(url);
        currentAudio = audio;
        const done = () => {
          if (currentAudio === audio) currentAudio = null;
          try { URL.revokeObjectURL(url); } catch { /* ignore */ }
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.onpause = () => {
          // pause() from stopSpeaking() — treat as finished.
          if (audio.ended) return;
          done();
        };
        void audio.play().catch(done);
      });
      return;
    }

    // No audio came back. macOS `say` renders to the device itself in the main
    // process, but Windows has no local engine at all, so previously the reply
    // was silent there. SpeechSynthesis always exists in a renderer, so use it.
    await legacySpeak(text, useStore.getState().settings, []);
  } finally {
    const st = useVoiceStore.getState();
    if (st.state === 'speaking') st.setState('idle');
  }
}

/** Stop any speech — ElevenLabs audio here, `say` in the main process. */
export async function stopSpeaking(): Promise<void> {
  stopAudioElement();
  legacyCancel();
  try { await window.henryAPI?.voiceStopSpeaking?.(); } catch { /* ignore */ }
  const st = useVoiceStore.getState();
  if (st.state === 'speaking') st.setState('idle');
}

/**
 * Speak a completed assistant reply. Desktop uses the local/ElevenLabs ladder;
 * web mode falls back to the legacy Groq/browser TTS with the caller's
 * settings + providers.
 */
export async function speakAssistantReply(
  text: string,
  settings: Record<string, string>,
  providers: unknown[],
): Promise<void> {
  if (voiceIpcAvailable()) {
    await speak(text);
  } else {
    await legacySpeak(text, settings, providers as never[]);
  }
}

export async function getVoiceTtsStatus(): Promise<HenryVoiceTtsStatus | null> {
  if (!window.henryAPI?.voiceTtsStatus) return null;
  try {
    const res = await window.henryAPI.voiceTtsStatus();
    return res.ok ? res.result : null;
  } catch {
    return null;
  }
}
