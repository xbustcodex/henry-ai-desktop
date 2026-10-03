/**
 * Wake word — desktop engine, and the pattern/cooldown core both engines share.
 *
 * Why this exists: `wakeWord.ts` ran continuous recognition through the
 * Capacitor MOBILE plugin `@capacitor-community/speech-recognition`, which
 * does not exist on Windows or Linux desktop. On desktop it fell through to
 * `webkitSpeechRecognition`, which Chromium does not ship a working
 * implementation of — so the row was "implemented but not operable".
 *
 * The desktop engine reuses machinery the app already has and that is proven on
 * desktop: `getUserMedia` capture, the RMS endpointing watcher, and the local
 * whisper.cpp transcription IPC. Those three are exactly what hands-free voice
 * commands already use, so nothing new has to be trusted.
 *
 * The loop is written against injected `capture`/`transcribe` functions rather
 * than a live microphone so the whole state machine — wake, cooldown, silence,
 * STT-absent — is unit-testable without hardware.
 */
import { DEFAULT_ASSISTANT_NAME } from './assistantName';

/** How long after a wake the next wake is ignored. Unchanged from the original. */
export const COOLDOWN_MS = 4000;

/**
 * Three patterns, carried over verbatim. The first captures a command after the
 * wake word, the second allows the bare name as a sentence start, the third
 * fires on the bare name alone.
 */
export const WAKE_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s,])(?:hey|okay|ok|yo)\s+henry[,\s]*(.*)/i,
  /(?:^|[\s])henry\s*[,?!]*\s+(.*)/i,
  /^henry[,!?\s]*$/i,
];

/**
 * The wake word an unconfigured install listens for.
 *
 * Derived from `DEFAULT_ASSISTANT_NAME` so renaming the assistant and
 * re-reading the default wake word can never disagree. A CONFIGURED name is
 * resolved at match time by `wakeWord.ts` via `patternsForWakeWord`.
 */
export const DEFAULT_WAKE_WORD = DEFAULT_ASSISTANT_NAME.toLowerCase();

export interface WakeMatch {
  /** Text after the wake word, trimmed. Empty when the utterance was just the name. */
  query: string;
  fullTranscript: string;
}

/**
 * Match one utterance against the wake patterns.
 *
 * Returns null when nothing matched. Kept free of DOM and timers so the same
 * function serves the mobile plugin path, the browser path and the desktop
 * loop, and so it can be tested directly.
 */
export function matchWakeWord(text: string, patterns: readonly RegExp[] = WAKE_PATTERNS): WakeMatch | null {
  const transcript = (text || '').trim();
  if (!transcript) return null;
  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (match) {
      const query = (match[1] || '').trim().replace(/^[,\s]+|[,\s]+$/g, '');
      return { query, fullTranscript: transcript };
    }
  }
  return null;
}

/**
 * Build patterns for an arbitrary wake word, keeping the three shapes above:
 * "hey <name> …", "<name> …", and "<name>" alone.
 */
export function patternsForWakeWord(wakeWord: string): RegExp[] {
  const word = (wakeWord || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!word) return [...WAKE_PATTERNS];
  return [
    new RegExp(String.raw`(?:^|[\s,])(?:hey|okay|ok|yo)\s+${word}[,\s]*(.*)`, 'i'),
    new RegExp(String.raw`(?:^|[\s])${word}\s*[,?!]*\s+(.*)`, 'i'),
    new RegExp(String.raw`^${word}[,!?\s]*$`, 'i'),
  ];
}

/**
 * The cooldown gate.
 *
 * Previously this was a bare `now - this._lastWake < COOLDOWN_MS` check inside
 * the transcript handler, which made the "did the cooldown actually hold"
 * behaviour untestable. As an explicit object it can be driven with an injected
 * clock.
 */
export class WakeCooldown {
  // -Infinity, not 0: seeding from 0 meant the first wake only passed because
  // Date.now() dwarfs COOLDOWN_MS. Any clock starting near the epoch — a test,
  // a freshly-booted device — silently swallowed the first wake word.
  private lastWake = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now, private readonly cooldownMs = COOLDOWN_MS) {}

  /** True when a wake may fire now; marks it as fired when it may. */
  tryAcquire(): boolean {
    const t = this.now();
    if (t - this.lastWake < this.cooldownMs) return false;
    this.lastWake = t;
    return true;
  }

  /** Test/diagnostic seam. */
  get lastFiredAt(): number {
    return this.lastWake;
  }
}

export interface DesktopWakeEngineOptions {
  /** Record one utterance and resolve its bytes, or null when nothing usable. */
  capture: () => Promise<ArrayBuffer | null>;
  /** Transcribe those bytes. Rejecting means "engine missing" → the loop stops. */
  transcribe: (audio: ArrayBuffer) => Promise<string>;
  /** Patterns to match against. Defaults to the built-in three. */
  patterns?: readonly RegExp[];
  /** Called with every transcript, wake or not. */
  onTranscript?: (text: string) => void;
  /** Called when the wake word fires, subject to the cooldown. */
  onWake?: (match: WakeMatch) => void;
  /** Called when the engine cannot run, with a reason the UI can explain. */
  onUnavailable?: (reason: DesktopWakeUnavailable) => void;
  now?: () => number;
  cooldownMs?: number;
  /** Gap between the end of one iteration and the next capture starting. */
  restartDelayMs?: number;
  /**
   * Hard ceiling on a single utterance, in ms.
   *
   * Without it, a capture that never resolves — endpointing switched off, a
   * muted mic that never trips the activity gate — parks the loop on one
   * utterance forever instead of listening. 15s is far longer than any real
   * sentence.
   */
  maxCaptureMs?: number;
  /**
   * Fired when one utterance runs past `maxCaptureMs`. The capture is abandoned
   * and the loop continues; the listener's job is to tear down whatever is
   * still holding the microphone.
   */
  onCaptureTimeout?: () => void;
  /**
   * Fired after every loop iteration, including ones that captured nothing.
   * Tests await this instead of sleeping, so the loop is driven
   * deterministically rather than raced against the wall clock.
   */
  onCycle?: (cycle: number) => void;
}

export type DesktopWakeUnavailable =
  /** The local STT engine is not installed/downloaded — voice setup fixes it. */
  | 'stt-not-ready'
  /** The microphone could not be opened. */
  | 'mic-denied'
  /** The loop was stopped deliberately. */
  | 'stopped';

export interface DesktopWakeEngine {
  start: () => Promise<void>;
  stop: () => void;
  readonly running: boolean;
}

/** Default ceiling on a single utterance. */
const DEFAULT_MAX_CAPTURE_MS = 15_000;

/**
 * Race a capture against a deadline.
 *
 * Resolves to null on timeout rather than rejecting: a run-on utterance is a
 * normal event, not an engine failure, and the loop should keep listening.
 * The timer is always cleared, so a fast capture never leaves one pending.
 */
async function withDeadline(
  capture: Promise<ArrayBuffer | null>,
  maxMs: number,
  onTimeout: () => void,
): Promise<ArrayBuffer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, maxMs);
  });
  try {
    return await Promise.race([capture, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rolling listen loop.
 *
 * Capture one utterance, transcribe it, feed the transcript onward, repeat.
 * It stops itself — with a reason — the moment transcription fails, because a
 * wake word that silently transcribes nothing is worse than one that reports
 * that it needs setup.
 */
export function createDesktopWakeEngine(options: DesktopWakeEngineOptions): DesktopWakeEngine {
  const cooldown = new WakeCooldown(options.now ?? Date.now, options.cooldownMs ?? COOLDOWN_MS);
  const patterns = options.patterns ?? WAKE_PATTERNS;
  const restartDelayMs = options.restartDelayMs ?? 250;
  const maxCaptureMs = options.maxCaptureMs ?? DEFAULT_MAX_CAPTURE_MS;

  let running = false;
  let generation = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let cycle = 0;

  const stop = (): void => {
    running = false;
    generation++;
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const loop = async (mine: number): Promise<void> => {
    while (running && mine === generation) {
      // Every iteration pauses before the next one, INCLUDING the empty-audio
      // case. Continuing straight back into capture() on a null result is a hot
      // spin: a mic that yields nothing usable answers instantly, so the loop
      // would run thousands of times a second for as long as it stayed on.
      let audio: ArrayBuffer | null = null;
      try {
        audio = await withDeadline(
          options.capture(),
          maxCaptureMs,
          () => options.onCaptureTimeout?.(),
        );
      } catch {
        options.onUnavailable?.('mic-denied');
        stop();
        return;
      }

      if (!running || mine !== generation) return;

      if (audio) {
        let text: string;
        try {
          text = await options.transcribe(audio);
        } catch {
          options.onUnavailable?.('stt-not-ready');
          stop();
          return;
        }
        if (!running || mine !== generation) return;

        if (text && text.trim()) {
          options.onTranscript?.(text.trim());
          const match = matchWakeWord(text, patterns);
          if (match && cooldown.tryAcquire()) options.onWake?.(match);
        }
      }

      cycle++;
      options.onCycle?.(cycle);

      if (!running || mine !== generation) return;
      if (restartDelayMs <= 0) {
        // A zero delay means "cycle immediately" — the microtask yield keeps the
        // loop off the event loop's critical path without a real timer.
        await Promise.resolve();
      } else {
        await new Promise<void>((resolve) => {
          restartTimer = setTimeout(resolve, restartDelayMs);
        });
      }
    }
  };

  return {
    async start() {
      stop();
      running = true;
      const mine = generation;
      void loop(mine);
    },
    stop() {
      stop();
      options.onUnavailable?.('stopped');
    },
    get running() {
      return running;
    },
  };
}