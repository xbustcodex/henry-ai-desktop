import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The chat voice path calls `transcribeLocal(blob)` FIRST and only falls back
 * to cloud transcription if it throws (ChatInput.tsx `transcribeAudio`). That
 * makes this function the contract the chat UI depends on, and it is the one
 * thing standing between "local Whisper is wired" and "local Whisper exists but
 * nothing calls it".
 *
 * The IPC bridge is stubbed so these stay deterministic and machine-independent;
 * the real ffmpeg → whisper-cli round trip is proven separately by a throwaway
 * smoke run, not by a test that would fail wherever whisper is not installed.
 *
 * This suite is deliberately pure-Node — `vitest.config.ts` sets
 * `environment: 'node'` and the project ships no jsdom — so the two globals the
 * module touches are provided by hand rather than by a DOM.
 */
type Bridge = {
  voiceTranscribe?: (audio: ArrayBuffer) => Promise<
    { ok: boolean; result?: { text: string }; error?: string }
  >;
};

const bridge: Bridge = {};
(globalThis as unknown as { window: { henryAPI: Bridge } }).window = { henryAPI: bridge };
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
} as unknown as Storage;

const { transcribeLocal, useVoiceStore } = await import('./voice');
function installBridge(transcribe: NonNullable<Bridge['voiceTranscribe']>): void {
  bridge.voiceTranscribe = transcribe;
}

function removeBridge(): void {
  bridge.voiceTranscribe = undefined;
}

const someAudio = (): Blob => new Blob([new Uint8Array(2048)], { type: 'audio/webm' });

beforeEach(() => {
  useVoiceStore.getState().setState('idle');
});

describe('transcribeLocal — the path the chat input prefers', () => {
  it('returns the transcript the local engine produced', async () => {
    installBridge(async () => ({ ok: true, result: { text: 'what is the weather' } }));
    await expect(transcribeLocal(someAudio())).resolves.toBe('what is the weather');
  });

  it('returns an empty string for silence rather than pretending it failed', async () => {
    // Whisper strips [BLANK_AUDIO]/[SILENCE] markers, so quiet audio comes back
    // as ''. That empty result is what lets the caller decide to fall back;
    // throwing here would misreport silence as a broken engine.
    installBridge(async () => ({ ok: true, result: { text: '' } }));
    await expect(transcribeLocal(someAudio())).resolves.toBe('');
  });

  it('surfaces the engine error verbatim, which is what drives the fallback', async () => {
    installBridge(async () => ({
      ok: false,
      error: 'whisper-cli not installed — run voice setup first.',
    }));
    // ChatInput catches this and moves to the cloud path, so the message has to
    // survive intact rather than being flattened to a generic failure.
    await expect(transcribeLocal(someAudio())).rejects.toThrow(
      'whisper-cli not installed — run voice setup first.',
    );
  });

  it('reports transcribing while working and idle afterwards, even on failure', async () => {
    const seen: string[] = [];
    installBridge(async () => {
      seen.push(useVoiceStore.getState().state);
      return { ok: true, result: { text: 'hi' } };
    });
    await transcribeLocal(someAudio());
    expect(seen).toEqual(['transcribing']);
    expect(useVoiceStore.getState().state).toBe('idle');

    installBridge(async () => ({ ok: false, error: 'nope' }));
    await expect(transcribeLocal(someAudio())).rejects.toThrow();
    // A failure must not strand the UI in "transcribing" forever.
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('hands the raw bytes across, not an empty buffer', async () => {
    let received: ArrayBuffer | null = null;
    installBridge(async (audio) => {
      received = audio;
      return { ok: true, result: { text: 'ok' } };
    });
    const blob = new Blob([new Uint8Array(4096)], { type: 'audio/webm' });
    await transcribeLocal(blob);
    expect(received).not.toBeNull();
    expect((received as unknown as ArrayBuffer).byteLength).toBe(4096);
  });

  it('fails clearly outside the desktop app instead of silently doing nothing', async () => {
    removeBridge();
    await expect(transcribeLocal(someAudio())).rejects.toThrow(
      /Local transcription needs the desktop app/,
    );
  });
});