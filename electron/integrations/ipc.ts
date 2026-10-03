/**
 * IPC for the integration layer.
 *
 * One set of channels for every provider, driven entirely by the registry —
 * there is no `google:` / `discord:` branching here, which is what makes "add a
 * provider" a registry entry rather than a new handler per service.
 *
 * Channels
 *   integration:list            → the providers and their setup hints (renderer)
 *   integration:status          → connection state per provider (renderer)
 *   integration:connect         → run the PKCE flow (main)
 *   integration:setToken        → store a pasted token, e.g. a Discord bot token
 *   integration:disconnect      → revoke remotely where supported, then delete locally
 *
 * SECURITY: no channel here ever returns an access token, a refresh token, or a
 * client secret to the renderer. `integration:connect` returns only
 * `{ ok, connected, expiresAt, scope }`. The renderer can tell whether it is
 * connected; it can never reconstruct a credential.
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import type { OAuthProviderConfig } from './oauth/types';
import { describeCredential } from './oauth/credentialStore';
import { connect, disconnect, OAuthFlowError } from './oauth/flow';
import { getProvider, listProviderIds } from './oauth/registry';

/** Rough shape check for a pasted token, so a typo fails fast with a clear message. */
function looksLikeToken(token: string): boolean {
  return token.length >= 32 && /^[A-Za-z0-9._-]+$/.test(token);
}

/** How a stored credential's identity facts are described to the renderer. */
function publicStatus(provider: OAuthProviderConfig, db: Database.Database) {
  return {
    id: provider.id,
    label: provider.label,
    setupHint: provider.setupHint,
    supportsOAuthFlow: provider.supportsOAuthFlow !== false,
    requiresClientSecret: provider.requiresClientSecret !== false,
    ...describeCredential(provider.id, db),
  };
}

export function registerIntegrationHandlers(
  getDb: () => Database.Database,
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle('integration:list', () => {
    return listProviderIds().map((id) => {
      const provider = getProvider(id);
      return provider
        ? {
            id: provider.id,
            label: provider.label,
            setupHint: provider.setupHint,
            scopes: provider.defaultScopes,
            supportsOAuthFlow: provider.supportsOAuthFlow !== false,
            requiresClientSecret: provider.requiresClientSecret !== false,
          }
        : { id, label: id, setupHint: '', scopes: [], supportsOAuthFlow: true, requiresClientSecret: true };
    });
  });

  ipcMain.handle('integration:status', () => {
    const db = getDb();
    return listProviderIds().map((id) => {
      const provider = getProvider(id);
      return provider ? publicStatus(provider, db) : { id, connected: false };
    });
  });

  ipcMain.handle(
    'integration:connect',
    async (
      _e,
      payload: { providerId?: string; clientId?: string; clientSecret?: string; scopes?: string[] },
    ) => {
      const providerId = String(payload?.providerId ?? '');
      const provider = getProvider(providerId);
      if (!provider) {
        return { ok: false, error: `Unknown integration: "${providerId}".` };
      }
      const clientId = String(payload?.clientId ?? '').trim();
      const clientSecret = String(payload?.clientSecret ?? '').trim();
      const scopes = Array.isArray(payload?.scopes)
        ? payload.scopes.filter((s): s is string => typeof s === 'string').slice(0, 64)
        : undefined;

      try {
        const tokens = await connect({
          provider,
          clientId,
          clientSecret,
          scopes,
          db: getDb(),
        });
        getMainWindow()?.webContents.send('integration:changed', { providerId });
        // Only non-secret facts cross back to the renderer.
        return { ok: true, connected: true, expiresAt: tokens.expiresAt || null, scope: tokens.scope || null };
      } catch (err) {
        const message =
          err instanceof OAuthFlowError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        getMainWindow()?.webContents.send('integration:changed', { providerId });
        return { ok: false, error: message };
      }
    },
  );

  /**
   * Store a token the user pasted directly. This is how Discord bot tokens are
   * connected: Discord issues them by copy-paste, and there is no refresh token
   * to refresh, so driving them through the OAuth flow would be theatre.
   */
  ipcMain.handle(
    'integration:setToken',
    async (_e, payload: { providerId?: string; token?: string; label?: string }) => {
      const providerId = String(payload?.providerId ?? '');
      const provider = getProvider(providerId);
      if (!provider) return { ok: false, error: `Unknown integration: "${providerId}".` };

      const token = String(payload?.token ?? '').trim();
      if (!looksLikeToken(token)) {
        return {
          ok: false,
          error:
            'That does not look like a Discord token. Copy it from the Developer Portal → ' +
            'your application → Bot → Reset Token (it is a long string of letters, digits, ' +
            'dots, dashes and underscores).',
        };
      }
      try {
        await connect({
          provider,
          clientId: '',
          staticToken: {
            accessToken: token,
            refreshToken: '',
            // Bot tokens do not expire; 0 means "no known expiry".
            expiresAt: 0,
            scope: '',
            tokenType: 'Bot',
            authScheme: 'Bot',
            account: payload?.label ? { name: String(payload.label).slice(0, 100) } : undefined,
          },
          db: getDb(),
        });
        getMainWindow()?.webContents.send('integration:changed', { providerId });
        return { ok: true, connected: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('integration:disconnect', async (_e, payload: { providerId?: string }) => {
    const providerId = String(payload?.providerId ?? '');
    const provider = getProvider(providerId);
    if (!provider) return { ok: false, error: `Unknown integration: "${providerId}".` };

    const result = await disconnect({ provider, db: getDb() });
    getMainWindow()?.webContents.send('integration:changed', { providerId });
    // `removed` is reported honestly: a disconnect that failed to delete the
    // row must not tell the user their token is gone when it is still on disk.
    return {
      ok: result.removed,
      removed: result.removed,
      remoteRevoked: result.remoteRevoked,
      ...(result.removed
        ? {}
        : { error: 'Could not remove the stored credential. It may still be on disk.' }),
    };
  });
}