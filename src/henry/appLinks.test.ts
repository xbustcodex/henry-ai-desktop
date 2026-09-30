import { describe, it, expect } from 'vitest';
import { resolveAppLink, APP_LINKS } from './appLinks';

describe('resolveAppLink — picks the right app', () => {
  it('returns null for text that names no known app', () => {
    expect(resolveAppLink('open firefox')).toBeNull();
    expect(resolveAppLink('')).toBeNull();
    expect(resolveAppLink('   ')).toBeNull();
  });

  it('opens the app home when no action or search term is given', () => {
    const r = resolveAppLink('open gmail');
    expect(r?.app.id).toBe('gmail');
    expect(r?.url).toBe('https://mail.google.com/');
  });

  it('prefers the longest alias so "google calendar" beats "calendar"', () => {
    const r = resolveAppLink('open google calendar');
    expect(r?.app.id).toBe('calendar');
  });

  it('does not let 2-char aliases match inside unrelated words', () => {
    // Regression guard: with a bare substring test, 'ig' matched "design"
    // and 'wa' matched "draw", so unrelated text resolved to a random app.
    expect(resolveAppLink('open the design file')).toBeNull();
    expect(resolveAppLink('configure my drawing app')).toBeNull();
  });

  it('describes the link it is about to open', () => {
    // `description` is the confirmation text the caller shows, so it has to
    // name the action, not just the app.
    expect(resolveAppLink('open my inbox')?.description).toBe('Open the inbox');
    expect(resolveAppLink('get directions to the train station')?.description).toBe('Directions');
    expect(resolveAppLink('open gmail')?.description).toBe('Open Gmail');
    expect(resolveAppLink('search youtube for lofi beats')?.description).toBe('Search YouTube for "lofi beats"');
  });
});

describe('resolveAppLink — named actions beat free-text search', () => {
  it('routes "open my inbox" to the inbox, not a search for "my inbox"', () => {
    const r = resolveAppLink('open my inbox');
    expect(r?.app.id).toBe('gmail');
    expect(r?.url).toBe('https://mail.google.com/mail/u/0/#inbox');
  });

  it('routes "show me today\'s calendar"', () => {
    const r = resolveAppLink("show me today's calendar");
    expect(r?.app.id).toBe('calendar');
    expect(r?.url).toContain('calendar.google.com');
  });

  it('routes GitHub notifications and pull requests', () => {
    expect(resolveAppLink('check my github notifications')?.url).toBe('https://github.com/notifications');
    expect(resolveAppLink('open github pull requests')?.url).toBe('https://github.com/pulls');
  });

  it('routes Amazon orders and cart', () => {
    expect(resolveAppLink('check my amazon orders')?.url).toContain('order-history');
    expect(resolveAppLink('open my cart on amazon')?.url).toContain('/cart/');
  });
});

describe('resolveAppLink — compose builds a prefilled Gmail link', () => {
  it('composes with a recipient and subject', () => {
    const r = resolveAppLink('compose an email to sam@example.com about the invoice');
    expect(r?.app.id).toBe('gmail');
    const u = new URL(r!.url);
    expect(u.searchParams.get('to')).toBe('sam@example.com');
    expect(u.searchParams.get('subject')).toBe('the invoice');
  });

  it('falls back to a blank compose window when there is nothing to prefill', () => {
    expect(resolveAppLink('compose a new email')?.url).toBe('https://mail.google.com/mail/u/0/#compose');
  });
});

describe('resolveAppLink — search terms are encoded', () => {
  it('searches inside the app, stripping the leading verb', () => {
    const r = resolveAppLink('search youtube for lofi beats');
    expect(r?.app.id).toBe('youtube');
    expect(r?.url).toBe('https://www.youtube.com/results?search_query=lofi%20beats');
  });

  it('percent-encodes characters that would break the URL', () => {
    const r = resolveAppLink('search youtube for a&b/c?d');
    expect(r?.url).toContain('search_query=');
    expect(r?.url).toBe(
      'https://www.youtube.com/results?search_query=' + encodeURIComponent('a&b/c?d'),
    );
  });
});

describe('resolveAppLink — direction links', () => {
  it('builds a maps directions URL for "directions to"', () => {
    const r = resolveAppLink('get directions to the train station');
    expect(r?.app.id).toBe('maps');
    expect(r?.url).toBe('https://www.google.com/maps/dir/' + encodeURIComponent('the train station'));
  });
});

describe('catalogue integrity', () => {
  it('has unique ids and at least one alias each', () => {
    const ids = new Set(APP_LINKS.map((a) => a.id));
    expect(ids.size).toBe(APP_LINKS.length);
    for (const app of APP_LINKS) {
      expect(app.aliases.length).toBeGreaterThan(0);
      expect(app.home.startsWith('https://')).toBe(true);
    }
  });

  it('builds valid https URLs for every action of every app', () => {
    for (const app of APP_LINKS) {
      for (const action of app.actions ?? []) {
        const url = action.url('sample query');
        if (url === null) continue; // action legitimately needs a target
        expect(url.startsWith('https://'), `${app.id}/${action.label}`).toBe(true);
        expect(() => new URL(url)).not.toThrow();
      }
    }
  });
});
