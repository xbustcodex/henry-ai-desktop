/**
 * The settings contract.
 *
 * Settings are stored as an untyped `Record<string, string>` in a key/value
 * table, and that is deliberate — it means a setting added years ago still
 * reads back. Paid 1.7.0 has a 24-field Zod schema (`contracts.ts:250-343`)
 * which is the right idea, but adopting a schema is only safe if it cannot
 * reshape what is already on disk.
 *
 * ## What this does NOT do
 *
 *   - It does not rename anything.
 *   - It does not rewrite or migrate stored values.
 *   - It does not invent defaults that overwrite what a user has chosen.
 *   - It does not reject unknown keys.
 *
 * A key the app has never heard of still round-trips untouched, because losing
 * it would be a worse failure than not typing it. The SQLite storage format is
 * unchanged; typing happens at the read and write boundary only.
 *
 * ## Why it still matters
 *
 * Without this, `voice_tts_engine` is whatever string was in the table. A
 * caller that expects `auto` will happily receive `undefined` and fall through
 * to a branch the user never picked. With it, a stored value that does not
 * parse falls back to the documented default *for that read only*, and the
 * stored value is left alone.
 */
import { z } from 'zod';

/** Anything we do not recognise passes through unchanged. */
const passthroughString = z.string();

export const settingsSchema = {
  // ── Engine / model selection ────────────────────────────────────────────
  chat_fast_provider: passthroughString.default(''),
  chat_fast_model: passthroughString.default(''),
  companion_provider: passthroughString.default(''),
  companion_model: passthroughString.default(''),
  companion_provider_2: passthroughString.default(''),
  companion_model_2: passthroughString.default(''),
  worker_provider: passthroughString.default(''),
  worker_model: passthroughString.default(''),

  // ── Endpoints ──────────────────────────────────────────────────────────
  ollama_base_url: passthroughString.default('http://127.0.0.1:11434'),
  mobile_proxy_url: passthroughString.default(''),

  // ── Flags ───────────────────────────────────────────────────────────────
  setup_complete: z.enum(['1', '0', 'true', 'false']).default('0'),
  henry_first_launch: z.enum(['1', '0', 'true', 'false']).default('0'),
  auto_tunnel_enabled: z.enum(['1', '0', 'true', 'false']).default('0'),
  henry_tts_enabled: z.enum(['1', '0', 'true', 'false']).default('1'),

  // ── Voice ───────────────────────────────────────────────────────────────
  owner_name: passthroughString.default(''),
  // Constrained, because this value branches behaviour: an unrecognised engine
  // would otherwise sail through a plain string schema and leave the caller
  // falling through to a branch the user never chose. The UI offers exactly
  // these three (SettingsView.tsx:868), and 'local' is kept because older
  // installs stored it.
  voice_tts_engine: z.enum(['auto', 'local', 'elevenlabs', 'kokoro', 'system']).default('auto'),
  voice_tts_voice: passthroughString.default(''),
  voice_say_voice: passthroughString.default(''),
  voice_say_rate: passthroughString.default(''),
  voice_espeak_voice: passthroughString.default(''),
  voice_espeak_rate: passthroughString.default(''),
  voice_greeting: passthroughString.default('on'),

  // ── JSON blobs (exact wire format preserved) ────────────────────────────
  creator_demo: passthroughString.default(''),
  creator_orb: passthroughString.default(''),
  theme_json: passthroughString.default(''),
  voice_endpointing: passthroughString.default(''),

  // ── Other keys seen in the app ──────────────────────────────────────────
  henry_agent_mode: passthroughString.default(''),
  henry_custom_mode_override: passthroughString.default(''),
} as const satisfies Record<string, z.ZodTypeAny>;

export type KnownSettingKey = keyof typeof settingsSchema;

/**
 * Apply defaults for absent keys.
 *
 * Only ever ADDS a key that is missing. A key that is present is left exactly
 * as stored, even if it does not parse — repairing a user's setting behind
 * their back is not this function's job.
 */
export function withSettingDefaults(stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...stored };
  for (const [key, schema] of Object.entries(settingsSchema)) {
    if (out[key] === undefined) {
      // Reading the default off the schema is safe: it is a constant, and it is
      // only consulted when nothing is stored.
      const parsed = (schema as z.ZodDefault<z.ZodString>)._def.defaultValue();
      out[key] = typeof parsed === 'string' ? parsed : '';
    }
  }
  return out;
}

/**
 * Read a typed value, falling back to the default for THIS read only.
 * The stored value is never modified.
 */
export function readSetting<T extends z.ZodTypeAny>(
  stored: Record<string, string>,
  key: string,
  schema: T,
): z.infer<T> {
  const raw = stored[key];
  if (raw === undefined) return schema.parse(undefined);
  const result = schema.safeParse(raw);
  return result.success ? result.data : schema.parse(undefined);
}

/** The list of keys this build knows about, for the settings UI and for tests. */
export const KNOWN_SETTING_KEYS = Object.keys(settingsSchema);

/**
 * Everything the app actually stores today must remain readable. This is the
 * guard against a schema silently dropping a key that used to work.
 */
export function unknownKeys(stored: Record<string, string>): string[] {
  return Object.keys(stored).filter((k) => !(k in settingsSchema));
}