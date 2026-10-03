/**
 * Google agent tools — Gmail, Drive, and Calendar against the stored credential.
 *
 * These are the tools row 10.1/10.2 were missing. The OAuth flow, the token
 * store, and the Settings surface all existed; nothing spent the token. Every
 * tool here goes through `apiRequest`, which pulls the encrypted credential,
 * refreshes it when stale, and reports "not connected" cleanly when there isn't
 * one.
 *
 * Tool names are prefixed `gmail_` / `drive_` / `gcal_` rather than reusing the
 * existing macOS-automation `email_*` and `calendar_*` tools. Those drive Mail.app
 * and Calendar.app through JXA and are macOS-only; these talk to the Google
 * account over the network and work on every platform. Two different systems
 * need two different names or the registry's last-wins rule would silently
 * replace one with the other.
 *
 * Safety tiers:
 *   gmail_search / gmail_read / drive_* reads   silent
 *   gcal_list_events                             silent
 *   google_auth_status                           silent
 *   gmail_create_draft                           notify  (reversible, stays in the user's mailbox)
 *   gmail_send_message                           confirm  (leaves Henry, notifies real people)
 *   drive_upload_file                            confirm  (uploads the user's local file off-machine)
 *   gcal_create_event / gcal_update_event        confirm  (syncs to shared calendars and notifies invitees)
 */

import { promises as fsp } from 'fs';
import type { ToolDefinition, ToolResult, AgentContext } from '../../agent/types';
import { resolveUserPath } from '../../agent/tools/files';
import type { ApiResponse } from '../httpClient';
import { describeCredential } from '../oauth/credentialStore';
import { GOOGLE_PROVIDER } from '../oauth/registry';
import {
  buildRawMessage,
  createDraft,
  createEvent,
  downloadFile,
  exportFile,
  exportMimeType,
  getFileMetadata,
  getMessage,
  hasHeaderInjection,
  isGoogleNative,
  listEvents,
  listFiles,
  relativeInstant,
  searchMessages,
  sendMessage,
  toMessageView,
  updateEvent,
  uploadFile,
} from './client';

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/**
 * "Google isn't set up" — returned as a successful read so the model relays the
 * instruction to the user instead of reporting an opaque failure. Same
 * convention as `qb_auth_status`.
 */
function notConnected(): ToolResult {
  return ok({
    connected: false,
    status: 'not_connected',
    message:
      'Google is not connected. Open Settings → Connections → Google, paste your OAuth ' +
      'client ID and secret from Google Cloud Console, and connect. Then run this again.',
  });
}

/**
 * A Google API error that means "the stored grant no longer covers this".
 * The user has to reconnect, so say so rather than relaying an opaque 403.
 */
function scopeFailure(res: ApiResponse): ToolResult | null {
  if (res.status !== 403 && res.status !== 401) return null;
  const detail = `${res.error ?? ''}`;
  if (/insufficient|scope|permission|Sorry, you cannot/i.test(detail)) {
    return fail(
      'Google rejected this: the connected account is missing a required permission. ' +
        'Reconnect Google in Settings → Connections → Google and approve the new scopes.',
      false,
    );
  }
  return null;
}

/**
 * Status 0 is `apiRequest`'s "no usable credential" signal, so it maps to the
 * actionable not-connected read rather than a generic failure.
 */
function fromApi(res: ApiResponse): ToolResult {
  if (res.ok) return ok(res.data);
  if (res.status === 0) return notConnected();
  const scoped = scopeFailure(res);
  if (scoped) return scoped;
  return fail(res.error ?? 'Google request failed.', res.status === 429);
}

function requiredString(value: unknown, field: string): string | ToolResult {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fail(`${field} is required.`);
  return text;
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** Cap a tool result's text so a huge document cannot blow up the turn. */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

export function googleTools(): ToolDefinition[] {
  return [
    // ── google_auth_status ──────────────────────────────────────────────
    {
      name: 'google_auth_status',
      description:
        'Report whether Google is connected and which Gmail/Drive/Calendar access Henry has. ' +
        'Use this before promising the user you can read or send their mail, files, or events.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_params, context: AgentContext) {
        const status = describeCredential(GOOGLE_PROVIDER.id, context.db);
        if (!status.connected) return notConnected();
        return ok({
          connected: true,
          hasRefreshToken: status.hasRefreshToken,
          expired: status.expired,
          expiresAt: status.expiresAt,
          scope: status.scope,
        });
      },
    },

    // ── gmail_search_messages ───────────────────────────────────────────
    {
      name: 'gmail_search_messages',
      description:
        'Search Gmail and return matching message summaries (sender, subject, date, snippet). ' +
        'Accepts Gmail search syntax, e.g. "from:boss@example.com is:unread newer_than:7d". ' +
        'Use gmail_read_message for the full text of a specific result.',
      category: 'communication',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Gmail search query. Empty means the whole mailbox.',
          },
          limit: { type: 'number', description: 'Max messages (default 10, max 50).' },
        },
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const query = typeof params.query === 'string' ? params.query.slice(0, 512) : '';
        const limit = boundedInt(params.limit, 10, 50);
        const list = await searchMessages(query, limit, { db: context.db });
        if (!list.ok) return fromApi(list);
        const ids = list.data?.messages ?? [];
        if (ids.length === 0) {
          return ok({ query, count: 0, messages: [], note: 'No messages matched.' });
        }
        // Fetch each message's metadata so the model gets a usable
        // sender/subject/date per row, not just ids it cannot use.
        const views = await Promise.all(
          ids.map(async (m) => {
            const detail = await getMessage(m.id, { db: context.db });
            if (!detail.ok || !detail.data) return null;
            const view = toMessageView(detail.data);
            return {
              id: view.id,
              from: view.from,
              subject: view.subject,
              date: view.date,
              snippet: clip(view.snippet ?? '', 300),
              labels: view.labels,
            };
          }),
        );
        const messages = views.filter((v): v is NonNullable<typeof v> => v !== null);
        return ok({ query, count: messages.length, messages });
      },
    },

    // ── gmail_read_message ──────────────────────────────────────────────
    {
      name: 'gmail_read_message',
      description:
        'Read one Gmail message in full — headers, decoded body text, and attachment names. ' +
        'Takes a messageId from gmail_search_messages.',
      category: 'communication',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: { messageId: { type: 'string', description: 'Gmail message id.' } },
        required: ['messageId'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const messageId = requiredString(params.messageId, 'messageId');
        if (typeof messageId !== 'string') return messageId;
        const res = await getMessage(messageId, { db: context.db });
        if (!res.ok) {
          if (res.status === 404) return fail(`No Gmail message with id "${messageId}".`);
          return fromApi(res);
        }
        const view = toMessageView(res.data as Parameters<typeof toMessageView>[0]);
        return ok({ ...view, body: clip(view.body, 20_000) });
      },
    },

    // ── gmail_send_message ──────────────────────────────────────────────
    {
      name: 'gmail_send_message',
      description:
        'Send an email from the connected Gmail account. This delivers a real message to real ' +
        'recipients, so the user confirms before it goes out.',
      category: 'communication',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => {
        const cc = p.cc ? ` (cc ${String(p.cc)})` : '';
        return `Send Gmail message to ${String(p.to)}${cc}: "${clip(String(p.subject ?? ''), 60)}"`;
      },
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address(es), comma-separated.' },
          cc: { type: 'string', description: 'Optional cc address(es).' },
          subject: { type: 'string', description: 'Subject line.' },
          body: { type: 'string', description: 'Plain-text body.' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const to = requiredString(params.to, 'to');
        if (typeof to !== 'string') return to;
        const subject = requiredString(params.subject, 'subject');
        if (typeof subject !== 'string') return subject;
        const body = typeof params.body === 'string' ? params.body : '';
        const cc = typeof params.cc === 'string' && params.cc.trim() ? params.cc.trim() : undefined;

        // A newline in any header field would let the model append its own
        // headers (Bcc, arbitrary directives) to a message the user is about
        // to approve and send.
        for (const [name, value] of [
          ['to', to],
          ['subject', subject],
          ...(cc ? [['cc', cc] as const] : []),
        ] as Array<[string, string]>) {
          if (hasHeaderInjection(value)) {
            return fail(`${name} must not contain a line break.`);
          }
        }
        if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+\.[^\s@,]+)*$/.test(to)) {
          return fail('to must be a comma-separated list of email addresses.');
        }

        const raw = buildRawMessage({ to, subject, body, cc });
        const res = await sendMessage(raw, { db: context.db });
        if (!res.ok) return fromApi(res);
        return ok({
          sent: true,
          messageId: res.data?.id ?? null,
          threadId: res.data?.threadId ?? null,
          to,
          subject,
        });
      },
    },

    // ── gmail_create_draft ──────────────────────────────────────────────
    {
      name: 'gmail_create_draft',
      description:
        'Save an unsent draft in the connected Gmail account. Use this when the user wants to ' +
        'write an email but not send it yet. Nothing leaves the mailbox.',
      category: 'communication',
      // notify, not confirm: a draft is reversible, stays in the user's own
      // mailbox, and notifies nobody. It is a write, so it is announced.
      safetyLevel: 'notify',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address(es), comma-separated.' },
          cc: { type: 'string', description: 'Optional cc address(es).' },
          subject: { type: 'string', description: 'Subject line.' },
          body: { type: 'string', description: 'Plain-text body.' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const to = requiredString(params.to, 'to');
        if (typeof to !== 'string') return to;
        const subject = requiredString(params.subject, 'subject');
        if (typeof subject !== 'string') return subject;
        const body = typeof params.body === 'string' ? params.body : '';
        const cc = typeof params.cc === 'string' && params.cc.trim() ? params.cc.trim() : undefined;
        for (const [name, value] of [
          ['to', to],
          ['subject', subject],
          ...(cc ? [['cc', cc] as const] : []),
        ] as Array<[string, string]>) {
          if (hasHeaderInjection(value)) return fail(`${name} must not contain a line break.`);
        }

        const raw = buildRawMessage({ to, subject, body, cc });
        const res = await createDraft(raw, { db: context.db });
        if (!res.ok) return fromApi(res);
        return ok({ drafted: true, draftId: res.data?.id ?? null, to, subject });
      },
    },

    // ── drive_list_files ────────────────────────────────────────────────
    {
      name: 'drive_list_files',
      description:
        'List files in the connected Google Drive. Accepts Drive query syntax, e.g. ' +
        '"name contains \'budget\'" or "mimeType=\'application/pdf\'". Omit query for recent files.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Drive query string.' },
          limit: { type: 'number', description: 'Max files (default 20, max 50).' },
        },
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const query = typeof params.query === 'string' ? params.query.slice(0, 1024) : '';
        const limit = boundedInt(params.limit, 20, 50);
        const res = await listFiles(query, limit, { db: context.db });
        if (!res.ok) return fromApi(res);
        return ok({
          query,
          count: res.data?.files?.length ?? 0,
          files: (res.data?.files ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size ?? null,
            modifiedTime: f.modifiedTime ?? null,
            link: f.webViewLink ?? null,
          })),
        });
      },
    },

    // ── drive_read_file ─────────────────────────────────────────────────
    {
      name: 'drive_read_file',
      description:
        'Read a Google Drive file. Google Docs/Sheets/Slides are exported to text automatically; ' +
        'plain text and markdown files are returned as-is. Binary formats report their metadata ' +
        'instead of dumping bytes into the conversation.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Drive file id from drive_list_files.' },
        },
        required: ['fileId'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const fileId = requiredString(params.fileId, 'fileId');
        if (typeof fileId !== 'string') return fileId;

        const meta = await getFileMetadata(fileId, { db: context.db });
        if (!meta.ok || !meta.data) {
          if (meta.status === 404) return fail(`No Drive file with id "${fileId}".`);
          return fromApi(meta);
        }
        const file = meta.data;

        if (isGoogleNative(file.mimeType)) {
          const exported = await exportFile(fileId, exportMimeType(file.mimeType), { db: context.db });
          if (!exported.ok) return fromApi(exported);
          return ok({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            kind: 'google_native_export',
            link: file.webViewLink ?? null,
            content: clip(String(exported.data ?? ''), 20_000),
          });
        }

        if (/^text\/|json|xml|csv/.test(file.mimeType)) {
          const raw = await downloadFile(fileId, { db: context.db });
          if (!raw.ok) return fromApi(raw);
          const bytes = raw.data instanceof ArrayBuffer ? Buffer.from(raw.data) : Buffer.from('');
          return ok({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            kind: 'text',
            link: file.webViewLink ?? null,
            content: clip(bytes.toString('utf8'), 20_000),
          });
        }

        return ok({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size ?? null,
          modifiedTime: file.modifiedTime ?? null,
          kind: 'binary_metadata_only',
          link: file.webViewLink ?? null,
          note:
            'This file type is binary. Henry read its metadata rather than the bytes — ' +
            'open the link or convert it first if the contents are needed.',
        });
      },
    },

    // ── drive_upload_file ───────────────────────────────────────────────
    {
      name: 'drive_upload_file',
      description:
        'Upload a local file to the connected Google Drive. This sends the file off the ' +
        'machine, so the user confirms first.',
      category: 'external',
      safetyLevel: 'confirm',
      confirmPrompt: (p) => `Upload ${String(p.path ?? '')} to Google Drive`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the local file to upload.' },
          name: { type: 'string', description: 'Optional Drive filename override.' },
          mimeType: { type: 'string', description: 'Optional MIME type override.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const target = requiredString(params.path, 'path');
        if (typeof target !== 'string') return target;

        // Reuse the file tools' home-confinement check so the agent cannot use
        // Drive upload to exfiltrate an arbitrary absolute path.
        const resolved = resolveUserPath(target);
        if (!resolved.ok) return fail(resolved.error);

        let content: Buffer;
        try {
          const stat = await fsp.stat(resolved.path);
          if (stat.isDirectory()) return fail('path is a directory — pass a file.');
          if (stat.size > 20 * 1024 * 1024) {
            return fail('File is larger than the 20 MB Drive upload limit.');
          }
          content = await fsp.readFile(resolved.path);
        } catch (e) {
          return fail(`Could not read ${resolved.path}: ${e instanceof Error ? e.message : String(e)}`);
        }

        const name =
          typeof params.name === 'string' && params.name.trim()
            ? params.name.trim().slice(0, 255)
            : resolved.path.split(/[\\/]/).pop() ?? 'upload';
        const mimeType =
          typeof params.mimeType === 'string' && params.mimeType.trim()
            ? params.mimeType.trim().slice(0, 200)
            : 'application/octet-stream';

        const res = await uploadFile(name, mimeType, content, { db: context.db });
        if (!res.ok) return fromApi(res);
        return ok({
          uploaded: true,
          fileId: res.data?.id ?? null,
          name: res.data?.name ?? name,
          mimeType: res.data?.mimeType ?? mimeType,
          link: res.data?.webViewLink ?? null,
        });
      },
    },

    // ── gcal_list_events ────────────────────────────────────────────────
    {
      name: 'gcal_list_events',
      description:
        'List Google Calendar events in a date range. Defaults to the next 7 days on the primary ' +
        'calendar. Use calendarId to read a shared calendar.',
      category: 'calendar',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          calendarId: {
            type: 'string',
            description: 'Calendar id (default "primary").',
          },
          query: { type: 'string', description: 'Free-text search within the range.' },
          daysFromNow: {
            type: 'number',
            description: 'Days from now to start (default 0, negative for the past).',
          },
          days: { type: 'number', description: 'Length of the window in days (default 7, max 60).' },
        },
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const calendarId =
          typeof params.calendarId === 'string' && params.calendarId.trim()
            ? params.calendarId.trim()
            : 'primary';
        const from = Number(params.daysFromNow ?? 0);
        const days = boundedInt(params.days, 7, 60);
        const start = Number.isFinite(from) ? from : 0;
        const query = typeof params.query === 'string' ? params.query.slice(0, 256) : undefined;

        const res = await listEvents(
          calendarId,
          { timeMin: relativeInstant(start), timeMax: relativeInstant(start + days), query, limit: 25 },
          { db: context.db },
        );
        if (!res.ok) {
          if (res.status === 404) return fail(`No Google Calendar with id "${calendarId}".`);
          return fromApi(res);
        }
        return ok({
          calendarId,
          count: res.data?.items?.length ?? 0,
          events: (res.data?.items ?? []).map((e) => ({
            id: e.id ?? null,
            summary: e.summary ?? '(no title)',
            start: e.start?.dateTime ?? e.start?.date ?? null,
            end: e.end?.dateTime ?? e.end?.date ?? null,
            location: e.location ?? null,
            organizer: e.organizer?.email ?? null,
            link: e.htmlLink ?? null,
          })),
        });
      },
    },

    // ── gcal_create_event ───────────────────────────────────────────────
    {
      name: 'gcal_create_event',
      description:
        'Create a Google Calendar event. The event syncs to the user\'s other devices and can ' +
        'notify invitees, so the user confirms before it is created.',
      category: 'calendar',
      safetyLevel: 'confirm',
      confirmPrompt: (p) =>
        `Create Google Calendar event "${clip(String(p.summary ?? ''), 60)}" ` +
        `on ${String(p.startDateTime ?? '')}`,
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title.' },
          startDateTime: { type: 'string', description: 'RFC 3339 start, e.g. 2026-10-05T14:00:00-04:00.' },
          endDateTime: { type: 'string', description: 'RFC 3339 end. Defaults to one hour after start.' },
          calendarId: { type: 'string', description: 'Target calendar (default "primary").' },
          location: { type: 'string' },
          description: { type: 'string' },
          timeZone: { type: 'string', description: 'IANA zone, e.g. America/New_York.' },
        },
        required: ['summary', 'startDateTime'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const summary = requiredString(params.summary, 'summary');
        if (typeof summary !== 'string') return summary;
        const startRaw = requiredString(params.startDateTime, 'startDateTime');
        if (typeof startRaw !== 'string') return startRaw;

        const startMs = Date.parse(startRaw);
        if (Number.isNaN(startMs)) {
          return fail('startDateTime must be an RFC 3339 datetime, e.g. 2026-10-05T14:00:00-04:00');
        }
        const endMs = params.endDateTime ? Date.parse(String(params.endDateTime)) : startMs + 3_600_000;
        if (Number.isNaN(endMs)) return fail('endDateTime must be an RFC 3339 datetime.');
        if (endMs <= startMs) return fail('endDateTime must be after startDateTime.');

        const calendarId =
          typeof params.calendarId === 'string' && params.calendarId.trim()
            ? params.calendarId.trim()
            : 'primary';
        const timeZone = typeof params.timeZone === 'string' && params.timeZone.trim() ? params.timeZone.trim() : undefined;

        const res = await createEvent(
          calendarId,
          {
            summary,
            start: timeZone ? { dateTime: new Date(startMs).toISOString(), timeZone } : { dateTime: new Date(startMs).toISOString() },
            end: timeZone ? { dateTime: new Date(endMs).toISOString(), timeZone } : { dateTime: new Date(endMs).toISOString() },
            ...(params.location ? { location: String(params.location) } : {}),
            ...(params.description ? { description: String(params.description) } : {}),
          },
          { db: context.db },
        );
        if (!res.ok) return fromApi(res);
        return ok({
          created: true,
          calendarId,
          eventId: res.data?.id ?? null,
          summary: res.data?.summary ?? summary,
          start: res.data?.start?.dateTime ?? new Date(startMs).toISOString(),
          end: res.data?.end?.dateTime ?? new Date(endMs).toISOString(),
          link: res.data?.htmlLink ?? null,
        });
      },
    },

    // ── gcal_update_event ───────────────────────────────────────────────
    {
      name: 'gcal_update_event',
      description:
        'Change an existing Google Calendar event. Only the fields you pass are changed. ' +
        'Updates sync to the user\'s devices and can notify invitees.',
      category: 'calendar',
      safetyLevel: 'confirm',
      confirmPrompt: (p) =>
        `Update Google Calendar event ${String(p.eventId ?? '')}` +
        (p.summary ? ` — title to "${clip(String(p.summary), 40)}"` : ''),
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Calendar event id from gcal_list_events.' },
          calendarId: { type: 'string', description: 'Calendar id (default "primary").' },
          summary: { type: 'string', description: 'New title.' },
          startDateTime: { type: 'string', description: 'New RFC 3339 start.' },
          endDateTime: { type: 'string', description: 'New RFC 3339 end.' },
          location: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['eventId'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const eventId = requiredString(params.eventId, 'eventId');
        if (typeof eventId !== 'string') return eventId;
        const calendarId =
          typeof params.calendarId === 'string' && params.calendarId.trim()
            ? params.calendarId.trim()
            : 'primary';

        const patch: Record<string, unknown> = {};
        if (typeof params.summary === 'string' && params.summary.trim()) {
          patch.summary = params.summary.trim();
        }
        if (params.startDateTime) {
          const ms = Date.parse(String(params.startDateTime));
          if (Number.isNaN(ms)) return fail('startDateTime must be an RFC 3339 datetime.');
          patch.start = { dateTime: new Date(ms).toISOString() };
        }
        if (params.endDateTime) {
          const ms = Date.parse(String(params.endDateTime));
          if (Number.isNaN(ms)) return fail('endDateTime must be an RFC 3339 datetime.');
          patch.end = { dateTime: new Date(ms).toISOString() };
        }
        if (typeof params.location === 'string') patch.location = params.location;
        if (typeof params.description === 'string') patch.description = params.description;
        if (Object.keys(patch).length === 0) {
          return fail('Provide at least one field to change (summary, startDateTime, endDateTime, location, description).');
        }

        const res = await updateEvent(calendarId, eventId, patch, { db: context.db });
        if (!res.ok) {
          if (res.status === 404) return fail(`No event "${eventId}" on calendar "${calendarId}".`);
          return fromApi(res);
        }
        return ok({
          updated: true,
          calendarId,
          eventId: res.data?.id ?? eventId,
          summary: res.data?.summary ?? null,
          start: res.data?.start?.dateTime ?? res.data?.start?.date ?? null,
          end: res.data?.end?.dateTime ?? res.data?.end?.date ?? null,
          link: res.data?.htmlLink ?? null,
        });
      },
    },
  ];
}