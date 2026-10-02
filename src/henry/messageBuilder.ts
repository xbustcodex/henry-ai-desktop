/**
 * Build model messages, pulling in attached images.
 *
 * An attachment used to reach the model as nothing at all — the file was stored,
 * bound to the message, rendered as a chip, and the model saw only the sentence
 * "I've attached 1 file: photo.png". Asking about the picture produced a
 * confident answer about something it had never seen.
 *
 * Images are now read back and attached to the turn. Non-image attachments are
 * named in the text so the model at least knows a file is there rather than
 * silently having one dropped.
 *
 * Bytes are never persisted into the transcript: history rebuilds messages from
 * the DB, and only the latest turn carries images.
 */
import type { MessageAttachment } from '../types';

export interface ContentPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image';
  mimeType: string;
  data: string;
  name?: string;
}

export interface BuildableMessage {
  role: 'system' | 'user' | 'assistant';
  /** May already carry parts; they are preserved. */
  content: string | (ContentPart | ImagePart)[];
  /** Database id, so attachments are matched to THIS message and no other. */
  id?: string;
}

const IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp|bmp|avif)$/i;

export function isImageAttachment(a: MessageAttachment): boolean {
  return IMAGE_MIME.test(String(a.mime_type || ''));
}

/** Split a `data:<mime>;base64,<payload>` URL. */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(url || '').trim());
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/**
 * One-line note for attachments the model cannot open, so they are announced
 * rather than silently dropped.
 */
export function describeAttachments(attachments: MessageAttachment[]): string {
  const names = attachments.map((a) => a.file_name);
  if (names.length === 0) return '';
  return names.length === 1
    ? `[Attached: ${names[0]}]`
    : `[Attached: ${names.join(', ')}]`;
}

export interface BuilderApi {
  getAttachment(id: string): Promise<{ ok: boolean; dataUrl?: string; mimeType?: string; fileName?: string }>;
}

/**
 * Flatten a message content for any consumer that is still text-only.
 *
 * Images become a short note rather than base64: a string-typed consumer must
 * never be handed megabytes of an image it cannot read.
 */
export function toPlainText(content: string | (ContentPart | ImagePart)[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => (p.type === 'text' ? p.text : `[image: ${p.name ?? p.mimeType}]`))
    .join('\n');
}

/** Cap per image, and on the number of images per turn. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * Turn stored messages plus their attachments into model messages.
 *
 * `withImages` should be the id of the one message to hydrate — normally the
 * newest user turn. Everything else stays text.
 */
export async function buildModelMessages(
  messages: BuildableMessage[],
  attachmentsByMessage: Map<string, MessageAttachment[]>,
  withImagesFor: string | null,
  api: BuilderApi
): Promise<{ role: string; content: string | (ContentPart | ImagePart)[] }[]> {
  const out: { role: string; content: string | (ContentPart | ImagePart)[] }[] = [];

  for (const m of messages) {
    const parts: (ContentPart | ImagePart)[] = [];
    let attachmentNote = '';
    const isTarget = m.role === 'user' && withImagesFor != null && m.id === withImagesFor;
    if (isTarget) {
      const list = attachmentsByMessage.get(withImagesFor) ?? [];
      const images = list.filter(isImageAttachment).slice(0, MAX_IMAGES_PER_MESSAGE);
      for (const img of images) {
        try {
          const got = await api.getAttachment(img.id);
          if (!got?.ok || !got.dataUrl) continue;
          const parsed = parseDataUrl(got.dataUrl);
          if (!parsed) continue;
          // Base64 inflates ~4/3; guard on the decoded estimate.
          if (parsed.data.length * 0.75 > MAX_IMAGE_BYTES) continue;
          parts.push({ type: 'image', mimeType: parsed.mimeType, data: parsed.data, name: img.file_name });
        } catch {
          // A single unreadable attachment must not lose the whole turn.
        }
      }
      // Only an actual image justifies the parts shape. A note on its own is
      // folded into the plain string, so providers and the rest of the pipeline
      // keep seeing the simplest valid form.
      attachmentNote = describeAttachments(list);
    }

    const images = parts.filter((p): p is ImagePart => p.type === 'image');
    const text = attachmentNote ? `${m.content}\n${attachmentNote}` : m.content;

    if (images.length === 0) {
      out.push({ role: m.role, content: text });
    } else {
      out.push({
        role: m.role,
        content: [{ type: 'text', text: text as string }, ...images],
      });
    }
  }
  return out;
}
