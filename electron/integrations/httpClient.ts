/**
 * Authenticated HTTP for every integration, in one place.
 *
 * Both the Google and Discord tool kits make the same three-step call: get a
 * live access token (refreshing if it is stale), issue the request with the
 * right `Authorization` header, and — on a 401 — refresh once and retry, since
 * a token can expire between the pre-flight check and the request landing.
 *
 * Keeping that here means neither tool kit can accidentally ship a request
 * without a token, and neither can accidentally log one.
 */

import type Database from 'better-sqlite3';
import type { OAuthProviderConfig } from './oauth/types';
import { ensureAccessToken, redact } from './oauth/flow';

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  /** Already redacted. Safe to put in a tool result or an IPC reply. */
  error?: string;
}

export interface ApiCallOptions {
  provider: OAuthProviderConfig;
  db: Database.Database;
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Set for multipart uploads — a raw Buffer body with an explicit type. */
  rawBody?: string | Buffer;
  headers?: Record<string, string>;
  /** Provider base, e.g. 'https://gmail.googleapis.com/gmail/v1'. */
  baseUrl: string;
  /** Per-request timeout. Defaults to 20s. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The `Authorization` header for a token. RFC 6750 Bearer is the default;
 * Discord's bot and user token schemes are both non-standard and are carried on
 * the stored credential.
 */
export function authorizationHeader(tokenType: 'Bearer' | 'Bot' | 'User', token: string): string {
  if (tokenType === 'Bearer') return `Bearer ${token}`;
  if (tokenType === 'Bot') return `Bot ${token}`;
  // Discord user tokens are sent bare — there is no scheme to prepend.
  return token;
}

/** The message a tool returns when the user has not connected the provider. */
export function notConnected<T = unknown>(provider: OAuthProviderConfig): ApiResponse<T> {
  return {
    ok: false,
    status: 0,
    error:
      `${provider.label} is not connected. ` +
      `Open Settings → Connections → ${provider.label} and connect it first.`,
  };
}

/**
 * Make one authenticated request, refreshing once on a 401.
 *
 * Returns `ok: false` with a redacted `error` for every failure mode —
 * uncredentialed, network, 4xx, 5xx — so no caller has to distinguish a thrown
 * rejection from a resolved error body.
 */
export async function apiRequest<T = unknown>(
  options: ApiCallOptions,
  _retried = false,
): Promise<ApiResponse<T>> {
  const { provider } = options;
  const tokens = await ensureAccessToken({
    provider,
    db: options.db,
    fetchImpl: options.fetchImpl,
    // A 401 means the token the server saw was rejected. Retrying with the
    // same cached token would produce the identical 401, so the retry must
    // force a refresh round trip.
    forceRefresh: _retried,
  });
  if (!tokens) return notConnected<T>(provider);

  const url = new URL(options.baseUrl + options.path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Authorization: authorizationHeader(tokens.authScheme, tokens.accessToken),
    Accept: 'application/json',
    ...(options.headers ?? {}),
  };

  let body: string | Buffer | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 20_000);
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: ctrl.signal,
    };
    // Node's fetch accepts a Uint8Array body and `Buffer` is one, but the DOM
    // `BodyInit` type does not know that. Passing the view avoids a cast here
    // and keeps a multipart upload's bytes intact.
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : new Uint8Array(body);
    }
    const res = await (options.fetchImpl ?? fetch)(url.toString(), init);

    // A token can expire between ensureAccessToken and the request landing.
    // Refresh once and replay; a second 401 is a real authorization failure.
    if (res.status === 401 && !_retried) {
      return apiRequest<T>(options, true);
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text || undefined;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: data as T,
        error: redact(describeHttpError(provider.label, res.status, data)),
      };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const aborted = e instanceof Error && /abort/i.test(e.message);
    return {
      ok: false,
      status: 0,
      error: redact(
        aborted
          ? `${provider.label} request timed out.`
          : `${provider.label} request failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a human-readable message out of a provider's error body. Google's shape
 * is `error.message`; Discord's is a bare `{message}` string.
 */
function describeHttpError(label: string, status: number, data: unknown): string {
  const body = data as { error?: { message?: string } | string; message?: string } | undefined;
  const raw = typeof body?.error === 'string' ? body.error : (body?.error?.message ?? body?.message);
  return `${label} API HTTP ${status}${raw ? `: ${String(raw).slice(0, 300)}` : ''}`;
}