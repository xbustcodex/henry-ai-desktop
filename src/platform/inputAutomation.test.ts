/**
 * Row 7.3 — desktop input automation.
 *
 * Two jobs here.
 *
 * 1. Regression safety net for the hardening already accepted in Card 7:
 *    coordinates that used to interpolate into an AppleScript string, a wrong
 *    typed key payload that used to throw a raw TypeError across IPC, and the
 *    Windows SendKeys string that used to be handed the caller's text.
 *
 * 2. Proof that the new Windows backend is real: a Win32 `SendInput` shim
 *    reached through PowerShell, with the caller's text carried as data over
 *    stdin or in an environment variable — never spliced into the script.
 */
import { describe, it, expect } from 'vitest';
import {
  clampPoint,
  normaliseButton,
  normaliseKeyExpression,
  normaliseModifiers,
  normaliseRepeat,
  normaliseText,
  encodePowerShellCommand,
  windowsHelperArgv,
  windowsKeyRequest,
  windowsMouseRequest,
  parseModifierList,
  execBinary,
  MAX_TEXT,
  TYPE_CHUNK,
} from './inputAutomation';

const BOUNDS = { width: 1920, height: 1080 };

describe('coordinates — the injection that was already fixed must stay fixed', () => {
  it('refuses the AppleScript payload the old schema caught', () => {
    // This exact shape was an AppleScript injection when x/y were interpolated.
    const r = clampPoint(
      '0} to {1,2} \n tell application "Calculator" to activate \n end tell \n tell application "System Events" to click at {0',
      0,
      BOUNDS,
    );
    expect(r.ok).toBe(false);
  });

  it('refuses a numeric string rather than parsing it', () => {
    // `Number(' 12 ')` is 12, so a lenient coercion would let a string reach
    // the backend at all. Coordinates are numbers or they are nothing.
    expect(clampPoint('100', 200, BOUNDS).ok).toBe(false);
    expect(clampPoint(100, '200', BOUNDS).ok).toBe(false);
  });

  it('refuses NaN, Infinity, null, undefined, objects and arrays', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [], true]) {
      expect(clampPoint(bad, 0, BOUNDS).ok).toBe(false);
      expect(clampPoint(0, bad, BOUNDS).ok).toBe(false);
    }
  });

  it('clamps to the measured desktop rather than sending the pointer off-screen', () => {
    const r = clampPoint(99_999, -50, BOUNDS);
    expect(r).toEqual({ ok: true, value: { x: 1919, y: 0 } });
  });

  it('allows the far edge but not one past it', () => {
    expect(clampPoint(1919, 1079, BOUNDS)).toEqual({ ok: true, value: { x: 1919, y: 1079 } });
    expect(clampPoint(1920, 1080, BOUNDS)).toEqual({ ok: true, value: { x: 1919, y: 1079 } });
  });

  it('rounds a fractional coordinate — Win32 will not honour one', () => {
    expect(clampPoint(10.6, 20.2, BOUNDS)).toEqual({ ok: true, value: { x: 11, y: 20 } });
  });

  it('respects a virtual desktop origin on a multi-monitor setup', () => {
    const bounds = {
      width: 1920,
      height: 1080,
      virtual: { x: -1920, y: 0, width: 3840, height: 1080 },
    };
    expect(clampPoint(-1900, 500, bounds)).toEqual({ ok: true, value: { x: -1900, y: 500 } });
    expect(clampPoint(-5000, 500, bounds)).toEqual({ ok: true, value: { x: -1920, y: 500 } });
  });
});

describe('mouse buttons', () => {
  it('accepts the names preload and the UI actually send', () => {
    expect(normaliseButton(undefined)).toEqual({ ok: true, value: 'left' });
    expect(normaliseButton('primary')).toEqual({ ok: true, value: 'left' });
    expect(normaliseButton('right')).toEqual({ ok: true, value: 'right' });
    expect(normaliseButton('middle')).toEqual({ ok: true, value: 'middle' });
  });

  it('refuses an unknown button rather than defaulting to a left click', () => {
    // Defaulting here would turn a typo into a click in the wrong place.
    expect(normaliseButton('wheel').ok).toBe(false);
    expect(normaliseButton('right\' ; calc').ok).toBe(false);
    expect(normaliseButton(7).ok).toBe(false);
  });
});

describe('repeat counts', () => {
  it('defaults to one and rejects nonsense', () => {
    expect(normaliseRepeat(undefined)).toEqual({ ok: true, value: 1 });
    expect(normaliseRepeat(0).ok).toBe(false);
    expect(normaliseRepeat(-3).ok).toBe(false);
    expect(normaliseRepeat(1.5).ok).toBe(false);
    expect(normaliseRepeat(Number.NaN).ok).toBe(false);
    expect(normaliseRepeat('many').ok).toBe(false);
  });

  it('is bounded, so a key cannot be held for hours', () => {
    expect(normaliseRepeat(100_000).ok).toBe(false);
    expect(normaliseRepeat(1000)).toEqual({ ok: true, value: 1000 });
  });
});

describe('key names', () => {
  it('accepts a bare name and a chord', () => {
    const enter = normaliseKeyExpression('enter');
    expect(enter.ok).toBe(true);
    expect(enter.ok && enter.value.key.vk).toBe(0x0d);

    const chord = normaliseKeyExpression('ctrl+shift+t');
    expect(chord.ok && chord.value.mods).toEqual({ ctrl: true, alt: false, shift: true, meta: false });
    expect(chord.ok && chord.value.key.token).toBe('t');
  });

  it('accepts a single printable character', () => {
    expect(normaliseKeyExpression('a').ok).toBe(true);
    expect(normaliseKeyExpression('7').ok).toBe(true);
    expect(normaliseKeyExpression('/').ok).toBe(true);
  });

  it('marks extended keys so Windows sends them correctly', () => {
    // Arrow keys, Home/End and Insert need KEYEVENTF_EXTENDEDKEY; without it
    // Win32 reads the scan code as a numeric-keypad key.
    for (const name of ['up', 'down', 'left', 'right', 'home', 'end', 'delete', 'pageup']) {
      const r = normaliseKeyExpression(name);
      expect(r.ok && r.value.key.extended, name).toBe(true);
    }
  });

  it('refuses the wrong-typed payload the old handler threw a TypeError on', () => {
    expect(normaliseKeyExpression(undefined).ok).toBe(false);
    expect(normaliseKeyExpression(null).ok).toBe(false);
    expect(normaliseKeyExpression({}).ok).toBe(false);
    expect(normaliseKeyExpression(123).ok).toBe(false);
    expect(normaliseKeyExpression([]).ok).toBe(false);
  });

  it('refuses SendKeys syntax and shell metacharacters', () => {
    // `{ENTER}`, `^c`, `%{F4}` and `+` are WScript.Shell syntax. They must
    // never reach a platform layer, because the backend is not SendKeys and
    // these mean nothing to SendInput, xdotool keysyms or AppleScript.
    for (const junk of ['{ENTER}', '^c', '%{F4}', 'a`b', 'a;b', '$(x)', 'a&&b']) {
      expect(normaliseKeyExpression(junk).ok, junk).toBe(false);
    }
  });

  it('refuses an unknown key name and says what is accepted', () => {
    const r = normaliseKeyExpression('frobnicate');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/enter/);
  });

  it('refuses a chord of only modifiers', () => {
    expect(normaliseKeyExpression('ctrl+shift').ok).toBe(false);
  });

  it('refuses more than one key in one call', () => {
    expect(normaliseKeyExpression('ctrl+c+v').ok).toBe(false);
  });

  it('treats a bare "+" as the plus key rather than an empty chord', () => {
    const r = normaliseKeyExpression('+');
    expect(r.ok && r.value.key.token).toBe('=');
    expect(r.ok && r.value.mods.shift).toBe(true);
  });

  it('bounds the expression length', () => {
    expect(normaliseKeyExpression('a'.repeat(500)).ok).toBe(false);
  });
});

describe('modifiers', () => {
  it('parses the three separator styles into the same flags', () => {
    const expected = { ctrl: true, alt: true, shift: false, meta: false };
    expect(parseModifierList('ctrl+alt')).toEqual({ ok: true, value: expected });
    expect(parseModifierList('ctrl,alt')).toEqual({ ok: true, value: expected });
    expect(parseModifierList('ctrl alt')).toEqual({ ok: true, value: expected });
  });

  it('maps the platform-specific names onto one set of flags', () => {
    expect(parseModifierList('cmd').ok && parseModifierList('cmd')).toBeTruthy();
    expect(normaliseModifiers('win').ok).toBe(true);
    expect(normaliseModifiers('super').ok).toBe(true);
    expect(normaliseModifiers('option').ok).toBe(true);
  });

  it('refuses an unknown modifier name', () => {
    expect(parseModifierList('ctrl+hyper').ok).toBe(false);
  });

  it('refuses a non-boolean flag value', () => {
    expect(normaliseModifiers({ ctrl: 'yes' }).ok).toBe(false);
  });
});

describe('typed text', () => {
  it('rejects a non-string and an empty string with the message the UI shows', () => {
    expect(normaliseText(undefined)).toEqual({
      ok: false,
      error: 'Text to type must be a non-empty string.',
    });
    expect(normaliseText('').ok).toBe(false);
    expect(normaliseText(42).ok).toBe(false);
  });

  it('is length capped', () => {
    expect(normaliseText('x'.repeat(MAX_TEXT)).ok).toBe(true);
    expect(normaliseText('x'.repeat(MAX_TEXT + 1)).ok).toBe(false);
  });

  it('refuses an unpaired surrogate instead of typing a replacement glyph', () => {
    expect(normaliseText('\ud800').ok).toBe(false);
    expect(normaliseText('ok\udc00').ok).toBe(false);
    // A real pair — an emoji — is fine.
    expect(normaliseText('done ✅').ok).toBe(true);
  });

  it('keeps SendKeys metacharacters as literal text', () => {
    // This is the concrete Windows bug: `WScript.Shell.SendKeys('total (net)')`
    // treats the parentheses as a grouping construct. SendInput with
    // KEYEVENTF_UNICODE types them literally, so they must survive validation
    // untouched rather than being escaped away or rejected.
    const text = 'total (net) 100% ^ {ok} ~ [x] +y * z';
    const r = normaliseText(text);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.join('')).toBe(text);
  });

  it('chunks long text so each request fits the transport', () => {
    const r = normaliseText('y'.repeat(TYPE_CHUNK * 2 + 5));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
    expect(r.value.every((c) => c.length <= TYPE_CHUNK)).toBe(true);
    expect(r.value.join('')).toBe('y'.repeat(TYPE_CHUNK * 2 + 5));
  });
});

describe('Windows backend — the request contract', () => {
  it('builds a click request from validated values only', () => {
    const req = windowsMouseRequest('id1', 'click', {
      point: { x: 100, y: 200 },
      button: 'right',
      clicks: 2,
    });
    expect(req).toEqual({ id: 'id1', op: 'click', x: 100, y: 200, button: 'right', clicks: 2 });
  });

  it('uses -1 for "do not move the pointer" when scrolling', () => {
    // The C# side checks for a negative coordinate before calling SetCursorPos.
    const req = windowsMouseRequest('id2', 'scroll', { deltaY: -3 });
    expect(req).toMatchObject({ op: 'scroll', x: -1, y: -1, dx: 0, dy: -3 });
  });

  it('encodes modifiers and repeat as 0/1 flags the shim reads', () => {
    const chord = normaliseKeyExpression('ctrl+shift+enter');
    expect(chord.ok).toBe(true);
    if (!chord.ok) return;
    const req = windowsKeyRequest('id3', chord.value.key, chord.value.mods, 3);
    expect(req).toEqual({
      id: 'id3', op: 'key', vk: 0x0d, extended: 0,
      ctrl: 1, alt: 0, shift: 1, meta: 0, repeat: 3,
    });
  });
});

describe('Windows backend — the PowerShell script', () => {
  const { cmd, args } = windowsHelperArgv();

  it('launches PowerShell with no shell string', () => {
    expect(cmd).toBe('powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(args).toContain('-EncodedCommand');
  });

  it('encodes the script the way PowerShell expects: base64 of UTF-16LE', () => {
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(encodePowerShellCommand('Write-Output "hi"')).toBe(
      Buffer.from('Write-Output "hi"', 'utf16le').toString('base64'),
    );
    expect(script).toContain('HenryInput');
  });

  it('P/Invokes the real Win32 input API rather than SendKeys', () => {
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain('DllImport("user32.dll"');
    expect(script).toContain('SendInput');
    expect(script).toContain('SetCursorPos');
    // The old backend. Its presence is exactly the bug: it cannot click and
    // it mis-parses `+ ^ % ~ ( ) { }`.
    expect(script).not.toContain('WScript.Shell');
    expect(script).not.toContain('SendKeys');
  });

  it('declares the INPUT struct with the union winuser.h specifies', () => {
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain('[StructLayout(LayoutKind.Explicit)]');
    expect(script).toContain('[StructLayout(LayoutKind.Sequential)]');
    expect(script).toContain('Marshal.SizeOf(typeof(INPUT))');
  });

  it('injects Unicode through KEYEVENTF_UNICODE so no escaping is needed', () => {
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain('KEYEVENTF_UNICODE = 0x0004');
    expect(script).toContain('public static void Type(string text)');
  });

  it('reads requests from stdin or an env var — never from the script text', () => {
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain('[Console]::In.ReadLine()');
    expect(script).toContain('$env:HENRY_INPUT_ONESHOT');
  });
});

describe('execBinary — argv only', () => {
  it('treats shell metacharacters in an argument as ordinary text', async () => {
    // If anything in this repo ever routes user text through a shell instead
    // of argv, this assertion fails loudly rather than at 3am on a user
    // machine.
    const payload = '$(touch /tmp/pwned); `id` && echo "x" | cat';
    const r = await execBinary('printf', ['%s', payload], 5000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe(payload);
  });
});