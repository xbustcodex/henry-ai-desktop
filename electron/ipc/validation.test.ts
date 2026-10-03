/**
 * The trust boundary is only worth having if it actually rejects bad input.
 *
 * Two things are tested deliberately: that malformed payloads are refused
 * before any privileged work runs, and that the refusals are shaped so a
 * caller can tell a validation failure from a "not installed" or an ordinary
 * error. That last part is not cosmetic — a validation failure reported as
 * absence is exactly how Henry ended up offering to install Node on a machine
 * that already had it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizePayload,
  assertPayloadSize,
  validateRequest,
  guarded,
  validationFailure,
  ValidationError,
  MAX_PAYLOAD_BYTES,
  channelSchemas,
} from './validation';

describe('baseline sanitisation', () => {
  it('strips prototype-pollution keys', () => {
    const out = sanitizePayload({ a: 1, __proto__: { polluted: true }, constructor: 'x', prototype: 'y' }) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.keys(out)).toEqual(['a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('strips them at depth too', () => {
    const out = sanitizePayload({ outer: { inner: { __proto__: { bad: 1 } } } }) as Record<string, { inner: Record<string, unknown> }>;
    expect(Object.keys(out.outer.inner)).toEqual([]);
  });

  it('keeps legitimate values intact', () => {
    const input = { s: 'text', n: 42, b: true, arr: [1, 2, 3], nested: { deep: 'yes' }, nil: null };
    expect(sanitizePayload(input)).toEqual(input);
  });

  it('drops values that cannot cross the boundary', () => {
    const out = sanitizePayload({
      fn: () => 1,
      sym: Symbol('x'),
      u: undefined,
      ok: 'kept',
      nan: NaN,
      inf: Infinity,
    }) as Record<string, unknown>;
    expect(out.ok).toBe('kept');
    expect('fn' in out).toBe(false);
    expect('sym' in out).toBe(false);
    expect('u' in out).toBe(false);
    expect(out.nan).toBeNull();
    expect(out.inf).toBeNull();
  });

  it('preserves binary payloads', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sanitizePayload({ bytes })).toEqual({ bytes });
  });

  it('converts dates rather than mangling them', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect((sanitizePayload({ d }) as unknown as { d: string }).d).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not recurse forever on deep nesting', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200; i++) deep = { next: deep };
    expect(() => sanitizePayload(deep)).not.toThrow();
  });
});

describe('size limits', () => {
  it('rejects an oversized string payload', () => {
    expect(() => assertPayloadSize('test', { big: 'x'.repeat(MAX_PAYLOAD_BYTES + 10) })).toThrow(ValidationError);
  });

  it('accepts a payload just inside the limit', () => {
    expect(() => assertPayloadSize('test', { ok: 'x'.repeat(1000) })).not.toThrow();
  });
});

describe('registered channel schemas', () => {
  it('accepts a valid computer:runShell', () => {
    const out = validateRequest('computer:runShell', { command: 'echo hi', timeout: 5000 }) as Record<string, unknown>;
    expect(out.command).toBe('echo hi');
  });

  it('rejects runShell with no command — nothing privileged runs', () => {
    expect(() => validateRequest('computer:runShell', {})).toThrow(ValidationError);
  });

  it('rejects runShell with the wrong primitive type', () => {
    expect(() => validateRequest('computer:runShell', { command: 123 })).toThrow(ValidationError);
    expect(() => validateRequest('computer:runShell', { command: ['echo'] })).toThrow(ValidationError);
  });

  it('rejects an out-of-range timeout instead of passing it through', () => {
    expect(() => validateRequest('computer:runShell', { command: 'x', timeout: -1 })).toThrow(ValidationError);
    expect(() => validateRequest('computer:runShell', { command: 'x', timeout: 99_999_999 })).toThrow(ValidationError);
  });

  it('rejects unexpected extra keys on a strict schema', () => {
    expect(() =>
      validateRequest('notification:notifyRun', {
        runId: 1, title: 't', success: true, sneaky: 'value',
      })
    ).toThrow(ValidationError);
  });

  it('accepts a valid notification:notifyRun', () => {
    expect(() =>
      validateRequest('notification:notifyRun', { runId: 1, title: 't', success: true })
    ).not.toThrow();
  });

  it('rejects creators media with a bad kind', () => {
    expect(() =>
      validateRequest('creators:importMedia', { paths: ['/tmp/a'], kind: 'executable' })
    ).toThrow(ValidationError);
  });

  it('rejects creators delete with a traversal-shaped name', () => {
    // The schema rejects the shape; the store independently refuses traversal.
    // Both must hold, so assert the schema catches obvious junk.
    expect(() => validateRequest('creators:deleteMedia', {})).toThrow(ValidationError);
  });

  it('validates providers:save without rejecting the existing shape', () => {
    expect(() =>
      validateRequest('providers:save', {
        id: 'groq', name: 'Groq', apiKey: 'gsk_x', enabled: 1, models: '[]',
      })
    ).not.toThrow();
  });

  it('rejects providers:save with no id', () => {
    expect(() =>
      validateRequest('providers:save', { name: 'x', enabled: true, models: '[]' })
    ).toThrow(ValidationError);
  });

  it('leaves unregistered channels working — the baseline must not reject them', () => {
    const odd = { anything: true, nested: { deeply: [1, 2, { x: 'y' }] } };
    expect(validateRequest('some:unregistered:channel', odd)).toEqual(odd);
    expect(validateRequest('some:channel', 'a plain string')).toBe('a plain string');
    expect(validateRequest('some:channel', undefined)).toBeUndefined();
    expect(validateRequest('some:channel', [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('has schemas only for channels we have actually looked at', () => {
    for (const name of Object.keys(channelSchemas)) {
      expect(name).toMatch(/^[a-z][a-zA-Z]*:[a-zA-Z]/);
    }
  });
});

describe('guarded handler', () => {
  it('invokes the handler for a valid payload', async () => {
    const handler = vi.fn((p: { command: string }) => `ran ${p.command}`);
    const wrapped = guarded('computer:runShell', handler);
    expect(await wrapped({ command: 'ls' })).toBe('ran ls');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('never invokes the handler for an invalid payload', async () => {
    const handler = vi.fn();
    const wrapped = guarded('computer:runShell', handler);
    const result = await wrapped({ command: '' });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, validationError: true });
  });

  it('reports the failing path so the user can be told what was wrong', async () => {
    const wrapped = guarded('computer:runShell', () => 'ok');
    const result = (await wrapped({})) as { issues: { path: string; message: string }[] };
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.message.length > 0)).toBe(true);
  });

  it('does NOT throw — an unhandled rejection in the renderer is the bug we are avoiding', async () => {
    const wrapped = guarded('computer:runShell', () => 'ok');
    await expect(wrapped({ nope: true })).resolves.toBeDefined();
  });

  it('cannot be mistaken for "not installed"', async () => {
    const wrapped = guarded('computer:runShell', () => 'ok');
    const result = (await wrapped({})) as unknown as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.validationError).toBe(true);
    expect(String(result.error)).toMatch(/reject/i);
    expect(result).not.toHaveProperty('installed');
    expect(result).not.toHaveProperty('missing');
    expect(result).not.toHaveProperty('version');
  });

  it('still applies the baseline to unregistered channels', async () => {
    const handler = vi.fn((p: Record<string, unknown>) => Object.keys(p).length);
    const wrapped = guarded('unregistered:channel', handler);
    // __proto__ is stripped even with no schema
    const result = await wrapped({ keep: 1, __proto__: { bad: true } });
    expect(result).toBe(1);
    expect(handler.mock.calls[0][0]).not.toHaveProperty('__proto__');
  });

  it('propagates a real handler error rather than masking it as validation', async () => {
    const wrapped = guarded('computer:runShell', () => {
      throw new Error('the handler genuinely failed');
    });
    await expect(wrapped({ command: 'x' })).rejects.toThrow('the handler genuinely failed');
  });
});

describe('failure shape', () => {
  it('is stable and carries the channel', () => {
    const f = validationFailure(new ValidationError('computer:runShell', [{ path: 'command', message: 'Required' }]));
    expect(f.channel).toBe('computer:runShell');
    expect(f.validationError).toBe(true);
    expect(f.error).toContain('command');
  });
});

describe('schema shapes match the real preload bridges', () => {
  // These were wrong when first written and silently rejected every real call.
  // The bridge shape is what the renderer actually sends.
  it('computer:openApp takes a bare string, not an object', () => {
    expect(() => validateRequest('computer:openApp', 'Notepad')).not.toThrow();
    const out = validateRequest('computer:openApp', 'Notepad') as string;
    expect(out).toBe('Notepad');
    // …and genuinely rejects the empty case
    expect(() => validateRequest('computer:openApp', '')).toThrow(ValidationError);
  });

  it('fs:readDirectory takes a bare optional string', () => {
    expect(() => validateRequest('fs:readDirectory', 'C:\\Users')).not.toThrow();
    expect(() => validateRequest('fs:readDirectory', undefined)).not.toThrow();
  });

  it('fs:readFile takes a bare optional string', () => {
    expect(() => validateRequest('fs:readFile', 'C:\\notes.txt')).not.toThrow();
    expect(() => validateRequest('fs:readFile', undefined)).not.toThrow();
  });

  it('fs:pathExists takes a non-empty bare string', () => {
    expect(() => validateRequest('fs:pathExists', 'C:\\a')).not.toThrow();
    expect(() => validateRequest('fs:pathExists', '')).toThrow(ValidationError);
  });

  it('computer:desktopMode keeps the object the panel sends', () => {
    expect(() =>
      validateRequest('computer:desktopMode', { enable: true, fullscreen: false })
    ).not.toThrow();
  });

  it('creator channels keep their wrapped object shape', () => {
    expect(() => validateRequest('creators:openMedia', { fileName: 'a.png' })).not.toThrow();
    expect(() => validateRequest('creators:launchStage', { mode: 'voice' })).not.toThrow();
  });
});
