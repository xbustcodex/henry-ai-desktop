import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSttStatus, sttModelPath, sttModelPresent } from './stt';

/**
 * Row 6.3: local Whisper was reported as `{binaryPresent:false,
 * modelPresent:false, ready:false}` with nothing to act on — the browser
 * engine silently carried speech while the local engine was simply absent.
 *
 * These pin the honest shape: when it is not ready, the status must say exactly
 * what is missing and how to get it. `ready: false` on its own is what made the
 * row read as a mystery.
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
  userData.value = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-status-test-'));
  tempDirs.push(userData.value);
});

afterEach(async () => {
  const fs = await import('node:fs');
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});
describe('getSttStatus — an absent local engine', () => {
  it('is not ready and names the missing model', () => {
    const status = getSttStatus();
    expect(status.ready).toBe(false);
    expect(status.modelPresent).toBe(false);
    expect(status.blockers.join(' ')).toMatch(/not downloaded/);
    expect(status.blockers.join(' ')).toContain(sttModelPath());
  });

  it('offers the platform install command so a binary gap is actionable', () => {
    // Every supported desktop platform has a hint; the empty string must never
    // be what a user is left with.
    if (['darwin', 'linux', 'win32'].includes(process.platform)) {
      expect(getSttStatus().installHint).toMatch(/whisper-cpp|ggml\.whisper/);
    }
  });

  it('reports a binary gap as a blocker only when the binary really is absent', () => {
    // Host-independent: whisper-cpp may or may not be installed on the machine
    // running this, and the status must track reality either way.
    const status = getSttStatus();
    const hasBinaryBlocker = status.blockers.some((b) => /whisper-cpp is not installed/.test(b));
    expect(hasBinaryBlocker).toBe(!status.binaryPresent);
  });

  it('drops the model blocker once a full-size model is on disk', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(userData.value, 'voice-models'), { recursive: true });
    // A plausible full-size ggml model, so the size check passes.
    fs.writeFileSync(sttModelPath(), Buffer.alloc(141 * 1024 * 1024, 1));

    expect(sttModelPresent()).toBe(true);
    const status = getSttStatus();
    expect(status.modelPresent).toBe(true);
    expect(status.blockers.some((b) => /not downloaded/.test(b))).toBe(false);
    // Every remaining blocker is the binary, and only the binary.
    expect(status.blockers.every((b) => /whisper-cpp is not installed/.test(b))).toBe(true);
    // Ready exactly when the binary is there too — never claimed from the
    // model alone.
    expect(status.ready).toBe(status.binaryPresent);
  });

  it('rejects a truncated model rather than counting it as present', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(userData.value, 'voice-models'), { recursive: true });
    // An interrupted download leaves something here; a mere existence check
    // would treat it as a model and whisper would then fail to load it.
    fs.writeFileSync(sttModelPath(), Buffer.alloc(1024, 1));
    expect(sttModelPresent()).toBe(false);
    expect(getSttStatus().modelPresent).toBe(false);
    expect(getSttStatus().blockers.some((b) => /not downloaded/.test(b))).toBe(true);
  });

  it('every blocker states a real absence rather than a generic warning', () => {
    const status = getSttStatus();
    for (const blocker of status.blockers) {
      const explainsBinary = !status.binaryPresent && /whisper-cpp is not installed/.test(blocker);
      const explainsModel = !status.modelPresent && /not downloaded/.test(blocker);
      expect(explainsBinary || explainsModel).toBe(true);
    }
  });
});