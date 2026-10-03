/**
 * Companion personality (row 8.3), emotional context (row 8.4) and
 * companion voice (row 8.5).
 *
 * All three are persisted state in the ONE existing database, and all three
 * are read by `buildCompanionContext()` — the function the companion/agent
 * prompt path calls to decide how Henry sounds on a given turn. That call is
 * the real consumer: without it these would be settings nobody applies.
 *
 * Nothing here invents a personality on a fresh install. Traits default to
 * unset, and `buildCompanionContext` reports them as unset so the prompt path
 * falls back to Henry's existing charter rather than a fabricated persona.
 */

import type Database from 'better-sqlite3';
import type { SqlDatabase } from '../vector/sql';

/** DDL for the three companion subsystems. Idempotent. */
export function migrateCompanionSchema(db: SqlDatabase): void {
  db.exec(`
    -- ── 8.3 Personality ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS companion_personality (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      traits_json   TEXT NOT NULL DEFAULT '{}',
      speaking_style TEXT,
      values_json   TEXT NOT NULL DEFAULT '[]',
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── 8.4 Emotional context ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS companion_emotional_state (
      id            TEXT PRIMARY KEY,
      mood          TEXT NOT NULL DEFAULT 'neutral',
      valence       REAL NOT NULL DEFAULT 0,
      arousal       REAL NOT NULL DEFAULT 0.3,
      intensity     REAL NOT NULL DEFAULT 0.2,
      confidence    REAL NOT NULL DEFAULT 0.5,
      trigger_note  TEXT,
      observed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS companion_emotional_history (
      id            TEXT PRIMARY KEY,
      mood          TEXT NOT NULL,
      valence       REAL NOT NULL DEFAULT 0,
      arousal       REAL NOT NULL DEFAULT 0,
      intensity     REAL NOT NULL DEFAULT 0,
      source        TEXT NOT NULL DEFAULT 'observed',
      note          TEXT,
      observed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_companion_emotional_history_time
      ON companion_emotional_history(observed_at);

    -- ── 8.5 Companion voice ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS companion_voice_profile (
      id            TEXT PRIMARY KEY,
      voice_id      TEXT,
      engine        TEXT,
      rate          REAL NOT NULL DEFAULT 1.0,
      pitch         REAL NOT NULL DEFAULT 1.0,
      style         TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export interface CompanionPersonality {
  name: string | null;
  /** Free-form trait map, e.g. `{ humour: 0.4, directness: 0.9 }`. */
  traits: Record<string, number>;
  speakingStyle: string | null;
  values: string[];
  updatedAt: string;
}

export interface CompanionEmotion {
  mood: string;
  /** -1 (unpleasant) .. +1 (pleasant). */
  valence: number;
  /** 0 (calm) .. 1 (activated). */
  arousal: number;
  /** How strongly this state should colour the response, 0..1. */
  intensity: number;
  confidence: number;
  triggerNote: string | null;
  observedAt: string;
}

export interface CompanionVoiceProfile {
  voiceId: string | null;
  engine: string | null;
  rate: number;
  pitch: number;
  style: string | null;
  updatedAt: string;
}

export interface CompanionContext {
  personality: CompanionPersonality;
  emotion: CompanionEmotion;
  voice: CompanionVoiceProfile;
  /** Prompt-ready text. Empty string when nothing has been configured. */
  promptBlock: string;
  /** True when nothing has been configured yet. */
  isDefault: boolean;
}

const PROFILE_ID = 'default';

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function clampRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Recognised moods and their (valence, arousal) priors. Valence is the sign of
 * affect; arousal is how activated the mood is. Restless and calm are both
 * mildly negative but differ sharply in arousal, which is why they are not
 * collapsed into one "sad" value.
 */
export const MOOD_PRIORS: Record<string, { valence: number; arousal: number }> = {
  neutral: { valence: 0, arousal: 0.3 },
  calm: { valence: 0.35, arousal: 0.15 },
  content: { valence: 0.55, arousal: 0.25 },
  happy: { valence: 0.7, arousal: 0.55 },
  excited: { valence: 0.75, arousal: 0.85 },
  grateful: { valence: 0.6, arousal: 0.35 },
  curious: { valence: 0.4, arousal: 0.6 },
  focused: { valence: 0.25, arousal: 0.55 },
  concerned: { valence: -0.35, arousal: 0.6 },
  anxious: { valence: -0.55, arousal: 0.8 },
  frustrated: { valence: -0.5, arousal: 0.7 },
  sad: { valence: -0.6, arousal: 0.25 },
  tired: { valence: -0.3, arousal: 0.1 },
  annoyed: { valence: -0.45, arousal: 0.65 },
};

/** Mood must decay toward neutral — a mood from Tuesday should not still be
 *  shaping Friday's tone. Half-life of ~6 hours. */
const DECAY_PER_HOUR = 0.89;

export class CompanionProfileService {
  private readonly db: SqlDatabase;

  constructor(db: Database.Database) {
    this.db = db as unknown as SqlDatabase;
  }

  migrate(): void {
    migrateCompanionSchema(this.db);
  }

  // ── 8.3 Personality ────────────────────────────────────────────────────

  getPersonality(): CompanionPersonality {
    const row = this.db
      .prepare(`SELECT name, traits_json, speaking_style, values_json, updated_at FROM companion_personality WHERE id = ?`)
      .get(PROFILE_ID) as Record<string, unknown> | undefined;
    if (!row) {
      return { name: null, traits: {}, speakingStyle: null, values: [], updatedAt: '' };
    }
    return {
      name: row.name == null ? null : String(row.name),
      traits: parseJson<Record<string, number>>(String(row.traits_json ?? '{}'), {}),
      speakingStyle: row.speaking_style == null ? null : String(row.speaking_style),
      values: parseJson<string[]>(String(row.values_json ?? '[]'), []),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  savePersonality(update: {
    name?: string | null;
    traits?: Record<string, number>;
    speakingStyle?: string | null;
    values?: string[];
  }): CompanionPersonality {
    const current = this.getPersonality();
    const traits: Record<string, number> = { ...current.traits };
    for (const [key, value] of Object.entries(update.traits ?? {})) {
      // Traits are confidences, not free text — clamp rather than reject, so a
      // 0..1 slider with floating-point drift still lands in range.
      traits[key] = clampRange(Number(value), 0, 1, 0.5);
    }
    const next = {
      name: update.name === undefined ? current.name : update.name,
      traits,
      speakingStyle: update.speakingStyle === undefined ? current.speakingStyle : update.speakingStyle,
      values: update.values ?? current.values,
    };
    this.db
      .prepare(
        `INSERT INTO companion_personality (id, name, traits_json, speaking_style, values_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           traits_json = excluded.traits_json,
           speaking_style = excluded.speaking_style,
           values_json = excluded.values_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        PROFILE_ID,
        next.name,
        JSON.stringify(next.traits),
        next.speakingStyle,
        JSON.stringify(next.values),
        new Date().toISOString(),
      );
    return this.getPersonality();
  }

  // ── 8.4 Emotional context ─────────────────────────────────────────────

  /**
   * Record an observation, blending it into the current state and appending to
   * the history. Blending rather than replacing is deliberate: one "frustrated"
   * message should not fully overwrite a calm baseline.
   */
  observeEmotion(input: { mood?: string; valence?: number; arousal?: number; intensity?: number; confidence?: number; note?: string }): CompanionEmotion {
    const mood = (input.mood ?? '').trim().toLowerCase() || 'neutral';
    const prior = MOOD_PRIORS[mood];
    const valence = input.valence !== undefined
      ? clampRange(input.valence, -1, 1, prior?.valence ?? 0)
      : (prior?.valence ?? 0);
    const arousal = input.arousal !== undefined
      ? clampRange(input.arousal, 0, 1, prior?.arousal ?? 0.3)
      : (prior?.arousal ?? 0.3);
    const intensity = clampRange(input.intensity ?? 0.5, 0, 1, 0.5);
    const confidence = clampRange(input.confidence ?? 0.6, 0, 1, 0.6);

    const current = this.getEmotion();
    // Weight the new observation by its own confidence; a confident read
    // ("user said they're anxious") outweighs a guess.
    const blend = Math.max(confidence, 0.1);
    const merged: CompanionEmotion = {
      mood,
      valence: current.valence * (1 - blend) + valence * blend,
      arousal: current.arousal * (1 - blend) + arousal * blend,
      intensity: current.intensity * (1 - blend) + intensity * blend,
      confidence,
      triggerNote: input.note ?? null,
      observedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO companion_emotional_state
           (id, mood, valence, arousal, intensity, confidence, trigger_note, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mood = excluded.mood, valence = excluded.valence, arousal = excluded.arousal,
           intensity = excluded.intensity, confidence = excluded.confidence,
           trigger_note = excluded.trigger_note, observed_at = excluded.observed_at`,
      )
      .run(
        PROFILE_ID, merged.mood, merged.valence, merged.arousal, merged.intensity,
        merged.confidence, merged.triggerNote, merged.observedAt,
      );

    this.db
      .prepare(
        `INSERT INTO companion_emotional_history (id, mood, valence, arousal, intensity, source, note, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(), mood, valence, arousal, intensity,
        input.note ? 'observed' : 'inferred', input.note ?? null, merged.observedAt,
      );

    return merged;
  }

  /** Current state, decayed toward neutral by elapsed time. */
  getEmotion(): CompanionEmotion {
    const row = this.db
      .prepare(
        `SELECT mood, valence, arousal, intensity, confidence, trigger_note, observed_at
         FROM companion_emotional_state WHERE id = ?`,
      )
      .get(PROFILE_ID) as Record<string, unknown> | undefined;
    if (!row) {
      return { mood: 'neutral', valence: 0, arousal: 0.3, intensity: 0.2, confidence: 0.5, triggerNote: null, observedAt: '' };
    }
    const observedAt = String(row.observed_at ?? '');
    const elapsedHours = observedAt ? (Date.now() - new Date(observedAt).getTime()) / 3_600_000 : 0;
    const decay = Math.pow(DECAY_PER_HOUR, Math.max(elapsedHours, 0));
    return {
      mood: decay < 0.5 ? 'neutral' : String(row.mood ?? 'neutral'),
      valence: Number(row.valence ?? 0) * decay,
      arousal: 0.3 + (Number(row.arousal ?? 0.3) - 0.3) * decay,
      intensity: Number(row.intensity ?? 0.2) * decay,
      confidence: Number(row.confidence ?? 0.5),
      triggerNote: row.trigger_note == null ? null : String(row.trigger_note),
      observedAt,
    };
  }

  /** Recent observations, newest first. */
  emotionalHistory(limit = 20): Array<{ mood: string; valence: number; arousal: number; note: string | null; observedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT mood, valence, arousal, note, observed_at FROM companion_emotional_history
         ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];
    return rows.map((r) => ({
      mood: String(r.mood),
      valence: Number(r.valence ?? 0),
      arousal: Number(r.arousal ?? 0),
      note: r.note == null ? null : String(r.note),
      observedAt: String(r.observed_at),
    }));
  }

  // ── 8.5 Companion voice ────────────────────────────────────────────────

  getVoiceProfile(): CompanionVoiceProfile {
    const row = this.db
      .prepare(`SELECT voice_id, engine, rate, pitch, style, updated_at FROM companion_voice_profile WHERE id = ?`)
      .get(PROFILE_ID) as Record<string, unknown> | undefined;
    if (!row) {
      return { voiceId: null, engine: null, rate: 1, pitch: 1, style: null, updatedAt: '' };
    }
    return {
      voiceId: row.voice_id == null ? null : String(row.voice_id),
      engine: row.engine == null ? null : String(row.engine),
      rate: Number(row.rate ?? 1),
      pitch: Number(row.pitch ?? 1),
      style: row.style == null ? null : String(row.style),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  saveVoiceProfile(update: {
    voiceId?: string | null;
    engine?: string | null;
    rate?: number;
    pitch?: number;
    style?: string | null;
  }): CompanionVoiceProfile {
    const current = this.getVoiceProfile();
    const next = {
      voiceId: update.voiceId === undefined ? current.voiceId : update.voiceId,
      engine: update.engine === undefined ? current.engine : update.engine,
      rate: clampRange(update.rate ?? current.rate, 0.5, 2, 1),
      pitch: clampRange(update.pitch ?? current.pitch, 0.5, 2, 1),
      style: update.style === undefined ? current.style : update.style,
    };
    this.db
      .prepare(
        `INSERT INTO companion_voice_profile (id, voice_id, engine, rate, pitch, style, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           voice_id = excluded.voice_id, engine = excluded.engine, rate = excluded.rate,
           pitch = excluded.pitch, style = excluded.style, updated_at = excluded.updated_at`,
      )
      .run(PROFILE_ID, next.voiceId, next.engine, next.rate, next.pitch, next.style, new Date().toISOString());
    return this.getVoiceProfile();
  }

  // ── The consumer: one call that assembles the whole companion context ──

  /**
   * Assemble personality + emotion + voice into the block the companion prompt
   * path injects. Returns `isDefault: true` and an empty prompt block when
   * nothing is configured, so callers must not assume a persona exists.
   */
  buildCompanionContext(): CompanionContext {
    const personality = this.getPersonality();
    const emotion = this.getEmotion();
    const voice = this.getVoiceProfile();
    const lines: string[] = [];

    if (personality.name) lines.push(`Companion name: ${personality.name}.`);
    if (personality.speakingStyle) lines.push(`Speaking style: ${personality.speakingStyle}.`);
    const traits = Object.entries(personality.traits)
      .filter(([, v]) => Number.isFinite(v))
      .sort((a, b) => b[1] - a[1]);
    if (traits.length > 0) {
      lines.push(`Trait strengths: ${traits.map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')}.`);
    }
    if (personality.values.length > 0) lines.push(`Stands for: ${personality.values.join('; ')}.`);

    // Only colour the tone when the mood is strong AND still fresh — a faded
    // mood must not keep steering the voice.
    if (emotion.intensity > 0.25 && emotion.confidence > 0.3) {
      const tone =
        emotion.valence > 0.25 ? 'warmer and more encouraging' :
        emotion.valence < -0.25 ? 'more careful and unhurried' :
        'steady and matter-of-fact';
      lines.push(`Current emotional context: ${emotion.mood} (${tone}; do not name the mood explicitly).`);
    }

    if (voice.voiceId || voice.style || voice.rate !== 1) {
      const parts: string[] = [];
      if (voice.style) parts.push(voice.style);
      if (voice.voiceId) parts.push(`voice ${voice.voiceId}`);
      if (Math.abs(voice.rate - 1) > 0.01) parts.push(`rate ${voice.rate.toFixed(2)}`);
      if (Math.abs(voice.pitch - 1) > 0.01) parts.push(`pitch ${voice.pitch.toFixed(2)}`);
      lines.push(`Voice: ${parts.join(', ')}.`);
    }

    const configured =
      Boolean(personality.name || personality.speakingStyle || traits.length > 0 || personality.values.length > 0) ||
      emotion.intensity > 0.25 ||
      Boolean(voice.voiceId || voice.style);

    return {
      personality,
      emotion,
      voice,
      promptBlock: lines.join('\n'),
      isDefault: !configured,
    };
  }
}

export function createCompanionProfileService(db: Database.Database): CompanionProfileService {
  const service = new CompanionProfileService(db);
  service.migrate();
  return service;
}
