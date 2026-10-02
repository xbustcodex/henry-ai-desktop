/**
 * The whole point of this card: an attached image must reach the model, and a
 * file it cannot open must still be announced rather than silently dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildModelMessages,
  parseDataUrl,
  isImageAttachment,
  describeAttachments,
  MAX_IMAGES_PER_MESSAGE,
  type BuilderApi,
} from './messageBuilder';
import type { MessageAttachment } from '../types';

const att = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: 'a1',
  conversation_id: null,
  message_id: 'm1',
  file_name: 'photo.png',
  mime_type: 'image/png',
  byte_size: 100,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const api = (map: Record<string, string>): BuilderApi => ({
  getAttachment: vi.fn(async (id: string) => {
    const dataUrl = map[id];
    return dataUrl
      ? { ok: true, dataUrl, mimeType: 'image/png', fileName: id }
      : { ok: false };
  }),
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('helpers', () => {
  it('recognises image attachments by mime type', () => {
    expect(isImageAttachment(att({ mime_type: 'image/png' }))).toBe(true);
    expect(isImageAttachment(att({ mime_type: 'image/webp' }))).toBe(true);
    expect(isImageAttachment(att({ mime_type: 'application/pdf' }))).toBe(false);
    expect(isImageAttachment(att({ mime_type: null }))).toBe(false);
  });

  it('parses a data URL', () => {
    expect(parseDataUrl(PNG)).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(parseDataUrl('not-a-data-url')).toBeNull();
    expect(parseDataUrl('')).toBeNull();
  });

  it('names attachments the model cannot open', () => {
    expect(describeAttachments([att({ file_name: 'a.pdf', mime_type: 'application/pdf' })])).toContain('a.pdf');
    expect(describeAttachments([])).toBe('');
  });
});

describe('buildModelMessages', () => {
  it('leaves a plain text message untouched', async () => {
    const out = await buildModelMessages(
      [{ role: 'user', content: 'hello' }],
      new Map(),
      null,
      api({})
    );
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('attaches an image to the hydrated turn', async () => {
    const out = await buildModelMessages(
      [{ id: 'm1', role: 'user', content: 'what is in this picture?' }],
      new Map([['m1', [att()]]]),
      'm1',
      api({ a1: PNG })
    );
    const content = out[0].content as { type: string; text?: string }[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((p) => p.type === 'image')).toBe(true);
    expect(content.some((p) => p.type === 'text' && (p.text || '').includes('photo.png'))).toBe(true);
  });

  it('announces a non-image attachment instead of dropping it', async () => {
    const out = await buildModelMessages(
      [{ id: 'm1', role: 'user', content: 'read this' }],
      new Map([['m1', [att({ file_name: 'report.pdf', mime_type: 'application/pdf' })]]]),
      'm1',
      api({})
    );
    expect(typeof out[0].content).toBe('string');
    expect(String(out[0].content)).toContain('report.pdf');
  });

  it('hydrates only the turn it was asked to', async () => {
    const map = new Map([
      ['old', [att({ id: 'aOld' })]],
      ['new', [att({ id: 'aNew' })]],
    ]);
    const out = await buildModelMessages(
      [
        { id: 'old', role: 'user', content: 'earlier' },
        { id: 'a1', role: 'assistant', content: 'ok' },
        { id: 'new', role: 'user', content: 'now' },
      ],
      map,
      'new',
      api({ aOld: PNG, aNew: PNG })
    );
    expect(typeof out[0].content).toBe('string');
    expect(Array.isArray(out[2].content)).toBe(true);
  });

  it('survives an attachment that cannot be read', async () => {
    const out = await buildModelMessages(
      [{ id: 'm1', role: 'user', content: 'look' }],
      new Map([['m1', [att()]]]),
      'm1',
      api({})   // nothing resolvable
    );
    expect(typeof out[0].content).toBe('string');
    // The note still appears: the model is told a file is attached even though
    // its bytes could not be read.
    expect(String(out[0].content)).toContain('photo.png');
  });

  it('survives a getAttachment that throws', async () => {
    const throwing: BuilderApi = {
      getAttachment: vi.fn(async () => {
        throw new Error('ipc exploded');
      }),
    };
    const out = await buildModelMessages(
      [{ id: 'm1', role: 'user', content: 'look' }],
      new Map([['m1', [att()]]]),
      'm1',
      throwing
    );
    expect(typeof out[0].content).toBe('string');
  });

  it('caps how many images ride along with one turn', async () => {
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, (_, i) =>
      att({ id: `a${i}` })
    );
    const map: Record<string, string> = {};
    many.forEach((a) => (map[a.id] = PNG));
    const out = await buildModelMessages(
      [{ id: 'm1', role: 'user', content: 'all of these' }],
      new Map([['m1', many]]),
      'm1',
      api(map)
    );
    const content = out[0].content as { type: string }[];
    expect(content.filter((p) => p.type === 'image').length).toBe(MAX_IMAGES_PER_MESSAGE);
  });

  it('skips an oversized image rather than sending it', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(20 * 1024 * 1024)}`;
    const out = await buildModelMessages(
      [{ id: 'm1', role: 'user', content: 'big' }],
      new Map([['m1', [att()]]]),
      'm1',
      api({ a1: huge })
    );
    expect(typeof out[0].content).toBe('string');
  });

  it('never puts image bytes into the plain-text form', async () => {
    const out = await buildModelMessages(
      [{ id: 'plain', role: 'user', content: 'plain' }],
      new Map([['other', [att()]]]),
      'other',
      api({ a1: PNG })
    );
    // 'other' is not a role, so nothing hydrates and the text stays clean.
    expect(typeof out[0].content).toBe('string');
  });
});