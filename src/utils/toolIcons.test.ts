/**
 * Icon resolution is only worth having if it degrades rather than showing
 * broken images, and if the "is this actually an image?" test is honest.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeToolKey,
  iconCandidates,
  resolveToolIcon,
  nextIconInChain,
  sniffImageType,
  isPlaceholder,
  clearIconCache,
} from './toolIcons';

describe('normalisation', () => {
  it('collapses the ways a name gets written', () => {
    expect(normalizeToolKey('Google Calendar')).toBe('googlecalendar');
    expect(normalizeToolKey('google_calendar')).toBe('googlecalendar');
    expect(normalizeToolKey('google-calendar')).toBe('googlecalendar');
    expect(normalizeToolKey('  Gmail  ')).toBe('gmail');
  });
});

describe('candidate chain', () => {
  it('offers several sources for a known service', () => {
    const c = iconCandidates('Google Calendar');
    expect(c.length).toBeGreaterThan(1);
    expect(new Set(c.map((x) => x.via)).size).toBe(c.length);
  });

  it('prefers simple-icons when the service is in the table', () => {
    expect(iconCandidates('GitHub')[0].via).toBe('simpleicons');
  });

  it('still offers something for a service it has never heard of', () => {
    const c = iconCandidates('Totally Unknown Service');
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].url).toContain('iconify');
  });

  it('uses the real domain for the favicon steps', () => {
    const urls = iconCandidates('Discord').map((c) => c.url).join(' ');
    expect(urls).toContain('discord.com');
  });
});

describe('resolution', () => {
  it('caches so a re-render does not re-resolve', () => {
    clearIconCache();
    const first = resolveToolIcon('GitHub');
    expect(resolveToolIcon('github')).toBe(first);
  });

  it('never throws on an empty or odd name', () => {
    clearIconCache();
    expect(() => resolveToolIcon('')).not.toThrow();
    expect(() => resolveToolIcon('!!!')).not.toThrow();
    expect(() => resolveToolIcon('a'.repeat(500))).not.toThrow();
  });
});

describe('fallback chain walking', () => {
  it('advances to an untried source', () => {
    const all = iconCandidates('Google Drive').map((c) => c.url);
    const nxt = nextIconInChain('Google Drive', [all[0]]);
    expect(nxt).not.toBe(all[0]);
    expect(all).toContain(nxt);
  });

  it('returns null once everything has been tried', () => {
    const all = iconCandidates('Google Drive').map((c) => c.url);
    expect(nextIconInChain('Google Drive', all)).toBeNull();
  });
});

describe('magic-byte sniffing', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);

  it('recognises real image types', () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38))).toBe('image/gif');
    expect(sniffImageType(bytes(0x00, 0x00, 0x01, 0x00))).toBe('image/x-icon');
    expect(sniffImageType(bytes(0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
  });

  it('identifies an error page served where an image was expected', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>404');
    expect(sniffImageType(html)).toBe('text/html');
    expect(isPlaceholder(html)).toBe(true);
  });

  it('does not treat a real image as a placeholder', () => {
    expect(isPlaceholder(png)).toBe(false);
  });

  it('treats short or empty payloads as a placeholder rather than assuming success', () => {
    expect(isPlaceholder(new Uint8Array(0))).toBe(true);
    expect(isPlaceholder(bytes(1, 2, 3))).toBe(true);
  });
});