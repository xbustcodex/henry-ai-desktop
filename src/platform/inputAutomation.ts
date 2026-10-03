/**
 * Desktop input automation — real mouse and keyboard control.
 *
 * Parity row 7.3. Before this module `computer:click` was macOS-only and
 * answered "Mouse control via AppleScript is macOS only." on Windows and
 * Linux, while the capability probe unconditionally advertised Windows input
 * automation as `ready`. Henry could therefore claim it could operate a
 * Windows desktop and then fail to move the pointer or click anything.
 *
 * WHAT EACH PLATFORM ACTUALLY USES
 * ---------------------------------
 *   darwin  AppleScript via System Events (existing behaviour, preserved).
 *           AppleScript has no pointer-move primitive, so `move`/`drag` are
 *           reported unsupported here rather than silently doing nothing.
 *   linux   xdotool (X11) / ydotool (Wayland).
 *   win32   Win32 `SendInput`/`SetCursorPos` reached through a resident
 *           PowerShell helper that P/Invokes user32.dll.
 *
 * Why not `WScript.Shell.SendKeys`, which is what the old Windows code used:
 * SendKeys is a *string parser*, not a key API. It cannot move a pointer, it
 * cannot click, it treats `+ ^ % ~ ( ) { } [ ]` as modifier and grouping
 * syntax (so typing `total (net)` throws or types the wrong characters), and
 * it depends on the active keyboard layout. `SendInput` is the real Win32
 * input API: it moves the pointer, clicks, scrolls, drives virtual-key codes
 * with proper modifier and extended-key handling, and injects arbitrary
 * Unicode through `KEYEVENTF_UNICODE` with no metacharacter escaping at all.
 *
 * Why a *resident* helper rather than one PowerShell process per action:
 * `Add-Type` compiles the P/Invoke shim, which costs about a second. Paying
 * that on every keystroke would make typing unusable. The helper starts once,
 * keeps the compiled type, and reads one JSON request per line from stdin. If
 * it cannot stay up we fall back to a one-shot run of the same script —
 * slower, but still the same input path.
 *
 * SECURITY
 * ---------
 * The PowerShell script is a constant. The only variable part is a JSON
 * request, and it reaches PowerShell through an environment variable or over
 * stdin — never interpolated into the script text. Text Henry was asked to
 * type is therefore data, never code, and there is no path from it into a
 * command that runs. Every other argument is bounded before a plan is built:
 * coordinates must be finite numbers, clamped to the measured desktop; key
 * names must resolve to a known token and virtual-key code; repeat counts,
 * click counts and scroll deltas are capped; typed text is length-capped,
 * surrogate-checked and chunked.
 */

import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';

/** The three platforms Henry ships for. */
export type InputPlatform = 'darwin' | 'linux' | 'win32';

export type MouseButton = 'left' | 'right' | 'middle';

export interface ScreenBounds {
  /** Primary display size in pixels. */
  width: number;
  height: number;
  /** Virtual-desktop origin and size, when the platform reports one. */
  virtual?: { x: number; y: number; width: number; height: number };
}

export interface NormalisedPoint {
  x: number;
  y: number;
}

/** Modifier flags, in the order they must be pressed and released. */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * A key Henry is allowed to press.
 *
 * `vk` is the Win32 virtual-key code, `xdo` the xdotool keysym, `code` the
 * macOS key code, and `char` a single literal character for the platforms that
 * can emit one directly.
 */
export interface NormalKey {
  /** Canonical lower-case token, e.g. `enter`, `f5`, `a`. */
  token: string;
  vk?: number;
  xdo?: string;
  /** macOS key code; absent for characters, which use `char`. */
  code?: string;
  /** Needs KEYEVENTF_EXTENDEDKEY on Windows. */
  extended?: boolean;
  /** A single literal character to emit rather than a named key. */
  char?: string;
}

export type PlanOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MouseOutcome {
  success: boolean;
  error?: string;
  backend: string;
}

export interface InputBackendProbe {
  status: 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable';
  backend: string;
  details: string;
  bounds?: ScreenBounds;
}

export type MouseAction = 'move' | 'click' | 'doubleClick' | 'scroll' | 'drag';

export interface MouseOptions {
  x?: unknown;
  y?: unknown;
  button?: unknown;
  clicks?: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
  toX?: unknown;
  toY?: unknown;
}

export interface PerformOptions {
  bounds?: ScreenBounds;
  platform?: InputPlatform;
}

/** The longest key expression accepted, so a caller cannot smuggle a blob. */
const MAX_KEY_LENGTH = 24;
const MAX_REPEAT = 1000;
const MAX_CLICKS = 10;
const MAX_TEXT = 32_000;
/** Each request travels in one env var, so typed text is chunked to fit. */
const TYPE_CHUNK = 1200;
/** One wheel notch is 120 in Win32; keep the delta sane either way. */
const MAX_SCROLL_DELTA = 20_000;

export { MAX_REPEAT, MAX_TEXT, TYPE_CHUNK };

/**
 * Conservative fallback when the real desktop size cannot be measured. Only
 * ever used to bound input; it is never reported as a real resolution.
 */
const FALLBACK_BOUNDS: ScreenBounds = { width: 8192, height: 8192 };

export const WINDOWS_BACKEND = 'win32 SendInput (user32.dll)';
export const DARWIN_BACKEND = 'osascript (System Events)';
export const LINUX_BACKEND = 'xdotool';

// ── Argument validation ─────────────────────────────────────────────────────

/**
 * Describe a rejected value for an error message without echoing a whole
 * object or a 4 KB string back across IPC.
 */
export function describeRejected(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 40));
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  return String(v);
}

/**
 * Require a real, finite number.
 *
 * Deliberately stricter than `Number(value)`: the coordinate path used to
 * interpolate into an AppleScript string, and `'0; calc'` is a string that
 * `Number()` also rejects, but `' 12 '` would not. A coordinate is a number.
 */
export function requireFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Coerce a repeat/count argument, accepting a numeric string but not junk. */
function coerceCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validate and clamp a screen coordinate pair.
 *
 * Rejects non-numbers outright, rounds to a whole pixel (Win32 will not honour
 * a fractional cursor position) and clamps to the measured desktop, so a bad
 * number can never send the pointer somewhere the user did not ask for.
 */
export function clampPoint(
  rawX: unknown,
  rawY: unknown,
  bounds: ScreenBounds = FALLBACK_BOUNDS,
): PlanOutcome<NormalisedPoint> {
  const x = requireFiniteNumber(rawX);
  if (x === null) {
    return { ok: false, error: `x must be a finite number, received ${describeRejected(rawX)}.` };
  }
  const y = requireFiniteNumber(rawY);
  if (y === null) {
    return { ok: false, error: `y must be a finite number, received ${describeRejected(rawY)}.` };
  }

  const originX = bounds.virtual ? bounds.virtual.x : 0;
  const originY = bounds.virtual ? bounds.virtual.y : 0;
  const spanX = bounds.virtual ? bounds.virtual.width : bounds.width;
  const spanY = bounds.virtual ? bounds.virtual.height : bounds.height;
  const maxX = Math.max(originX, originX + spanX - 1);
  const maxY = Math.max(originY, originY + spanY - 1);

  return {
    ok: true,
    value: {
      x: Math.min(maxX, Math.max(originX, Math.round(x))),
      y: Math.min(maxY, Math.max(originY, Math.round(y))),
    },
  };
}

export function normaliseButton(raw: unknown): PlanOutcome<MouseButton> {
  if (raw === undefined || raw === null) return { ok: true, value: 'left' };
  if (typeof raw !== 'string') return { ok: false, error: 'button must be a string.' };
  const b = raw.trim().toLowerCase();
  if (b === 'primary' || b === 'left') return { ok: true, value: 'left' };
  if (b === 'right' || b === 'secondary') return { ok: true, value: 'right' };
  if (b === 'middle') return { ok: true, value: 'middle' };
  return { ok: false, error: `Unknown mouse button "${raw.slice(0, 24)}". Use left, right or middle.` };
}

export function normaliseRepeat(raw: unknown, max = MAX_REPEAT): PlanOutcome<number> {
  if (raw === undefined || raw === null) return { ok: true, value: 1 };
  const n = coerceCount(raw);
  if (n === null || !Number.isInteger(n)) return { ok: false, error: 'repeat must be a whole number.' };
  if (n < 1) return { ok: false, error: 'repeat must be at least 1.' };
  if (n > max) return { ok: false, error: `repeat must be at most ${max}.` };
  return { ok: true, value: n };
}

function normaliseScrollDelta(raw: unknown): PlanOutcome<number> {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  const n = coerceCount(raw);
  if (n === null) return { ok: false, error: 'Scroll delta must be a finite number.' };
  return { ok: true, value: Math.min(MAX_SCROLL_DELTA, Math.max(-MAX_SCROLL_DELTA, Math.round(n))) };
}

// ── Key names ───────────────────────────────────────────────────────────────

const NO_MODS: Modifiers = { ctrl: false, alt: false, shift: false, meta: false };

/** `ctrl+shift`, `cmd,alt` and `ctrl alt` all parse into the same flags. */
export function parseModifierList(raw: string): PlanOutcome<Modifiers> {
  const mods = { ...NO_MODS };
  const parts = raw.trim().split(/[+,\s]+/).filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0].toLowerCase() === 'none')) {
    return { ok: true, value: mods };
  }
  for (const part of parts) {
    if (!applyModifierToken(part.toLowerCase(), mods)) {
      return { ok: false, error: `Unknown modifier "${part.slice(0, 16)}".` };
    }
  }
  return { ok: true, value: mods };
}

function applyModifierToken(token: string, mods: Modifiers): boolean {
  switch (token) {
    case 'ctrl':
    case 'control':
      mods.ctrl = true;
      return true;
    case 'alt':
    case 'option':
    case 'opt':
      mods.alt = true;
      return true;
    case 'shift':
      mods.shift = true;
      return true;
    case 'meta':
    case 'cmd':
    case 'command':
    case 'win':
    case 'super':
      mods.meta = true;
      return true;
    default:
      return false;
  }
}

export function normaliseModifiers(raw: unknown): PlanOutcome<Modifiers> {
  if (raw === undefined || raw === null) return { ok: true, value: { ...NO_MODS } };
  if (typeof raw === 'boolean') return { ok: true, value: { ...NO_MODS, meta: raw } };
  if (typeof raw === 'string') return parseModifierList(raw);
  if (typeof raw !== 'object') {
    return { ok: false, error: 'modifiers must be a string like "ctrl+shift" or an object of flags.' };
  }
  const mods = { ...NO_MODS };
  const flags: Record<string, keyof Modifiers> = {
    ctrl: 'ctrl', control: 'ctrl',
    alt: 'alt', option: 'alt',
    shift: 'shift',
    meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta',
  };
  for (const [name, target] of Object.entries(flags)) {
    const value = (raw as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { ok: false, error: `Modifier "${name}" must be true or false.` };
    mods[target] = value;
  }
  return { ok: true, value: mods };
}

interface KeyDef {
  aliases: string[];
  vk?: number;
  xdo?: string;
  /** macOS key code; empty means "emit the character instead". */
  code?: string;
  extended?: boolean;
  char?: string;
}

function functionKey(i: number): KeyDef {
  // F1–F12 have fixed virtual-key codes; F13+ sit in the extended range.
  return {
    aliases: [`f${i}`],
    vk: i <= 12 ? 0x6f + i : 0x7a + (i - 13),
    xdo: `F${i}`,
    code: String(111 + i),
    extended: i > 12,
  };
}

const NAMED_KEYS: KeyDef[] = [
  { aliases: ['enter', 'return', 'cr'], vk: 0x0d, xdo: 'Return', code: '36' },
  { aliases: ['tab'], vk: 0x09, xdo: 'Tab', code: '48' },
  { aliases: ['escape', 'esc'], vk: 0x1b, xdo: 'Escape', code: '53' },
  { aliases: ['space'], vk: 0x20, xdo: 'space', code: '49', char: ' ' },
  { aliases: ['backspace'], vk: 0x08, xdo: 'BackSpace', code: '51' },
  { aliases: ['delete', 'del'], vk: 0x2e, xdo: 'Delete', code: '117', extended: true },
  { aliases: ['insert', 'ins'], vk: 0x2d, xdo: 'Insert', code: '114', extended: true },
  { aliases: ['home'], vk: 0x24, xdo: 'Home', code: '115', extended: true },
  { aliases: ['end'], vk: 0x23, xdo: 'End', code: '119', extended: true },
  { aliases: ['pageup', 'pgup', 'prior'], vk: 0x21, xdo: 'Prior', code: '116', extended: true },
  { aliases: ['pagedown', 'pgdn', 'next'], vk: 0x22, xdo: 'Next', code: '121', extended: true },
  { aliases: ['up', 'arrowup'], vk: 0x26, xdo: 'Up', code: '126', extended: true },
  { aliases: ['down', 'arrowdown'], vk: 0x28, xdo: 'Down', code: '125', extended: true },
  { aliases: ['left', 'arrowleft'], vk: 0x25, xdo: 'Left', code: '123', extended: true },
  { aliases: ['right', 'arrowright'], vk: 0x27, xdo: 'Right', code: '124', extended: true },
  { aliases: ['capslock', 'caps'], vk: 0x14, xdo: 'Caps_Lock', code: '57' },
  { aliases: ['printscreen', 'prtsc'], vk: 0x2c, xdo: 'Print', code: '105', extended: true },
  { aliases: ['numlock'], vk: 0x90, xdo: 'Num_Lock', code: '71', extended: true },
  { aliases: ['scrolllock'], vk: 0x91, xdo: 'Scroll_Lock', code: '73', extended: true },
  { aliases: ['pause', 'break'], vk: 0x13, xdo: 'Pause', code: '71' },
  { aliases: ['contextmenu', 'menu', 'apps'], vk: 0x5d, xdo: 'Menu', code: '110', extended: true },
  { aliases: ['clear'], vk: 0x0c, xdo: 'Clear', code: '47' },
  // Pressable on their own; also usable as chord modifiers.
  { aliases: ['shift'], vk: 0x10, xdo: 'shift', code: '56' },
  { aliases: ['ctrl', 'control'], vk: 0x11, xdo: 'ctrl', code: '59' },
  { aliases: ['alt', 'option'], vk: 0x12, xdo: 'alt', code: '58' },
  { aliases: ['meta', 'cmd', 'command', 'win', 'super'], vk: 0x5b, xdo: 'super', code: '55', extended: true },
];

const UNSHIFTED_PUNCTUATION: Record<string, number> = {
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

const SHIFTED_PUNCTUATION: Record<string, number> = {
  '!': 0x31, '@': 0x32, '#': 0x33, $: 0x34, '%': 0x35, '^': 0x36,
  '&': 0x37, '*': 0x38, '(': 0x39, ')': 0x40, _: 0x5f,
  '+': 0xbb, '{': 0xdb, '}': 0xdd, '|': 0xdc, ':': 0xba,
  '"': 0xde, '<': 0xbc, '>': 0xbe, '?': 0xbf, '~': 0xc0, '§': 0xc7,
};

/**
 * Virtual-key code for a single printable character, or null when the
 * platform has none (only `char` injection covers those, and only on
 * Windows and X11).
 */
function charVirtualKey(ch: string): number | null {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0);
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase().charCodeAt(0);
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0);
  return UNSHIFTED_PUNCTUATION[ch] ?? SHIFTED_PUNCTUATION[ch] ?? null;
}

const KEY_LOOKUP: Record<string, KeyDef> = (() => {
  const table: Record<string, KeyDef> = {};
  for (const def of NAMED_KEYS) {
    for (const alias of def.aliases) table[alias] ??= def;
  }
  for (let i = 1; i <= 24; i++) {
    const def = functionKey(i);
    table[`f${i}`] = def;
  }
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (table[ch.toLowerCase()]) continue;
    const vk = charVirtualKey(ch);
    if (vk === null) continue;
    // macOS emits printable characters with `keystroke`, not `key code`.
    table[ch.toLowerCase()] = { aliases: [ch], vk, xdo: ch, char: ch };
  }
  return table;
})();

/**
 * Turn a caller-supplied key into something safe to press: a bare key name, a
 * `ctrl+shift+t` chord, or a single printable character.
 *
 * Anything else — an empty string, a 200-character expression, an unknown
 * name, a chord made only of modifiers, or two keys at once — is refused.
 * This is what keeps SendKeys syntax and shell metacharacters out of the
 * platform layer entirely.
 */
export function normaliseKeyExpression(raw: unknown): PlanOutcome<{ key: NormalKey; mods: Modifiers }> {
  if (typeof raw !== 'string') {
    return { ok: false, error: `A key name string is required, received ${describeRejected(raw)}.` };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'A key name string is required.' };
  if (trimmed.length > MAX_KEY_LENGTH * 4) {
    return { ok: false, error: `Key expression is too long (max ${MAX_KEY_LENGTH * 4} characters).` };
  }
  // `+` is both the chord separator and a real key. A bare "+" means shift.
  const expression = trimmed === '+' ? 'shift+=' : trimmed;

  const mods = { ...NO_MODS };
  const targets: string[] = [];
  for (const part of expression.split('+').map((p) => p.trim()).filter(Boolean)) {
    if (part.toLowerCase() === 'none') continue;
    if (!applyModifierToken(part.toLowerCase(), mods)) targets.push(part);
  }

  if (targets.length === 0) {
    return { ok: false, error: 'That expression names only modifiers — add the key to press.' };
  }
  if (targets.length > 1) {
    return { ok: false, error: 'Press one key per call; send "ctrl+c" rather than "ctrl+c+v".' };
  }

  const target = targets[0];
  if (target.length > MAX_KEY_LENGTH) {
    return { ok: false, error: `Key name is too long (max ${MAX_KEY_LENGTH} characters).` };
  }
  const def = KEY_LOOKUP[target.toLowerCase()];
  if (!def) {
    return {
      ok: false,
      error:
        `Unknown key "${target.slice(0, MAX_KEY_LENGTH)}". Use a single character, a name such as ` +
        'enter/tab/escape/space/backspace/delete/arrows, or f1–f24.',
    };
  }

  const key: NormalKey = { token: target.toLowerCase() };
  if (def.vk !== undefined) key.vk = def.vk;
  if (def.xdo !== undefined) key.xdo = def.xdo;
  if (def.code !== undefined) key.code = def.code;
  if (def.extended) key.extended = true;
  if (def.char !== undefined) key.char = def.char;
  return { ok: true, value: { key, mods } };
}

// ── Typed text ──────────────────────────────────────────────────────────────

/**
 * Validate typed text and split it into chunks the transport can carry.
 *
 * Lone surrogates are rejected: they become invalid UTF-8 on the way into
 * PowerShell, and the old SendKeys path would have typed a replacement glyph
 * while reporting success.
 */
export function normaliseText(raw: unknown, max = MAX_TEXT): PlanOutcome<string[]> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'Text to type must be a non-empty string.' };
  }
  if (raw.length > max) return { ok: false, error: `Text to type is too long (max ${max} characters).` };
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (!isHigh && !isLow) continue;
    const next = raw.charCodeAt(i + 1);
    if (!isHigh || !(next >= 0xdc00 && next <= 0xdfff)) {
      return { ok: false, error: 'Text contains an unpaired surrogate and cannot be typed.' };
    }
    i += 1;
  }
  const chunks: string[] = [];
  for (let i = 0; i < raw.length; i += TYPE_CHUNK) chunks.push(raw.slice(i, i + TYPE_CHUNK));
  return { ok: true, value: chunks };
}

// ── Windows helper: the P/Invoke shim and its PowerShell driver ─────────────

/**
 * C# P/Invoke shim compiled once inside the resident PowerShell helper.
 *
 * `INPUT` matches winuser.h exactly: a DWORD type followed by an explicit
 * layout union whose 8-byte alignment forces the 4-byte pad on x64.
 * `Marshal.SizeOf` then yields the documented 40 (x64) / 28 (x86) bytes and
 * that value is what goes to SendInput, so the struct is right on both.
 */
const WIN_INPUT_CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class HenryInput
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    private static int StructSize { get { return Marshal.SizeOf(typeof(INPUT)); } }

    private static void Send(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, StructSize);
        if (sent != (uint)inputs.Length)
        {
            throw new InvalidOperationException("SendInput delivered " + sent + " of " + inputs.Length + " events");
        }
    }

    private static INPUT Mouse(uint flags, int dx, int dy, int data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = unchecked((uint)data), dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        return i;
    }

    private static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        return i;
    }

    private static void ButtonPair(string button, out uint down, out uint up)
    {
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
    }

    public static string Screen()
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\\"width\\":").Append(GetSystemMetrics(SM_CXSCREEN));
        sb.Append(",\\"height\\":").Append(GetSystemMetrics(SM_CYSCREEN));
        sb.Append(",\\"vx\\":").Append(GetSystemMetrics(SM_XVIRTUALSCREEN));
        sb.Append(",\\"vy\\":").Append(GetSystemMetrics(SM_YVIRTUALSCREEN));
        sb.Append(",\\"vw\\":").Append(GetSystemMetrics(SM_CXVIRTUALSCREEN));
        sb.Append(",\\"vh\\":").Append(GetSystemMetrics(SM_CYVIRTUALSCREEN));
        sb.Append("}");
        return sb.ToString();
    }

    public static void Move(int x, int y)
    {
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
    }

    public static void Click(int x, int y, string button, int clicks)
    {
        SetCursorPos(x, y);
        Thread.Sleep(30);
        uint down; uint up;
        ButtonPair(button, out down, out up);
        for (int i = 0; i < clicks; i++)
        {
            Send(new INPUT[] { Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0) });
            if (i + 1 < clicks) Thread.Sleep(60);
        }
    }

    public static void Scroll(int x, int y, int dx, int dy)
    {
        if (x >= 0 && y >= 0) SetCursorPos(x, y);
        if (dy != 0) Send(new INPUT[] { Mouse(MOUSEEVENTF_WHEEL, 0, 0, dy * 120) });
        if (dx != 0) Send(new INPUT[] { Mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx * 120) });
    }

    public static void Drag(int x1, int y1, int x2, int y2, string button)
    {
        uint down; uint up;
        ButtonPair(button, out down, out up);
        SetCursorPos(x1, y1);
        Thread.Sleep(30);
        Send(new INPUT[] { Mouse(down, 0, 0, 0) });
        int steps = 12;
        for (int i = 1; i <= steps; i++)
        {
            SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
            Thread.Sleep(12);
        }
        Send(new INPUT[] { Mouse(up, 0, 0, 0) });
    }

    public static void Key(int vk, int extended, int ctrl, int alt, int shift, int meta, int repeat)
    {
        List<ushort> mods = new List<ushort>();
        if (ctrl != 0) mods.Add(0x11);
        if (alt != 0) mods.Add(0x12);
        if (shift != 0) mods.Add(0x10);
        if (meta != 0) mods.Add(0x5B);
        uint ext = KEYEVENTF_EXTENDEDKEY;
        for (int r = 0; r < repeat; r++)
        {
            foreach (ushort m in mods) Send(new INPUT[] { Key(m, 0, ext) });
            uint flag = extended != 0 ? ext : 0;
            Send(new INPUT[] { Key((ushort)vk, 0, flag) });
            Send(new INPUT[] { Key((ushort)vk, 0, flag | KEYEVENTF_KEYUP) });
            for (int i = mods.Count - 1; i >= 0; i--) Send(new INPUT[] { Key(mods[i], 0, ext | KEYEVENTF_KEYUP) });
            if (r + 1 < repeat) Thread.Sleep(40);
        }
    }

    public static void Type(string text)
    {
        foreach (char ch in text)
        {
            ushort unit = (ushort)ch;
            Send(new INPUT[] {
                Key(0, unit, KEYEVENTF_UNICODE),
                Key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
            });
        }
    }
}
`;

/**
 * The constant PowerShell driver.
 *
 * Two entry points share one body: resident mode reads one JSON request per
 * line from stdin, one-shot mode reads a single request from the
 * HENRY_INPUT_ONESHOT environment variable and exits. The request is data;
 * it is never concatenated into this text.
 */
const WIN_HELPER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WIN_INPUT_CSHARP}
'@

function Invoke-HenryInputOp($req) {
    $id = [string]$req.id
    try {
        $result = '{}'
        switch ([string]$req.op) {
            'screen' { $result = [HenryInput]::Screen() }
            'move'   { [HenryInput]::Move([int]$req.x, [int]$req.y) | Out-Null }
            'click'  { [HenryInput]::Click([int]$req.x, [int]$req.y, [string]$req.button, [int]$req.clicks) | Out-Null }
            'scroll' { [HenryInput]::Scroll([int]$req.x, [int]$req.y, [int]$req.dx, [int]$req.dy) | Out-Null }
            'drag'   { [HenryInput]::Drag([int]$req.x1, [int]$req.y1, [int]$req.x2, [int]$req.y2, [string]$req.button) | Out-Null }
            'key'    { [HenryInput]::Key([int]$req.vk, [int]$req.extended, [int]$req.ctrl, [int]$req.alt, [int]$req.shift, [int]$req.meta, [int]$req.repeat) | Out-Null }
            'type'   { [HenryInput]::Type([string]$req.text) | Out-Null }
            default  { throw ('unknown op: ' + [string]$req.op) }
        }
        return [pscustomobject]@{ id = $id; ok = $true; data = ($result | ConvertFrom-Json) }
    } catch {
        $msg = $_.Exception.Message
        $msg = $msg.Replace([char]13, ' ').Replace([char]10, ' ').Replace([char]34, [char]39)
        return [pscustomobject]@{ id = $id; ok = $false; error = $msg }
    }
}

if ($env:HENRY_INPUT_ONESHOT) {
    $one = $env:HENRY_INPUT_ONESHOT | ConvertFrom-Json
    [Console]::Out.WriteLine((Invoke-HenryInputOp $one | ConvertTo-Json -Compress -Depth 5))
    exit 0
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $req = $line | ConvertFrom-Json
    [Console]::Out.WriteLine((Invoke-HenryInputOp $req | ConvertTo-Json -Compress -Depth 5))
}
exit 0
`;

/** Encode a PowerShell script for `-EncodedCommand` (base64 of UTF-16LE). */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** The argv used to launch either flavour of the Windows helper. */
export function windowsHelperArgv(): { cmd: string; args: string[] } {
  return {
    cmd: 'powershell',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(WIN_HELPER_SCRIPT),
    ],
  };
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `op-${process.pid}-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

/** A request the Windows helper understands. */
export interface WindowsInputRequest {
  id: string;
  op: 'screen' | 'move' | 'click' | 'scroll' | 'drag' | 'key' | 'type';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  dx?: number;
  dy?: number;
  button?: MouseButton;
  clicks?: number;
  vk?: number;
  extended?: number;
  ctrl?: number;
  alt?: number;
  shift?: number;
  meta?: number;
  repeat?: number;
  text?: string;
}

export interface WindowsInputResponse {
  id: string;
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

type MouseDispatch =
  | 'move'
  | 'click'
  | 'scroll'
  | 'drag';

export interface MouseDispatchArgs {
  point?: NormalisedPoint;
  from?: NormalisedPoint;
  to?: NormalisedPoint;
  button?: MouseButton;
  clicks?: number;
  deltaX?: number;
  deltaY?: number;
}

/** Build the wire request for a mouse action. */
export function windowsMouseRequest(
  id: string,
  action: MouseDispatch,
  o: MouseDispatchArgs,
): WindowsInputRequest {
  switch (action) {
    case 'move':
      return { id, op: 'move', x: o.point!.x, y: o.point!.y };
    case 'click':
      return { id, op: 'click', x: o.point!.x, y: o.point!.y, button: o.button ?? 'left', clicks: o.clicks ?? 1 };
    case 'scroll':
      return {
        id,
        op: 'scroll',
        // A negative coordinate means "do not move the pointer" — the C# side
        // checks for it before calling SetCursorPos.
        x: o.point ? o.point.x : -1,
        y: o.point ? o.point.y : -1,
        dx: o.deltaX ?? 0,
        dy: o.deltaY ?? 0,
      };
    case 'drag':
      return { id, op: 'drag', x1: o.from!.x, y1: o.from!.y, x2: o.to!.x, y2: o.to!.y, button: o.button ?? 'left' };
  }
}

/** Build the wire request for a key press. */
export function windowsKeyRequest(
  id: string,
  key: NormalKey,
  mods: Modifiers,
  repeat: number,
): WindowsInputRequest {
  return {
    id,
    op: 'key',
    vk: key.vk ?? 0,
    extended: key.extended ? 1 : 0,
    ctrl: mods.ctrl ? 1 : 0,
    alt: mods.alt ? 1 : 0,
    shift: mods.shift ? 1 : 0,
    meta: mods.meta ? 1 : 0,
    repeat,
  };
}

// ── Process helpers ─────────────────────────────────────────────────────────

interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a binary with an argv array and capture its output.
 *
 * Never a shell string: everything Henry types or is told to type stays a
 * single argv element and cannot be re-read as a command.
 */
export function execBinary(cmd: string, args: string[], timeout = 10_000): Promise<ExecOutcome> {
  // The executor form is required here: `Promise.withResolvers` is not in this
  // project's TypeScript lib target (see the same note in computer.ts).
  const { promise, resolve } = (() => {
    let done!: (v: ExecOutcome) => void;
    const p = new Promise<ExecOutcome>((res) => { done = res; });
    return { promise: p, resolve: done };
  })();
  const child = spawn(cmd, args, { timeout, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.on('error', (e: Error) => resolve({ ok: false, stdout, stderr: e.message, exitCode: -1 }));
  child.on('close', (code: number | null) =>
    resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? -1 }),
  );
  return promise;
}

async function runTool(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; error?: string }> {
  const r = await execBinary(cmd, args, timeout);
  return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() || `exit ${r.exitCode}` };
}

// ── The resident Windows helper ─────────────────────────────────────────────

interface PendingRequest {
  resolve: (r: WindowsInputResponse) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 20_000;
/** `Add-Type` compiling a shim is slow the first time; give it room. */
const STARTUP_TIMEOUT_MS = 30_000;

class WindowsInputHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private starting: Promise<boolean> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private failAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ id: '', ok: false, error: reason });
    }
    this.pending.clear();
  }

  private start(): Promise<boolean> {
    if (this.child && !this.child.killed) return Promise.resolve(true);
    if (this.starting) return this.starting;

    const { cmd, args } = windowsHelperArgv();
    this.starting = new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      }) as ChildProcessWithoutNullStreams;

      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.starting = null;
        resolve(ok);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        for (let nl = this.buffer.indexOf('\n'); nl !== -1; nl = this.buffer.indexOf('\n')) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let parsed: WindowsInputResponse;
          try {
            parsed = JSON.parse(line) as WindowsInputResponse;
          } catch {
            continue; // A malformed line must not kill a working helper.
          }
          const p = this.pending.get(parsed.id);
          if (!p) continue;
          clearTimeout(p.timer);
          this.pending.delete(parsed.id);
          p.resolve(parsed);
        }
      });

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });

      child.on('error', (e: Error) => {
        if (this.child === child) this.child = null;
        this.failAll(`The Windows input helper could not start: ${e.message}`);
        settle(false);
      });

      child.on('exit', (code: number | null) => {
        if (this.child === child) this.child = null;
        const why = stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : '';
        this.failAll(`The Windows input helper exited (code ${code ?? -1})${why}.`);
        settle(false);
      });

      this.child = child;
      // The helper only proves itself by answering; a `screen` round trip is
      // the cheapest way to know Add-Type compiled and user32 loaded.
      this.send({ id: nextRequestId(), op: 'screen' }, STARTUP_TIMEOUT_MS)
        .then((r) => settle(r.ok))
        .catch(() => settle(false));
    });

    return this.starting;
  }

  private send(req: WindowsInputRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<WindowsInputResponse> {
    const child = this.child;
    if (!child || child.killed) {
      return Promise.resolve({ id: req.id, ok: false, error: 'The Windows input helper is not running.' });
    }
    return new Promise<WindowsInputResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        resolve({ id: req.id, ok: false, error: `The Windows input helper did not respond within ${timeoutMs}ms.` });
      }, timeoutMs);
      this.pending.set(req.id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify(req) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        resolve({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** Requests are serialised: one line in, one line out. */
  request(req: WindowsInputRequest): Promise<WindowsInputResponse> {
    const run = async (): Promise<WindowsInputResponse> => {
      const up = await this.start();
      if (!up) return { id: req.id, ok: false, error: 'The Windows input helper is unavailable.' };
      return this.send(req);
    };
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.failAll('The input helper was shut down.');
    if (!child || child.killed) return;
    try { child.stdin.end(); } catch { /* already gone */ }
    try { child.kill(); } catch { /* already gone */ }
  }
}

let helper: WindowsInputHelper | null = null;

/** Stop the resident helper. Safe to call when it was never started. */
export function disposeInputHelper(): void {
  helper?.dispose();
  helper = null;
}

/**
 * Send one request to the resident helper, falling back to a one-shot run of
 * the same script if the helper could not stay up. The fallback is slower but
 * exercises exactly the same code.
 */
async function sendWindows(req: WindowsInputRequest): Promise<WindowsInputResponse> {
  if (!helper) helper = new WindowsInputHelper();
  const resident = await helper.request(req);
  if (resident.ok) return resident;
  const residentError = resident.error ?? 'unknown error';

  try {
    const { cmd, args } = windowsHelperArgv();
    const child = spawn(cmd, args, {
      windowsHide: true,
      env: { ...process.env, HENRY_INPUT_ONESHOT: JSON.stringify(req) },
    });
    const captured = await new Promise<ExecOutcome>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (e: Error) => resolve({ ok: false, stdout, stderr: e.message, exitCode: -1 }));
      child.on('close', (code: number | null) =>
        resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? -1 }),
      );
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, REQUEST_TIMEOUT_MS);
    });

    const line = captured.stdout.trim().split('\n').filter(Boolean).pop();
    if (line) {
      try {
        const parsed = JSON.parse(line) as WindowsInputResponse;
        return parsed.ok ? parsed : { id: req.id, ok: false, error: parsed.error ?? residentError };
      } catch { /* fall through to the resident error */ }
    }
    return { id: req.id, ok: false, error: residentError };
  } catch {
    return { id: req.id, ok: false, error: residentError };
  }
}

// ── The public, platform-neutral surface ────────────────────────────────────

function backendFor(platform: InputPlatform): string {
  if (platform === 'win32') return WINDOWS_BACKEND;
  return platform === 'darwin' ? DARWIN_BACKEND : LINUX_BACKEND;
}

function currentPlatform(): InputPlatform {
  return process.platform as InputPlatform;
}

export async function performMouseAction(
  action: MouseAction,
  o: MouseOptions,
  opts: PerformOptions = {},
): Promise<MouseOutcome> {
  const platform = opts.platform ?? currentPlatform();
  const backend = backendFor(platform);
  const bounds = opts.bounds ?? FALLBACK_BOUNDS;

  if (action === 'drag') {
    const from = clampPoint(o.x, o.y, bounds);
    if (!from.ok) return { success: false, error: from.error, backend };
    const to = clampPoint(o.toX, o.toY, bounds);
    if (!to.ok) return { success: false, error: to.error, backend };
    const button = normaliseButton(o.button);
    if (!button.ok) return { success: false, error: button.error, backend };
    return dispatchMouse(platform, 'drag', { from: from.value, to: to.value, button: button.value });
  }

  const point = clampPoint(o.x, o.y, bounds);
  if (!point.ok) return { success: false, error: point.error, backend };

  if (action === 'scroll') {
    const dx = normaliseScrollDelta(o.deltaX);
    if (!dx.ok) return { success: false, error: dx.error, backend };
    const dy = normaliseScrollDelta(o.deltaY);
    if (!dy.ok) return { success: false, error: dy.error, backend };
    if (dx.value === 0 && dy.value === 0) {
      return { success: false, error: 'A scroll needs a non-zero delta.', backend };
    }
    return dispatchMouse(platform, 'scroll', { point: point.value, deltaX: dx.value, deltaY: dy.value });
  }

  const button = normaliseButton(o.button);
  if (!button.ok) return { success: false, error: button.error, backend };
  const clicks = normaliseRepeat(action === 'doubleClick' ? 2 : o.clicks, MAX_CLICKS);
  if (!clicks.ok) return { success: false, error: clicks.error, backend };
  return dispatchMouse(platform, 'click', { point: point.value, button: button.value, clicks: clicks.value });
}

async function dispatchMouse(
  platform: InputPlatform,
  kind: MouseDispatch,
  o: MouseDispatchArgs,
): Promise<MouseOutcome> {
  if (platform === 'win32') {
    const res = await sendWindows(windowsMouseRequest(nextRequestId(), kind, o));
    return { success: res.ok, error: res.error, backend: WINDOWS_BACKEND };
  }

  if (platform === 'darwin') {
    if (kind === 'move' || kind === 'drag') {
      return {
        success: false,
        backend: DARWIN_BACKEND,
        error:
          'AppleScript has no pointer-move primitive. Use a macOS automation tool (Shortcuts, ' +
          'Hammerspoon, or an accessibility helper) for pointer control.',
      };
    }
    if (kind === 'scroll') {
      // Page Up / Page Down are the real AppleScript equivalent of a scroll.
      const code = (o.deltaY ?? 0) < 0 ? 116 : 121;
      const r = await runTool('osascript', ['-e', `tell application "System Events" to key code ${code}`], 5000);
      return { success: r.ok, error: r.error, backend: DARWIN_BACKEND };
    }
    const word = o.button === 'right' ? 'right ' : '';
    const at = `${o.point!.x}, ${o.point!.y}`;
    const verb = (o.clicks ?? 1) > 1 ? 'double click' : 'click';
    const r = await runTool(
      'osascript',
      ['-e', `tell application "System Events" to ${word}${verb} at {${at}}`],
      10_000,
    );
    return { success: r.ok, error: r.error, backend: DARWIN_BACKEND };
  }

  // Linux: xdotool, always argv so nothing the user asked for can be re-read
  // as a shell word.
  const btn = { left: '1', right: '3', middle: '2' }[o.button ?? 'left'];
  if (kind === 'move') {
    const r = await runTool('xdotool', ['mousemove', '--sync', String(o.point!.x), String(o.point!.y)], 5000);
    return { success: r.ok, error: r.error, backend: LINUX_BACKEND };
  }
  if (kind === 'drag') {
    const r = await runTool(
      'xdotool',
      ['mousemove', '--sync', String(o.from!.x), String(o.from!.y), 'mousedown', btn,
       'mousemove', '--sync', String(o.to!.x), String(o.to!.y), 'mouseup', btn],
      8000,
    );
    return { success: r.ok, error: r.error, backend: LINUX_BACKEND };
  }
  if (kind === 'scroll') {
    // Buttons 4/5 are the X11 wheel convention, 6/7 horizontal.
    const steps = Math.max(1, Math.min(50, Math.abs(o.deltaY ?? 0)));
    const args = ['click', '--repeat', String(steps), '--delay', '20', (o.deltaY ?? 0) > 0 ? '4' : '5'];
    if ((o.deltaX ?? 0) !== 0) args.push((o.deltaX ?? 0) > 0 ? '7' : '6');
    const r = await runTool('xdotool', args, 8000);
    return { success: r.ok, error: r.error, backend: LINUX_BACKEND };
  }
  const args = ['mousemove', '--sync', String(o.point!.x), String(o.point!.y)];
  if ((o.clicks ?? 1) > 1) {
    args.push('click', '--repeat', String(o.clicks), '--delay', '80', btn);
  } else {
    args.push('click', btn);
  }
  const r = await runTool('xdotool', args, 8000);
  return { success: r.ok, error: r.error, backend: LINUX_BACKEND };
}

export async function performKeyPress(
  expression: unknown,
  repeatRaw?: unknown,
  opts: PerformOptions = {},
): Promise<MouseOutcome> {
  const platform = opts.platform ?? currentPlatform();
  const backend = backendFor(platform);

  const parsed = normaliseKeyExpression(expression);
  if (!parsed.ok) return { success: false, error: parsed.error, backend };
  const repeat = normaliseRepeat(repeatRaw);
  if (!repeat.ok) return { success: false, error: repeat.error, backend };
  const { key, mods } = parsed.value;

  if (platform === 'win32') {
    if (key.vk === undefined) {
      return { success: false, backend, error: `Key "${key.token}" has no Windows virtual-key code.` };
    }
    const res = await sendWindows(windowsKeyRequest(nextRequestId(), key, mods, repeat.value));
    return { success: res.ok, error: res.error, backend };
  }

  if (platform === 'darwin') {
    let script: string;
    if (key.char && key.char !== ' ') {
      // AppleScript emits printable characters with `keystroke`.
      const literal = key.char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `tell application "System Events" to keystroke "${literal}"`;
    } else if (key.code) {
      script = `tell application "System Events" to key code ${key.code}`;
    } else {
      return { success: false, backend, error: `Key "${key.token}" cannot be emitted on macOS.` };
    }
    const flags: string[] = [];
    if (mods.ctrl) flags.push('control down');
    if (mods.alt) flags.push('option down');
    if (mods.shift) flags.push('shift down');
    if (mods.meta) flags.push('command down');
    if (flags.length) script += ` using {${flags.join(', ')}}`;

    for (let i = 0; i < repeat.value; i++) {
      const r = await runTool('osascript', ['-e', script], 5000);
      if (!r.ok) return { success: false, error: r.error, backend };
    }
    return { success: true, backend };
  }

  if (!key.xdo) return { success: false, backend, error: `Key "${key.token}" has no xdotool keysym.` };
  const chord = [
    mods.ctrl ? 'ctrl' : '',
    mods.alt ? 'alt' : '',
    mods.shift ? 'shift' : '',
    mods.meta ? 'super' : '',
    key.xdo,
  ].filter(Boolean).join('+');
  const args = ['key', '--clearmodifiers'];
  if (repeat.value > 1) args.push('--repeat', String(repeat.value), '--delay', '40');
  args.push(chord);
  const r = await runTool('xdotool', args, 10_000);
  return { success: r.ok, error: r.error, backend };
}

export async function performTypeText(
  text: unknown,
  opts: PerformOptions = {},
): Promise<MouseOutcome> {
  const platform = opts.platform ?? currentPlatform();
  const backend = backendFor(platform);
  const chunks = normaliseText(text);
  if (!chunks.ok) return { success: false, error: chunks.error, backend };

  for (const chunk of chunks.value) {
    if (platform === 'win32') {
      // SendInput + KEYEVENTF_UNICODE types the characters literally — no
      // SendKeys metacharacter escaping, no dependence on the active layout.
      const res = await sendWindows({ id: nextRequestId(), op: 'type', text: chunk });
      if (!res.ok) return { success: false, error: res.error, backend };
      continue;
    }
    if (platform === 'darwin') {
      const escaped = chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const r = await runTool(
        'osascript',
        ['-e', `tell application "System Events" to keystroke "${escaped}"`],
        30_000,
      );
      if (!r.ok) return { success: false, error: r.error, backend };
      continue;
    }
    const r = await runTool('xdotool', ['type', '--delay', '12', '--', chunk], 60_000);
    if (!r.ok) return { success: false, error: r.error, backend };
  }
  return { success: true, backend };
}

// ── Capability probe ────────────────────────────────────────────────────────

let boundsCache: ScreenBounds | null = null;

/**
 * Measure the real desktop so coordinates can be clamped to it.
 *
 * Probed, never assumed — the previous Windows branch of the capability check
 * reported `ready` for input automation without running anything at all.
 */
export async function measureScreenBounds(opts: PerformOptions = {}): Promise<ScreenBounds> {
  const platform = opts.platform ?? currentPlatform();
  if (boundsCache) return boundsCache;

  if (platform === 'win32') {
    const res = await sendWindows({ id: nextRequestId(), op: 'screen' });
    const d = res.ok ? res.data : undefined;
    const width = d ? Number(d.width) : NaN;
    const height = d ? Number(d.height) : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return FALLBACK_BOUNDS;
    }
    boundsCache = {
      width,
      height,
      virtual: {
        x: Number(d!.vx) || 0,
        y: Number(d!.vy) || 0,
        width: Number(d!.vw) || width,
        height: Number(d!.vh) || height,
      },
    };
    return boundsCache;
  }

  if (platform === 'linux') {
    const r = await execBinary('xdotool', ['getdisplaygeometry'], 3000);
    const m = r.ok ? /(\d+)\s+x\s+(\d+)/.exec(r.stdout) : null;
    if (m) {
      boundsCache = { width: Number(m[1]), height: Number(m[2]) };
      return boundsCache;
    }
    return FALLBACK_BOUNDS;
  }

  try {
    // Electron is main-process code only, so a static import would drag the
    // whole runtime into any module that merely wants argument validation.
    const { screen } = await import('electron');
    const d = screen.getPrimaryDisplay();
    boundsCache = { width: d.size.width, height: d.size.height };
    return boundsCache;
  } catch {
    return FALLBACK_BOUNDS;
  }
}

/**
 * Report what input automation this machine can ACTUALLY do.
 *
 * `ready` requires a real backend: a live user32.dll round trip on Windows,
 * xdotool/ydotool present on Linux, Accessibility granted on macOS. Anything
 * else is reported honestly rather than as `ready`.
 */
export async function probeInputBackend(opts: PerformOptions = {}): Promise<InputBackendProbe> {
  const platform = opts.platform ?? currentPlatform();

  if (platform === 'win32') {
    const res = await sendWindows({ id: nextRequestId(), op: 'screen' });
    if (res.ok && res.data) {
      return {
        status: 'ready',
        backend: WINDOWS_BACKEND,
        details: 'Win32 SendInput verified by a live user32.dll round trip (mouse, keys and Unicode text)',
        bounds: await measureScreenBounds({ platform }),
      };
    }
    return {
      status: 'dependency-missing',
      backend: WINDOWS_BACKEND,
      details: `Win32 SendInput shim could not be loaded: ${res.error ?? 'unknown error'}`,
    };
  }

  if (platform === 'linux') {
    const wayland = Boolean(process.env.WAYLAND_DISPLAY);
    if (await binaryExists(wayland ? 'ydotool' : 'xdotool')) {
      return {
        status: 'ready',
        backend: wayland ? 'ydotool' : 'xdotool',
        details: wayland
          ? 'Wayland synthetic input via ydotool (needs ydotoold running)'
          : 'X11 synthetic input via xdotool',
        bounds: await measureScreenBounds({ platform }),
      };
    }
    if (wayland && (await binaryExists('xdotool'))) {
      return {
        status: 'degraded',
        backend: 'xdotool (XWayland)',
        details:
          'xdotool via XWayland — may not reach every Wayland compositor. Install ydotool for native input.',
      };
    }
    return {
      status: 'dependency-missing',
      backend: wayland ? 'ydotool' : 'xdotool',
      details: `Install ${wayland ? 'ydotool (plus ydotoold)' : 'xdotool'} for desktop input automation.`,
    };
  }

  try {
    const { systemPreferences } = await import('electron');
    if (systemPreferences.isTrustedAccessibilityClient(false)) {
      return {
        status: 'ready',
        backend: DARWIN_BACKEND,
        details: 'AppleScript via System Events (Accessibility granted)',
        bounds: await measureScreenBounds({ platform }),
      };
    }
    return {
      status: 'dependency-missing',
      backend: DARWIN_BACKEND,
      details:
        'Requires Accessibility permission: System Settings → Privacy & Security → Accessibility → Henry AI',
    };
  } catch (e) {
    return {
      status: 'unavailable',
      backend: DARWIN_BACKEND,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

async function binaryExists(bin: string): Promise<boolean> {
  // `which` does not exist on Windows; `where` is its counterpart.
  const r = await execBinary(process.platform === 'win32' ? 'where' : 'which', [bin], 3000);
  return r.ok && r.stdout.trim().length > 0;
}

/** Test seam: forget the cached desktop size. */
export function resetScreenBoundsCache(): void {
  boundsCache = null;
}