/**
 * Endpointing decides when the user is finished talking, so the logic that can
 * end a recording early (or never end one) is worth pinning down.
 *
 * WebAudio is stubbed so the detector can be driven with a known RMS signal
 * rather than a real microphone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_ENDPOINTING,
  sanitizeEndpointing,
  rmsThreshold,
  describeEndpointing,
  watchForEnd,
  type EndpointingSettings,
} from './voiceEndpointing';

class FakeAnalyser {
  rms = 0;
  fftSize = 2048;
  getFloatTimeDomainData(buf: Float32Array) {
    for (let i = 0; i < buf.length; i++) buf[i] = this.rms;
  }
}

let fakeAnalyser: FakeAnalyser | null = null;

beforeEach(() => {
  fakeAnalyser = new FakeAnalyser();
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return fakeAnalyser; }
    close() { return Promise.resolve(); }
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('settings', () => {
  it('defaults to paid-like values', () => {
    expect(DEFAULT_ENDPOINTING.silenceMs).toBe(900);
    expect(DEFAULT_ENDPOINTING.enabled).toBe(true);
  });

  it('clamps silence to the 400–5000 range paid uses', () => {
    expect(sanitizeEndpointing({ silenceMs: 10 }).silenceMs).toBe(400);
    expect(sanitizeEndpointing({ silenceMs: 99_999 }).silenceMs).toBe(5000);
    expect(sanitizeEndpointing({ silenceMs: 1500 }).silenceMs).toBe(1500);
  });

  it('clamps sensitivity into 0..1', () => {
    expect(sanitizeEndpointing({ sensitivity: -3 }).sensitivity).toBe(0);
    expect(sanitizeEndpointing({ sensitivity: 9 }).sensitivity).toBe(1);
    expect(sanitizeEndpointing({ sensitivity: 0.25 }).sensitivity).toBe(0.25);
  });

  it('falls back to defaults on rubbish input', () => {
    expect(sanitizeEndpointing(null)).toEqual(DEFAULT_ENDPOINTING);
    expect(sanitizeEndpointing('nope')).toEqual(DEFAULT_ENDPOINTING);
    expect(sanitizeEndpointing({})).toEqual(DEFAULT_ENDPOINTING);
  });

  it('maps sensitivity to a rising noise gate', () => {
    expect(rmsThreshold(0)).toBeLessThan(rmsThreshold(1));
    expect(rmsThreshold(0.5)).toBeGreaterThan(rmsThreshold(0.2));
  });

  it('describes itself in plain words', () => {
    expect(describeEndpointing({ ...DEFAULT_ENDPOINTING, enabled: false })).toContain('Off');
    expect(describeEndpointing({ ...DEFAULT_ENDPOINTING, silenceMs: 900 })).toContain('900ms');
  });
});

describe('detector', () => {
  const settings: EndpointingSettings = { silenceMs: 400, sensitivity: 0.5, maxUtteranceMs: 30_000, enabled: true };
  const stream = {} as MediaStream;

  it('does not end a recording that never heard speech', () => {
    const onEnd = vi.fn();
    watchForEnd(stream, settings, onEnd);
    fakeAnalyser!.rms = 0.001; // below the gate: silence only
    vi.advanceTimersByTime(3000);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('ends once speech is followed by enough silence', () => {
    const onEnd = vi.fn();
    watchForEnd(stream, settings, onEnd);

    fakeAnalyser!.rms = 0.05; // speech
    vi.advanceTimersByTime(200);
    fakeAnalyser!.rms = 0.001; // now the speaker stops
    vi.advanceTimersByTime(500); // past the 400ms silence window
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('restarts the silence window when speech resumes', () => {
    const onEnd = vi.fn();
    watchForEnd(stream, settings, onEnd);

    fakeAnalyser!.rms = 0.05;
    vi.advanceTimersByTime(200);
    fakeAnalyser!.rms = 0.001;
    vi.advanceTimersByTime(300); // 300ms of silence — not enough yet
    fakeAnalyser!.rms = 0.05;    // they started talking again
    vi.advanceTimersByTime(200);
    fakeAnalyser!.rms = 0.001;
    vi.advanceTimersByTime(300); // another 300ms — total since speech is not 400ms
    expect(onEnd).not.toHaveBeenCalled();

    fakeAnalyser!.rms = 0.001;
    vi.advanceTimersByTime(200); // now the window is satisfied
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('never waits forever, even with constant noise', () => {
    const onEnd = vi.fn();
    watchForEnd(stream, { ...settings, maxUtteranceMs: 2000 }, onEnd);
    fakeAnalyser!.rms = 0.9; // continuous, very loud noise
    vi.advanceTimersByTime(2500);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('fires once, not repeatedly', () => {
    const onEnd = vi.fn();
    watchForEnd(stream, { ...settings, maxUtteranceMs: 2000 }, onEnd);
    vi.advanceTimersByTime(6000);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('stop() detaches cleanly and prevents any later callback', () => {
    const onEnd = vi.fn();
    const h = watchForEnd(stream, settings, onEnd);
    fakeAnalyser!.rms = 0.05;
    vi.advanceTimersByTime(200);
    h.stop();
    fakeAnalyser!.rms = 0.001;
    vi.advanceTimersByTime(3000);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('falls back to a timeout when WebAudio is unavailable', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('AudioContext', undefined);
    const onEnd = vi.fn();
    watchForEnd(stream, { ...settings, maxUtteranceMs: 2000 }, onEnd);
    vi.advanceTimersByTime(2500);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});