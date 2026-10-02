/**
 * What an Ollama model can actually do.
 *
 * Ollama answers this itself: POST /api/show returns a `capabilities` array, and
 * "vision" is in it only for models that accept images. That is authoritative,
 * whereas guessing from a model name is not — `llama3.2-vision` is a different
 * model from `llama3.2:3b`.
 *
 * Why this matters: sending an image to a text-only model does not fail. Ollama
 * accepts the request, drops the image, and the model answers as though it had
 * looked. Observed live: llama3.2:3b describing a blue disc as "a square of
 * yellow". A hallucinated description is worse than a clear refusal.
 */

export interface OllamaShowResponse {
  capabilities?: string[];
}

export type OllamaFetcher = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** One capability lookup per model per base URL; it cannot change at runtime. */
const cache = new Map<string, boolean>();

export function clearOllamaCapabilityCache(): void {
  cache.clear();
}

export async function ollamaSupportsVision(
  base: string,
  model: string,
  fetchImpl?: OllamaFetcher
): Promise<boolean> {
  const key = `${base}|${model}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const doFetch = (fetchImpl ?? (globalThis.fetch as unknown as OllamaFetcher));
  let supports = false;
  try {
    const res = await doFetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: (typeof AbortSignal !== 'undefined' ? AbortSignal : undefined)?.timeout?.(6000),
    });
    if (res?.ok) {
      const data = (await res.json()) as OllamaShowResponse;
      supports = Array.isArray(data?.capabilities) && data.capabilities.includes('vision');
    }
  } catch {
    // Could not determine. Staying optimistic means Ollama's own 400 surfaces,
    // which is clearer than Henry silently pretending the model can see.
    return true;
  }
  cache.set(key, supports);
  return supports;
}

/**
 * What the model is told when it cannot see an attached image.
 *
 * It must be explicit and must forbid guessing: the failure being prevented is
 * a model confidently describing a picture it never received.
 */
export const NO_VISION_NOTE =
  '[An image is attached but this model does not support vision, so its contents cannot be shown. ' +
  'Do not describe or guess at the image; say that you cannot view it.]';

/** Build one Ollama chat message, honouring what the model can actually see. */
export function buildOllamaMessage(
  role: string,
  content: string,
  images: string[],
  canSee: boolean
): { role: string; content: string; images?: string[] } {
  if (images.length === 0) return { role, content };
  if (!canSee) return { role, content: `${content}\n${NO_VISION_NOTE}` };
  return { role, content, images };
}
