/**
 * Provider-agnostic OAuth 2.0 types for Henry's integration layer.
 *
 * Every third-party integration Henry talks to (Google, Discord, and whatever
 * comes next) is described by ONE `OAuthProviderConfig` and driven by the same
 * engine in `engine.ts`. Adding a provider must never mean adding a second
 * PKCE implementation — that is what made the pre-existing `googleAuth.ts`
 * unreachable: a correct flow nobody could call.
 *
 * Nothing in this file touches the network or the keychain. It is types and
 * the provider registry's shape, so it is trivially testable.
 */

/** A stored credential. Never logged, never returned to the renderer. */
export interface OAuthTokenSet {
  accessToken: string;
  /** Empty string when the provider issued no refresh token (e.g. a bot token). */
  refreshToken: string;
  /** Epoch ms. 0 means "no known expiry" (Discord bot tokens do not expire). */
  expiresAt: number;
  /** Space-delimited scope string as the provider reported it. */
  scope: string;
  tokenType: string;
  /**
   * How the access token is presented in the `Authorization` header.
   *   'Bearer' — RFC 6750, the default (Google).
   *   'Bot'    — Discord bot tokens.
   *   'User'   — Discord *user* tokens, sent bare with no scheme.
   */
  authScheme: 'Bearer' | 'Bot' | 'User';
  /** Non-secret identity facts worth showing in Settings (user id, bot name…). */
  account?: Record<string, string>;
}

/**
 * Everything the engine needs that differs between providers. The engine reads
 * nothing else about a provider — no `if (provider === 'google')` branches.
 */
export interface OAuthProviderConfig {
  /** Stable id. Also the settings-table key suffix and the tool-name prefix. */
  id: string;
  label: string;

  authorizeUrl: string;
  tokenUrl: string;
  /** Omitted when the provider has no documented revocation endpoint. */
  revokeUrl?: string;
  /** HTTP method the token endpoint expects. Defaults to POST. */
  tokenMethod?: 'POST' | 'GET';

  /** Loopback redirect this provider was registered with (RFC 8252 §7.3). */
  redirectUri: string;
  /** Loopback port the callback listener binds. Must match `redirectUri`. */
  callbackPort: number;
  callbackPath: string;

  /** Scopes the agent tools need. Requested on every connect. */
  defaultScopes: string[];
  /**
   * Human labels for `defaultScopes`, shown in the consent list.
   *
   * These live beside the scopes they describe on purpose: a Settings panel
   * that keeps its own list is a consent list that silently drifts from what is
   * actually requested, which is how a user ends up granting — or believing
   * they granted — something else entirely. The renderer reads these over IPC
   * and renders them; it never declares its own.
   */
  scopeLabels?: Record<string, string>;
  /**
   * How the access token is presented in the `Authorization` header.
   *   'Bearer' — RFC 6750 (Google, and the default everywhere).
   *   'Bot'    — Discord bot tokens.
   *   'User'   — Discord *user* tokens, sent bare with no scheme.
   */
  authScheme: OAuthTokenSet['authScheme'];
  /**
   * Extra authorize-URL parameters that are not scopes. Google's
   * `access_type=offline` + `prompt=consent` are what make a refresh token
   * exist at all for a Desktop-app client.
   */
  authorizeParams?: Record<string, string>;

  /** Providers that need a client secret at the token endpoint (most do). */
  requiresClientSecret?: boolean;
  /** How the client authenticates at the token endpoint. Defaults to 'body'. */
  clientAuth?: 'body' | 'basic';
  /**
   * A provider that issues no refresh token (Discord bot tokens) must not be
   * driven through the OAuth flow at all; the user pastes the token instead.
   */
  supportsOAuthFlow?: boolean;

  /** Shown verbatim in Settings so the user knows what to create. */
  setupHint: string;
}

/** Why a token could not be produced. Drives the actionable user-facing message. */
export type TokenFailureReason =
  | 'not_configured'
  | 'not_connected'
  | 'needs_client_credentials'
  | 'revoked'
  | 'refresh_failed'
  | 'network';

export type AccessTokenOutcome =
  | { ok: true; token: OAuthTokenSet }
  | { ok: false; reason: TokenFailureReason; message: string };