/**
 * The point of this module is that TTS does not read "H.E.N.R.Y" as five
 * letters, so both behaviours are pinned: the styled form collapses, and a
 * name that carries nothing to say is not spoken at all.
 */
import { describe, it, expect } from 'vitest';
import { spokenAssistantName, withSpokenName } from './spokenName';

describe('spokenAssistantName', () => {
  it('collapses the styled brand so it is not spelled out', () => {
    expect(spokenAssistantName('H.E.N.R.Y')).toBe('');
    expect(spokenAssistantName('H.E.N.R.Y AI')).toBe('Henry AI');
    expect(spokenAssistantName('H. E. N. R. Y')).toBe('');
  });

  it('does not speak the default name — that is noise before every sentence', () => {
    expect(spokenAssistantName('Henry')).toBe('');
    expect(spokenAssistantName('  henry  ')).toBe('');
    expect(spokenAssistantName('HENRY')).toBe('');
  });

  it('does not speak reserved words', () => {
    for (const w of ['assistant', 'Assistant', 'ai', 'bot', 'sir', 'none', '']) {
      expect(spokenAssistantName(w), w).toBe('');
    }
  });

  it('speaks a real custom name', () => {
    expect(spokenAssistantName('JARVIS')).toBe('JARVIS');
    expect(spokenAssistantName('Ada')).toBe('Ada');
  });

  it('keeps the prefix short enough to say', () => {
    const long = 'An Extremely Long Assistant Name Indeed';
    expect(spokenAssistantName(long)!.length).toBeLessThanOrEqual(24);
  });

  it('handles nothing at all', () => {
    expect(spokenAssistantName(undefined)).toBe('');
    expect(spokenAssistantName(null)).toBe('');
  });
});

describe('withSpokenName', () => {
  // The greeting already substitutes the owner's name into its salutation, so
  // this must NOT prefix — doing so speaks the name twice.
  it('does not add a prefix, ever', () => {
    expect(withSpokenName('All systems online.', 'JARVIS')).toBe('All systems online.');
    expect(withSpokenName('Afternoon, JARVIS. Systems are online.', 'JARVIS'))
      .toBe('Afternoon, JARVIS. Systems are online.');
  });

  it('leaves the line untouched when there is no name', () => {
    expect(withSpokenName('All systems online.', 'Henry')).toBe('All systems online.');
    expect(withSpokenName('All systems online.', '')).toBe('All systems online.');
    expect(withSpokenName('All systems online.', undefined)).toBe('All systems online.');
  });

  it('strips the styled brand so TTS does not spell it out', () => {
    expect(withSpokenName('H.E.N.R.Y is ready.', '')).toBe('Henry is ready.');
    expect(withSpokenName('H.E.N.R.Y AI online.', undefined)).toBe('Henry AI online.');
  });
});