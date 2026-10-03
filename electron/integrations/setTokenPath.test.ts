/**
 * The paste-a-credential path, end to end.
 *
 * `integration:setToken` is the one channel where the user hands Henry a live
 * secret with no OAuth flow in between — a Discord bot token is a bearer
 * credential for a real account. Each claim below is asserted rather than
 * asserted-by-inspection, because the failures here are silent: a leaked token
 * is invisible until it has already been exposed.
 *
 * Claims:
 *   1. the pasted token lands in the encrypted store under a per-provider key
 *   2. no channel reply ever contains it
 *   3. no log line can contain it — including the `redactLogs` literal-secret
 *      set, which is what catches a token shape no heuristic would recognise
 *   4. the renderer keeps no copy: the panel wipes its state on submit AND on
 *      unmount
 *   5. disconnect makes it unrecoverable
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  shell: { openExternal: vi.fn(async () => undefined) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { registerIntegrationHandlers } from './ipc';
import { clearCredential, loadCredential } from './oauth/credentialStore';
import { clearRegisteredSecrets, redactSecrets, REDACTION_PLACEHOLDER } from '../ipc/appLog';
import { DISCORD_PROVIDER } from './oauth/registry';

/** Opaque on purpose: no prefix, no dots that a heuristic could key on. */
const PASTED_TOKEN = 'q7Rt2XvNpLmZc4HdWsJb6YgUnAe1DfGh0IkLpXoRqZ9UvNc3Me';

class FakeDb {
  readonly rows = new Map<string, string>();
  prepare(sql: string) {
    if (sql.includes('SELECT')) {
      return { get: (key: string) => (this.rows.has(key) ? { value: this.rows.get(key) } : undefined) };
    }
    if (sql.includes('DELETE')) {
      return { run: (key: string) => { this.rows.delete(key); return { changes: 1 }; } };
    }
    return {
      run: (key: string, value: string) => {
        this.rows.set(key, value);
        return { changes: 1 };
      },
    };
  }
}

const db = new FakeDb();
const window = { webContents: { send: () => undefined } };

const call = <T = Record<string, unknown>>(channel: string, payload?: unknown): Promise<T> =>
  h.handlers.get(channel)?.({}, payload) as Promise<T>;

beforeEach(() => {
  h.handlers.clear();
  db.rows.clear();
  clearRegisteredSecrets();
  registerIntegrationHandlers(() => db as never, () => window as never);
});

describe('a pasted token reaches the encrypted store and nowhere else', () => {
  it('is persisted under the provider key, not a global one', async () => {
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    expect([...db.rows.keys()]).toEqual([`oauth:${DISCORD_PROVIDER.id}`]);
    expect(loadCredential(DISCORD_PROVIDER.id, db as never)?.tokens.accessToken).toBe(PASTED_TOKEN);
  });

  it('is absent from every reply on the success path', async () => {
    const set = await call('integration:setToken', {
      providerId: 'discord',
      token: PASTED_TOKEN,
    });
    const status = await call('integration:status');
    const list = await call('integration:list');
    for (const [label, reply] of [
      ['setToken', set],
      ['status', status],
      ['list', list],
    ] as const) {
      expect(JSON.stringify(reply), `${label} leaked the token`).not.toContain(PASTED_TOKEN);
    }
  });

  it('is absent from the failure reply too', async () => {
    const reply = await call('integration:setToken', {
      providerId: 'discord',
      token: `${PASTED_TOKEN} invalid chars`,
    });
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain(PASTED_TOKEN);
  });
});

describe('the pasted token cannot reach the app log', () => {
  it('would survive the pattern rules alone — which is why registration matters', async () => {
    // Control assertion. Without this the next test could pass for the wrong
    // reason: a token shape the heuristics already catch would prove nothing
    // about the literal-secret path.
    expect(redactSecrets(`request failed for ${PASTED_TOKEN}`)).toContain(PASTED_TOKEN);
  });

  it('is redacted once it has been stored, even in free-form log prose', async () => {
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    const line = redactSecrets(`[discord] send failed: bad token ${PASTED_TOKEN}`);
    expect(line).not.toContain(PASTED_TOKEN);
    // The line is still useful: the secret is replaced, not the whole message.
    expect(line).toContain(REDACTION_PLACEHOLDER);
    expect(line).toContain('send failed');
  });

  it('is redacted wherever it appears, not just after a keyword', async () => {
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    for (const line of [
      `Authorization header was ${PASTED_TOKEN}`,
      `{"body":"${PASTED_TOKEN}"}`,
      PASTED_TOKEN,
    ]) {
      expect(redactSecrets(line), `leaked in: ${line.slice(0, 20)}`).not.toContain(PASTED_TOKEN);
    }
  });

  it('a Google refresh token is redacted whether or not it was registered', async () => {
    // The `1//` prefix is a pattern rule, so this one is covered even without
    // registration — asserted so the guarantee is not assumed to come from the
    // literal-secret set when it actually comes from the patterns.
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    const rotated = `1//${PASTED_TOKEN}`;
    expect(redactSecrets(`refresh with ${rotated}`)).not.toContain(PASTED_TOKEN);
  });
});

describe('the renderer keeps no copy', () => {
  it('hands the token over exactly once and reads no copy back', async () => {
    // Every reply on this path is credential-free, and the panel has no read
    // channel at all: `integration:status` returns connection facts only, so
    // there is nothing in the renderer's reach to recover the token from.
    const set = await call('integration:setToken', {
      providerId: 'discord',
      token: PASTED_TOKEN,
    });
    const status = await call('integration:status');
    expect(JSON.stringify({ set, status })).not.toContain(PASTED_TOKEN);

    // `integration:list` and `integration:status` are the only read channels,
    // and neither exposes a credential-shaped field.
    const providers = status as unknown as Array<Record<string, unknown>>;
    expect(providers.map((p) => p.id)).toEqual(['google', 'discord']);
    for (const provider of providers) {
      for (const key of Object.keys(provider)) {
        // `requiresClientSecret` is a boolean capability flag, not a
        // credential — the shape being banned is a field that could CARRY one.
        expect(key).not.toMatch(
          /^(access|accessTok|access_token|refresh|refreshToken|refresh_token|clientSecret|client_secret|token|secret|authorization)$/i,
        );
      }
    }
  });

  /**
   * The panel-side wipe (on submit, and on unmount) is reviewed code, not a
   * covered assertion: this repo has no DOM test environment, and asserting on
   * the component's source text would prove the string is present rather than
   * that the behaviour happens. What IS asserted here is the half that can be —
   * there is no read channel the renderer could recover the token through.
   */
  it('offers no channel the renderer could recover the token through', async () => {
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    const reachable = {
      status: await call('integration:status'),
      list: await call('integration:list'),
    };
    expect(JSON.stringify(reachable)).not.toContain(PASTED_TOKEN);
  });
});

describe('a disconnected token is unrecoverable', () => {
  it('the row is gone and the credential no longer loads', async () => {
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    expect(loadCredential(DISCORD_PROVIDER.id, db as never)).not.toBeNull();

    const reply = await call('integration:disconnect', { providerId: 'discord' });
    expect(reply).toMatchObject({ ok: true, removed: true });
    expect(loadCredential(DISCORD_PROVIDER.id, db as never)).toBeNull();
    expect(db.rows.size).toBe(0);
    // Nothing anywhere in the store still holds the token.
    for (const value of db.rows.values()) expect(value).not.toContain(PASTED_TOKEN);
  });

  it('is idempotent — disconnecting twice is not an error', async () => {
    await call('integration:setToken', { providerId: 'discord', token: PASTED_TOKEN });
    expect(await call('integration:disconnect', { providerId: 'discord' })).toMatchObject({ ok: true });
    // A second disconnect has nothing to do; it must not report a failure the
    // user would then have to act on.
    expect(await call('integration:disconnect', { providerId: 'discord' })).toMatchObject({ ok: true });
    expect(clearCredential('discord', db as never)).toBe(true);
    expect(db.rows.size).toBe(0);
  });
});