/**
 * The OAuth 2.0 Authorization Code + PKCE flow, once, for every provider.
 *
 * RFC 8252 §7.3 "Loopback Interface Redirection" is the correct flow for an
 * installed desktop application, and Google's own desktop-app guidance says the
 * same. This module implements it:
 *
 *   1. Generate a PKCE verifier (RFC 7636 §4.1) and its S256 challenge (§4.2).
 *   2. Generate a random `state` and bind it to this attempt.
 *   3. Open the system browser at the provider's authorize URL carrying
 *      client_id, redirect_uri, response_type=code, scope, code_challenge,
 *      code_challenge_method=S256, state.
 *   4. Listen on 127.0.0.1:<callbackPort> and wait for the provider to redirect
 *      back. The listener binds loopback only — never 0.0.0.0 — because it is
 *      an unauthenticated endpoint that accepts an authorization code.
 *   5. Reject any callback whose `state` does not match (CSRF), then exchange
 *      the code for tokens with the verifier still in memory.
 *   6. Persist the token set through `credentialStore`, encrypted at rest.
 *
 * Security properties this module is responsible for:
 *   - `state` is compared with a timing-safe equal, and a mismatched callback
 *     does not resolve the promise — it is ignored, and the listener stays up
 *     for the real callback.
 *   - The verifier is never persisted and never sent anywhere but the token
 *     endpoint of the same provider.
 *   - Tokens are never logged. Every error path is passed through `redact()`,
 *     which strips anything token-shaped before it can reach a log line, an
 *     IPC response, or a tool result.
 *   - The listener answers the browser and closes immediately on success, so a
 *     second callback cannot reuse the port.
 */

import crypto from 'crypto';
import http from 'http';
import { URL } from 'url';
import { shell } from 'electron';
import type Database from 'better-sqlite3';
import type { OAuthProviderConfig, OAuthTokenSet } from './types';
import { loadCredential, saveCredential, clearCredential } from './credentialStore';
import { log } from '../../lib/log';

// ── PKCE primitives (RFC 7636) ──────────────────────────────────────────────

/**
 * 64 random bytes, base64url — comfortably inside the 43–128 character range
 * RFC 7636 §4.1 allows, using the full alphabet.
 */
export function makeCodeVerifier(): string {
  return crypto.randomBytes(64).toString('base64url');
}

/** S256 challenge: BASE64URL(SHA256(ASCII(code_verifier))). §4.2. */
export function makeCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** 128 bits of CSRF-binding state, hex encoded. */
export function makeState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Constant-time state comparison. `===` on a short hex string is theoretically
 * timing-observable, and the cost of `timingSafeEqual` is nil.
 */
export function statesMatch(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * Strip anything token-shaped out of a string destined for a log, an IPC
 * reply, or a tool result.
 *
 * Providers echo credentials back in error bodies more often than anyone would
 * like (`{"error":"invalid_token","error_description":"Token ya29...."}`), and a
 * thrown `Response.text()` is exactly the kind of thing that ends up in a log
 * line. This is the single choke point every provider error passes through.
 */
export function redact(input: string, extraSecrets: string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    // Short values would redact half the message; a real token is never short.
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out
    .replace(/\b(ya29\.)[A-Za-z0-9._-]+/g, '$1[redacted]')
    .replace(/\b(1\/\/)[A-Za-z0-9._-]+/g, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-jwt]')
    .replace(/\b(Bearer|Bot)\s+\S+/gi, '$1 [redacted]')
    // A quoted or assigned value under a credential-bearing key. Providers and
    // proxies both do this in error bodies — `client_secret "..." was rejected`
    // — and it is the shape a leaked secret most often arrives in.
    .replace(
      /(["']?\b(?:client_?secret|access_?token|refresh_?token|id_?token|api_?key|password)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      '$1[redacted]',
    )
    .replace(
      /\b(client_?secret|access_?token|refresh_?token|id_?token|api_?key|password)\s+("[^"]*"|'[^']*'|\S+)/gi,
      '$1 [redacted]',
    );
}

/** A provider returned something that isn't a token response. */
export class OAuthFlowError extends Error {
  readonly providerId: string;
  /** True when the provider said the grant is gone — the credential is dead. */
  readonly revoked: boolean;
  constructor(providerId: string, message: string, revoked = false) {
    super(redact(message));
    this.name = 'OAuthFlowError';
    this.providerId = providerId;
    this.revoked = revoked;
  }
}

// ── Authorization URL ───────────────────────────────────────────────────────

export interface AuthorizeUrlInput {
  clientId: string;
  codeChallenge: string;
  state: string;
  scopes: string[];
  /** Overrides `provider.redirectUri`. Providers differ; the default wins. */
  redirectUri?: string;
  /** `login_hint` — used to re-auth as a specific account. */
  loginHint?: string;
}

/**
 * Build the provider's authorize URL. `response_type=code` and the S256
 * challenge are non-negotiable; nothing about this is provider-specific.
 */
export function buildAuthorizeUrl(
  provider: OAuthProviderConfig,
  input: AuthorizeUrlInput,
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri ?? provider.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  for (const [k, v] of Object.entries(provider.authorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

// ── Loopback callback listener ──────────────────────────────────────────────

export interface CallbackResult {
  code: string;
  state: string;
}

/**
 * A running loopback listener. The bound port is exposed because a provider may
 * be configured with port 0 ("let the OS pick"), in which case only the server
 * knows where the browser has to be redirected back to.
 */
export interface CallbackListener {
  /** The port actually bound. 0 only when the provider pins a fixed port. */
  port: number;
  /** Resolves with the authorization code; rejects on decline, error, or timeout. */
  waitForCode: () => Promise<CallbackResult>;
  /** Tear the listener down without settling it (e.g. the browser failed to open). */
  close: () => void;
}

/**
 * Start the loopback listener.
 *
 * A `state` mismatch is answered with an HTML page and then ignored — the
 * listener stays up so a genuine callback can still arrive. That is the CSRF
 * property: an unsolicited request must not be able to bind this attempt to an
 * attacker's session, and must not be able to tear the attempt down either.
 */
export async function startCallbackListener(
  provider: OAuthProviderConfig,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<CallbackListener> {
  // `Promise.withResolvers` is ES2024 and this project compiles against ES2022,
  // so the deferred pair is built by hand.
  let resolveCode!: (value: CallbackResult) => void;
  let rejectCode!: (reason: unknown) => void;
  const outcome = new Promise<CallbackResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The listener can be abandoned (browser failed to open, listener closed), in
  // which case nothing ever awaits `outcome` and Node would report its
  // rejection as unhandled. Marking it handled here keeps a genuine, awaited
  // rejection intact for `waitForCode()`.
  void outcome.catch(() => undefined);
  let settled = false;

  let server: http.Server;
  const timer = setTimeout(() => {
    finish(() =>
      rejectCode(
        new OAuthFlowError(provider.id, 'Authorization timed out \u2014 no callback received.'),
      ),
    );
  }, timeoutMs);
  // Don't hold the event loop open on account of this timer alone.
  if (typeof timer.unref === 'function') timer.unref();

  function finish(fn: () => void): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    fn();
  }

  server = http.createServer((req, res) => {
    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url ?? '/', provider.redirectUri);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (reqUrl.pathname !== provider.callbackPath) {
      res.writeHead(404).end();
      return;
    }

    /**
     * DNS-rebinding defence. The callback ports are fixed and well known, so a
     * hostile page could resolve its own hostname to 127.0.0.1 and reach this
     * listener through the browser. Nothing here is secret to a rebinding
     * attack — the `state` check below is what actually protects the flow — but
     * a request whose Host is not a loopback literal did not come from the
     * provider's redirect, and refusing it costs nothing.
     */
    const boundPort = (() => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : provider.callbackPort;
    })();
    const allowedHosts = new Set([
      `127.0.0.1:${boundPort}`,
      `localhost:${boundPort}`,
      '127.0.0.1',
      'localhost',
    ]);
    if (!req.headers.host || !allowedHosts.has(req.headers.host.toLowerCase())) {
      res.writeHead(421).end();
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const returnedState = reqUrl.searchParams.get('state');

    /**
     * `state` is checked FIRST, before `error=` is acted on.
     *
     * Ordering matters here, not just style. An `error=` parameter used to be
     * honoured without one, which let any page the user happened to be visiting
     * kill an in-progress authorization with a single subresource request to
     * `http://127.0.0.1:<port>/callback?error=access_denied` — the listener
     * would be torn down and the flow would fail with "you declined", for a
     * user who never declined anything. Availability only, but it presents as
     * a flaky OAuth flow and there is no way for the user to tell the
     * difference.
     */
    if (!statesMatch(expectedState, returnedState)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        callbackHtml(false, 'Invalid callback \u2014 this authorization attempt did not match.'),
      );
      return;
    }

    const error = reqUrl.searchParams.get('error');
    if (error) {
      const description =
        reqUrl.searchParams.get('error_description') ??
        (error === 'access_denied' ? 'You declined the authorization request.' : error);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        callbackHtml(false, `Authorization failed: ${description}`),
      );
      finish(() => rejectCode(new OAuthFlowError(provider.id, description)));
      return;
    }

    if (!code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        callbackHtml(false, 'Authorization failed: no code was returned.'),
      );
      finish(() => rejectCode(new OAuthFlowError(provider.id, 'No authorization code returned.')));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      callbackHtml(true, `${provider.label} is connected. You can close this tab.`),
    );
    finish(() => resolveCode({ code, state: returnedState as string }));
  });

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      finish(() =>
        rejectCode(
          new OAuthFlowError(
            provider.id,
            `Port ${provider.callbackPort} is already in use. Close whatever is using it and try again.`,
          ),
        ),
      );
    } else {
      finish(() =>
        rejectCode(new OAuthFlowError(provider.id, `Callback listener error: ${err.message}`)),
      );
    }
  });

  // Loopback only. Binding 0.0.0.0 would expose an unauthenticated
  // code-accepting endpoint to the whole network.
  //
  // The port is only known once the socket is actually bound, and with
  // callbackPort 0 the OS picks it — so the returned listener awaits that.
  const bound = new Promise<number>((resolvePort) => {
    server.once('listening', () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address ? address.port : provider.callbackPort);
    });
  });
  server.listen(provider.callbackPort, '127.0.0.1');

  const port = await bound;
  if (settled) {
    // EADDRINUSE or a zero-length timeout beat the bind; surface that reason
    // rather than handing back a listener nobody can reach.
    return { port, waitForCode: () => outcome, close: () => undefined };
  }

  return {
    port,
    waitForCode: () => outcome,
    close: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
    },
  };
}

/**
 * Convenience wrapper for callers that do not need the bound port.
 */
export async function waitForAuthorizationCode(
  provider: OAuthProviderConfig,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<CallbackResult> {
  return (await startCallbackListener(provider, expectedState, timeoutMs)).waitForCode();
}

function callbackHtml(success: boolean, message: string): string {
  const heading = success
    ? '<h2 style="color:#22c55e">✓ Connected</h2>'
    : '<h2 style="color:#ef4444">Not connected</h2>';
  return `<!DOCTYPE html><html><head><title>Henry</title></head><body style="font-family:system-ui;padding:48px;max-width:480px">
    ${heading}
    <p style="color:#6b7280">${escapeHtml(message)}</p>
    <p style="color:#6b7280;font-size:14px">You can close this tab and return to Henry.</p>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Token endpoint ──────────────────────────────────────────────────────────

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Google and Discord both answer `invalid_grant` when a refresh token has been
 * revoked by the user or by the provider's own rotation policy. That is not a
 * transient failure: the credential must be deleted, not retried.
 */
function isRevocationResponse(data: RawTokenResponse, status: number): boolean {
  const err = String(data.error ?? '');
  return status === 400 && (err === 'invalid_grant' || err === 'unauthorized_client');
}

/**
 * POST to the token endpoint. `clientAuth: 'basic'` puts the client id/secret
 * in an HTTP Basic header instead of the body (Discord's documented style);
 * 'body' is the default every other provider expects.
 */
export async function requestToken(
  provider: OAuthProviderConfig,
  params: Record<string, string>,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawTokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const body = new URLSearchParams(params);
  if (provider.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  body.set('client_id', clientId);
  if (clientSecret && provider.clientAuth !== 'basic') body.set('client_secret', clientSecret);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetchImpl(provider.tokenUrl, {
      method: provider.tokenMethod ?? 'POST',
      headers,
      body: body.toString(),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: RawTokenResponse;
    try {
      data = text ? (JSON.parse(text) as RawTokenResponse) : {};
    } catch {
      // A non-JSON body from a token endpoint is either an intercepting proxy
      // or a very confused server. Neither body nor token may be logged.
      throw new OAuthFlowError(
        provider.id,
        `${provider.label} token endpoint returned HTTP ${res.status} with a non-JSON body.`,
      );
    }
    if (!res.ok || data.error) {
      const description = String(data.error_description ?? data.error ?? `HTTP ${res.status}`);
      // The provider may quote the credential back at us. `extraSecrets` is the
      // only thing that reliably catches it — no pattern can guess an opaque
      // secret, but we know exactly which one we just sent.
      throw new OAuthFlowError(
        provider.id,
        `${provider.label} authorization failed: ${redact(description, [clientSecret])}`,
        isRevocationResponse(data, res.status),
      );
    }
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new OAuthFlowError(provider.id, `${provider.label} returned no access token.`);
    }
    return data;
  } catch (e) {
    if (e instanceof OAuthFlowError) throw e;
    const aborted = e instanceof Error && /abort/i.test(e.message);
    throw new OAuthFlowError(
      provider.id,
      aborted
        ? `${provider.label} token request timed out.`
        : `${provider.label} token request failed: ${
            redact(e instanceof Error ? e.message : String(e), [clientSecret])
          }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a raw token response into the shape the credential store persists. */
export function toTokenSet(
  provider: OAuthProviderConfig,
  data: RawTokenResponse,
  previous?: OAuthTokenSet,
): OAuthTokenSet {
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token as string,
    // A provider that omits refresh_token on refresh keeps the old one. Writing
    // '' here would silently break the next refresh.
    refreshToken:
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : (previous?.refreshToken ?? ''),
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : (previous?.expiresAt ?? 0),
    scope: typeof data.scope === 'string' ? data.scope : (previous?.scope ?? ''),
    tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    authScheme: provider.authScheme,
    account: previous?.account,
  };
}

// ── The full flow ───────────────────────────────────────────────────────────

export interface ConnectInput {
  provider: OAuthProviderConfig;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  loginHint?: string;
  /** Pre-built token set for providers with no OAuth flow (Discord bot token). */
  staticToken?: OAuthTokenSet;
  db: Database.Database;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to opening the system browser. */
  openExternal?: (url: string) => Promise<unknown>;
}

/**
 * Connect a provider and persist the credential. Returns the stored token set
 * with the access token intact — callers in the main process may use it; it is
 * never handed to the renderer.
 */
export async function connect(input: ConnectInput): Promise<OAuthTokenSet> {
  const { provider } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  // A provider with no OAuth flow (a Discord bot token) is stored directly.
  if (input.staticToken) {
    const saved = saveCredential(
      provider.id,
      { tokens: input.staticToken, clientId: input.clientId, clientSecret: input.clientSecret },
      input.db,
    );
    if (!saved) {
      throw new OAuthFlowError(
        provider.id,
        'Could not store the credential — the database is unavailable.',
      );
    }
    return input.staticToken;
  }

  if (!input.clientId) {
    throw new OAuthFlowError(provider.id, `${provider.label} needs an OAuth client ID.`);
  }
  if (provider.requiresClientSecret !== false && !input.clientSecret) {
    throw new OAuthFlowError(provider.id, `${provider.label} needs an OAuth client secret.`);
  }

  const verifier = makeCodeVerifier();
  const challenge = makeCodeChallenge(verifier);
  const state = makeState();
  const scopes = input.scopes ?? provider.defaultScopes;

  const authorizeUrl = buildAuthorizeUrl(provider, {
    clientId: input.clientId,
    codeChallenge: challenge,
    state,
    scopes,
    loginHint: input.loginHint,
  });

  const open = input.openExternal ?? ((url: string) => shell.openExternal(url));

  // Start listening first so a bind failure is reported before the user has
  // approved anything we could not receive.
  const listener = await startCallbackListener(provider, state);
  try {
    await open(authorizeUrl);
  } catch (e) {
    // The browser never opened, so no callback will arrive — release the port.
    listener.close();
    // The frame holds the client secret, so it must be named as a known secret
    // to `redact`. A browser-launch failure that quoted it back would hand a
    // credential straight to the renderer through the error string.
    throw new OAuthFlowError(
      provider.id,
      `Could not open the browser: ${redact(
        e instanceof Error ? e.message : String(e),
        [input.clientSecret ?? ''],
      )}`,
    );
  }

  const { code } = await listener.waitForCode();

  const data = await requestToken(
    provider,
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: provider.redirectUri,
    },
    input.clientId,
    input.clientSecret ?? '',
    fetchImpl,
  );

  const tokens = toTokenSet(provider, data);
  const saved = saveCredential(
    provider.id,
    { tokens, clientId: input.clientId, clientSecret: input.clientSecret },
    input.db,
  );
  if (!saved) {
    throw new OAuthFlowError(provider.id, 'Authorized, but the credential could not be stored.');
  }
  log.info(`[oauth:${provider.id}] connected, scopes: ${tokens.scope || 'n/a'}`);
  return tokens;
}

// ── Refresh ─────────────────────────────────────────────────────────────────

/** How close to expiry counts as "expired". 60s matches the QB connector. */
const REFRESH_MARGIN_MS = 60_000;

export interface EnsureTokenInput {
  provider: OAuthProviderConfig;
  db: Database.Database;
  fetchImpl?: typeof fetch;
  /**
   * Refresh even when the stored access token is still valid. Used by the
   * explicit "refresh now" path — a token can be rejected upstream before its
   * stated expiry, and the 401 retry in `apiRequest` needs a forced round trip
   * rather than a second identical failure.
   */
  forceRefresh?: boolean;
}

/**
 * Return a usable access token, refreshing first when it is within a minute of
 * expiry. This is what every Google and Discord API call goes through.
 */
export async function ensureAccessToken(input: EnsureTokenInput): Promise<OAuthTokenSet | null> {
  const { provider } = input;
  const stored = loadCredential(provider.id, input.db);
  if (!stored) return null;

  const { tokens } = stored;
  const canRefresh = Boolean(tokens.refreshToken && stored.clientId && stored.clientSecret);
  const needsRefresh =
    input.forceRefresh === true ||
    (tokens.expiresAt > 0 && tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS);

  if (!needsRefresh || !canRefresh) return tokens;

  try {
    const data = await requestToken(
      provider,
      { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
      stored.clientId as string,
      stored.clientSecret as string,
      input.fetchImpl ?? fetch,
    );
    const fresh = toTokenSet(provider, data, tokens);
    saveCredential(provider.id, { ...stored, tokens: fresh }, input.db);
    return fresh;
  } catch (e) {
    if (e instanceof OAuthFlowError && e.revoked) {
      // The grant is gone. Leaving the row behind would make every later call
      // fail with a confusing 401 instead of an actionable "reconnect".
      clearCredential(provider.id, input.db);
      log.warn(`[oauth:${provider.id}] refresh token revoked — stored credential removed`);
    }
    return null;
  }
}

// ── Revocation ──────────────────────────────────────────────────────────────

export interface DisconnectInput {
  provider: OAuthProviderConfig;
  db: Database.Database;
  fetchImpl?: typeof fetch;
}

/**
 * Disconnect: tell the provider to kill the grant when it offers an endpoint,
 * then remove the stored credential.
 *
 * Returns whether the local row was actually deleted, so a caller can report
 * honestly rather than claiming a disconnect that left a token behind.
 */
export async function disconnect(
  input: DisconnectInput,
): Promise<{ removed: boolean; remoteRevoked: boolean }> {
  const { provider } = input;
  const stored = loadCredential(provider.id, input.db);

  let remoteRevoked = false;
  if (provider.revokeUrl && stored) {
    try {
      const params: Record<string, string> = {
        token: stored.tokens.refreshToken || stored.tokens.accessToken,
      };
      if (stored.clientId) params.client_id = stored.clientId;
      if (stored.clientSecret && provider.clientAuth !== 'basic') {
        params.client_secret = stored.clientSecret;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await (input.fetchImpl ?? fetch)(provider.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
          signal: ctrl.signal,
        });
        remoteRevoked = res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // Never fails the disconnect: the local row still has to go.
      log.warn(
        `[oauth:${provider.id}] remote revoke failed: ${redact(
          e instanceof Error ? e.message : String(e),
          [stored.tokens.refreshToken, stored.tokens.accessToken, stored.clientSecret ?? ''],
        )}`,
      );
    }
  }

  const removed = clearCredential(provider.id, input.db);
  if (removed) log.info(`[oauth:${provider.id}] disconnected — stored credential removed`);
  return { removed, remoteRevoked };
}