/**
 * `computer:click` interpolates x and y straight into an AppleScript string, and
 * preload typed the payload as `Record<string, unknown>` — so a crafted
 * renderer could smuggle arbitrary AppleScript through what looked like a
 * number. It is macOS-only at the handler, but that is exactly why a type that
 * says "number" and a runtime that says "anything" is a hole.
 *
 * These tests assert the boundary holds, and — just as important — that an
 * ordinary click still works.
 */
import { describe, it, expect } from 'vitest';
import { validateRequest, ValidationError, guardedEvent } from './validation';

const click = (payload: unknown) => validateRequest('computer:click', payload);

describe('computer:click — injection', () => {
  it('accepts the ordinary shape', () => {
    expect(click({ x: 100, y: 200 })).toMatchObject({ x: 100, y: 200 });
    expect(click({ x: 0, y: 0, button: 'right' })).toMatchObject({ button: 'right' });
  });

  it('accepts negative and fractional coordinates', () => {
    expect(() => click({ x: -5.5, y: 12.25 })).not.toThrow();
  });

  it('refuses a string where a number belongs', () => {
    expect(() => click({ x: '0', y: 0 })).toThrow(ValidationError);
    expect(() => click({ x: 0, y: '0' })).toThrow(ValidationError);
  });

  it('refuses the AppleScript payload that made this exploitable', () => {
    const attack = {
      x: '0} to {1,2} \n tell application "Calculator" to activate \n end tell \n tell application "System Events" to click at {0',
      y: 0,
    };
    expect(() => click(attack)).toThrow(ValidationError);
  });

  it('refuses an object or array smuggled in as a coordinate', () => {
    expect(() => click({ x: { toString: 1 }, y: 0 })).toThrow(ValidationError);
    expect(() => click({ x: [1], y: 0 })).toThrow(ValidationError);
  });

  it('refuses a missing coordinate', () => {
    expect(() => click({ y: 0 })).toThrow(ValidationError);
    expect(() => click({})).toThrow(ValidationError);
    expect(() => click(undefined)).toThrow(ValidationError);
  });

  it('refuses NaN and Infinity, which would stringify into the command', () => {
    expect(() => click({ x: Number.NaN, y: 0 })).toThrow(ValidationError);
    expect(() => click({ x: 0, y: Number.POSITIVE_INFINITY })).toThrow(ValidationError);
  });

  it('refuses an unknown button rather than passing it through', () => {
    expect(() => click({ x: 0, y: 0, button: 'wheel' })).toThrow(ValidationError);
    expect(() => click({ x: 0, y: 0, button: "right' ; calc" })).toThrow(ValidationError);
  });

  it('refuses unexpected extra keys', () => {
    expect(() => click({ x: 0, y: 0, extra: 'nope' })).toThrow(ValidationError);
  });
});

describe('guardedEvent wiring', () => {
  it('passes the payload through untouched when it is valid', async () => {
    const seen: unknown[] = [];
    const wrapped = guardedEvent('computer:click', (_e, p: { x: number; y: number }) => {
      seen.push(p);
      return { success: true };
    });
    const result = await wrapped({}, { x: 5, y: 6 });
    expect(result).toEqual({ success: true });
    expect(seen[0]).toMatchObject({ x: 5, y: 6 });
  });

  it('does not invoke the handler for an injection attempt', async () => {
    let called = false;
    const wrapped = guardedEvent('computer:click', () => {
      called = true;
      return { success: true };
    });
    const result = (await wrapped({}, { x: '1) to run shell code #', y: 0 })) as Record<string, unknown>;
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.validationError).toBe(true);
  });

  it('does not throw across the IPC boundary', async () => {
    const wrapped = guardedEvent('computer:click', () => ({ success: true }));
    await expect(wrapped({}, 'not even an object')).resolves.toBeDefined();
  });
});

describe('computer:runShell', () => {
  it('accepts the real call shape', () => {
    expect(() => validateRequest('computer:runShell', { command: 'echo hi' })).not.toThrow();
    expect(() => validateRequest('computer:runShell', { command: 'echo hi', timeout: 5000 })).not.toThrow();
  });

  it('refuses an empty or missing command', () => {
    expect(() => validateRequest('computer:runShell', { command: '' })).toThrow(ValidationError);
    expect(() => validateRequest('computer:runShell', {})).toThrow(ValidationError);
  });

  it('refuses an out-of-range timeout instead of forwarding it', () => {
    expect(() => validateRequest('computer:runShell', { command: 'x', timeout: -5 })).toThrow(ValidationError);
    expect(() => validateRequest('computer:runShell', { command: 'x', timeout: 1e12 })).toThrow(ValidationError);
  });
});

describe('desktopMode is not strict on purpose', () => {
  it('still accepts the fullscreen flag HQPanel sends', () => {
    // The handler ignores `fullscreen`; that is a handler bug, not a reason to
    // reject a live call.
    expect(() =>
      validateRequest('computer:desktopMode', { enable: true, fullscreen: true })
    ).not.toThrow();
  });
});

describe('google schemas keep the empty-credential default', () => {
  it('accepts the empty strings preload substitutes when the renderer omits creds', () => {
    expect(() =>
      validateRequest('google:getToken', { clientId: '', clientSecret: '' })
    ).not.toThrow();
  });

  it('accepts a payload with no credentials at all', () => {
    expect(() => validateRequest('google:getToken', {})).not.toThrow();
  });

  it('accepts the scopes the preload sends, even though the handler ignores them', () => {
    expect(() =>
      validateRequest('google:startAuth', {
        clientId: 'a', clientSecret: 'b', scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      })
    ).not.toThrow();
  });
});

describe('fs channels use their real names', () => {
  it('validates fs:readFile under its REAL name and bare-string shape', () => {
    // preload bridges these as bare strings: readFile: (filePath) => invoke('fs:readFile', filePath)
    expect(() => validateRequest('fs:readFile', '/tmp/x')).not.toThrow();
    expect(() => validateRequest('fs:readFile', { filePath: '/tmp/x' })).toThrow(ValidationError);
    // The invented channel name is simply unguarded, which is why the first
    // draft of the schema map was wrong.
    expect(() => validateRequest('filesystem:read', { path: '/tmp/x' })).not.toThrow();
  });

  it('refuses a missing path on fs:writeFile', () => {
    expect(() => validateRequest('fs:writeFile', { content: 'x' })).toThrow(ValidationError);
  });
});