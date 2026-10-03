import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_ELEVEN_VOICE,
  getElevenLabsStatus,
  listElevenVoices,
  type ElevenStatus,
} from './elevenLabs';

/**
 * Row 6.9 (ElevenLabs) is credential-blocked on this machine — there is no key,
 * so it cannot be live-verified. These tests pin the behaviour that matters
 * precisely because of that: with no credential the adapter must say so
 * explicitly and must never invent a voice or claim readiness; with a
 * credential it must reflect what the account actually returned.
 *
 * `fetch` is stubbed, so nothing here touches the network. The key store is
 * stubbed too, so no real key is read and none is ever written down.
 */

vi.mock('../ipc/_keyStorage', () => ({
  decryptKey: (value: string) => (value === 'encrypted:k' ? 'k' : ''),
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(response: Response | Error): void {
  globalThis.fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A db stub whose providers row holds `value`. */
const dbWith = (value: string) =>
  ({ prepare: () => ({ get: () => (value ? { api_key: value } : undefined) }) }) as never;

describe('getElevenLabsStatus — no credential', () => {
  it('is a definite, explainable answer rather than an error', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const status: ElevenStatus = await getElevenLabsStatus(dbWith(''));

    expect(status.available).toBe(false);
    expect(status.keyPresent).toBe(false);
    expect(status.reason).toBe('no-credential');
    expect(status.voiceCount).toBe(0);
    expect(status.detail).toMatch(/No ElevenLabs API key is saved/);
    expect(status.detail).toMatch(/Add a key/);
    // Crucially: it must not reach for the network it has no credential for.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an undecryptable stored key as no credential', async () => {
    // A row that decrypts to '' is unusable, and saying "saved" would be a lie.
    const status = await getElevenLabsStatus(dbWith('garbage-not-encrypted'));
    expect(status.keyPresent).toBe(false);
    expect(status.reason).toBe('no-credential');
  });

  it('never leaks a key-shaped value into the detail string', async () => {
    const status = await getElevenLabsStatus(dbWith(''));
    expect(status.detail).not.toMatch(/[A-Za-z0-9]{20,}/);
  });
});

describe('listElevenVoices', () => {
  it('maps the account voice list', async () => {
    stubFetch(
      json({
        voices: [
          { voice_id: 'abc', name: 'Rachel', category: 'premade' },
          { voice_id: 'def', name: 'Adam', category: 'cloned' },
        ],
      }),
    );
    await expect(listElevenVoices('key')).resolves.toEqual([
      { voiceId: 'abc', name: 'Rachel', category: 'premade' },
      { voiceId: 'def', name: 'Adam', category: 'cloned' },
    ]);
  });

  it('drops entries with no voice_id rather than emitting a blank option', async () => {
    stubFetch(json({ voices: [{ voice_id: 'abc', name: 'Rachel' }, { name: 'Nameless' }] }));
    const voices = await listElevenVoices('key');
    expect(voices).toHaveLength(1);
    expect(voices[0].voiceId).toBe('abc');
  });

  it('falls back to the id when a voice has no name', async () => {
    stubFetch(json({ voices: [{ voice_id: 'abc' }] }));
    expect((await listElevenVoices('key'))[0].name).toBe('abc');
  });

  it('sends the key as a header, never in the URL', async () => {
    const spy = vi.fn(async () => json({ voices: [] }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await listElevenVoices('super-secret-key');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/voices');
    expect(url).not.toContain('super-secret-key');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('super-secret-key');
  });

  it('rejects on a non-2xx rather than returning an empty list', async () => {
    // An empty list and an unreachable API look identical downstream; only one
    // of them means "this account has no voices".
    stubFetch(new Response('nope', { status: 401 }));
    await expect(listElevenVoices('bad-key')).rejects.toThrow(/ElevenLabs 401/);
  });

  it('propagates a network failure', async () => {
    stubFetch(new Error('getaddrinfo ENOTFOUND api.elevenlabs.io'));
    await expect(listElevenVoices('key')).rejects.toThrow(/ENOTFOUND/);
  });
});

describe('getElevenLabsStatus — with a credential', () => {
  it('reports available only after the account actually answers', async () => {
    stubFetch(json({ voices: [{ voice_id: 'a' }, { voice_id: 'b' }] }));
    const status = await getElevenLabsStatus(dbWith('encrypted:k'));

    expect(status.available).toBe(true);
    expect(status.keyPresent).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.voiceCount).toBe(2);
    expect(status.detail).toMatch(/2 voices/);
  });

  it('distinguishes a rejected key from a network failure', async () => {
    stubFetch(new Response('bad', { status: 401 }));
    const status = await getElevenLabsStatus(dbWith('encrypted:k'));
    expect(status.available).toBe(false);
    expect(status.keyPresent).toBe(true);
    expect(status.reason).toBe('key-rejected');
    expect(status.detail).toMatch(/rejected/);
  });

  it('reports a network problem without claiming the key is bad', async () => {
    stubFetch(new Error('getaddrinfo ENOTFOUND'));
    const status = await getElevenLabsStatus(dbWith('encrypted:k'));
    expect(status.reason).toBe('network');
    expect(status.keyPresent).toBe(true);
    expect(status.detail).not.toMatch(/rejected/);
  });

  it('exports the documented default voice id', () => {
    expect(DEFAULT_ELEVEN_VOICE).toBe('21m00Tcm4TlvDq8ikWAM');
  });
});