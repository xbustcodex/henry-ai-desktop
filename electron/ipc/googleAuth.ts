/**
 * Henry AI — Google Desktop OAuth (IPC surface).
 *
 * The Authorization Code + PKCE + loopback flow itself now lives in ONE place,
 * `electron/integrations/oauth/`, and every provider uses it. This module is
 * the legacy `google:*` IPC facade over that shared engine, kept so the
 * existing Settings panel keeps working unchanged.
 *
 * What changed, and why:
 *   - The token set used to live in two module-level variables, so it died with
 *     the process and no other module could read it. That is why row 10.1 was
 *     PARTIAL: the connect surface was live and the agent had nothing to spend.
 *     Credentials now live in the shared encrypted store (settings table +
 *     safeStorage), which is the same store the Google agent tools read.
 *   - The client id/secret are stored with the credential, so a refresh no
 *     longer depends on the renderer passing them back in on every call.
 *   - `google:startAuth` no longer returns the access token to the renderer.
 *     The panel never used it, and handing a renderer a live token is exactly
 *     the shape of thing that later leaks into a log or a screenshot.
 *
 * Flow (unchanged, and still correct per RFC 8252 §7.3 for installed apps):
 *   1. Renderer calls `google:startAuth` with { clientId, clientSecret }.
 *   2. Main generates PKCE verifier/challenge + random state.
 *   3. Main opens the system browser at Google's auth endpoint.
 *   4. Main listens on 127.0.0.1:9005 for the redirect.
 *   5. Google redirects back with ?code=…&state=…
 *   6. Main exchanges the code for access + refresh tokens.
 *   7. Tokens are encrypted with safeStorage and persisted.
 *
 * GOOGLE CLOUD CONSOLE REQUIREMENTS (unchanged):
 *   - Create an OAuth 2.0 client of type "Desktop app"
 *   - Enable: Gmail API, Google Calendar API, Google Drive API
 *   - No redirect URI needs to be added — Google accepts 127.0.0.1 loopback
 *     automatically for Desktop app clients (RFC 8252 §7.3)
 *   - Copy the client_id and client_secret into Henry's Google settings
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { GOOGLE_PROVIDER } from '../integrations/oauth/registry';
import { connect, ensureAccessToken, disconnect, OAuthFlowError } from '../integrations/oauth/flow';
import { clearCredential, describeCredential, hasCredential } from '../integrations/oauth/credentialStore';

/** The provider object this module drives. Read from the shared registry. */
const PROVIDER = GOOGLE_PROVIDER;

/**
 * The live database handle. `getDb` throws before `initDatabase` runs, so a
 * boot-race call degrades to "no credential" rather than taking the app down.
 */
function currentDb(): Database.Database | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

export function registerGoogleAuthHandlers(getMainWindow: () => BrowserWindow | null): void {
  /**
   * Start the PKCE + loopback flow.
   *
   * Returns `{ ok: true, connected, expiresAt, scope }` on success — never the
   * access token. Throws nothing: failures come back as `{ ok: false, error }`
   * so the renderer can show the message without an unhandled rejection.
   */
  ipcMain.handle(
    'google:startAuth',
    async (
      _e,
      { clientId, clientSecret, scopes }: { clientId: string; clientSecret: string; scopes?: string[] },
    ) => {
      // The panel offers a scope list; the provider's own list is the floor.
      // Merging means the agent's scopes (gmail.send, drive.file) are always
      // requested even if an older panel only offers the read-only set.
      const db = currentDb();
      if (!db) return { ok: false, connected: false, error: 'Henry is still starting up — try again in a moment.' };
      const requested = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string') : [];
      const merged = Array.from(new Set([...PROVIDER.defaultScopes, ...requested]));
      try {
        const tokens = await connect({
          provider: PROVIDER,
          clientId,
          clientSecret,
          scopes: merged,
          db,
        });
        return {
          ok: true,
          connected: true,
          expiresAt: tokens.expiresAt || null,
          scope: tokens.scope || null,
        };
      } catch (e) {
        const message = e instanceof OAuthFlowError ? e.message : e instanceof Error ? e.message : String(e);
        return { ok: false, connected: false, error: message };
      }
    },
  );

  /**
   * Get the current access token, refreshing automatically inside a minute of
   * expiry. Returns null when nothing is stored (the user needs to connect).
   * Emits `google:tokenRevoked` if the refresh token was revoked upstream.
   *
   * This handler no longer takes client credentials. They used to have to be
   * passed back by the renderer on every single call, which meant a refresh
   * silently failed whenever the caller forgot; they are stored with the
   * credential now.
   */
  ipcMain.handle('google:getToken', async () => {
    const db = currentDb();
    if (!db) return null;
    const before = describeCredential(PROVIDER.id, db).connected;
    const tokens = await ensureAccessToken({ provider: PROVIDER, db });
    if (!tokens) {
      // The engine deletes a revoked credential on its way to returning null;
      // tell the renderer rather than leaving a panel showing "connected".
      if (before) getMainWindow()?.webContents.send('google:tokenRevoked');
      return null;
    }
    return {
      // Legacy field: some callers expect a bare token shape. The renderer
      // receives the short-lived access token, never the refresh token.
      ok: true,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    };
  });

  /**
   * Explicit refresh — the agent's `apiRequest` path uses this on a 401.
   * Returns the new access token, or throws if revoked.
   */
  ipcMain.handle('google:refreshToken', async () => {
    const db = currentDb();
    if (!db || !hasCredential(PROVIDER.id, db)) {
      throw new Error('No Google refresh token stored. Please reconnect Google.');
    }
    // Force a real round trip: a token can be rejected upstream before its
    // stated expiry, and returning the same rejected token is not a refresh.
    const tokens = await ensureAccessToken({ provider: PROVIDER, db, forceRefresh: true });
    if (!tokens) {
      getMainWindow()?.webContents.send('google:tokenRevoked');
      throw new Error('Google refresh failed — the token was likely revoked. Please reconnect Google.');
    }
    return { ok: true, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  });

  /**
   * Check whether long-term credentials exist.
   * Returns true even if the access token has expired (we can still refresh).
   */
  ipcMain.handle('google:hasCredentials', () => {
    const db = currentDb();
    return db ? hasCredential(PROVIDER.id, db) : false;
  });

  /**
   * Wipe all stored credentials — user disconnecting Google.
   * Revokes upstream first where Google supports it, then deletes the row.
   */
  ipcMain.handle('google:disconnect', async () => {
    const db = currentDb();
    if (!db) return { ok: false, error: 'Henry is still starting up — try again in a moment.' };
    const result = await disconnect({ provider: PROVIDER, db });
    // Belt and braces: if the revoke path somehow left the row, delete it.
    if (!result.removed) clearCredential(PROVIDER.id, db);
    getMainWindow()?.webContents.send('google:tokenRevoked');
    return { ok: true, ...describeCredential(PROVIDER.id, db) };
  });
}