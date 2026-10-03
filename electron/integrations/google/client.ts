/**
 * Google API client — Gmail, Drive, and Calendar.
 *
 * Every request runs through `apiRequest`, which pulls the stored OAuth
 * credential, refreshes it when it is stale, and retries once on a 401. That is
 * the whole reason the pre-existing `google:startAuth` flow was unusable by the
 * agent: the token existed but no module could spend it, and now one can.
 *
 * Endpoint shapes are Google's documented v1 REST API:
 *   Gmail    https://gmail.googleapis.com/gmail/v1/users/me/…
 *   Drive    https://www.googleapis.com/drive/v3/…
 *   Calendar https://www.googleapis.com/calendar/v3/…
 */

import type Database from 'better-sqlite3';
import { apiRequest, type ApiResponse } from '../httpClient';
import { GOOGLE_PROVIDER } from '../oauth/registry';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/** Gmail caps a page at 500. We stay well under so a tool turn stays cheap. */
const MAX_PAGE = 100;

export interface GoogleRequestOptions {
  db: Database.Database;
  fetchImpl?: typeof fetch;
}

// ── Gmail ───────────────────────────────────────────────────────────────────

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
}

export interface GmailListResponse {
  messages?: GmailMessageSummary[];
  resultSizeEstimate?: number;
  nextPageToken?: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    body?: { data?: string; size?: number };
    parts?: GmailPart[];
  };
}

export interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

/** One decoded message, flattened for the model. */
export interface GmailMessageView {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  labels: string[];
  body: string;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
}

/**
 * Gmail's search syntax is its own language (`from:`, `is:unread`,
 * `newer_than:7d`, …). It is passed through verbatim, which is what the user
 * means when they say "search my mail" — but it is bounded in length so a
 * runaway query cannot produce an unbounded response.
 */
export function searchMessages(
  query: string,
  limit: number,
  options: GoogleRequestOptions,
): Promise<ApiResponse<GmailListResponse>> {
  return apiRequest<GmailListResponse>({
    provider: GOOGLE_PROVIDER,
    baseUrl: GMAIL_BASE,
    path: '/users/me/messages',
    query: { q: query || undefined, maxResults: Math.min(Math.max(limit, 1), MAX_PAGE) },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

export function getMessage(
  messageId: string,
  options: GoogleRequestOptions,
): Promise<ApiResponse<GmailMessage>> {
  return apiRequest<GmailMessage>({
    provider: GOOGLE_PROVIDER,
    baseUrl: GMAIL_BASE,
    path: `/users/me/messages/${encodeURIComponent(messageId)}`,
    query: { format: 'full' },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

export interface GmailSendResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/**
 * Send a real email.
 *
 * Gmail's REST API takes a base64url-encoded RFC 822 message — there is no
 * structured "to/subject/body" form — so `buildRawMessage` produces the wire
 * format here. A header injection guard runs over every field: a newline in a
 * recipient address would otherwise let the model append headers of its own
 * (Bcc, arbitrary headers) to a message the user is about to send.
 */
export function sendMessage(
  raw: string,
  options: GoogleRequestOptions,
): Promise<ApiResponse<GmailSendResponse>> {
  return apiRequest<GmailSendResponse>({
    provider: GOOGLE_PROVIDER,
    baseUrl: GMAIL_BASE,
    path: '/users/me/messages/send',
    method: 'POST',
    body: { raw },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

export function createDraft(
  raw: string,
  options: GoogleRequestOptions,
): Promise<ApiResponse<{ id: string; message: { id: string; threadId: string } }>> {
  return apiRequest({
    provider: GOOGLE_PROVIDER,
    baseUrl: GMAIL_BASE,
    path: '/users/me/drafts',
    method: 'POST',
    body: { message: { raw } },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** A field that ends up in an RFC 822 header must not contain a newline. */
export function hasHeaderInjection(value: string): boolean {
  return /[\r\n]/.test(value);
}

/**
 * Assemble an RFC 822 message and base64url-encode it for the Gmail API.
 * Header order is fixed; body content is never inspected for structure.
 */
export function buildRawMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  from?: string;
}): string {
  const lines: string[] = [];
  if (input.from) lines.push(`From: ${input.from}`);
  lines.push(`To: ${input.to}`);
  if (input.cc) lines.push(`Cc: ${input.cc}`);
  lines.push(`Subject: ${input.subject}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  lines.push('');
  lines.push(input.body);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/** Pull a header's value out of a Gmail payload, case-insensitively. */
export function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const hit = headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

/** Walk a MIME tree to the first text/plain part, or the whole body if simple. */
export function extractTextBody(payload: GmailMessage['payload']): string {
  if (!payload) return '';
  const walk = (part: GmailPart): string | null => {
    const mime = part.mimeType ?? '';
    if (mime.startsWith('text/plain') && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
    for (const child of part.parts ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const found = payload.body?.data
    ? walk({ mimeType: 'text/plain', body: payload.body })
    : null;
  if (found) return found;
  // No text/plain part — fall back to the first part that has any data, so a
  // message with only text/html still yields something readable.
  const fallback = walk(payload);
  if (fallback) return fallback;
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  return '';
}

function collectAttachments(
  payload: GmailMessage['payload'],
): Array<{ filename: string; mimeType: string; size: number }> {
  const out: Array<{ filename: string; mimeType: string; size: number }> = [];
  const walk = (part: GmailPart) => {
    // Gmail puts the attachment's display name on `filename`, alongside the
    // part's own `body`.
    const name = (part as GmailPart & { filename?: string }).filename;
    if (name) {
      out.push({
        filename: name,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? 0,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return out;
}

export function toMessageView(message: GmailMessage): GmailMessageView {
  const headers = message.payload?.headers;
  return {
    id: message.id,
    threadId: message.threadId,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: message.snippet ?? null,
    labels: message.labelIds ?? [],
    body: extractTextBody(message.payload),
    attachments: collectAttachments(message.payload),
  };
}

// ── Drive ───────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

const DRIVE_FILE_FIELDS = 'files(id,name,mimeType,size,modifiedTime,webViewLink),nextPageToken';

export function listFiles(
  query: string,
  limit: number,
  options: GoogleRequestOptions,
): Promise<ApiResponse<{ files?: DriveFile[]; nextPageToken?: string }>> {
  return apiRequest({
    provider: GOOGLE_PROVIDER,
    baseUrl: DRIVE_BASE,
    path: '/files',
    query: {
      q: query || undefined,
      pageSize: Math.min(Math.max(limit, 1), MAX_PAGE),
      fields: DRIVE_FILE_FIELDS,
    },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** Google-native documents are not downloadable — they are exported. */
export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

/** The export MIME type to request for a Google-native document. */
export function exportMimeType(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return 'text/plain';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'text/csv';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'text/plain';
  return 'text/plain';
}

export function getFileMetadata(
  fileId: string,
  options: GoogleRequestOptions,
): Promise<ApiResponse<DriveFile>> {
  return apiRequest<DriveFile>({
    provider: GOOGLE_PROVIDER,
    baseUrl: DRIVE_BASE,
    path: `/files/${encodeURIComponent(fileId)}`,
    query: { fields: 'id,name,mimeType,size,modifiedTime,webViewLink' },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** Binary download for ordinary files. Returns raw bytes. */
export function downloadFile(
  fileId: string,
  options: GoogleRequestOptions,
): Promise<ApiResponse<ArrayBuffer>> {
  return apiRequest<ArrayBuffer>({
    provider: GOOGLE_PROVIDER,
    baseUrl: DRIVE_BASE,
    path: `/files/${encodeURIComponent(fileId)}`,
    query: { alt: 'media' },
    db: options.db,
    fetchImpl: options.fetchImpl,
    headers: { Accept: '*/*' },
  });
}

/** Text export for Google Docs/Sheets/Slides. */
export function exportFile(
  fileId: string,
  mimeType: string,
  options: GoogleRequestOptions,
): Promise<ApiResponse<string>> {
  return apiRequest<string>({
    provider: GOOGLE_PROVIDER,
    baseUrl: DRIVE_BASE,
    path: `/files/${encodeURIComponent(fileId)}/export`,
    query: { mimeType },
    db: options.db,
    fetchImpl: options.fetchImpl,
    headers: { Accept: '*/*' },
  });
}

/**
 * Multipart upload, per Google's documented `uploadType=multipart` form:
 * a JSON metadata part and a binary part in one request. Requires the
 * `drive.file` scope — granted at connect time.
 */
export function uploadFile(
  name: string,
  mimeType: string,
  content: Buffer,
  options: GoogleRequestOptions,
): Promise<ApiResponse<DriveFile>> {
  const boundary = `henry-${Date.now().toString(36)}`;
  const metadata = JSON.stringify({ name, mimeType });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
    content,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);

  return apiRequest<DriveFile>({
    provider: GOOGLE_PROVIDER,
    baseUrl: DRIVE_UPLOAD_BASE,
    path: '/files',
    method: 'POST',
    query: { uploadType: 'multipart' },
    rawBody: body,
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    db: options.db,
    fetchImpl: options.fetchImpl,
    // Uploads get a longer budget than a metadata read.
    timeoutMs: 60_000,
  });
}

// ── Calendar ────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  organizer?: { email: string; displayName?: string };
}

export function listEvents(
  calendarId: string,
  params: { timeMin?: string; timeMax?: string; query?: string; limit?: number },
  options: GoogleRequestOptions,
): Promise<ApiResponse<{ items?: CalendarEvent[]; nextPageToken?: string }>> {
  return apiRequest({
    provider: GOOGLE_PROVIDER,
    baseUrl: CALENDAR_BASE,
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    query: {
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      q: params.query,
      // Expanded recurrences matter: "what's on Thursday" should see a
      // recurring standup, not an empty week.
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: Math.min(Math.max(params.limit ?? 25, 1), MAX_PAGE),
    },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

export function createEvent(
  calendarId: string,
  event: CalendarEvent,
  options: GoogleRequestOptions,
): Promise<ApiResponse<CalendarEvent>> {
  return apiRequest<CalendarEvent>({
    provider: GOOGLE_PROVIDER,
    baseUrl: CALENDAR_BASE,
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    method: 'POST',
    body: event,
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** Calendar's own update verb. SendsIfNoneMatch guards a concurrent edit. */
export function updateEvent(
  calendarId: string,
  eventId: string,
  event: CalendarEvent,
  options: GoogleRequestOptions,
): Promise<ApiResponse<CalendarEvent>> {
  return apiRequest<CalendarEvent>({
    provider: GOOGLE_PROVIDER,
    baseUrl: CALENDAR_BASE,
    path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    method: 'PATCH',
    body: event,
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** The start of a date range `days` from now, as an RFC 3339 instant. */
export function relativeInstant(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}