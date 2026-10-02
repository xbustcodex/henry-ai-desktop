/**
 * The contract's whole promise is that existing settings survive. These tests
 * exist to make that falsifiable rather than merely stated.
 */
import { describe, it, expect } from 'vitest';
import {
  withSettingDefaults,
  readSetting,
  settingsSchema,
  unknownKeys,
  KNOWN_SETTING_KEYS,
} from './settingsContract';

describe('defaults', () => {
  it('adds a default only for a key that is absent', () => {
    const out = withSettingDefaults({});
    expect(out.voice_tts_engine).toBe('auto');
    expect(out.voice_greeting).toBe('on');
    expect(out.henry_tts_enabled).toBe('1');
  });

  it('never overwrites a stored value with the default', () => {
    const out = withSettingDefaults({ voice_tts_engine: 'elevenlabs', ollama_base_url: 'http://nas:11434' });
    expect(out.voice_tts_engine).toBe('elevenlabs');
    expect(out.ollama_base_url).toBe('http://nas:11434');
  });

  it('leaves a stored value alone even when it does not parse', () => {
    // Repairing a user's setting behind their back is not this function's job.
    const out = withSettingDefaults({ henry_tts_enabled: 'maybe' });
    expect(out.henry_tts_enabled).toBe('maybe');
  });

  it('does not invent keys that never existed', () => {
    const out = withSettingDefaults({});
    expect(Object.keys(out).sort()).toEqual([...KNOWN_SETTING_KEYS].sort());
  });
});

describe('unknown keys survive', () => {
  it('round-trips a key the build has never heard of', () => {
    const stored = { some_future_setting: 'value', another: 'x' };
    const out = withSettingDefaults(stored);
    expect(out.some_future_setting).toBe('value');
    expect(out.another).toBe('x');
  });

  it('reports what it does not type, rather than dropping it', () => {
    expect(unknownKeys({ voice_tts_engine: 'auto', mystery: '2' })).toEqual(['mystery']);
  });

  it('does not mutate the caller\'s object', () => {
    const stored: Record<string, string> = { voice_tts_engine: 'elevenlabs' };
    withSettingDefaults(stored);
    expect(Object.keys(stored)).toEqual(['voice_tts_engine']);
  });
});

describe('typed reads', () => {
  it('returns the stored value when it parses', () => {
    expect(readSetting({ voice_tts_engine: 'elevenlabs' }, 'voice_tts_engine', settingsSchema.voice_tts_engine)).toBe('elevenlabs');
  });

  it('falls back to the default for one read when it does not parse', () => {
    const stored = { voice_tts_engine: 'nonsense-engine' };
    expect(readSetting(stored, 'voice_tts_engine', settingsSchema.voice_tts_engine)).toBe('auto');
    // …and the stored value is untouched.
    expect(stored.voice_tts_engine).toBe('nonsense-engine');
  });

  it('accepts both boolean spellings already in the wild', () => {
    // Both '1' and 'true' exist in real databases from different eras.
    expect(readSetting({ henry_tts_enabled: 'true' }, 'henry_tts_enabled', settingsSchema.henry_tts_enabled)).toBe('true');
    expect(readSetting({ henry_tts_enabled: '1' }, 'henry_tts_enabled', settingsSchema.henry_tts_enabled)).toBe('1');
  });

  it('reads an absent key as its default', () => {
    expect(readSetting({}, 'voice_greeting', settingsSchema.voice_greeting)).toBe('on');
  });
});

describe('JSON blobs keep their exact wire format', () => {
  it('passes the stored JSON string through untouched', () => {
    const blob = JSON.stringify({ skin: 'minimalistic', accent: '#5cdcff' });
    const out = withSettingDefaults({ theme_json: blob });
    // Not parsed, not re-serialised, not re-ordered.
    expect(out.theme_json).toBe(blob);
  });

  it('leaves a blank blob blank rather than substituting a value', () => {
    expect(withSettingDefaults({ creator_orb: '' }).creator_orb).toBe('');
  });
});

describe('endpoints', () => {
  it('keeps a custom ollama_base_url exactly as stored', () => {
    const url = 'http://192.168.1.50:11434';
    expect(withSettingDefaults({ ollama_base_url: url }).ollama_base_url).toBe(url);
  });

  it('falls back to the local default only when unset', () => {
    expect(withSettingDefaults({}).ollama_base_url).toBe('http://127.0.0.1:11434');
  });
});

describe('keys in real use are covered', () => {
  it('types every key the app currently writes', () => {
    const inUse = [
      'chat_fast_model', 'chat_fast_provider', 'companion_model', 'companion_provider',
      'companion_model_2', 'companion_provider_2', 'worker_model', 'worker_provider',
      'ollama_base_url', 'mobile_proxy_url', 'setup_complete', 'henry_first_launch',
      'auto_tunnel_enabled', 'henry_tts_enabled', 'creator_demo', 'creator_orb',
      'theme_json', 'voice_endpointing', 'henry_agent_mode', 'henry_custom_mode_override',
      'owner_name', 'voice_tts_engine', 'voice_tts_voice', 'voice_say_voice',
      'voice_say_rate', 'voice_espeak_voice', 'voice_espeak_rate', 'voice_greeting',
    ];
    for (const key of inUse) {
      expect(KNOWN_SETTING_KEYS, `${key} is in use but not typed`).toContain(key);
    }
  });
});