import { describe, it, expect } from 'vitest';
import {
  ALL_GREETING_VARIANTS,
  DEFAULT_ASSISTANT_NAME,
  GREETING_VARIANTS,
  assistantNameFor,
  buildGreetingText,
  greetingPeriod,
  renderGreeting,
} from './greeting';

/**
 * Row 6.11 regression: every one of the twelve greeting variants used to
 * hardcode the literal "Henry", so renaming the assistant in CreatorsPanel
 * changed the power-on intro but never the spoken greeting. The variant that
 * proved it was "Hey{address} — Henry is up and listening."
 *
 * These tests drive ALL TWELVE templates through the renderer, not the one the
 * daily seed happens to select, so a variant cannot regress unnoticed.
 */

/** One date per period, each a different day so the seed walks the pool. */
const DATES = {
  morning: new Date(2026, 0, 15, 9),
  afternoon: new Date(2026, 0, 16, 14),
  evening: new Date(2026, 0, 17, 20),
  lateNight: new Date(2026, 0, 18, 23),
} as const;

describe('greeting variant inventory', () => {
  it('still has exactly twelve variants, three per period', () => {
    expect(ALL_GREETING_VARIANTS).toHaveLength(12);
    expect(GREETING_VARIANTS.morning).toHaveLength(3);
    expect(GREETING_VARIANTS.afternoon).toHaveLength(3);
    expect(GREETING_VARIANTS.evening).toHaveLength(3);
    expect(GREETING_VARIANTS.lateNight).toHaveLength(3);
  });

  it('uses only the two documented placeholders and never a literal identity', () => {
    for (const variant of ALL_GREETING_VARIANTS) {
      expect(variant).toContain('{address}');
      // The defect: the identity was baked into the copy.
      expect(variant).not.toMatch(/Henry/);
      // Nothing may introduce a third placeholder we never resolve.
      const placeholders = variant.match(/\{[a-zA-Z]+\}/g) ?? [];
      for (const p of placeholders) expect(['{address}', '{name}']).toContain(p);
    }
  });
});

describe('all twelve variants honour the configured assistant name', () => {
  it('substitutes Zorblax into every applicable self-reference', () => {
    const rendered = ALL_GREETING_VARIANTS.map((v) => renderGreeting(v, undefined, 'Zorblax'));

    for (const text of rendered) {
      expect(text).not.toMatch(/\{name\}/);
      // (a) No stale hardcoded identity survives anywhere in the output.
      expect(text).not.toMatch(/Henry/);
      expect(text).not.toMatch(/H\.E\.N\.R\.Y/);
    }

    // Seven of twelve name the assistant in the third person. Renaming the
    // assistant must move every one of those.
    const selfNaming = ALL_GREETING_VARIANTS.filter((v) => v.includes('{name}'));
    expect(selfNaming).toHaveLength(7);
    for (const variant of selfNaming) {
      expect(renderGreeting(variant, undefined, 'Zorblax')).toContain('Zorblax');
    }
  });

  it('reaches the reported variant through buildGreetingText', () => {
    // The negative test reported "Hey, JARVIS — Henry is up and listening.".
    // Find the day whose seed selects that exact variant rather than assuming
    // a date, then assert on the real path end to end.
    const target = 'Hey{address} — {name} is up and listening.';
    let hit: Date | null = null;
    for (let day = 1; day <= 28 && !hit; day++) {
      const candidate = new Date(2026, 0, day, 14);
      const { text, period } = buildGreetingText('JARVIS', candidate, 'Zorblax');
      if (period === 'afternoon' && text === renderGreeting(target, 'JARVIS', 'Zorblax')) {
        hit = candidate;
      }
    }
    expect(hit).not.toBeNull();
    expect(buildGreetingText('JARVIS', hit as Date, 'Zorblax').text).toBe(
      'Hey, JARVIS — Zorblax is up and listening.',
    );
  });

  it('every produced greeting is one of the twelve rendered variants', () => {
    for (const date of Object.values(DATES)) {
      const { text } = buildGreetingText('JARVIS', date, 'Zorblax');
      expect(ALL_GREETING_VARIANTS.map((v) => renderGreeting(v, 'JARVIS', 'Zorblax'))).toContain(text);
    }
  });

  it('keeps period selection and per-day stability unchanged', () => {
    expect(greetingPeriod(DATES.morning)).toBe('morning');
    expect(greetingPeriod(DATES.afternoon)).toBe('afternoon');
    expect(greetingPeriod(DATES.evening)).toBe('evening');
    expect(greetingPeriod(DATES.lateNight)).toBe('lateNight');

    // Same day, different hour in the same period → same variant.
    const nine = buildGreetingText('Alex', new Date(2026, 0, 15, 9), 'Zorblax').text;
    const eleven = buildGreetingText('Alex', new Date(2026, 0, 15, 11), 'Zorblax').text;
    expect(nine).toBe(eleven);
  });

  it('produces distinct output for two different configured names', () => {
    const a = ALL_GREETING_VARIANTS.map((v) => renderGreeting(v, undefined, 'Zorblax'));
    const b = ALL_GREETING_VARIANTS.map((v) => renderGreeting(v, undefined, 'Henry'));
    expect(a.filter((t, i) => t !== b[i])).toHaveLength(7);
  });
});

describe('owner {address} substitution — tested separately from the name', () => {
  it('inserts the owner name, independent of the assistant name', () => {
    for (const assistantName of ['Henry', 'Zorblax', null]) {
      const text = renderGreeting(
        'Good morning{address}. {name} is up and ready.',
        'Alex',
        assistantName,
      );
      expect(text).toBe(`Good morning, Alex. ${assistantNameFor(assistantName)} is up and ready.`);
    }
  });

  it('leaves no address gap when the owner is unknown', () => {
    for (const owner of [undefined, null, '', '   ']) {
      const text = renderGreeting('Morning{address}. Systems are online.', owner, 'Zorblax');
      expect(text).not.toMatch(/\{address\}/);
      expect(text).toBe('Morning. Systems are online.');
    }
  });

  it('never emits a doubled comma or a double space', () => {
    for (const variant of ALL_GREETING_VARIANTS) {
      for (const owner of [undefined, 'Alex']) {
        const text = renderGreeting(variant, owner, 'Zorblax');
        expect(text).not.toMatch(/,\s*,/);
        expect(text).not.toMatch(/\s{2,}/);
      }
    }
  });

  it('keeps the owner and the assistant as distinct people', () => {
    const text = renderGreeting(
      'Hey{address} — {name} is up and listening.',
      'JARVIS',
      'Zorblax',
    );
    expect(text).toBe('Hey, JARVIS — Zorblax is up and listening.');
  });
});

describe('default unconfigured install is unchanged', () => {
  it('falls back to Henry for null, undefined, blank and whitespace', () => {
    for (const raw of [null, undefined, '', '   ']) {
      expect(assistantNameFor(raw)).toBe('Henry');
      expect(assistantNameFor(raw)).toBe(DEFAULT_ASSISTANT_NAME);
    }
  });

  it('renders the historical literals when nothing is configured', () => {
    // Every variant, unconfigured, is the historical string: the {name} ones
    // with "Henry", the first-person ones verbatim.
    for (const variant of ALL_GREETING_VARIANTS) {
      const expected = variant
        .replace('{name}', DEFAULT_ASSISTANT_NAME)
        .replace('{address}', ', Alex');
      expect(renderGreeting(variant, 'Alex', null)).toBe(expected);
    }

    // The daily seed picks one; whatever it picks is among those twelve.
    for (const date of Object.values(DATES)) {
      const { text } = buildGreetingText('Alex', date);
      expect(ALL_GREETING_VARIANTS.map((v) => renderGreeting(v, 'Alex', null))).toContain(text);
    }

    // The third-person morning variant, unconfigured, still says Henry.
    expect(renderGreeting(GREETING_VARIANTS.morning[0], 'Alex', null)).toBe(
      'Good morning, Alex. Henry is up and ready.',
    );
  });

  it('trims and caps a configured name the way the orb setting does', () => {
    expect(assistantNameFor('  Zorblax  ')).toBe('Zorblax');
    expect(assistantNameFor('x'.repeat(40))).toHaveLength(32);
  });
});