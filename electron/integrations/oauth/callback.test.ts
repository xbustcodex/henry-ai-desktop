/**
 * Loopback callback listener tests.
 *
 * These drive the real HTTP listener the app binds during an OAuth flow — no
 * mock, no network egress beyond 127.0.0.1. The assertions are the security
 * properties a unit test can actually prove:
 *
 *   - a matching state + code resolves
 *   - a mismatched state is IGNORED and the listener stays open for the real
 *     one. An implementation that rejected the whole attempt on a bad state
 *     would still pass a naive "does it reject?" test, so the second half of
 *     each case matters as much as the first.
 *   - `?error=access_denied` rejects with a readable message
 *   - the wrong path 404s and does not settle the listener
 *   - the listener closes its port after a successful callback, so nothing is
 *     left holding the loopback endpoint open
 */
import { describe, it, expect } from 'vitest';
import { startCallbackListener, waitForAuthorizationCode } from './flow';
import type { OAuthProviderConfig } from './types';

/**
 * Port 0 asks the OS for a free port. The listener reports back the port it
 * actually bound, which is what the browser would be redirected to.
 */
function testProvider(): OAuthProviderConfig {
  return {
    id: 'testprovider',
    label: 'Test Provider',
    authorizeUrl: 'https://example.test/authorize',
    tokenUrl: 'https://example.test/token',
    redirectUri: 'http://127.0.0.1/callback',
    callbackPort: 0,
    callbackPath: '/callback',
    defaultScopes: ['a'],
    authScheme: 'Bearer',
    setupHint: 'test only',
  };
}

/**
 * Wait for the listener to accept a connection, by opening and immediately
 * closing a socket. Retrying is the wait condition itself, not a guessed sleep.
 */
async function untilListening(port: number): Promise<void> {
  const net = await import('net');
  for (let attempt = 0; attempt < 200; attempt++) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('callback listener never started');
}

describe('startCallbackListener', () => {
  it('resolves with the code when the state matches', async () => {
    const listener = await startCallbackListener(testProvider(), 'expected-state', 5000);
    await untilListening(listener.port);

    const res = await fetch(
      `http://127.0.0.1:${listener.port}/callback?code=auth-code-1&state=expected-state`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Connected');

    await expect(listener.waitForCode()).resolves.toEqual({
      code: 'auth-code-1',
      state: 'expected-state',
    });

    // The port must be released once the flow is done — an unauthenticated
    // code-accepting socket left open is a standing target.
    await expect(
      fetch(`http://127.0.0.1:${listener.port}/callback?code=x&state=expected-state`).catch(
        (e: Error) => {
          throw new Error('listener still open: ' + e.message);
        },
      ),
    ).rejects.toThrow(/listener still open/);
  });

  it('ignores a callback whose state does not match, then accepts the real one', async () => {
    const listener = await startCallbackListener(testProvider(), 'expected-state', 5000);
    await untilListening(listener.port);

    const forged = await fetch(
      `http://127.0.0.1:${listener.port}/callback?code=attacker-code&state=forged-state`,
    );
    expect(forged.status).toBe(200);
    expect(await forged.text()).toContain('did not match');

    const genuine = await fetch(
      `http://127.0.0.1:${listener.port}/callback?code=real-code&state=expected-state`,
    );
    expect(genuine.status).toBe(200);
    await expect(listener.waitForCode()).resolves.toMatchObject({ code: 'real-code' });
  });

  it('rejects a callback that carries a code but no state at all', async () => {
    const listener = await startCallbackListener(testProvider(), 'expected-state', 5000);
    await untilListening(listener.port);

    const res = await fetch(`http://127.0.0.1:${listener.port}/callback?code=no-state-code`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('did not match');

    // Still open for the genuine callback.
    await fetch(
      `http://127.0.0.1:${listener.port}/callback?code=real&state=expected-state`,
    );
    await expect(listener.waitForCode()).resolves.toMatchObject({ code: 'real' });
  });

  it('rejects with a readable message when the user declines', async () => {
    const listener = await startCallbackListener(testProvider(), 'expected-state', 5000);
    await untilListening(listener.port);

    await fetch(
      `http://127.0.0.1:${listener.port}/callback?error=access_denied&state=expected-state`,
    );
    await expect(listener.waitForCode()).rejects.toThrow(/declined/i);
  });

  it('404s an unrelated path without settling the listener', async () => {
    const listener = await startCallbackListener(testProvider(), 'expected-state', 5000);
    await untilListening(listener.port);
    let settled = false;
    const code = listener.waitForCode().then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        throw e;
      },
    );
    // Keep the rejection from surfacing as an unhandled rejection; this test
    // asserts on `settled`, not on the value.
    const guard = code.catch(() => undefined);

    const res = await fetch(
      `http://127.0.0.1:${listener.port}/not-the-callback?code=x&state=expected-state`,
    );
    expect(res.status).toBe(404);
    expect(settled).toBe(false);

    await fetch(`http://127.0.0.1:${listener.port}/callback?code=real&state=expected-state`);
    await expect(code).resolves.toMatchObject({ code: 'real' });
    await guard;
  });

  it('releases the port when closed without settling', async () => {
    const listener = await startCallbackListener(testProvider(), 'expected-state', 5000);
    await untilListening(listener.port);
    listener.close();

    await expect(
      fetch(`http://127.0.0.1:${listener.port}/callback?code=x&state=expected-state`),
    ).rejects.toThrow();
  });
});

describe('waitForAuthorizationCode', () => {
  it('times out rather than holding the port forever', async () => {
    await expect(waitForAuthorizationCode(testProvider(), 'expected-state', 60)).rejects.toThrow(
      /timed out/i,
    );
  });
});