/**
 * Multimodal message content.
 *
 * The whole pipeline used to be `content: string`, which is why `file_load`
 * returning an image looked like support but was not — the base64 was stringified
 * into the tool text and no provider ever saw a picture. Paid 1.7.0 puts image
 * bytes into the model turn (`load_file`, tool-registry.ts:191-203) and does
 * not persist them in the transcript.
 *
 * Every provider spells an image differently, so the shape is converted at the
 * adapter rather than leaking into the app.
 *
 * ## The rule that matters
 *
 * If a provider cannot accept an image, the image is NEVER dropped silently.
 * The turn gets a text note saying an image is attached and could not be
 * shown. A model that quietly receives nothing will confidently answer about a
 * picture it never saw — which is the failure this whole card exists to stop.
 */

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; /** Original name, for the note below. */ name?: string };

/** Text and images together, or just text. */
export type MessageContent = string | MessagePart[];

export interface ContentMessage {
  role: string;
  content: MessageContent;
}

const IMAGE_NOTE = (p: Extract<MessagePart, { type: 'image' }>) =>
  `[An image is attached (${p.name ? `${p.name}, ` : ''}${p.mimeType}) but this model cannot view images, so its contents could not be shown.]`;

export function isImagePart(p: MessagePart): p is Extract<MessagePart, { type: 'image' }> {
  return p.type === 'image';
}

/** True when the message carries at least one image. */
export function hasImage(m: ContentMessage): boolean {
  return Array.isArray(m.content) && m.content.some(isImagePart);
}

/** Flatten to plain text, noting any image that will not survive. */
export function toText(content: MessageContent, opts: { noteImages?: boolean } = {}): string {
  if (typeof content === 'string') return content;
  const { noteImages = true } = opts;
  return content
    .map((p) => {
      if (p.type === 'text') return p.text;
      return noteImages ? IMAGE_NOTE(p) : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Split into the text to send and the images that survived. */
export function partition(content: MessageContent): {
  text: string;
  images: Extract<MessagePart, { type: 'image' }>[];
} {
  if (typeof content === 'string') return { text: content, images: [] };
  const images = content.filter(isImagePart);
  const text = content
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  return { text, images };
}

/** Build a message from text plus zero or more images. */
export function message(role: string, text: string, images: { mimeType: string; data: string; name?: string }[] = []): ContentMessage {
  if (images.length === 0) return { role, content: text };
  const parts: MessagePart[] = [{ type: 'text', text }];
  for (const img of images) parts.push({ type: 'image', ...img });
  return { role, content: parts };
}

export const dataUrl = (mimeType: string, base64: string) => `data:${mimeType};base64,${base64}`;