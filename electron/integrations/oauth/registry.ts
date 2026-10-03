/**
 * The provider registry.
 *
 * This file is the ONLY place a provider's identity lives. Everything else —
 * the PKCE flow, the loopback listener, refresh, revocation, the credential
 * store, the IPC surface — is written against `OAuthProviderConfig` and has no
 * `if (provider === …)` anywhere.
 *
 * Adding a provider is therefore: append an entry here, and (if it has its own
 * API surface) add a tool module under `electron/integrations/<id>/`. No new
 * OAuth machinery, no new token store, no new IPC wiring.
 *
 * Both providers here are ordinary public REST APIs. Neither depends on a
 * proprietary or hosted Henry backend; Discord in particular is a local
 * equivalent built entirely against Discord's documented API.
 */

import type { OAuthProviderConfig } from './types';

/** Google — Gmail, Drive, and Calendar. */
export const GOOGLE_PROVIDER: OAuthProviderConfig = {
  id: 'google',
  label: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  tokenMethod: 'POST',
  // RFC 8252 §7.3 loopback. Google accepts any loopback port for Desktop-app
  // clients without pre-registration, but the port baked into redirectUri and
  // callbackPort must agree, or the redirect never arrives.
  redirectUri: 'http://127.0.0.1:9005/callback',
  callbackPort: 9005,
  callbackPath: '/callback',
  authScheme: 'Bearer',
  defaultScopes: [
    'openid',
    'email',
    // Read + compose + send. `gmail.send` is what makes gmail_send_message a
    // real send rather than a draft; without it the API answers 403.
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    // `drive.file` is app-scoped: Henry can read what it uploaded and write new
    // files, without being granted the user's entire Drive.
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ],
  scopeLabels: {
    openid: 'Confirm your Google account',
    email: 'Read your email address',
    'https://www.googleapis.com/auth/gmail.readonly': 'Read your Gmail messages',
    'https://www.googleapis.com/auth/gmail.compose': 'Create Gmail drafts',
    'https://www.googleapis.com/auth/gmail.send': 'Send email from your account',
    'https://www.googleapis.com/auth/calendar.readonly': 'Read your Google Calendar',
    'https://www.googleapis.com/auth/calendar.events': 'Create and update calendar events',
    'https://www.googleapis.com/auth/drive.readonly': 'Read your Google Drive files',
    'https://www.googleapis.com/auth/drive.file': 'Upload files to your Drive',
  },
  authorizeParams: {
    // Without access_type=offline a Desktop-app client gets no refresh token,
    // and without prompt=consent Google will not re-issue one on reconnect.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
  requiresClientSecret: true,
  clientAuth: 'body',
  supportsOAuthFlow: true,
  setupHint:
    'Create an OAuth 2.0 Client ID of type "Desktop app" in Google Cloud Console, ' +
    'enable the Gmail, Drive and Calendar APIs, and paste the client ID and client secret here.',
};

/** Discord — bot tokens and user authorization, against Discord's public REST API. */
export const DISCORD_PROVIDER: OAuthProviderConfig = {
  id: 'discord',
  label: 'Discord',
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  revokeUrl: 'https://discord.com/api/oauth2/token/revoke',
  tokenMethod: 'POST',
  // Discord desktop/CLI-style loopback redirect, per their own OAuth2 docs.
  redirectUri: 'http://127.0.0.1:9011/callback',
  callbackPort: 9011,
  callbackPath: '/callback',
  // A bot token is presented as `Authorization: Bot <token>`. A user token is
  // presented bare. Which one applies is recorded per credential, not per
  // provider, so it lives on the stored token set — the config value is the
  // default used when nothing else is known.
  authScheme: 'Bot',
  defaultScopes: ['identify', 'guilds', 'guilds.read', 'bot'],
  scopeLabels: {
    identify: 'See your username, avatar and id',
    guilds: 'See which Discord servers you are in',
    'guilds.read': 'Read server member lists',
    bot: 'Act as the application (send and read messages)',
  },
  authorizeParams: {
    // Discord requires the bot scope to be requested explicitly to receive
    // gateway/REST access on the application's behalf.
    permissions: '274878032640',
    prompt: 'consent',
  },
  requiresClientSecret: true,
  clientAuth: 'basic',
  supportsOAuthFlow: true,
  setupHint:
    'Paste a bot token from Discord → Developer Portal → your app → Bot → Reset Token, ' +
    'or connect a user account via OAuth. The bot must be invited to any server it reads.',
};

const PROVIDERS: Record<string, OAuthProviderConfig> = {
  [GOOGLE_PROVIDER.id]: GOOGLE_PROVIDER,
  [DISCORD_PROVIDER.id]: DISCORD_PROVIDER,
};

export function getProvider(id: string): OAuthProviderConfig | undefined {
  return PROVIDERS[id];
}

/** Every registered provider id, in registration order. */
export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * Throw rather than return undefined for a caller that has already validated
 * the id. Every call site reaches this through a registry lookup first, so a
 * miss here is a programming error, not a runtime condition to report.
 */
export function requireProvider(id: string): OAuthProviderConfig {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown OAuth provider: ${id}`);
  return provider;
}