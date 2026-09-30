/**
 * App deep links — jump straight to a specific place inside an app.
 *
 * These are plain web URLs, so the OS routes them to whichever app is
 * registered as the default handler. Nothing here talks to a third-party
 * service: it is a local catalogue, and opening a link is the existing
 * cross-platform `computer:openUrl` path.
 *
 * A catalogue entry turns an intent ("compose an email to Sam") into a URL.
 */

export interface AppLinkAction {
  /** Words that select this action in a request. */
  match: string[];
  /** Human label shown in the UI. */
  label: string;
  /**
   * Build the target URL. `query` is the user's text after the action, e.g.
   * the recipient or search term. May return null when the query is not
   * usable for this action.
   */
  url: (query: string) => string | null;
}

export interface AppLink {
  id: string;
  /** Names/aliases people actually say. */
  aliases: string[];
  /** How the app itself is described in the UI. */
  displayName: string;
  /** Used when the request has no specific action, e.g. "open gmail". */
  home: string;
  /** Optional — many apps only support search/home. */
  actions?: AppLinkAction[];
  /** Free-text search inside the app, when supported. */
  search?: (query: string) => string | null;
}

const q = (s: string) => encodeURIComponent(s.trim());

/** Gmail: compose, search, or a specific label. */
const gmail: AppLink = {
  id: 'gmail',
  aliases: ['gmail', 'email', 'mail', 'e-mail', 'inbox'],
  displayName: 'Gmail',
  home: 'https://mail.google.com/',
  search: (query) => (query ? `https://mail.google.com/mail/u/0/#search/${q(query)}` : null),
  actions: [
    {
      match: ['compose', 'write', 'new email', 'new mail', 'send an email', 'email'],
      label: 'Compose a new email',
      url: (query) => {
        // "compose to sam@x.com about X" → a prefilled compose window.
        // Anchored: without \b, the "to " inside "photo" matched and silently
        // misaddressed the message to "album".
        const to = query.match(/\bto\s+([^\s,]+@[^\s,]+|[^\s,]+)/i)?.[1];
        const subject = query.match(/(?:about|subject|re)\s+(.+)$/i)?.[1];
        const body = query.match(/(?:saying|body|message)\s+(.+)$/i)?.[1];
        if (!to && !subject && !body) return 'https://mail.google.com/mail/u/0/#compose';
        const p = new URLSearchParams();
        if (to) p.set('to', to);
        if (subject) p.set('subject', subject);
        if (body) p.set('body', body);
        return `https://mail.google.com/mail/u/0/?view=cm&fs=1&${p.toString()}`;
      },
    },
    {
      match: ['inbox', 'unread'],
      label: 'Open the inbox',
      url: () => 'https://mail.google.com/mail/u/0/#inbox',
    },
    {
      match: ['sent', 'sent mail'],
      label: 'Open sent mail',
      url: () => 'https://mail.google.com/mail/u/0/#sent',
    },
  ],
};

const calendar: AppLink = {
  id: 'calendar',
  aliases: ['calendar', 'google calendar', 'cal', 'schedule'],
  displayName: 'Google Calendar',
  home: 'https://calendar.google.com/',
  actions: [
    { match: ['today'], label: "Today's schedule", url: () => 'https://calendar.google.com/calendar/u/0/r/week' },
    { match: ['week'], label: 'This week', url: () => 'https://calendar.google.com/calendar/u/0/r/week' },
    { match: ['month'], label: 'This month', url: () => 'https://calendar.google.com/calendar/u/0/r/month' },
    {
      match: ['new event', 'create event', 'add event', 'schedule a meeting', 'book'],
      label: 'Create an event',
      url: (query) => {
        const text = query.trim();
        return text
          ? `https://calendar.google.com/calendar/u/0/r/eventedit?text=${q(text)}`
          : 'https://calendar.google.com/calendar/u/0/r/eventedit';
      },
    },
  ],
};

const github: AppLink = {
  id: 'github',
  aliases: ['github', 'gh', 'repos', 'repository'],
  displayName: 'GitHub',
  home: 'https://github.com/',
  search: (query) => (query ? `https://github.com/search?q=${q(query)}` : null),
  actions: [
    { match: ['notifications', 'alerts'], label: 'Notifications', url: () => 'https://github.com/notifications' },
    { match: ['pull requests', 'prs', 'pulls'], label: 'Pull requests', url: () => 'https://github.com/pulls' },
    { match: ['issues'], label: 'Issues', url: () => 'https://github.com/issues' },
    {
      match: ['repo', 'repository'],
      label: 'Open a repository',
      url: (query) => {
        const repo = query.replace(/^(open|the)?\s*(repo|repository)\s*/i, '').trim();
        if (!repo) return null;
        return `https://github.com/${repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '')}`;
      },
    },
  ],
};

const slack: AppLink = {
  id: 'slack',
  aliases: ['slack'],
  displayName: 'Slack',
  home: 'https://app.slack.com/client',
  search: (query) => (query ? `https://app.slack.com/client/${q(query)}` : null),
  actions: [
    { match: ['mentions', 'mentioned'], label: 'Mentions', url: () => 'https://app.slack.com/client/mentions' },
    { match: ['dms', 'direct messages'], label: 'Direct messages', url: () => 'https://app.slack.com/client/dm' },
    { match: ['threads'], label: 'Threads', url: () => 'https://app.slack.com/client/threads' },
  ],
};

const notion: AppLink = {
  id: 'notion',
  aliases: ['notion'],
  displayName: 'Notion',
  home: 'https://www.notion.so/',
  search: (query) => (query ? `https://www.notion.so/search?q=${q(query)}` : null),
};

const drive: AppLink = {
  id: 'drive',
  aliases: ['drive', 'google drive', 'docs', 'sheets', 'slides'],
  displayName: 'Google Drive',
  home: 'https://drive.google.com/',
  search: (query) => (query ? `https://drive.google.com/drive/u/0/my-drive?q=${q(query)}` : null),
};

const maps: AppLink = {
  id: 'maps',
  aliases: ['maps', 'google maps', 'directions', 'navigate'],
  displayName: 'Maps',
  home: 'https://www.google.com/maps',
  search: (query) => (query ? `https://www.google.com/maps/search/${q(query)}` : null),
  actions: [
    {
      match: ['directions to', 'navigate to', 'route to', 'take me to'],
      label: 'Directions',
      url: (query) => (query ? `https://www.google.com/maps/dir/${q(query)}` : null),
    },
  ],
};

const youtube: AppLink = {
  id: 'youtube',
  aliases: ['youtube', 'yt'],
  displayName: 'YouTube',
  home: 'https://www.youtube.com/',
  search: (query) => (query ? `https://www.youtube.com/results?search_query=${q(query)}` : null),
};

const amazon: AppLink = {
  id: 'amazon',
  aliases: ['amazon', 'orders', 'shopping'],
  displayName: 'Amazon',
  home: 'https://www.amazon.com/',
  search: (query) => (query ? `https://www.amazon.com/s?k=${q(query)}` : null),
  actions: [
    { match: ['orders', 'my orders', 'order status'], label: 'Your orders', url: () => 'https://www.amazon.com/gp/css/order-history' },
    { match: ['cart', 'basket'], label: 'Cart', url: () => 'https://www.amazon.com/gp/cart/view.html' },
  ],
};

const whatsapp: AppLink = {
  id: 'whatsapp',
  aliases: ['whatsapp', 'wa'],
  displayName: 'WhatsApp',
  home: 'https://web.whatsapp.com/',
  search: (query) => (query ? `https://web.whatsapp.com/send?text=${q(query)}` : null),
};

const telegram: AppLink = {
  id: 'telegram',
  aliases: ['telegram', 'tg'],
  displayName: 'Telegram',
  home: 'https://web.telegram.org/',
  search: (query) => (query ? `https://t.me/share/url?url=&text=${q(query)}` : null),
};

const linear: AppLink = {
  id: 'linear',
  aliases: ['linear', 'issues app'],
  displayName: 'Linear',
  home: 'https://linear.app/',
  search: (query) => (query ? `https://linear.app/search?q=${q(query)}` : null),
};

const spotify: AppLink = {
  id: 'spotify',
  aliases: ['spotify', 'music'],
  displayName: 'Spotify',
  home: 'https://open.spotify.com/',
  search: (query) => (query ? `https://open.spotify.com/search/${q(query)}` : null),
};

const meta: AppLink = {
  id: 'meta',
  aliases: ['meta ads', 'facebook', 'facebook ads', 'instagram', 'ig'],
  displayName: 'Meta',
  home: 'https://www.facebook.com/businessadsmanager',
  search: (query) => (query ? `https://www.facebook.com/search/top?q=${q(query)}` : null),
  actions: [
    { match: ['ads manager', 'ad manager', 'campaigns', 'ads'], label: 'Ads Manager', url: () => 'https://www.facebook.com/businessadsmanager' },
  ],
};

const tiktok: AppLink = {
  id: 'tiktok',
  aliases: ['tiktok'],
  displayName: 'TikTok',
  home: 'https://www.tiktok.com/',
  search: (query) => (query ? `https://www.tiktok.com/search?q=${q(query)}` : null),
};

const linkedin: AppLink = {
  id: 'linkedin',
  aliases: ['linkedin'],
  displayName: 'LinkedIn',
  home: 'https://www.linkedin.com/feed/',
  search: (query) => (query ? `https://www.linkedin.com/search/results/all/?keywords=${q(query)}` : null),
  actions: [
    { match: ['messages', 'inbox', 'linkedin inbox'], label: 'Messages', url: () => 'https://www.linkedin.com/messaging/' },
    { match: ['notifications', 'my network'], label: 'Notifications', url: () => 'https://www.linkedin.com/notifications/' },
  ],
};

const stripe: AppLink = {
  id: 'stripe',
  aliases: ['stripe', 'payments', 'billing'],
  displayName: 'Stripe',
  home: 'https://dashboard.stripe.com/',
  actions: [
    { match: ['payments', 'transactions'], label: 'Payments', url: () => 'https://dashboard.stripe.com/payments' },
    { match: ['customers'], label: 'Customers', url: () => 'https://dashboard.stripe.com/customers' },
    { match: ['invoices'], label: 'Invoices', url: () => 'https://dashboard.stripe.com/invoices' },
  ],
};

const klaviyo: AppLink = {
  id: 'klaviyo',
  aliases: ['klaviyo', 'email marketing'],
  displayName: 'Klaviyo',
  home: 'https://www.klaviyo.com/',
};

export const APP_LINKS: AppLink[] = [
  gmail, calendar, drive, github, slack, notion, linear, meta, stripe, klaviyo,
  maps, youtube, amazon, whatsapp, telegram, spotify, tiktok, linkedin,
];

export interface ResolvedAppLink {
  app: AppLink;
  url: string;
  /** What the link does, for the confirmation text. */
  description: string;
}

/** Find the catalogue entry whose aliases best match `text`. */
function findApp(text: string): AppLink | null {
  const lower = text.toLowerCase();
  let best: { app: AppLink; score: number } | null = null;
  for (const app of APP_LINKS) {
    for (const alias of app.aliases) {
      // Word boundaries are required. A bare substring test meant the 2-char
      // aliases hijacked unrelated words — 'ig' matched "design" and
      // "configure", 'wa' matched "draw", 'gh' matched "neighbour" — so
      // "open figma" resolved to a Facebook search.
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(lower)) continue;
      // Prefer the longest alias so "google calendar" beats "calendar".
      const score = alias.length;
      if (!best || score > best.score) best = { app, score };
    }
  }
  return best?.app ?? null;
}

/**
 * Resolve a natural-language request into a concrete deep link.
 *
 * Returns null when the text does not name a known app, so callers can fall
 * back to plain app launching.
 */
export function resolveAppLink(text: string): ResolvedAppLink | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const app = findApp(trimmed);
  if (!app) return null;

  const lower = trimmed.toLowerCase();

  // A named action wins over free-text search.
  for (const action of app.actions ?? []) {
    for (const phrase of action.match) {
      if (!lower.includes(phrase)) continue;
      // The query is what follows the action phrase, else the app mention.
      const at = lower.indexOf(phrase);
      const query = trimmed.slice(at + phrase.length).replace(/^\s*(to|in|for|about)\s+/i, '').trim();
      const url = action.url(query);
      if (url) return { app, url, description: action.label };
    }
  }

  // Otherwise treat the rest as a search term, or open the app home.
  // Strip the app mention and any leading verb, then any connective that is
  // left dangling — "search youtube for lofi beats" must search for
  // "lofi beats", not "for lofi beats".
  const aliasPattern = app.aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const withoutApp = trimmed
    .replace(new RegExp(`\\b(?:${aliasPattern})\\b`, 'ig'), ' ')
    .replace(/^\s*(open|go to|show me|search|find|launch|start|browse|check|view)\s+/i, '')
    .replace(/^\s*(?:for|about|on|in|at|with)\s+/i, '')
    // Collapse inner runs: stripping the alias left "my   files" in the query.
    .replace(/\s+/g, ' ')
    .trim();

  if (withoutApp && app.search) {
    const url = app.search(withoutApp);
    if (url) return { app, url, description: `Search ${app.displayName} for "${withoutApp}"` };
  }

  return { app, url: app.home, description: `Open ${app.displayName}` };
}
