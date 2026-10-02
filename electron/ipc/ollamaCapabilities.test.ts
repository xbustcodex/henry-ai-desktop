/**
 * The behaviour under test is not "does the image get sent" — it is "does the
 * model get told the truth about what it can see".
 *
 * Before the capability check, a text-only model accepted an image request,
 * ignored the bytes, and described a blue disc as "a square of yellow".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ollamaSupportsVision,
  buildOllamaMessage,
  clearOllamaCapabilityCache,
  NO_VISION_NOTE,
  type OllamaFetcher,
} from './ollamaCapabilities';

/** Capability lists exactly as Ollama returns them. */
const CAPS: Record<string, string[]> = {
  moondream: ['completion', 'vision'],
  'llava:7b': ['completion', 'vision'],
  'llama3.2:3b': ['completion', 'tools'],
  'qwen2.5-coder:7b': ['completion', 'tools'],
};

function fakeOllama(): { fetchImpl: OllamaFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: OllamaFetcher = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/api/show')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      const caps = CAPS[body.model];
      if (!caps) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ capabilities: caps }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

beforeEach(() => clearOllamaCapabilityCache());

describe('capability lookup', () => {
  it('reports vision for a model Ollama says has it', async () => {
    const { fetchImpl } = fakeOllama();
    expect(await ollamaSupportsVision('http://h:11434', 'moondream', fetchImpl)).toBe(true);
  });

  it('reports no vision for a text-only model', async () => {
    const { fetchImpl } = fakeOllama();
    expect(await ollamaSupportsVision('http://h:11434', 'llama3.2:3b', fetchImpl)).toBe(false);
  });

  it('distinguishes sibling models rather than guessing from the family name', async () => {
    const { fetchImpl } = fakeOllama();
    // Same family, different capability — which is why a name check is wrong.
    expect(await ollamaSupportsVision('http://h:11434', 'llava:7b', fetchImpl)).toBe(true);
    expect(await ollamaSupportsVision('http://h:11434', 'llama3.2:3b', fetchImpl)).toBe(false);
  });

  it('asks once per model and caches', async () => {
    const { fetchImpl, calls } = fakeOllama();
    await ollamaSupportsVision('http://h:11434', 'moondream', fetchImpl);
    await ollamaSupportsVision('http://h:11434', 'moondream', fetchImpl);
    expect(calls).toHaveLength(1);
  });

  it('treats an unknown model as no-vision rather than inventing capability', async () => {
    const { fetchImpl } = fakeOllama();
    expect(await ollamaSupportsVision('http://h:11434', 'nope:1b', fetchImpl)).toBe(false);
  });

  it('stays optimistic when the lookup itself fails, so Ollama\'s own 400 surfaces', async () => {
    const boom: OllamaFetcher = async () => {
      throw new Error('ollama unreachable');
    };
    expect(await ollamaSupportsVision('http://h:11434', 'moondream', boom)).toBe(true);
  });
});

describe('what the model is actually sent', () => {
  it('sends the image when the model can see', () => {
    const m = buildOllamaMessage('user', 'what is this?', ['BASE64'], true);
    expect(m.images).toEqual(['BASE64']);
    expect(m.content).toBe('what is this?');
  });

  it('does NOT send image bytes to a model that cannot see', () => {
    const m = buildOllamaMessage('user', 'what is this?', ['BASE64'], false);
    expect(m.images).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('BASE64');
  });

  it('tells the model it cannot view the image', () => {
    const m = buildOllamaMessage('user', 'what is this?', ['BASE64'], false);
    expect(m.content).toContain('does not support vision');
  });

  it('forbids guessing, because guessing is the failure being prevented', () => {
    expect(NO_VISION_NOTE).toMatch(/do not describe or guess/i);
  });

  it('keeps the user text so the turn is not lost', () => {
    const m = buildOllamaMessage('user', 'what is this?', ['BASE64'], false);
    expect(m.content).toContain('what is this?');
    expect(m.content).toContain(NO_VISION_NOTE);
  });

  it('leaves a plain text message untouched either way', () => {
    expect(buildOllamaMessage('user', 'hello', [], false)).toEqual({ role: 'user', content: 'hello' });
    expect(buildOllamaMessage('user', 'hello', [], true)).toEqual({ role: 'user', content: 'hello' });
  });
});
