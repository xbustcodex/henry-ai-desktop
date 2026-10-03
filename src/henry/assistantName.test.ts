/**
 * The resolver itself — the pure part.
 *
 * The WIRING is proved in `electron/voice/greetingAssistantNameWiring.test.ts`,
 * which drives the real `settings:save` and `voice:greeting` IPC handlers.
 * That test failed against the shipped code while this one passed, which is
 * exactly why both exist: this file pins the resolution RULES (precedence,
 * normalisation, the legacy fallback), and the wiring file pins that the rules
 * are actually reached.
 */
import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_NAME_SETTING_KEY,
  DEFAULT_ASSISTANT_NAME,
  MAX_ASSISTANT_NAME_LENGTH,
  assistantNameFrom,
  normalizeAssistantName,
} from './assistantName';
import { DEFAULT_WAKE_WORD, patternsForWakeWord, matchWakeWord } from './wakeWordDesktop';

describe('normalizeAssistantName', () => {
  it('falls back to Henry for nothing, empty and whitespace', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n']) {
      expect(normalizeAssistantName(raw), JSON.stringify(raw)).toBe(DEFAULT_ASSISTANT_NAME);
      expect(normalizeAssistantName(raw)).toBe('Henry');
    }
  });

  it('trims and collapses internal whitespace', () => {
    expect(normalizeAssistantName('  Zorblax  ')).toBe('Zorblax');
    expect(normalizeAssistantName('Zor  blax')).toBe('Zor blax');
    expect(normalizeAssistantName('Zor\n\tblax')).toBe('Zor blax');
  });

  it('caps the length, so a paste cannot produce an unspeakable name', () => {
    expect(normalizeAssistantName('x'.repeat(80))).toHaveLength(MAX_ASSISTANT_NAME_LENGTH);
    // Truncation must not be able to leave a name ending in whitespace: the
    // slice is re-trimmed, so the cap yields a clean, speakable name.
    const truncated = normalizeAssistantName(`${'ab'.repeat(MAX_ASSISTANT_NAME_LENGTH)} tail`);
    expect(truncated).toHaveLength(MAX_ASSISTANT_NAME_LENGTH);
    expect(truncated).not.toMatch(/\s$/);
  });

  it('preserves case — a name is a name, not a slug', () => {
    expect(normalizeAssistantName('JARVIS')).toBe('JARVIS');
    expect(normalizeAssistantName('zorblax')).toBe('zorblax');
  });
});

describe('assistantNameFrom — precedence', () => {
  it('reads the setting, which is the authoritative key', () => {
    expect(assistantNameFrom({ [ASSISTANT_NAME_SETTING_KEY]: 'Zorblax' })).toBe('Zorblax');
  });

  it('defaults to Henry on an unconfigured install', () => {
    expect(assistantNameFrom({})).toBe('Henry');
    expect(assistantNameFrom(undefined)).toBe('Henry');
    expect(assistantNameFrom(null)).toBe('Henry');
  });

  it('treats a blank setting as unset, so the field can be cleared', () => {
    expect(assistantNameFrom({ [ASSISTANT_NAME_SETTING_KEY]: '' })).toBe('Henry');
    expect(assistantNameFrom({ [ASSISTANT_NAME_SETTING_KEY]: '   ' })).toBe('Henry');
  });

  it('falls back to a name already stored in the legacy orb blob', () => {
    // Older builds kept the name inside `creator_orb`. Reading it is what stops
    // an existing install from silently reverting to "Henry".
    const orb = JSON.stringify({ skin: 'neon', speed: 'default', accent: '#5cdcff', assistantName: 'Zorblax' });
    expect(assistantNameFrom({ creator_orb: orb })).toBe('Zorblax');
  });

  it('the setting wins over the legacy blob', () => {
    const orb = JSON.stringify({ assistantName: 'Stale' });
    expect(assistantNameFrom({ [ASSISTANT_NAME_SETTING_KEY]: 'Zorblax', creator_orb: orb })).toBe(
      'Zorblax',
    );
  });

  it('survives a corrupt or non-JSON orb blob without throwing', () => {
    // Overwriting `creator_orb` with a bare string is exactly the mistake that
    // was made during manual testing; the greeting must still work.
    for (const orb of ['Zorblax', '{', '', 'null', '[1,2,3]']) {
      expect(() => assistantNameFrom({ creator_orb: orb })).not.toThrow();
      expect(assistantNameFrom({ creator_orb: orb }), orb).toBe(DEFAULT_ASSISTANT_NAME);
    }
  });

  it('ignores a non-string assistantName inside the blob', () => {
    for (const value of [42, null, { name: 'Zorblax' }, ['Zorblax']]) {
      const orb = JSON.stringify({ assistantName: value });
      expect(assistantNameFrom({ creator_orb: orb }), JSON.stringify(value)).toBe('Henry');
    }
  });

  it('never writes back — resolution is a read', () => {
    const settings = { [ASSISTANT_NAME_SETTING_KEY]: 'Zorblax' };
    const snapshot = JSON.stringify(settings);
    assistantNameFrom(settings);
    expect(JSON.stringify(settings)).toBe(snapshot);
  });
});

describe('the wake word answers to the same name', () => {
  it('the default wake word is the default assistant name, lowercased', () => {
    // Derived, not a second literal: renaming the default must move both.
    expect(DEFAULT_WAKE_WORD).toBe(DEFAULT_ASSISTANT_NAME.toLowerCase());
    expect(DEFAULT_WAKE_WORD).toBe('henry');
  });

  it('a resolved name produces wake patterns that match it and not the default', () => {
    const name = assistantNameFrom({ [ASSISTANT_NAME_SETTING_KEY]: 'Zorblax' });
    const patterns = patternsForWakeWord(name);

    expect(matchWakeWord('hey zorblax run the tests', patterns)?.query).toBe('run the tests');
    expect(matchWakeWord('zorblax open the door', patterns)?.query).toBe('open the door');
    expect(matchWakeWord('zorblax', patterns)?.query).toBe('');
    expect(matchWakeWord('hey henry run the tests', patterns)).toBeNull();
  });

  it('an unconfigured install keeps matching the historical utterances', () => {
    const patterns = patternsForWakeWord(assistantNameFrom({}));
    expect(matchWakeWord('hey henry what is the weather', patterns)?.query).toBe('what is the weather');
    expect(matchWakeWord('hey there', patterns)).toBeNull();
  });
});