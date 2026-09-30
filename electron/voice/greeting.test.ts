import { describe, it, expect } from 'vitest';
import { greetingPeriod, buildGreetingText } from './greeting';

/**
 * The greeting is synthesized once and cached on disk, so a bad phrase is
 * cached and replayed on every launch. These cover the two things that can go
 * wrong: picking the wrong time-of-day bucket, and emitting an awkward name
 * insertion.
 */
describe('greetingPeriod — time of day', () => {
  const at = (h: number) => new Date(2026, 0, 15, h, 0, 0);

  it('buckets by hour', () => {
    expect(greetingPeriod(at(5))).toBe('morning');
    expect(greetingPeriod(at(11))).toBe('morning');
    expect(greetingPeriod(at(12))).toBe('afternoon');
    expect(greetingPeriod(at(17))).toBe('afternoon');
    expect(greetingPeriod(at(18))).toBe('evening');
    expect(greetingPeriod(at(22))).toBe('evening');
    expect(greetingPeriod(at(23))).toBe('lateNight');
    expect(greetingPeriod(at(4))).toBe('lateNight');
    expect(greetingPeriod(at(0))).toBe('lateNight');
  });
});

describe('buildGreetingText — name insertion', () => {
  it('uses a neutral greeting when no owner name is known', () => {
    for (const name of [undefined, null, '', '   ']) {
      const { text } = buildGreetingText(name, new Date(2026, 0, 15, 9));
      expect(text).not.toContain(',');
      expect(text).not.toMatch(/\s{2,}/);
    }
  });

  it('inserts the owner name after a comma', () => {
    const { text } = buildGreetingText('Alex', new Date(2026, 0, 15, 9));
    expect(text).toContain('Alex');
    expect(text).not.toContain('{address}');
    expect(text).not.toMatch(/,\s*,/);
  });

  it('never leaves the template placeholder behind', () => {
    for (const h of [3, 9, 14, 20]) {
      for (const name of [undefined, 'Alex']) {
        const { text } = buildGreetingText(name, new Date(2026, 0, 15, h));
        expect(text).not.toContain('{address}');
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('is stable within a day so the disk cache key matches', () => {
    const morning = new Date(2026, 0, 15, 9);
    const later = new Date(2026, 0, 15, 11);
    expect(buildGreetingText('Alex', morning).text).toBe(buildGreetingText('Alex', later).text);
  });

  it('changes across periods', () => {
    const morning = buildGreetingText('Alex', new Date(2026, 0, 15, 9)).text;
    const evening = buildGreetingText('Alex', new Date(2026, 0, 15, 20)).text;
    expect(morning).not.toBe(evening);
  });
});
