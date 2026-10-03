/**
 * The templates are only worth offering if their cron actually means what the
 * card claims. A "Weekdays at 7:00" template running hourly would be worse than
 * no template at all.
 */
import { describe, it, expect } from 'vitest';
import {
  ROUTINE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  templatesByCategory,
  findTemplate,
  templateToRoutineInput,
  isValidCron,
} from './routineTemplates';

describe('the library', () => {
  it('ships a useful number of templates', () => {
    expect(ROUTINE_TEMPLATES.length).toBeGreaterThanOrEqual(6);
  });

  it('has unique ids — they key the cards', () => {
    const ids = ROUTINE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every template a name, description, prompt and schedule label', () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(t.name.trim().length, t.id).toBeGreaterThan(2);
      expect(t.description.trim().length, t.id).toBeGreaterThan(10);
      expect(t.prompt.trim().length, t.id).toBeGreaterThan(30);
      expect(t.scheduleLabel.trim().length, t.id).toBeGreaterThan(3);
    }
  });

  it('only uses declared categories', () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(TEMPLATE_CATEGORIES).toContain(t.category);
    }
  });
});

describe('cron expressions', () => {
  it('are all valid five-field expressions', () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(isValidCron(t.cronExpression), `${t.id}: ${t.cronExpression}`).toBe(true);
    }
  });

  it('never schedule more often than the label implies', () => {
    // A template that says "at 7" must not run hourly.
    for (const t of ROUTINE_TEMPLATES) {
      const [, hour] = t.cronExpression.split(' ');
      if (/at \d{2}:\d{2}/.test(t.scheduleLabel)) {
        expect(/[,\-*/]/.test(hour), `${t.id} hour field "${hour}"`).toBe(false);
      }
    }
  });

  it('keeps weekday templates off weekends', () => {
    for (const t of ROUTINE_TEMPLATES) {
      if (/Weekdays/i.test(t.scheduleLabel)) {
        const dow = t.cronExpression.split(' ')[4];
        expect(dow, t.id).toBe('1-5');
      }
    }
  });

  it('rejects malformed expressions', () => {
    expect(isValidCron('0 7 * *')).toBe(false);
    expect(isValidCron('0 7 * * * *')).toBe(false);
    expect(isValidCron('0 7 * * abc')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });
});

describe('filtering', () => {
  it('returns everything when no category is given', () => {
    expect(templatesByCategory().length).toBe(ROUTINE_TEMPLATES.length);
  });

  it('returns only that category', () => {
    const business = templatesByCategory('Business');
    expect(business.length).toBeGreaterThan(0);
    expect(business.every((t) => t.category === 'Business')).toBe(true);
  });

  it('finds one by id and returns undefined for a miss', () => {
    expect(findTemplate('morning-brief')?.name).toBe('Morning briefing');
    expect(findTemplate('nope')).toBeUndefined();
  });
});

describe('starting a template', () => {
  it('produces exactly what addRoutine expects', () => {
    const input = templateToRoutineInput(findTemplate('morning-brief')!);
    expect(input).toHaveProperty('name');
    expect(input).toHaveProperty('description');
    expect(input).toHaveProperty('prompt');
    expect(input).toHaveProperty('cronExpression');
    expect(input.enabled).toBe(true);
    expect(typeof input.name).toBe('string');
    expect(typeof input.prompt).toBe('string');
  });

  it('starts enabled — a template the user picked should just run', () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(templateToRoutineInput(t).enabled).toBe(true);
    }
  });

  it('carries the prompt through unshortened', () => {
    const t = findTemplate('daily-review')!;
    expect(templateToRoutineInput(t).prompt).toBe(t.prompt);
  });
});