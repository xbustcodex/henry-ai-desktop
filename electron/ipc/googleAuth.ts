/**
 * Henry AI — Google Desktop OAuth
 *
 * Implements Authorization Code + PKCE + offline_access for the Electron
 * desktop app.  This is the correct flow for installed applications
 * per RFC 8252 and Google's own desktop-app guidance.
 *
 * FLOW:
 *   1. Renderer calls `google:startAuth` with { clientId, clientSecret }
 *   2. Main process generates PKCE verifier/challenge + random state
 *   3. Main process opens system browser at Google's auth endpoint
 *   4. Main process starts a temporary HTTP listener on 127.0.0.1:9005
 *   5. After user approves, Google redirects to http://127.0.0.1:9005/callback?code=…
 *   6. Main process exchanges the code for access + refresh tokens
 *   7. Tokens are encrypted with safeStorage (OS keychain / DPAPI / SecretService)
 *   8. Only the short-lived access token + expiry are sent back to the renderer
 *
 * REFRESH:
 *   `google:getToken` automatically refreshes if the stored token is within
 *   5 minutes of expiry.  Refresh failures due to revocation clear credentials
 *   and push a `google:tokenRevoked` event to the renderer.
 *
 * GOOGLE CLOUD CONSOLE REQUIREMENTS (documented for the user):
 *   - Create an OAuth 2.0 client of type "Desktop app"
 *   - Enable: Gmail API, Google Calendar API, Google Drive API
 *   - No redirect URI needs to be added — Google accepts 127.0.0.1 loopback
 *     automatically for Desktop app clients (RFC 8252 §7.3)
 *   - Copy the client_id and client_secret into Henry's Google settings
 */

import { ipcMain, shell, safeStorage } from 'electron';
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';
import type { BrowserWindow } from 'electron';

// ── Constants ─────────────────────────────────────────────────────────────────

const CALLBACK_PORT = 9005;
const CALLBACK_PATH = '/callback';
const CALLBACK_URL  = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

/** All scopes Henry needs.  Granted once via `prompt=consent`. */
const SCOPES = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

// ── In-memory credential storage ─────────────────────────────────────────────
// Refresh tokens never leave the main process.
// Access tokens are sent to the renderer as short-lived strings.

interface GoogleTokenSet {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number;   // epoch ms
  scopes:       string;
}

/** Encrypted credential buffer (Electron safeStorage). */
let credentialBuffer: Buffer | null = null;

/** Fallback when safeStorage is unavailable (dev / headless). */
let credentialPlaintext: string | null = null;

function persistCredentials(tokenSet: GoogleTokenSet): void {
  const json = JSON.stringify(tokenSet);
  if (safeStorage.isEncryptionAvailable()) {
    credentialBuffer    = safeStorage.encryptString(json);
    credentialPlaintext = null;
  } else {
    credentialPlaintext = json;
    credentialBuffer    = null;
  }
}

function retrieveCredentials(): GoogleTokenSet | null {
  try {
    if (credentialBuffer && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(credentialBuffer)) as GoogleTokenSet;
    }
    if (credentialPlaintext) {
      return JSON.parse(credentialPlaintext) as GoogleTokenSet;
    }
  } catch {
    // Corrupted — treat as missing
  }
  return null;
}

function wipeCredentials(): void {
  credentialBuffer    = null;
  credentialPlaintext = null;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function makeCodeVerifier(): string {
  return crypto.randomBytes(64).toString('base64url');
}

function makeCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Loopback callback listener ────────────────────────────────────────────────

/**
 * Starts a temporary HTTP server on 127.0.0.1:9005.
 * Resolves with the authorization code when Google redirects back.
 * The server is destroyed immediately after receiving the first valid callback.
 */
function waitForAuthorizationCode(expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);

        if (reqUrl.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }

        const code          = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const error         = reqUrl.searchParams.get('error');

        // Always respond with HTML so the browser tab shows a friendly message
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

        if (error) {
          const msg = error === 'access_denied'
            ? 'You declined the authorization request.'
            : `Authorization failed: ${error}`;
          res.end(`<!DOCTYPE html><html><head><title>Henry</title></head><body style="font-family:system-ui;padding:48px;max-width:480px">
            <h2 style="color:#ef4444">Authorization declined</h2>
            <p style="color:#6b7280">${msg}</p>
            <p style="color:#6b7280;font-size:14px">You can close this tab and return to Henry.</p>
          </body></html>`);
          server.close();
          reject(new Error(msg));
          return;
        }

        if (!code || returnedState !== expectedState) {
          res.end('Invalid callback. You can close this tab.');
          return;
        }

        res.end(`<!DOCTYPE html><html><head><title>Henry</title></head><body style="font-family:system-ui;padding:48px;max-width:480px">
          <h2 style="color:#22c55e">✓ Henry is connected</h2>
          <p style="color:#6b7280">Google authorization was successful. You can close this tab and return to Henry.</p>
        </body></html>`);

        server.close();
        resolve(code);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${CALLBACK_PORT} is already in use. Close any other process using it and try again.`
        ));
      } else {
        reject(new Error(`Callback listener error: ${err.message}`));
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCodeForTokens(
  code:         string,
  codeVerifier: string,
  clientId:     string,
  clientSecret: string,
): Promise<GoogleTokenSet> {
  const body = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  CALLBACK_URL,
    grant_type:    'authorization_code',
    code_verifier: codeVerifier,
  });

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json() as Record<string, unknown>;

  if (!res.ok || data.error) {
    throw new Error(
      String(data.error_description ?? data.error ?? `Token exchange failed (HTTP ${res.status})`)
    );
  }

  if (!data.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Make sure the OAuth client type is "Desktop app" and try again.'
    );
  }

  return {
    accessToken:  data.access_token  as string,
    refreshToken: data.refresh_token as string,
    expiresAt:    Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    scopes:       (data.scope as string) ?? SCOPES,
  };
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function doRefreshToken(
  refreshToken: string,
  clientId:     string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'refresh_token',
  });

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json() as Record<string, unknown>;

  if (!res.ok || data.error) {
    throw new Error(
      String(data.error_description ?? data.error ?? `Token refresh failed (HTTP ${res.status})`)
    );
  }

  return {
    accessToken: data.access_token as string,
    expiresAt:   Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
  };
}

const REVOKED_ERRORS = new Set(['invalid_grant', 'Token has been expired or revoked']);

function isRevocationError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return REVOKED_ERRORS.has(msg) || msg.includes('invalid_grant') || msg.includes('revoked');
}

// ── IPC registration ──────────────────────────────────────────────────────────

export function registerGoogleAuthHandlers(getMainWindow: () => BrowserWindow | null): void {

  /**
   * Start the PKCE + loopback flow.
   * Returns { accessToken, expiresAt } to the renderer on success.
   * Throws a string message on failure (the renderer should show it to the user).
   */
  ipcMain.handle('google:startAuth', async (
    _e,
    { clientId, clientSecret }: { clientId: string; clientSecret: string }
  ) => {
    const codeVerifier   = makeCodeVerifier();
    const codeChallenge  = makeCodeChallenge(codeVerifier);
    const state          = crypto.randomBytes(16).toString('hex');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',             clientId);
    authUrl.searchParams.set('redirect_uri',          CALLBACK_URL);
    authUrl.searchParams.set('response_type',         'code');
    authUrl.searchParams.set('scope',                 SCOPES);
    authUrl.searchParams.set('code_challenge',        codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state',                 state);
    authUrl.searchParams.set('access_type',           'offline');
    authUrl.searchParams.set('prompt',                'consent');

    // Open system default browser — not an Electron BrowserWindow
    await shell.openExternal(authUrl.toString());

    // Block until Google redirects to the loopback listener
    const code = await waitForAuthorizationCode(state);

    // Exchange for tokens — refresh token is captured and stored here in main process
    const tokenSet = await exchangeCodeForTokens(code, codeVerifier, clientId, clientSecret);
    persistCredentials(tokenSet);

    // Return only the short-lived access token to the renderer
    return { accessToken: tokenSet.accessToken, expiresAt: tokenSet.expiresAt };
  });

  /**
   * Get the current access token.
   * Automatically refreshes if the token will expire within 5 minutes.
   * Returns null if no credentials are stored (user needs to connect).
   * Emits `google:tokenRevoked` if the refresh token was revoked.
   */
  ipcMain.handle('google:getToken', async (
    _e,
    auth?: { clientId?: string; clientSecret?: string },
  ) => {
    // The app's OAuth client credentials, supplied by the caller. Previously
    // the preload invoked this with no argument, so this destructuring threw.
    const clientId = auth?.clientId ?? '';
    const clientSecret = auth?.clientSecret ?? '';
    const creds = retrieveCredentials();
    if (!creds) return null;

    const fiveMinutes = 5 * 60 * 1000;
    const needsRefresh = creds.expiresAt - Date.now() < fiveMinutes;

    if (!needsRefresh) {
      return { accessToken: creds.accessToken, expiresAt: creds.expiresAt };
    }

    // Proactive silent refresh
    try {
      const refreshed = await doRefreshToken(creds.refreshToken, clientId, clientSecret);
      persistCredentials({ ...creds, ...refreshed });
      return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    } catch (err) {
      if (isRevocationError(err)) {
        wipeCredentials();
        getMainWindow()?.webContents.send('google:tokenRevoked');
      }
      return null;
    }
  });

  /**
   * Explicit refresh — called by the renderer when a 401 is received.
   * Returns the new access token, or throws if revoked.
   */
  ipcMain.handle('google:refreshToken', async (
    _e,
    auth?: { clientId?: string; clientSecret?: string },
  ) => {
    // The app's OAuth client credentials, supplied by the caller. Previously
    // the preload invoked this with no argument, so this destructuring threw.
    const clientId = auth?.clientId ?? '';
    const clientSecret = auth?.clientSecret ?? '';
    const creds = retrieveCredentials();
    if (!creds?.refreshToken) {
      throw new Error('No refresh token stored. Please reconnect Google.');
    }

    try {
      const refreshed = await doRefreshToken(creds.refreshToken, clientId, clientSecret);
      persistCredentials({ ...creds, ...refreshed });
      return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    } catch (err) {
      if (isRevocationError(err)) {
        wipeCredentials();
        getMainWindow()?.webContents.send('google:tokenRevoked');
      }
      throw err;
    }
  });

  /**
   * Check whether long-term credentials exist in the main process.
   * Returns true even if the access token is expired (we can still refresh).
   */
  ipcMain.handle('google:hasCredentials', () => {
    return retrieveCredentials() !== null;
  });

  /**
   * Wipe all stored credentials — user disconnecting Google.
   */
  ipcMain.handle('google:disconnect', () => {
    wipeCredentials();
  });
}
