/**
 * Wake word.
 *
 * Three engines, tried in order of what actually works on the host:
 *
 *   1. Capacitor native (`@capacitor-community/speech-recognition`) — mobile.
 *   2. Desktop local STT — the rolling capture → whisper loop in
 *      `wakeWordDesktop.ts`. This is the engine that runs on Windows/Linux/macOS
 *      desktop, built from the same capture + whisper path hands-free voice
 *      commands already use.
 *   3. Web `SpeechRecognition` — kept for environments that genuinely implement it.
 *
 * Measured on Electron 31.7.7 rather than assumed: `webkitSpeechRecognition`
 * IS defined and `start()` does not throw, but the recogniser immediately
 * reports `not-allowed` and never yields a result. Chromium's speech backend
 * needs the Google API key that only official Chrome builds carry, and
 * Electron has none. On desktop this third engine is therefore not a fallback
 * at all, which is exactly why the local STT engine above has to work.
 *
 * The patterns, the 4s cooldown and the `henry_ambient_note` /
 * `henry_wake_word` events are unchanged, so nothing downstream had to move.
 */

import { Capacitor } from '@capacitor/core';
import {
  createDesktopWakeEngine,
  matchWakeWord,
  WakeCooldown,
  type DesktopWakeEngine,
  type DesktopWakeUnavailable,
} from './wakeWordDesktop';
import {
  cancelVoiceRecording,
  startVoiceRecording,
  stopVoiceRecording,
  transcribeLocal,
  voiceIpcAvailable,
} from './voice';

export type AmbientNote = {
  text: string;
  timestamp: string;
};

const AMBIENT_KEY = 'henry:ambient_notes';
const WAKE_STATE_KEY = 'henry:wake_active';

/** The slice of the SpeechRecognition instance this module actually touches. */
interface WebSpeechSession {
  abort: () => void;
}

/** The untyped constructor exposed on `window` by browsers that implement it. */
interface WebSpeechCtor {
  new (): {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    maxAlternatives: number;
    onresult: ((event: WebSpeechEvent) => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    abort: () => void;
  };
}

interface WebSpeechEvent {
  resultIndex: number;
  results: { length: number } & Record<number, { isFinal: boolean; 0: { transcript: string } }>;
}

/** Read the browser constructor off `window` without asserting a shape. */
function webSpeechCtor(): WebSpeechCtor | null {
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as WebSpeechCtor) : null;
}

class WakeWordManager {
  private webRecognition: WebSpeechSession | null = null;
  private _active = false;
  private _ambientLog: AmbientNote[] = [];
  private cooldown = new WakeCooldown();
  private desktop: DesktopWakeEngine | null = null;
  /** Which engine actually started, so `stop()` tears down the right one. */
  private _engine: 'native' | 'desktop' | 'web' | null = null;

  get isActive() {
    return this._active;
  }

  async start(): Promise<'ok' | 'no-api' | 'native-ok' | 'desktop-ok'> {
    this.stop();

    if (Capacitor.isNativePlatform()) {
      const started = await this._startNative();
      if (started === 'native-ok') return 'native-ok';
      return this._startWeb();
    }

    // Desktop Electron: the mobile plugin does not exist here, and Chromium's
    // recogniser (measured on 31.7.7) accepts `start()` and then immediately
    // reports `not-allowed` without ever yielding a result. So there is exactly
    // one engine that can work, and it is the local whisper pipeline.
    if (await this._startDesktop()) return 'desktop-ok';

    // Falling through to the web engine here would report 'ok' and dispatch
    // `active: true`, then die a frame later on `not-allowed`. Saying it is
    // unavailable is both true and the difference between an honest engine
    // report and a phantom one.
    if (voiceIpcAvailable()) {
      window.dispatchEvent(new CustomEvent('henry_wake_state', {
        detail: { active: false, error: 'no-api' },
      }));
      return 'no-api';
    }

    return this._startWeb();
  }

  stop() {
    this._active = false;
    if (this._engine === 'desktop') {
      this.desktop?.stop();
      cancelVoiceRecording();
    } else if (this._engine === 'native') {
      void this._stopNative();
    } else if (this._engine === 'web') {
      this._stopWeb();
    }
    this.desktop = null;
    this._engine = null;
    this._persist(false);
    window.dispatchEvent(new CustomEvent('henry_wake_state', { detail: { active: false } }));
  }

  savedState(): boolean {
    try { return localStorage.getItem(WAKE_STATE_KEY) === 'true'; } catch { return false; }
  }

  getAmbientLog(): AmbientNote[] {
    return [...this._ambientLog];
  }

  clearAmbientLog() {
    this._ambientLog = [];
    try { localStorage.removeItem(AMBIENT_KEY); } catch { /* ignore */ }
  }

  // ── Desktop (local whisper, via the hands-free capture path) ───────────────

  /**
   * Honest about its own readiness: when the local STT engine is not installed
   * and downloaded it reports that and lets the caller fall through, rather
   * than reporting "listening" while nothing can hear anything.
   */
  private async _startDesktop(): Promise<boolean> {
    if (!voiceIpcAvailable() || typeof window.henryAPI.voiceSttStatus !== 'function') return false;

    let ready = false;
    try {
      const status = await window.henryAPI.voiceSttStatus();
      ready = Boolean(status?.ok && status.result?.ready);
    } catch {
      return false;
    }
    if (!ready) {
      window.dispatchEvent(new CustomEvent('henry_wake_state', {
        detail: { active: false, error: 'stt-not-ready' },
      }));
      return false;
    }

    this.desktop = createDesktopWakeEngine({
      // One utterance: open the mic, let endpointing end it on silence, hand
      // back the bytes. This is the hands-free path, not a second recorder —
      // `stopVoiceRecording()` resolves when `startVoiceRecording()`'s
      // endpointing watcher decides the speaker stopped, so awaiting it here is
      // what waits for the utterance rather than cutting it off instantly.
      capture: async () => {
        await startVoiceRecording();
        const blob = await stopVoiceRecording();
        return blob ? await blob.arrayBuffer() : null;
      },
      transcribe: (audio) => transcribeLocal(new Blob([audio])),
      onTranscript: (text) => this._recordNote(text),
      onWake: (match) => this._fireWake(match.query, match.fullTranscript),
      onUnavailable: (reason) => this._onDesktopUnavailable(reason),
      // An utterance that never ends — endpointing switched off, a muted mic
      // that never trips the gate — would otherwise hold the microphone open
      // indefinitely. Drop it and start listening again.
      onCaptureTimeout: () => cancelVoiceRecording(),
    });

    this._active = true;
    this._engine = 'desktop';
    this.cooldown = new WakeCooldown();
    this._loadAmbientLog();
    this._persist(true);
    await this.desktop.start();
    window.dispatchEvent(new CustomEvent('henry_wake_state', { detail: { active: true, engine: 'desktop' } }));
    return true;
  }

  private _onDesktopUnavailable(reason: DesktopWakeUnavailable) {
    // `stopped` is the deliberate teardown path, which already reported itself.
    if (reason === 'stopped') return;
    this._active = false;
    this.desktop = null;
    this._engine = null;
    cancelVoiceRecording();
    this._persist(false);
    window.dispatchEvent(new CustomEvent('henry_wake_state', {
      detail: { active: false, error: reason },
    }));
  }

  // ── Native (Capacitor) ─────────────────────────────────────────────────────

  private async _startNative(): Promise<'native-ok' | 'no-api'> {
    try {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');

      const perm = await SpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== 'granted') {
        const req = await SpeechRecognition.requestPermissions();
        if (req.speechRecognition !== 'granted') {
          window.dispatchEvent(new CustomEvent('henry_wake_state', {
            detail: { active: false, error: 'mic-denied' },
          }));
          return 'no-api';
        }
      }

      this._active = true;
      this._engine = 'native';
      this.cooldown = new WakeCooldown();
      this._loadAmbientLog();
      this._persist(true);

      await SpeechRecognition.start({
        language: 'en-US',
        maxResults: 1,
        partialResults: false,
        popup: false,
      });

      SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
        const text = data.matches?.[0]?.trim();
        if (text) this._handleTranscript(text);
      });

      window.dispatchEvent(new CustomEvent('henry_wake_state', { detail: { active: true, engine: 'native' } }));
      return 'native-ok';
    } catch {
      return 'no-api';
    }
  }

  private async _stopNative() {
    try {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      await SpeechRecognition.stop();
      SpeechRecognition.removeAllListeners();
    } catch { /* ignore */ }
  }

  // ── Web (SpeechRecognition API) — last resort ──────────────────────────────

  private _startWeb(): 'ok' | 'no-api' {
    const API = webSpeechCtor();
    if (!API) {
      window.dispatchEvent(new CustomEvent('henry_wake_state', {
        detail: { active: false, error: 'no-api' },
      }));
      return 'no-api';
    }

    this._active = true;
    this._engine = 'web';
    this.cooldown = new WakeCooldown();
    this._loadAmbientLog();
    this._persist(true);
    this._createAndStartWeb(API);
    window.dispatchEvent(new CustomEvent('henry_wake_state', { detail: { active: true, engine: 'web' } }));
    return 'ok';
  }

  private _stopWeb() {
    try { this.webRecognition?.abort(); } catch { /* ignore */ }
    this.webRecognition = null;
  }

  private _createAndStartWeb(API: WebSpeechCtor) {
    if (!this._active) return;

    const r = new API();
    r.continuous = true;
    r.interimResults = false;
    r.lang = 'en-US';
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          this._handleTranscript(event.results[i][0].transcript.trim());
        }
      }
    };

    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this._active = false;
        this._persist(false);
        window.dispatchEvent(new CustomEvent('henry_wake_state', {
          detail: { active: false, error: 'mic-denied' },
        }));
      }
    };

    r.onend = () => {
      this.webRecognition = null;
      if (this._active) {
        setTimeout(() => {
          const A = webSpeechCtor();
          if (A && this._active) this._createAndStartWeb(A);
        }, 300);
      }
    };

    r.start();
    this.webRecognition = r;
  }

  // ── Shared transcript handling ─────────────────────────────────────────────

  private _recordNote(text: string) {
    const note: AmbientNote = { text, timestamp: new Date().toISOString() };
    this._ambientLog.push(note);
    if (this._ambientLog.length > 300) this._ambientLog.shift();
    this._saveAmbientLog();

    window.dispatchEvent(new CustomEvent('henry_ambient_note', { detail: { note } }));
  }

  private _fireWake(query: string, fullTranscript: string) {
    window.dispatchEvent(new CustomEvent('henry_wake_word', {
      detail: { query, fullTranscript },
    }));
  }

  private _handleTranscript(text: string) {
    if (!text) return;

    this._recordNote(text);

    const match = matchWakeWord(text);
    if (!match) return;
    if (!this.cooldown.tryAcquire()) return;

    this._fireWake(match.query, match.fullTranscript);
  }

  private _persist(active: boolean) {
    try { localStorage.setItem(WAKE_STATE_KEY, active ? 'true' : 'false'); } catch { /* ignore */ }
  }

  private _loadAmbientLog() {
    try {
      const stored = JSON.parse(localStorage.getItem(AMBIENT_KEY) || '[]');
      if (Array.isArray(stored)) this._ambientLog = stored.slice(-300);
    } catch { /* ignore */ }
  }

  private _saveAmbientLog() {
    try {
      localStorage.setItem(AMBIENT_KEY, JSON.stringify(this._ambientLog.slice(-200)));
    } catch { /* ignore */ }
  }
}

export const wakeWordManager = new WakeWordManager();