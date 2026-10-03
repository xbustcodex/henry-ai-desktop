/**
 * Companion personality (8.3), emotional context (8.4) and voice (8.5).
 *
 * These assert persistence across service instances, because a companion
 * profile that lives only in memory is not a feature — restarting the app must
 * not reset how Henry speaks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { CompanionProfileService } from './personality';

let db: DatabaseSync;

function service(): CompanionProfileService {
  const s = new CompanionProfileService(db as never);
  s.migrate();
  return s;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
});

afterEach(() => {
  db.close();
});

describe('Companion personality (8.3)', () => {
  it('reports nothing configured on a fresh install rather than inventing a persona', () => {
    const fresh = service();
    expect(fresh.getPersonality()).toEqual({
      name: null, traits: {}, speakingStyle: null, values: [], updatedAt: '',
    });
    const context = fresh.buildCompanionContext();
    expect(context.isDefault).toBe(true);
    expect(context.promptBlock).toBe('');
  });

  it('persists a saved personality across service instances', () => {
    service().savePersonality({
      name: 'Wren',
      speakingStyle: 'warm and brief',
      traits: { humour: 0.4, directness: 0.9 },
      values: ['never guess at numbers'],
    });

    const reloaded = service().getPersonality();
    expect(reloaded.name).toBe('Wren');
    expect(reloaded.speakingStyle).toBe('warm and brief');
    expect(reloaded.values).toEqual(['never guess at numbers']);
    expect(reloaded.traits.directness).toBeCloseTo(0.9, 5);
  });

  it('clamps a trait outside 0..1 instead of storing nonsense', () => {
    const saved = service().savePersonality({ traits: { humour: 4.2, directness: -3 } });
    expect(saved.traits.humour).toBe(1);
    expect(saved.traits.directness).toBe(0);
  });

  it('merges traits rather than replacing the whole map', () => {
    const s = service();
    s.savePersonality({ traits: { humour: 0.4 } });
    const merged = s.savePersonality({ traits: { patience: 0.8 } });
    expect(merged.traits.humour).toBeCloseTo(0.4, 5);
    expect(merged.traits.patience).toBeCloseTo(0.8, 5);
  });

  it('renders the saved personality into the prompt block the agent consumes', () => {
    const s = service();
    s.savePersonality({ name: 'Wren', speakingStyle: 'plainspoken', values: ['be specific'] });
    s.saveVoiceProfile({ style: 'measured' });

    const context = s.buildCompanionContext();
    expect(context.isDefault).toBe(false);
    expect(context.promptBlock).toContain('Wren');
    expect(context.promptBlock).toContain('plainspoken');
    expect(context.promptBlock).toContain('be specific');
    expect(context.promptBlock).toContain('measured');
  });
});

describe('Companion emotional context (8.4)', () => {
  it('starts neutral rather than at a fabricated mood', () => {
    expect(service().getEmotion().mood).toBe('neutral');
  });

  it('records an observation and persists it', () => {
    const s = service();
    s.observeEmotion({ mood: 'anxious', note: 'user mentioned a deadline slipping' });

    const reloaded = service().getEmotion();
    expect(reloaded.mood).toBe('anxious');
    expect(reloaded.valence).toBeLessThan(0);
    expect(reloaded.arousal).toBeGreaterThan(0.5);
    expect(reloaded.triggerNote).toContain('deadline');
  });

  it('appends to history rather than overwriting it', () => {
    const s = service();
    s.observeEmotion({ mood: 'calm' });
    s.observeEmotion({ mood: 'frustrated' });
    s.observeEmotion({ mood: 'happy' });

    const history = s.getEmotion().mood === 'happy' ? s.emotionalHistory(10) : [];
    expect(history.length).toBe(3);
    expect(history[0].mood).toBe('happy');
  });

  it('decays a stale mood back toward neutral', () => {
    const s = service();
    s.observeEmotion({ mood: 'angry' as never, valence: -0.9, arousal: 0.9, intensity: 0.9, confidence: 1 });
    // Backdate the observation by three days.
    db.prepare(`UPDATE companion_emotional_state SET observed_at = ? WHERE id = 'default'`).run(
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
    );

    const faded = s.getEmotion();
    expect(faded.mood).toBe('neutral');
    expect(Math.abs(faded.valence)).toBeLessThan(0.01);
  });

  it('clamps out-of-range observations before blending', () => {
    const s = service();
    // The returned state is the BLEND of the clamped observation with the
    // neutral baseline, weighted by confidence — so an extreme observation
    // shows up as a bounded move toward the clamped value, never beyond it.
    const state = s.observeEmotion({ mood: 'happy', valence: 99, arousal: -5, intensity: 42, confidence: 1 });
    expect(state.valence).toBeLessThanOrEqual(1);
    expect(state.valence).toBeGreaterThan(0.5);
    expect(state.arousal).toBe(0);
    expect(state.intensity).toBe(1);
  });


  it('keeps a faded mood out of the prompt block', () => {
    const s = service();
    s.savePersonality({ name: 'Wren' });
    s.observeEmotion({ mood: 'anxious', valence: -0.8, arousal: 0.8, intensity: 0.9, confidence: 0.9 });
    expect(s.buildCompanionContext().promptBlock).toContain('emotional context');

    db.prepare(`UPDATE companion_emotional_state SET observed_at = ? WHERE id = 'default'`).run(
      new Date(Date.now() - 5 * 86_400_000).toISOString(),
    );
    expect(s.buildCompanionContext().promptBlock).not.toContain('emotional context');
  });
});

describe('Companion voice (8.5)', () => {
  it('defaults to the app voice when nothing is configured', () => {
    expect(service().getVoiceProfile()).toEqual({
      voiceId: null, engine: null, rate: 1, pitch: 1, style: null, updatedAt: '',
    });
  });

  it('persists a voice profile across instances', () => {
    service().saveVoiceProfile({ voiceId: '21m00Tcm', engine: 'elevenlabs', rate: 1.1, pitch: 0.95, style: 'measured' });

    const reloaded = service().getVoiceProfile();
    expect(reloaded.voiceId).toBe('21m00Tcm');
    expect(reloaded.engine).toBe('elevenlabs');
    expect(reloaded.rate).toBeCloseTo(1.1, 5);
  });

  it('clamps rate and pitch to a speakable range', () => {
    const saved = service().saveVoiceProfile({ rate: 12, pitch: -4 });
    expect(saved.rate).toBe(2);
    expect(saved.pitch).toBe(0.5);
  });
});
