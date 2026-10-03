/**
 * Google + Discord agent-tool tests.
 *
 * These exercise the tool DEFINITIONS and their `execute` paths against an
 * in-memory settings table and an injected `fetch`. No network egress, no real
 * credentials, no Electron.
 *
 * What is asserted is behaviour a consumer can observe:
 *   - safety tiers: sending, uploading, and calendar writes are confirm; reads
 *     are silent. A downgrade here is a real-world side effect with no gate.
 *   - an uncredentialed provider produces an actionable, successful read — not
 *     a fabricated success and not an opaque throw.
 *   - a send with a header-injection attempt in the recipient is REFUSED
 *   - a send that fails upstream reports the failure; it never claims `sent: true`
 *   - Discord DM routing opens the DM channel first and reports the real
 *     channel id back
 *   - a rate limit surfaces `retry_after` instead of looking like a hang
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { googleTools } from './google/tools';
import { discordTools } from './discord/tools';
import { saveCredential, loadCredential } from './oauth/credentialStore';
import { DISCORD_PROVIDER, GOOGLE_PROVIDER } from './oauth/registry';
import { integrationTools } from './index';
import type { AgentContext, ToolDefinition } from '../agent/types';
import type { OAuthTokenSet } from './oauth/types';

class FakeDb {
  readonly rows = new Map<string, string>();
  prepare(sql: string) {
    if (sql.includes('SELECT')) {
      return { get: (key: string) => (this.rows.has(key) ? { value: this.rows.get(key) } : undefined) };
    }
    if (sql.includes('DELETE')) {
      return { run: (key: string) => { this.rows.delete(key); return { changes: 1 }; } };
    }
    return {
      run: (key: string, value: string) => {
        this.rows.set(key, value);
        return { changes: 1 };
      },
    };
  }
}

const db = new FakeDb();

function context(): AgentContext {
  // `getWindow` is unused by these tools; a null window is the honest value.
  return { db: db as never, getWindow: () => null };
}

function googleToken(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: 'ya29.google-access-token',
    refreshToken: '1//google-refresh-token',
    expiresAt: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    tokenType: 'Bearer',
    authScheme: 'Bearer',
    ...overrides,
  };
}

function discordToken(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: 'MTA.discord-bot-token-value',
    refreshToken: '',
    expiresAt: 0,
    scope: '',
    tokenType: 'Bot',
    authScheme: 'Bot',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Records every request so a test can assert on the wire call. */
function recordingFetch(
  respond: (url: string, init: RequestInit) => Response,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const byName = (name: string): ToolDefinition => {
  const tool = integrationTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool;
};

beforeEach(() => {
  db.rows.clear();
  vi.restoreAllMocks();
});

// ── Registration and safety tiers ───────────────────────────────────────────

describe('integration tool registration', () => {
  const names = integrationTools().map((t) => t.name);

  it('registers the Gmail, Drive, Calendar, and Discord tools', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'google_auth_status',
        'gmail_search_messages',
        'gmail_read_message',
        'gmail_send_message',
        'gmail_create_draft',
        'drive_list_files',
        'drive_read_file',
        'drive_upload_file',
        'gcal_list_events',
        'gcal_create_event',
        'gcal_update_event',
        'discord_auth_status',
        'discord_list_guilds',
        'discord_list_channels',
        'discord_read_messages',
        'discord_send_message',
      ]),
    );
  });

  it('never collides with the existing macOS email/calendar tool names', () => {
    // The registry is last-wins per name. A collision would silently replace a
    // shipped tool rather than fail.
    const existing = ['email_send', 'email_search', 'calendar_create_event', 'calendar_list_events'];
    for (const name of existing) expect(names).not.toContain(name);
  });

  // Each confirm tool's prompt must name the specific thing being approved, so
  // the user can actually say no to it.
  const confirmCases: Array<[string, Record<string, unknown>, string]> = [
    ['gmail_send_message', { to: 'alex@example.com', subject: 'Lunch' }, 'alex@example.com'],
    ['drive_upload_file', { path: 'Documents/report.pdf' }, 'Documents/report.pdf'],
    ['gcal_create_event', { summary: 'Quarterly review', startDateTime: '2026-10-06T14:00:00Z' }, 'Quarterly review'],
    ['gcal_update_event', { eventId: 'evt-7', summary: 'Renamed' }, 'evt-7'],
    ['discord_send_message', { channelId: 'c-1', content: 'deploy is green' }, 'c-1'],
  ];
  it.each(confirmCases)('%s is confirm-tier and names its target', (name, params, expected) => {
    const tool = byName(name);
    expect(tool.safetyLevel).toBe('confirm');
    // A confirm tier with no prompt string shows the user nothing to approve.
    expect(typeof tool.confirmPrompt).toBe('function');
    expect(String(tool.confirmPrompt?.(params))).toContain(expected);
  });

  it.each([
    'google_auth_status',
    'gmail_search_messages',
    'gmail_read_message',
    'drive_list_files',
    'drive_read_file',
    'gcal_list_events',
    'discord_auth_status',
    'discord_list_guilds',
    'discord_list_channels',
    'discord_read_messages',
  ])('%s is silent — it only reads', (name) => {
    expect(byName(name).safetyLevel).toBe('silent');
  });

  it('spends no confirm gate on a reversible Gmail draft', () => {
    expect(byName('gmail_create_draft').safetyLevel).toBe('notify');
  });
});

// ── Uncredentialed behaviour ────────────────────────────────────────────────

describe('uncredentialed behaviour', () => {
  it('google_auth_status reports how to connect instead of failing', async () => {
    const result = await byName('google_auth_status').execute({}, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
    expect(String((result.data as { message: string }).message)).toMatch(/Settings/);
  });

  it('discord_auth_status reports how to connect instead of failing', async () => {
    const result = await byName('discord_auth_status').execute({}, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
  });

  it('discord_list_guilds never reaches the network when nothing is stored', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);
    const result = await byName('discord_list_guilds').execute({}, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gmail_search_messages reports not-connected rather than an empty inbox', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);
    const result = await byName('gmail_search_messages').execute({ query: 'is:unread' }, context());
    // An empty list would read to the model as "you have no unread mail".
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('discord_send_message refuses to send without a credential', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);
    const result = await byName('discord_send_message').execute(
      { channelId: '111', content: 'hi' },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
    // Reporting "sent" here would be a fabricated delivery.
    expect(result.data).not.toMatchObject({ sent: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── Google reads ────────────────────────────────────────────────────────────

describe('gmail_search_messages', () => {
  it('returns sender, subject, and date per hit rather than bare ids', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const { fetchImpl } = recordingFetch((url) => {
      if (url.includes('/messages?')) {
        return jsonResponse({ messages: [{ id: 'm1', threadId: 't1' }] });
      }
      return jsonResponse({
        id: 'm1',
        threadId: 't1',
        snippet: 'Lunch?',
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          headers: [
            { name: 'From', value: 'alex@example.com' },
            { name: 'Subject', value: 'Lunch tomorrow' },
            { name: 'Date', value: 'Tue, 6 Oct 2026 09:00:00 -0400' },
          ],
          body: { data: b64('Are you free at noon?') },
        },
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_search_messages').execute({ query: 'from:alex' }, context());
    expect(result.ok).toBe(true);
    const messages = (result.data as { messages: Array<{ from: string; subject: string }> }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('alex@example.com');
    expect(messages[0].subject).toBe('Lunch tomorrow');
  });

  it('reports a genuine empty result as a count of zero, not as not-connected', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({ messages: [] }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_search_messages').execute({ query: 'nope' }, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 0 });
    expect((result.data as { note: string }).note).toMatch(/No messages matched/);
  });

  it('surfaces a wrong channel id as a specific error', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: { message: 'Not Found' } }, 404));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_read_message').execute({ messageId: 'missing' }, context());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No Gmail message/);
  });
});

describe('gmail_send_message', () => {
  beforeEach(() => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
  });

  it('refuses a recipient containing a header-injection line break', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_send_message').execute(
      { to: 'alex@example.com\r\nBcc: attacker@evil.test', subject: 'hi', body: 'x' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/line break/);
    // Nothing may reach the API — not even a partially-built message.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a subject containing a line break', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);
    const result = await byName('gmail_send_message').execute(
      { to: 'alex@example.com', subject: 'hi\r\nBcc: attacker@evil.test', body: 'x' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a recipient that is not an email address', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);
    const result = await byName('gmail_send_message').execute(
      { to: 'not-an-address', subject: 'hi', body: 'x' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a base64url RFC 822 message and reports the real message id', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ id: 'sent-1', threadId: 'th-1' }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_send_message').execute(
      { to: 'alex@example.com', subject: 'Lunch', body: 'Noon works.' },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ sent: true, messageId: 'sent-1' });

    const body = JSON.parse(String(calls[0].init.body)) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: alex@example.com');
    expect(decoded).toContain('Subject: Lunch');
    expect(decoded).toContain('Noon works.');
  });

  it('reports the upstream failure instead of claiming the mail was sent', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: { message: 'Delegation denied for user' } }, 403),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_send_message').execute(
      { to: 'alex@example.com', subject: 'Lunch', body: 'Noon.' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toMatch(/Delegation denied/);
  });

  it('tells the user to reconnect when the grant lacks the scope', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(
        { error: { message: 'Request had insufficient authentication scopes.' } },
        403,
      ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_send_message').execute(
      { to: 'alex@example.com', subject: 'Lunch', body: 'Noon.' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Reconnect Google/);
  });
});

// ── Google Drive and Calendar ───────────────────────────────────────────────

describe('drive_read_file', () => {
  it('exports a Google Doc to text instead of dumping bytes', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.includes('/export')) return new Response('Quarterly plan', { status: 200 });
      return jsonResponse({
        id: 'f1',
        name: 'Plan',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://docs.google.com/x',
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('drive_read_file').execute({ fileId: 'f1' }, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ kind: 'google_native_export', content: 'Quarterly plan' });
    expect(calls.some((c) => c.url.includes('/export'))).toBe(true);
  });

  it('reports binary metadata rather than emitting undecodable bytes', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ id: 'f2', name: 'scan.pdf', mimeType: 'application/pdf', size: '900' }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('drive_read_file').execute({ fileId: 'f2' }, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ kind: 'binary_metadata_only', size: '900' });
  });
});

describe('drive_upload_file', () => {
  it('refuses a path outside the user home directory', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('drive_upload_file').execute(
      { path: '/etc/../../../../etc/passwd' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a missing local file instead of reporting an upload', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('drive_upload_file').execute(
      { path: 'definitely-not-here-9f2a.txt' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not read/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('gcal_create_event', () => {
  it('rejects an end that is not after the start', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gcal_create_event').execute(
      {
        summary: 'Review',
        startDateTime: '2026-10-06T14:00:00-04:00',
        endDateTime: '2026-10-06T13:00:00-04:00',
      },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/after startDateTime/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unparseable start rather than inventing one', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gcal_create_event').execute(
      { summary: 'Review', startDateTime: 'next tuesday' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates the event and returns its id and link', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        id: 'evt-1',
        summary: 'Review',
        htmlLink: 'https://calendar.google.com/event?eid=1',
        start: { dateTime: '2026-10-06T18:00:00.000Z' },
        end: { dateTime: '2026-10-06T19:00:00.000Z' },
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gcal_create_event').execute(
      { summary: 'Review', startDateTime: '2026-10-06T14:00:00-04:00' },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ created: true, eventId: 'evt-1' });
    expect(calls[0].init.method).toBe('POST');
    // No end supplied: one hour is the documented default, not zero.
    expect(calls.some((c) => c.url.includes('18:00:00') || c.url.includes('19:00:00'))).toBe(false);
    const body = JSON.parse(String(calls[0].init.body)) as { end: { dateTime: string } };
    expect(Date.parse(body.end.dateTime) - Date.parse('2026-10-06T14:00:00-04:00')).toBe(3_600_000);
  });
});

describe('gcal_update_event', () => {
  it('requires at least one field to change', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gcal_update_event').execute({ eventId: 'evt-1' }, context());
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('PATCHes only the supplied fields', async () => {
    saveCredential(GOOGLE_PROVIDER.id, { tokens: googleToken() }, db as never);
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: 'evt-1', summary: 'Renamed' }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gcal_update_event').execute(
      { eventId: 'evt-1', summary: 'Renamed' },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ summary: 'Renamed' });
  });
});

// ── Discord ─────────────────────────────────────────────────────────────────

describe('discord_list_guilds', () => {
  it('presents a bot token as an Authorization: Bot header', async () => {
    saveCredential(DISCORD_PROVIDER.id, { tokens: discordToken() }, db as never);
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse([{ id: 'g1', name: 'Henry HQ', owner: true }]),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_list_guilds').execute({}, context());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 1 });
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bot MTA.discord-bot-token-value',
    });
  });

  it('presents a user token bare, with no scheme', async () => {
    saveCredential(
      DISCORD_PROVIDER.id,
      { tokens: discordToken({ accessToken: 'user-token-value', authScheme: 'User' }) },
      db as never,
    );
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse([]));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    await byName('discord_list_guilds').execute({}, context());
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'user-token-value' });
  });

  it('reports a rejected token as needing a fresh one, not as "no servers"', async () => {
    saveCredential(DISCORD_PROVIDER.id, { tokens: discordToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: '401: Unauthorized' }, 401));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_list_guilds').execute({}, context());
    // An empty list would read as "you are in no servers", which is a lie.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fresh bot token/);
  });
});

describe('discord_read_messages', () => {
  it('clamps the limit into the range Discord accepts', async () => {
    saveCredential(DISCORD_PROVIDER.id, { tokens: discordToken() }, db as never);
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse([]));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    await byName('discord_read_messages').execute({ channelId: 'c1', limit: 5000 }, context());
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('100');
  });

  it('explains a bot that lacks the Message Content intent', async () => {
    saveCredential(DISCORD_PROVIDER.id, { tokens: discordToken() }, db as never);
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: 'Missing Access' }, 403));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_read_messages').execute({ channelId: 'c1' }, context());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Message Content/);
  });
});

describe('discord_send_message', () => {
  beforeEach(() => {
    saveCredential(DISCORD_PROVIDER.id, { tokens: discordToken() }, db as never);
  });

  it('posts to the given channel and reports the delivered message id', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: 'm1', channel_id: 'c1', content: 'hi', author: { id: 'b1' } }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_send_message').execute(
      { channelId: 'c1', content: 'hi' },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ sent: true, channelId: 'c1', messageId: 'm1' });
    expect(calls[0].url).toContain('/channels/c1/messages');
  });

  it('opens the DM channel before sending when given a user id', async () => {
    const { fetchImpl, calls } = recordingFetch((url) =>
      url.endsWith('/users/@me/channels')
        ? jsonResponse({ id: 'dm-9', type: 1 })
        : jsonResponse({ id: 'm2', channel_id: 'dm-9', content: 'hi', author: { id: 'b1' } }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_send_message').execute(
      { userId: 'u1', content: 'hi' },
      context(),
    );
    expect(result.ok).toBe(true);
    // The reported channel must be the DM channel that was actually opened.
    expect(result.data).toMatchObject({ channelId: 'dm-9' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ recipient_id: 'u1' });
  });

  it('does not claim delivery when the DM channel cannot be opened', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: 'Unknown User' }, 404));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_send_message').execute(
      { userId: 'nobody', content: 'hi' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No Discord user/);
  });

  it('truncates rather than letting Discord reject an oversized message', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: 'm3', channel_id: 'c1', author: { id: 'b1' } }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    await byName('discord_send_message').execute(
      { channelId: 'c1', content: 'x'.repeat(3000) },
      context(),
    );
    const body = JSON.parse(String(calls[0].init.body)) as { content: string };
    expect(body.content).toHaveLength(2000);
  });

  it('surfaces a rate limit with its retry hint', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ retry_after: 2.5, message: 'You are being rate limited.' }, 429),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_send_message').execute(
      { channelId: 'c1', content: 'hi' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rate-limited/i);
    expect(result.error).toMatch(/2\.5s/);
    expect(result.retryable).toBe(true);
  });

  it('reports a permission failure rather than a delivered message', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ message: 'Missing Permissions' }, 403),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('discord_send_message').execute(
      { channelId: 'c1', content: 'hi' },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission/);
  });
});

// ── Token refresh on 401 ────────────────────────────────────────────────────

describe('401 handling', () => {
  it('refreshes and replays once rather than repeating the same failed call', async () => {
    saveCredential(
      GOOGLE_PROVIDER.id,
      { tokens: googleToken(), clientId: 'cid', clientSecret: 'csec' },
      db as never,
    );
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const href = String(url);
      if (href.includes('/messages?')) {
        seen.push('list');
        const auth = (init.headers as Record<string, string>).Authorization;
        if (auth === 'Bearer ya29.google-access-token') {
          return jsonResponse({ error: { message: 'Invalid Credentials' } }, 401);
        }
        return jsonResponse({ messages: [] });
      }
      // Token endpoint.
      seen.push('token');
      return jsonResponse({ access_token: 'ya29.rotated-token', expires_in: 3600 });
    }) as unknown as typeof fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as never);

    const result = await byName('gmail_search_messages').execute({}, context());
    expect(result.ok).toBe(true);
    // Exactly one refresh, then a replay — never an unbounded retry loop.
    expect(seen).toEqual(['list', 'token', 'list']);
    // The rotated access token must be persisted, not held in memory only.
    expect(loadCredential(GOOGLE_PROVIDER.id, db as never)?.tokens.accessToken).toBe(
      'ya29.rotated-token',
    );
  });
});