/**
 * Row 6.11 — the assistant's spoken name, driven through the REAL entry point.
 *
 * The trap this file exists to close: `greetingAssistantName.test.ts` called
 * `renderGreeting(template, owner, 'Zorblax')` directly. That proved the
 * RENDERER honours its parameter and nothing more. On the installed package the
 * greeting said the OWNER's name twice and ignored every setting, because
 * nothing ever supplied the value:
 *
 *   - `brand_name` does not exist in this app.
 *   - `creator_orb` — the key the greeting read — is an orb-appearance blob
 *     (skin / speed / accent), not a name.
 *
 * So there was NO setting that drove the assistant's spoken name at all. A
 * function-level test cannot catch that class of bug, and one already shipped
 * here and had to be retracted.
 *
 * Everything below goes through the same two IPC handlers a user reaches:
 *
 *   write:  `settings:save`  ← what `window.henryAPI.saveSetting` invokes,
 *                              which is what the Settings panel calls.
 *   read:   `voice:greeting` ← what `window.henryAPI.voiceGreeting` invokes,
 *                              which is what `App.tsx` calls at launch.
 *
 * Both handlers are the REAL registered functions against a REAL, file-backed
 * SQLite database. `node:sqlite` stands in for better-sqlite3 because the copy
 * in node_modules is rebuilt against Electron's ABI and will not dlopen under
 * plain Node — same SQL engine, same statements, so the wiring under test is
 * the production wiring and only the driver differs. A file (not `:memory:`) so
 * "survives a restart" can be tested by actually closing and reopening it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { registerVoiceGreetingHandlers, GREETING_VARIANTS, ALL_GREETING_VARIANTS } from './greeting';
import { registerSettingsHandlers } from '../ipc/settings';
import { withSettingDefaults, KNOWN_SETTING_KEYS } from '../../src/henry/settingsContract';

/**
 * The greeting synthesises audio into `app.getPath('userData')` and calls the
 * TTS ladder. Point userData at a throwaway directory and stub `speak`, so the
 * test exercises the wiring rather than a speech engine. The stub still returns
 * a real buffer derived from the text, so the on-disk cache is genuinely
 * written and re-read — the cache must not be able to hide the name by
 * replaying audio synthesised for a previous one.
 *
 * Mocked before the static imports above are evaluated: vitest hoists
 * `vi.mock` above the module graph, so `greeting.ts` and `platform/tts` both
 * see these doubles.
 */
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  userData: '',
  spoken: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? h.userData : os.tmpdir()),
    getVersion: () => '0.0.0-test',
    getName: () => 'Henry',
    isPackaged: false,
  },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      // Electron throws on a second handle() for one channel; so does this, so
      // a test that registers twice fails loudly rather than silently.
      if (h.handlers.has(channel)) throw new Error(`duplicate ipcMain.handle: ${channel}`);
      h.handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      h.handlers.delete(channel);
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  dialog: {},
  BrowserWindow: class {},
}));

vi.mock('../../src/platform/tts', () => ({
  speak: vi.fn(async (_db: unknown, opts: { text: string }) => {
    h.spoken.push(opts.text);
    return { audio: Buffer.from(`audio-for:${opts.text}`, 'utf8'), engine: 'local' };
  }),
}));

/** The production schema for these tables, copied from `ipc/database.ts`. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, level TEXT, scope TEXT, message TEXT, meta TEXT
  );
`;

interface GreetingResult {
  ok: boolean;
  result: { text: string; period: string; speak: boolean; mimeType: string; audio: Uint8Array };
  error?: string;
}

let db: DatabaseSync;
let tmpDir: string;
let userData: string;
let dbFile: string;
function openDb(file: string): DatabaseSync {
  const handle = new DatabaseSync(file);
  // IF NOT EXISTS, so reopening the same file after a simulated restart is a
  // no-op rather than a failure — that is what production does too.
  handle.exec(SCHEMA);
  return handle;
}

/** Register the production IPC handlers against `db`. */
function boot(): void {
  registerSettingsHandlers(db as unknown as Database.Database);
  registerVoiceGreetingHandlers(db as unknown as Database.Database);
}

/** The real `settings:save` handler — exactly what the Settings panel invokes. */
function saveSetting(key: string, value: string): boolean {
  const handler = h.handlers.get('settings:save');
  if (!handler) throw new Error('settings:save is not registered');
  // `guardedEvent` inspects the sender; there is no window here, so pass the
  // empty sender it tolerates (see ipc/validation.ts).
  return handler({ sender: undefined, senderFrame: null }, { key, value }) as boolean;
}

/** The real `settings:getAll` handler — the renderer's read-back path. */
function getAllSettings(): Record<string, string> {
  const handler = h.handlers.get('settings:getAll');
  if (!handler) throw new Error('settings:getAll is not registered');
  return handler() as Record<string, string>;
}

/** The real `voice:greeting` handler — what `App.tsx` calls at launch. */
async function voiceGreeting(opts: { speak?: boolean } = { speak: false }): Promise<GreetingResult> {
  const handler = h.handlers.get('voice:greeting');
  if (!handler) throw new Error('voice:greeting is not registered');
  return (await handler(null, opts)) as GreetingResult;
}

/** `voice:greeting` with the clock pinned, so the daily seed can be walked. */
async function greetingOnDate(date: Date): Promise<string> {
  const clock = vi.useFakeTimers();
  clock.setSystemTime(date);
  try {
    const res = await voiceGreeting();
    return res.result.text;
  } finally {
    clock.useRealTimers();
  }
}

beforeEach(() => {
  h.handlers.clear();
  h.spoken.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-greeting-'));
  userData = path.join(tmpDir, 'userData');
  dbFile = path.join(tmpDir, 'henry.db');
  h.userData = userData;

  db = openDb(dbFile);
  boot();
});

afterEach(() => {
  h.handlers.clear();
  // A test that failed part-way through the reload simulation may already have
  // closed the handle; closing twice throws, so this must tolerate it.
  try { db.close(); } catch { /* already closed by the test itself */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the assistant name reaches the greeting through the wired path', () => {
  it('says the configured name when set via the real settings:save handler', async () => {
    saveSetting('assistant_name', 'Zorblax');

    const res = await voiceGreeting();
    expect(res.ok, res.error).toBe(true);
    expect(res.result.text).toContain('Zorblax');
    // The whole point of row 6.11: no stale literal survives.
    expect(res.result.text).not.toContain('Henry');
  });

  it('the renderer can read the name back out of settings:getAll', () => {
    saveSetting('assistant_name', 'Zorblax');
    expect(getAllSettings().assistant_name).toBe('Zorblax');
  });

  it('speaks the configured name, not the owner name', async () => {
    saveSetting('owner_name', 'JARVIS');
    saveSetting('assistant_name', 'Zorblax');

    await voiceGreeting({ speak: true });

    expect(h.spoken).toHaveLength(1);
    // The reported failure was the OWNER's name appearing in the assistant
    // slot. Both names must be present, each exactly once, in their own role.
    expect(h.spoken[0]).toContain('Zorblax');
    expect(h.spoken[0]).toContain('JARVIS');
    expect(h.spoken[0].match(/JARVIS/g)).toHaveLength(1);
    expect(h.spoken[0].match(/Zorblax/g)).toHaveLength(1);
  });

  it('reads the name through the settings service after a simulated reload', async () => {
    saveSetting('assistant_name', 'Zorblax');
    expect(getAllSettings().assistant_name).toBe('Zorblax');

    // Simulate a restart: tear the IPC layer down, close the database, then
    // reopen the SAME FILE and re-register. A value held in a module-level
    // variable, a React local, or a closure would not survive this.
    h.handlers.clear();
    db.close();
    db = openDb(dbFile);
    boot();

    expect(getAllSettings().assistant_name).toBe('Zorblax');

    const res = await voiceGreeting();
    expect(res.ok, res.error).toBe(true);
    expect(res.result.text).toContain('Zorblax');
  });
});

describe('all twelve variants, through the real IPC handler', () => {
  /**
   * The daily seed picks one variant per period per day, so a fixed date only
   * ever reaches one of the three. Each template is therefore walked to a date
   * whose seed selects it, and the handler is invoked with the clock pinned to
   * that date. That exercises the real `pickVariant` → `renderGreeting` →
   * SQLite path, not a direct render call.
   */
  async function findDateFor(variant: string, period: string): Promise<Date> {
    const hours: Record<string, number> = { morning: 9, afternoon: 14, evening: 20, lateNight: 23 };
    for (let day = 1; day <= 400; day++) {
      const date = new Date(2026, 0, day, hours[period]);
      if (date.getMonth() !== 0) break;
      const text = await greetingOnDate(date);
      // Strip the resolved values so the comparison is template-shaped.
      const skeleton = text.replace(/Zorblax/g, '{name}').replace(/, Alex/g, '{address}');
      if (skeleton === variant) return date;
    }
    throw new Error(`no date in 2026 selects ${variant}`);
  }

  it('every one of the twelve substitutes the configured name', async () => {
    saveSetting('owner_name', 'Alex');
    saveSetting('assistant_name', 'Zorblax');

    let reached = 0;
    for (const variant of ALL_GREETING_VARIANTS) {
      const period =
        Object.entries(GREETING_VARIANTS).find(([, pool]) => pool.includes(variant))?.[0] ?? '';
      const date = await findDateFor(variant, period);
      const text = await greetingOnDate(date);
      reached++;

      // The invariant that matters: no literal identity survives, and the
      // placeholder resolves to the configured name wherever one appears.
      expect(text, variant).not.toMatch(/Henry/);
      expect(text, variant).not.toContain('{name}');
      expect(text, variant).not.toContain('{address}');
      if (variant.includes('{name}')) expect(text, variant).toContain('Zorblax');
      // The five first-person variants carry no {name} and must not acquire one.
      else expect(text, variant).not.toContain('Zorblax');
    }

    // Proves the walk really covered all twelve rather than short-circuiting.
    expect(reached).toBe(12);
  });

  it('still has exactly twelve variants, three per period', () => {
    for (const pool of Object.values(GREETING_VARIANTS)) expect(pool).toHaveLength(3);
    expect(ALL_GREETING_VARIANTS).toHaveLength(12);
  });

  it('no template carries a literal identity or a third placeholder', () => {
    // Guards the COPY, not the wiring. A variant edited back to a hardcoded
    // name would pass every assertion above on a default install, because
    // "Henry" is also the fallback — this is the only check that catches it.
    for (const variant of ALL_GREETING_VARIANTS) {
      expect(variant).toContain('{address}');
      expect(variant, variant).not.toMatch(/Henry/i);
      for (const p of variant.match(/\{[a-zA-Z]+\}/g) ?? []) {
        expect(['{address}', '{name}'], `${variant} → ${p}`).toContain(p);
      }
    }
  });

  it('keeps the stable per-day selection on the wired path', async () => {
    saveSetting('assistant_name', 'Zorblax');
    const morning = await greetingOnDate(new Date(2026, 0, 15, 9));
    expect(await greetingOnDate(new Date(2026, 0, 15, 11))).toBe(morning);
    expect(await greetingOnDate(new Date(2026, 0, 16, 9))).not.toBe(morning);
  });
});

describe('{address} is the OWNER and is independent of the assistant name', () => {
  it('renders the owner name in the salutation for any assistant name', async () => {
    saveSetting('owner_name', 'Alex');
    for (const assistantName of ['Henry', 'Zorblax', 'Ada']) {
      saveSetting('assistant_name', assistantName);
      const res = await voiceGreeting();
      expect(res.result.text, assistantName).toContain('Alex');
      expect(res.result.text, assistantName).toContain(assistantName);
      // The owner name must never be reused as the self-reference: the exact
      // shape the live bug produced was "{name} here" reading "JARVIS here".
      expect(res.result.text, assistantName).not.toMatch(/\bAlex\b[^.]*\b(is|here)\b/);
    }
  });

  it('omits the owner name entirely when none is configured', async () => {
    saveSetting('assistant_name', 'Zorblax');
    const res = await voiceGreeting();
    // The salutation carries no name at all. Asserted on the salutation rather
    // than on the whole line: several templates contain a comma of their own
    // ("…, ready to get things done.").
    const salutation = res.result.text.split(/[.—]/)[0];
    expect(salutation).not.toContain(',');
    expect(res.result.text).toContain('Zorblax');
  });
});

describe('an unconfigured install is unchanged', () => {
  it('says Henry when nothing at all has been set', async () => {
    const res = await voiceGreeting();
    expect(res.ok, res.error).toBe(true);
    expect(res.result.text).toContain('Henry');
  });

  it('a blank setting falls back to Henry', async () => {
    for (const blank of ['', '   ']) {
      saveSetting('assistant_name', blank);
      const res = await voiceGreeting();
      expect(res.result.text, JSON.stringify(blank)).toContain('Henry');
    }
  });

  it('exposes the default through the settings contract, not just the greeting', () => {
    // The panel reads its placeholder from the same contract default the
    // resolver falls back to, so an unconfigured install shows "Henry" there too.
    expect(KNOWN_SETTING_KEYS).toContain('assistant_name');
    expect(withSettingDefaults({}).assistant_name).toBe('Henry');
  });
});

describe('changing the name is not masked by the audio cache', () => {
  it('a rename produces new audio rather than replaying the cached bytes', async () => {
    saveSetting('assistant_name', 'Zorblax');
    const first = await voiceGreeting({ speak: true });
    expect(Buffer.from(first.result.audio).toString('utf8')).toContain('Zorblax');

    saveSetting('assistant_name', 'Ada');
    const second = await voiceGreeting({ speak: true });
    expect(Buffer.from(second.result.audio).toString('utf8')).toContain('Ada');
    // Two synthesis passes: the cache is keyed on the rendered text, so a
    // rename cannot serve the previous name's bytes.
    expect(h.spoken).toHaveLength(2);
  });

  it('repeating the same name reuses the cache instead of re-synthesising', async () => {
    saveSetting('assistant_name', 'Zorblax');
    await voiceGreeting({ speak: true });
    await voiceGreeting({ speak: true });
    expect(h.spoken).toHaveLength(1);
  });

  it('voice:greeting:clearCache drops the synthesised bytes', async () => {
    saveSetting('assistant_name', 'Zorblax');
    await voiceGreeting({ speak: true });
    const cacheDir = path.join(userData, 'cache', 'greetings');
    expect(fs.readdirSync(cacheDir).length).toBeGreaterThan(0);

    const clear = h.handlers.get('voice:greeting:clearCache');
    expect(clear?.()).toEqual({ ok: true });
    // `rmSync(recursive)` removes the directory itself, not just its contents.
    expect(fs.existsSync(cacheDir)).toBe(false);

    // And the observable consequence: the next greeting re-synthesises rather
    // than serving the bytes it just threw away.
    await voiceGreeting({ speak: true });
    expect(h.spoken).toHaveLength(2);
  });
});