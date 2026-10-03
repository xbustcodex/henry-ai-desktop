import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_LOCAL_VOICE,
  INSTALLABLE_VOICES,
  lengthScaleForRate,
  getLocalTtsStatus,
  listLocalVoices,
  detectPiperBinary,
  synthesizeLocal,
} from './localTts';

/**
 * Row 6.2 recorded `engine: local` with `availableEngines: [web-speech]` — an
 * engine advertised but not reachable. These tests exist so that cannot come
 * back: the status must report `ready: false` with actionable blockers when
 * nothing is installed, and must never claim readiness optimistically.
 *
 * `electron`'s `app.getPath` is stubbed to a temp dir, and no real download or
 * synthesis is attempted.
 */

const userData = { value: '' };

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData.value : '/tmp') },
  ipcMain: { handle: vi.fn() },
}));

const tempDirs: string[] = [];

beforeEach(async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  userData.value = fs.mkdtempSync(path.join(os.tmpdir(), 'localtts-test-'));
  tempDirs.push(userData.value);
  // Fresh detection on every test — the module caches the binary probe.
  detectPiperBinary(true);
});

afterEach(async () => {
  const fs = await import('node:fs');
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

/** Write a plausible voice model + its config into the temp userData dir. */
async function installModel(voiceId = DEFAULT_LOCAL_VOICE): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(userData.value, 'voice-models');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${voiceId}.onnx`), Buffer.alloc(6 * 1024 * 1024, 1));
  fs.writeFileSync(
    path.join(dir, `${voiceId}.onnx.json`),
    JSON.stringify({ audio: { sample_rate: 22050 }, phoneme_map: { '@': 'ə' } }),
  );
}

describe('getLocalTtsStatus — honest when nothing is installed', () => {
  it('is not ready and says exactly what is missing', () => {
    const status = getLocalTtsStatus();
    expect(status.engine).toBe('piper');
    expect(status.ready).toBe(false);
    expect(status.modelPresent).toBe(false);
    expect(status.blockers).toHaveLength(2);
    expect(status.blockers.join(' ')).toMatch(/Piper is not installed/);
    expect(status.blockers.join(' ')).toMatch(/is not downloaded/);
    expect(status.installHint).toBeTruthy();
  });

  it('never reports ready from a partially-present install', async () => {
    await installModel();
    // Model but no binary — still not ready, and only one blocker remains.
    const status = getLocalTtsStatus();
    expect(status.modelPresent).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.blockers).toHaveLength(1);
    expect(status.blockers[0]).toMatch(/Piper is not installed/);
  });

  it('treats an onnx without its json config as absent', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(userData.value, 'voice-models');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${DEFAULT_LOCAL_VOICE}.onnx`), Buffer.alloc(6 * 1024 * 1024, 1));
    // No .onnx.json — piper cannot load a weights file without its config.
    expect(getLocalTtsStatus().modelPresent).toBe(false);
  });

  it('treats a truncated model as absent rather than as a model', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(userData.value, 'voice-models');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${DEFAULT_LOCAL_VOICE}.onnx`), Buffer.alloc(1024, 1));
    fs.writeFileSync(path.join(dir, `${DEFAULT_LOCAL_VOICE}.onnx.json`), '{}');
    expect(getLocalTtsStatus().modelPresent).toBe(false);
  });
});

describe('voice catalogue', () => {
  it('offers voices and marks exactly what is on disk', async () => {
    await installModel('en_US-amy-medium');
    const voices = listLocalVoices();
    const amy = voices.find((v) => v.id === 'en_US-amy-medium');
    const other = voices.find((v) => v.id !== 'en_US-amy-medium');

    expect(amy?.installed).toBe(true);
    expect(amy?.sizeBytes).toBe(6 * 1024 * 1024);
    expect(other?.installed).toBe(false);
    expect(other?.sizeBytes).toBe(0);
  });

  it('every catalogue voice has an id, a language and a locale in its id', () => {
    expect(INSTALLABLE_VOICES.length).toBeGreaterThan(0);
    for (const v of INSTALLABLE_VOICES) {
      expect(v.id).toMatch(/^[a-z]{2}_[A-Z]{2}-[a-z]+-(low|medium|high)$/);
      expect(v.language).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it('the default voice is one of the catalogue entries', () => {
    expect(INSTALLABLE_VOICES.some((v) => v.id === DEFAULT_LOCAL_VOICE)).toBe(true);
  });
});

describe('lengthScaleForRate — the wpm bridge', () => {
  it('is neutral at 200 wpm', () => {
    expect(lengthScaleForRate(200)).toBe('1.000');
  });

  it('is a duration multiplier: faster rate → smaller scale', () => {
    expect(Number(lengthScaleForRate(300))).toBeLessThan(Number(lengthScaleForRate(100)));
  });

  it('falls back to neutral for out-of-range or non-numeric rates', () => {
    for (const bad of [0, 10, 10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lengthScaleForRate(bad)).toBe('1.000');
    }
  });
});

describe('synthesizeLocal — refuses rather than faking', () => {
  it('rejects with a specific, actionable error when nothing is installed', async () => {
    await expect(synthesizeLocal('hello')).rejects.toThrow(/Piper is not installed/);
    await expect(synthesizeLocal('hello')).rejects.toThrow(/is not downloaded/);
  });

  it('names the voice that is missing when a specific voice is requested', async () => {
    await installModel(DEFAULT_LOCAL_VOICE);
    await expect(synthesizeLocal('hello', { voice: 'en_GB-alba-medium' })).rejects.toThrow(
      /en_GB-alba-medium\.onnx is not downloaded/,
    );
  });

  it('leaves no scratch directory behind when it refuses', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    await expect(synthesizeLocal('hello')).rejects.toThrow();
    // It must bail before creating temp space, not after.
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('henry-tts-'))).toEqual([]);
  });
});