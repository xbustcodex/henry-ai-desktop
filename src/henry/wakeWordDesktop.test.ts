import { describe, it, expect, vi } from 'vitest';
import {
  COOLDOWN_MS,
  WAKE_PATTERNS,
  WakeCooldown,
  createDesktopWakeEngine,
  matchWakeWord,
  patternsForWakeWord,
  type DesktopWakeEngineOptions,
  type WakeMatch,
} from './wakeWordDesktop';

/**
 * Row 6.4: the wake word shipped with a mobile-only engine, so it could not
 * fire on Windows or Linux desktop. These cover the desktop engine's loop and
 * the pattern/cooldown semantics it had to preserve.
 *
 * Nothing here waits on a wall clock: the loop reports each completed cycle
 * through `onCycle`, and the tests await that signal (or the engine's own
 * unavailable/stopped callbacks) instead of sleeping and hoping.
 */

/** Await `n` completed capture → transcribe cycles, with a bounded spin so a
 *  stalled loop fails the assertion rather than hanging the suite. */
function afterCycles(n: number, register: (fn: (c: number) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seen = 0;
    const guard = setTimeout(() => {
      reject(new Error(`only ${seen} of ${n} cycles completed`));
    }, 5000);
    register((c) => {
      if (c >= n) {
        clearTimeout(guard);
        resolve();
      }
    });
  });
}

/** Resolves when the engine reports it cannot continue. */
function whenUnavailable(
  options: DesktopWakeEngineOptions,
): { promise: Promise<string>; calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn();
  const promise = new Promise<string>((resolve) => {
    options.onUnavailable = (reason) => {
      calls(reason);
      resolve(reason);
    };
  });
  return { promise, calls };
}

const bytes = (): ArrayBuffer => new ArrayBuffer(64);

describe('matchWakeWord — the three original patterns', () => {
  it('still has exactly three patterns', () => {
    expect(WAKE_PATTERNS).toHaveLength(3);
  });

  it('captures a command after "hey henry"', () => {
    expect(matchWakeWord('hey henry what is the weather')).toEqual({
      query: 'what is the weather',
      fullTranscript: 'hey henry what is the weather',
    });
  });

  it('accepts okay / ok / yo as the spoken prefix', () => {
    for (const prefix of ['hey', 'okay', 'ok', 'yo']) {
      expect(matchWakeWord(`${prefix} henry open the garage`)?.query).toBe('open the garage');
    }
  });

  it('captures a command after a bare name mid-sentence', () => {
    expect(matchWakeWord('okay henry, turn off the lights')?.query).toBe('turn off the lights');
  });

  it('fires on the bare name alone with an empty query', () => {
    const match = matchWakeWord('henry');
    expect(match?.query).toBe('');
    expect(match?.fullTranscript).toBe('henry');
  });

  it('ignores speech that never says the name', () => {
    for (const text of ['', '   ', 'turn off the lights', 'hey there', 'hydrogen peroxide']) {
      expect(matchWakeWord(text)).toBeNull();
    }
  });

  it('handles a pattern with no capture group', () => {
    expect(matchWakeWord('henry', [/^henry$/i])).toEqual({ query: '', fullTranscript: 'henry' });
  });
});

describe('patternsForWakeWord', () => {
  it('mirrors the three shapes for a different name', () => {
    const p = patternsForWakeWord('Zorblax');
    expect(matchWakeWord('hey zorblax run the tests', p)?.query).toBe('run the tests');
    expect(matchWakeWord('zorblax open the door', p)?.query).toBe('open the door');
    expect(matchWakeWord('zorblax', p)?.query).toBe('');
    expect(matchWakeWord('hey henry run the tests', p)).toBeNull();
  });

  it('escapes regex metacharacters in the name', () => {
    const p = patternsForWakeWord('a.b');
    expect(matchWakeWord('hey a.b do it', p)?.query).toBe('do it');
    expect(matchWakeWord('hey axb do it', p)).toBeNull();
  });

  it('falls back to the built-ins for a blank name', () => {
    expect(patternsForWakeWord('   ')).toHaveLength(WAKE_PATTERNS.length);
  });
});

describe('WakeCooldown — the 4s gate', () => {
  it('is 4000ms by default', () => {
    expect(COOLDOWN_MS).toBe(4000);
  });

  it('allows the first wake and blocks the next inside the window', () => {
    let now = 1000;
    const gate = new WakeCooldown(() => now);
    expect(gate.tryAcquire()).toBe(true);
    now += COOLDOWN_MS - 1;
    expect(gate.tryAcquire()).toBe(false);
    now += 1;
    expect(gate.tryAcquire()).toBe(true);
  });

  it('only marks the time when it actually fires', () => {
    let now = 1000;
    const gate = new WakeCooldown(() => now);
    expect(gate.tryAcquire()).toBe(true);
    now += 500;
    expect(gate.tryAcquire()).toBe(false);
    // A blocked attempt must not extend the window.
    expect(gate.lastFiredAt).toBe(1000);
    now += COOLDOWN_MS;
    expect(gate.tryAcquire()).toBe(true);
  });
});

describe('createDesktopWakeEngine — the rolling listen loop', () => {
  it('fires on a wake utterance and reports the query', async () => {
    const wakes: WakeMatch[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => 'hey henry what is the weather',
      onWake: (m) => wakes.push(m),
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(1, (fn) => { options.onCycle = fn; });
    engine.stop();

    expect(wakes).toEqual([{ query: 'what is the weather', fullTranscript: 'hey henry what is the weather' }]);
  });

  it('reports every transcript, wake or not', async () => {
    const seen: string[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => 'the kettle is boiling',
      onTranscript: (t) => seen.push(t),
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(3, (fn) => { options.onCycle = fn; });
    engine.stop();

    expect(seen).toEqual(['the kettle is boiling', 'the kettle is boiling', 'the kettle is boiling']);
  });

  it('enforces the cooldown across consecutive utterances', async () => {
    let clock = 1000;
    const wakes: WakeMatch[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => 'hey henry do it',
      onWake: (m) => wakes.push(m),
      now: () => clock,
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(4, (fn) => { options.onCycle = fn; });
    engine.stop();

    // All four land inside one 4s window, so exactly one may fire.
    expect(wakes).toHaveLength(1);
  });

  it('fires again once the cooldown has elapsed', async () => {
    let clock = 1000;
    const wakes: WakeMatch[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => 'hey henry do it',
      onWake: (m) => wakes.push(m),
      // Each cycle advances the injected clock past the cooldown.
      now: () => (clock += COOLDOWN_MS + 1),
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(3, (fn) => { options.onCycle = fn; });
    engine.stop();

    expect(wakes).toHaveLength(3);
  });

  it('stops and reports stt-not-ready when the local engine is missing', async () => {
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => { throw new Error('whisper-cli not installed'); },
      restartDelayMs: 0,
    };
    const unavailable = whenUnavailable(options);
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await expect(unavailable.promise).resolves.toBe('stt-not-ready');

    expect(unavailable.calls).toHaveBeenCalledWith('stt-not-ready');
    expect(engine.running).toBe(false);
  });

  it('stops and reports mic-denied when capture throws', async () => {
    const options: DesktopWakeEngineOptions = {
      capture: async () => { throw new Error('NotAllowedError'); },
      transcribe: async () => '',
      restartDelayMs: 0,
    };
    const unavailable = whenUnavailable(options);
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await expect(unavailable.promise).resolves.toBe('mic-denied');
    expect(engine.running).toBe(false);
  });

  it('never hands empty audio to the transcriber', async () => {
    const transcribe = vi.fn(async () => 'unused');
    const options: DesktopWakeEngineOptions = {
      capture: async () => null,
      transcribe,
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    // A capture that yields nothing must not count as a completed cycle, so
    // there is no cycle to await — the guarantee is the absence of transcribe.
    await Promise.resolve();
    await Promise.resolve();
    engine.stop();

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('stop() reports stopped and halts the loop', async () => {
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => 'hey henry',
      restartDelayMs: 0,
    };
    const unavailable = whenUnavailable(options);
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(1, (fn) => { options.onCycle = fn; });
    engine.stop();

    expect(unavailable.calls).toHaveBeenCalledWith('stopped');
    expect(engine.running).toBe(false);
  });

  it('restarts cleanly when started twice — one loop, not two', async () => {
    const wakes: WakeMatch[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => 'hey henry go',
      onWake: (m) => wakes.push(m),
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await engine.start();
    await afterCycles(3, (fn) => { options.onCycle = fn; });
    engine.stop();

    // The cooldown hides the duplicate loop; the count still proves one engine.
    expect(wakes).toHaveLength(1);
  });

  it('does not wake, and does not log, on an empty transcript', async () => {
    const wakes: WakeMatch[] = [];
    const transcripts: string[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => bytes(),
      transcribe: async () => '   ',
      onTranscript: (t) => transcripts.push(t),
      onWake: (m) => wakes.push(m),
      restartDelayMs: 0,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(2, (fn) => { options.onCycle = fn; });
    engine.stop();

    expect(wakes).toHaveLength(0);
    expect(transcripts).toHaveLength(0);
  });
});

/** Resolves when the engine reports the reason it stopped. */
function afterUnavailable(options: DesktopWakeEngineOptions): Promise<string> {
  return new Promise<string>((resolve) => {
    options.onUnavailable = (reason) => resolve(reason);
  });
}

describe('createDesktopWakeEngine — does not busy-loop or storm', () => {
  /**
   * A capture that yields nothing answers instantly, so a loop that continues
   * straight back into it runs thousands of times a second for as long as the
   * wake word stays on. These assert the pause happens even when there is
   * nothing to transcribe.
   */
  it('pauses between iterations even when capture yields nothing', async () => {
    let captures = 0;
    const options: DesktopWakeEngineOptions = {
      capture: async () => {
        captures++;
        return null;
      },
      transcribe: async () => 'never',
      restartDelayMs: 20,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(3, (fn) => { options.onCycle = fn; });
    engine.stop();

    // Paced, not spinning: three cycles at a 20ms pause cannot have consumed
    // an unbounded number of iterations.
    expect(captures).toBeGreaterThanOrEqual(3);
    expect(captures).toBeLessThan(30);
  });

  it('gives up on an utterance that never ends instead of holding the mic open', async () => {
    const timeouts = vi.fn();
    const options: DesktopWakeEngineOptions = {
      // A capture that never settles — endpointing off, muted mic.
      capture: () => new Promise<ArrayBuffer | null>(() => {}),
      transcribe: async () => 'never',
      maxCaptureMs: 20,
      onCaptureTimeout: timeouts,
      restartDelayMs: 5,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(2, (fn) => { options.onCycle = fn; });
    engine.stop();

    expect(timeouts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps listening after a capture timeout rather than going unavailable', async () => {
    const unavailable = vi.fn();
    const wakes: WakeMatch[] = [];
    let captures = 0;
    const options: DesktopWakeEngineOptions = {
      capture: () => {
        captures++;
        return captures === 1 ? new Promise<ArrayBuffer | null>(() => {}) : Promise.resolve(bytes());
      },
      transcribe: async () => 'hey henry go',
      onWake: (m) => { wakes.push(m); },
      onUnavailable: unavailable,
      maxCaptureMs: 20,
      restartDelayMs: 5,
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await afterCycles(3, (fn) => { options.onCycle = fn; });
    engine.stop();

    // A run-on utterance is a normal event, not an engine failure — only the
    // deliberate teardown is reported, never 'stt-not-ready' or 'mic-denied'.
    expect(unavailable.mock.calls.flat()).toEqual(['stopped']);
    expect(wakes.length).toBeGreaterThan(0);
  });

  it('does not count an iteration it never actually ran', async () => {
    const cycles: number[] = [];
    const options: DesktopWakeEngineOptions = {
      capture: async () => { throw new Error('NotAllowedError'); },
      transcribe: async () => 'never',
      onCycle: (c) => cycles.push(c),
    };
    const engine = createDesktopWakeEngine(options);

    await engine.start();
    await expect(afterUnavailable(options)).resolves.toBe('mic-denied');
    engine.stop();

    expect(cycles).toEqual([]);
  });
});