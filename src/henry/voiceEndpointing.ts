/**
 * Voice endpointing (voice activity detection).
 *
 * Recording used to stop only when the user called stop, which made
 * hands-free use impossible — you had to let go of the button yourself.
 * Paid 1.7.0 has `voiceSilenceMs` (how long a pause ends an utterance) and
 * `micSensitivity` (the noise gate). Ours had neither.
 *
 * This watches the real signal rather than guessing: an AnalyserNode reports
 * RMS on a short interval, and the recording ends when speech has been heard
 * and then silence has lasted long enough.
 *
 * Two guards that matter in practice:
 *   - speech must have been DETECTED before silence can end anything, so a
 *     tap that never carried voice does not submit an empty utterance;
 *   - there is a hard maximum utterance, so a mute button, a stuck open mic or
 *     background noise cannot record forever.
 */

export interface EndpointingSettings {
  /** Silence, after speech has started, that ends the utterance. */
  silenceMs: number;
  /** RMS gate. Higher = needs to be louder to count as speech. */
  sensitivity: number;
  /** Hard cap on a single utterance. */
  maxUtteranceMs: number;
  /** Off entirely, for people who prefer an explicit button. */
  enabled: boolean;
}

export const DEFAULT_ENDPOINTING: EndpointingSettings = {
  // Paid's default is 900ms with a 400–5000 range (contracts.ts:263-275).
  silenceMs: 900,
  sensitivity: 0.5,
  maxUtteranceMs: 30_000,
  enabled: true,
};

const SILENCE_MIN = 400;
const SILENCE_MAX = 5000;
const SAMPLE_MS = 50;

export function sanitizeEndpointing(input: unknown): EndpointingSettings {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_ENDPOINTING };
  const r = input as Record<string, unknown>;
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    silenceMs: Math.round(clamp(r.silenceMs, SILENCE_MIN, SILENCE_MAX, DEFAULT_ENDPOINTING.silenceMs)),
    sensitivity: Math.round(clamp(r.sensitivity, 0, 1, DEFAULT_ENDPOINTING.sensitivity) * 100) / 100,
    maxUtteranceMs: Math.round(clamp(r.maxUtteranceMs, 2000, 120_000, DEFAULT_ENDPOINTING.maxUtteranceMs)),
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_ENDPOINTING.enabled,
  };
}

/**
 * Map the sensitivity slider onto an RMS gate.
 *
 * 0 is permissive (very quiet counts as speech), 1 is strict. The range is
 * deliberately wide because RMS depends entirely on the microphone and room.
 */
export function rmsThreshold(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, sensitivity));
  // 0.004 (quiet room) up to 0.06 (noisy room / far-field mic).
  return 0.004 + s * 0.056;
}

export interface EndpointingHandle {
  stop: () => void;
}

/**
 * Watch `stream` and call `onEnd` when the utterance is over.
 * Returns a handle whose `stop()` detaches everything.
 */
export function watchForEnd(
  stream: MediaStream,
  settings: EndpointingSettings,
  onEnd: () => void,
): EndpointingHandle {
  // Read off globalThis rather than window: this module is also exercised in a
  // plain node test environment where `window` does not exist at all.
  const g = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioCtx = g.AudioContext ?? g.webkitAudioContext;
  if (!AudioCtx) {
    // No WebAudio — fall back to the maximum cap so a stuck mic still ends.
    const t = setTimeout(onEnd, settings.maxUtteranceMs);
    return { stop: () => clearTimeout(t) };
  }

  let ctx: AudioContext;
  try {
    ctx = new AudioCtx();
  } catch {
    const t = window.setTimeout(onEnd, settings.maxUtteranceMs);
    return { stop: () => window.clearTimeout(t) };
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  const gate = rmsThreshold(settings.sensitivity);
  let speechSeen = false;
  let silentSince: number | null = null;
  let finished = false;
  const startedAt = Date.now();

  const tick = () => {
    if (finished) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();

    if (rms >= gate) {
      speechSeen = true;
      silentSince = null;
    } else if (speechSeen) {
      if (silentSince === null) silentSince = now;
      else if (now - silentSince >= settings.silenceMs) {
        finish();
        return;
      }
    }

    if (now - startedAt >= settings.maxUtteranceMs) {
      finish();
      return;
    }
    timer = setTimeout(tick, SAMPLE_MS) as unknown as number;
  };

  let timer = setTimeout(tick, SAMPLE_MS) as unknown as number;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { source.disconnect(); } catch { /* already detached */ }
    try { ctx.close(); } catch { /* already closed */ }
    onEnd();
  }

  return { stop: () => { finished = true; clearTimeout(timer); try { source.disconnect(); } catch { /* */ } try { ctx.close(); } catch { /* */ } } };
}

/** Short human label for the UI. */
export function describeEndpointing(s: EndpointingSettings): string {
  if (!s.enabled) return 'Off — recording ends only when you release the button';
  if (s.silenceMs >= SILENCE_MAX) return `Very patient — ends after ${(s.silenceMs / 1000).toFixed(1)}s of quiet`;
  return `Ends after ${s.silenceMs}ms of quiet, ${Math.round(s.sensitivity * 100)}% noise gate`;
}