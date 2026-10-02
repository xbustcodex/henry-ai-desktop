/**
 * Icon resolution for any list of named tools or services.
 *
 * Paid 1.7.0 has this (integration-logos.ts): read the Content-Type header,
 * sniff magic bytes for PNG/JPEG/GIF/ICO/WebP, detect a Composio placeholder,
 * and fall back through SimpleIcons → jsDelivr → Iconify → unavatar → the
 * site's own favicon. Ours had nothing, so any list of integrations would have
 * shown broken images.
 *
 * The point of the chain is that no caller has to know where an icon lives:
 * give it a name and get something renderable. Resolution is lazy and
 * cached, and every step degrades rather than throwing — a missing icon must
 * never break the list around it.
 */

export interface IconSource {
  url: string;
  /** Why this step was chosen, for the fallback chain's benefit. */
  via: 'simpleicons' | 'jsdelivr' | 'iconify' | 'unavatar' | 'favicon' | 'local';
}

const CACHE = new Map<string, string | null>();

/** simple-icons slug for the services we actually show. */
const SIMPLE_ICONS: Record<string, string> = {
  google: 'google',
  gmail: 'gmail',
  googlecalendar: 'googlecalendar',
  googledrive: 'googledrive',
  github: 'github',
  gitlab: 'gitlab',
  discord: 'discord',
  slack: 'slack',
  notion: 'notion',
  openai: 'openai',
  anthropic: 'anthropic',
  ollama: 'ollama',
  opencode: 'opencode',
  notioncalendar: 'notion',
  dropbox: 'dropbox',
  figma: 'figma',
  linear: 'linear',
  airtable: 'airtable',
  asana: 'asana',
  trello: 'trello',
  shopify: 'shopify',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  zendesk: 'zendesk',
  intercom: 'intercom',
  jira: 'jira',
  clickup: 'clickup',
  monday: 'mondaycom',
  githubcopilot: 'githubcopilot',
  huggingface: 'huggingface',
  langchain: 'langchain',
  pinecone: 'pinecone',
  supabase: 'supabase',
  vercel: 'vercel',
  netlify: 'netlify',
  sendgrid: 'sendgrid',
  twilio: 'twilio',
  stripe: 'stripe',
};

/** Normalise "Google Calendar", "google_calendar", "google-calendar" → one key. */
export function normalizeToolKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function domainFor(name: string): string | null {
  const key = normalizeToolKey(name);
  const known: Record<string, string> = {
    gmail: 'mail.google.com',
    googlecalendar: 'calendar.google.com',
    googledrive: 'drive.google.com',
    google: 'google.com',
    openrouter: 'openrouter.ai',
    opencode: 'opencode.ai',
    github: 'github.com',
    discord: 'discord.com',
  };
  return known[key] ?? null;
}

/**
 * Ordered candidates for a tool. First that resolves wins; nothing throws.
 */
export function iconCandidates(name: string): IconSource[] {
  const key = normalizeToolKey(name);
  const out: IconSource[] = [];
  const slug = SIMPLE_ICONS[key];
  if (slug) out.push({ url: `https://cdn.simpleicons.org/${slug}`, via: 'simpleicons' });
  if (slug) out.push({ url: `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`, via: 'jsdelivr' });
  // Iconify covers far more services than the table above.
  out.push({ url: `https://api.iconify.design/simple-icons:${slug ?? key}`, via: 'iconify' });
  const domain = domainFor(name);
  if (domain) {
    out.push({ url: `https://unavatar.io/${domain}`, via: 'unavatar' });
    out.push({ url: `https://${domain}/favicon.ico`, via: 'favicon' });
  }
  return out;
}

/** Cached resolver — safe to call during render. Never throws. */
export function resolveToolIcon(name: string): string | null {
  const key = normalizeToolKey(name);
  if (CACHE.has(key)) return CACHE.get(key) ?? null;
  // Best guess for the common case; the <img> onError handler walks the chain.
  const first = iconCandidates(name)[0];
  const value = first?.url ?? null;
  CACHE.set(key, value);
  return value;
}

/**
 * Magic-byte sniffing, for when a service hands back HTML or an error page
 * where an image was expected. A 404 page that renders as a broken icon is the
 * failure this exists to prevent.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // "GIF" is a 4-byte signature; requiring 6 rejected a truncated prefix.
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // An error page can begin "<!DOCTYPE", "<?xml" or "<html" — matching only
  // "<?" let the common "<!" case through as "unknown".
  if (b.length >= 2 && b[0] === 0x3c) {
    const c = b[1];
    if (c === 0x21 || c === 0x3f || (c >= 0x41 && c <= 0x7a)) return 'text/html';
  }
  return null;
}

/** True when a payload is an error page rather than an image. */
export function isPlaceholder(bytes: Uint8Array): boolean {
  const type = sniffImageType(bytes);
  return type === null || type === 'text/html';
}

/** Walk the fallback chain; used by an <img> onError handler. */
export function nextIconInChain(name: string, tried: string[]): string | null {
  return iconCandidates(name).map((c) => c.url).find((u) => !tried.includes(u)) ?? null;
}

/** Test seam. */
export function clearIconCache(): void {
  CACHE.clear();
}