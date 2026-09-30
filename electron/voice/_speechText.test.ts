import { describe, it, expect } from 'vitest';
import { prepareSpeechText, MAX_SPEECH_CHARS } from './_speechText';

describe('prepareSpeechText', () => {
  it('returns empty string for empty/undefined-ish input', () => {
    expect(prepareSpeechText('')).toBe('');
    expect(prepareSpeechText('   \n  ')).toBe('');
  });

  it('leaves plain prose untouched', () => {
    expect(prepareSpeechText('Hello Topher, the mower is ready.')).toBe(
      'Hello Topher, the mower is ready.',
    );
  });

  it('replaces fenced code blocks with "code omitted"', () => {
    const input = 'Here you go:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nDone.';
    const out = prepareSpeechText(input);
    expect(out).toContain('code omitted');
    expect(out).not.toContain('const x');
    expect(out).not.toContain('```');
  });

  it('collapses links to their text', () => {
    expect(prepareSpeechText('See [the docs](https://example.com/x) for more.')).toBe(
      'See the docs for more.',
    );
  });

  it('uses alt text for images', () => {
    expect(prepareSpeechText('![a mower photo](https://x.com/a.png) looks good')).toBe(
      'a mower photo looks good',
    );
  });

  it('strips heading markers, bold, italics, and backticks', () => {
    const input = '# Plan\n\nUse **ffmpeg** with *care* and run `brew install ffmpeg` today.';
    const out = prepareSpeechText(input);
    expect(out).not.toMatch(/[#*`]/);
    expect(out).toContain('Plan');
    expect(out).toContain('ffmpeg');
    expect(out).toContain('care');
    expect(out).toContain('brew install ffmpeg');
  });

  it('strips blockquote and bullet markers', () => {
    const input = '> quoted wisdom\n- first\n* second\n+ third';
    const out = prepareSpeechText(input);
    expect(out).not.toContain('>');
    expect(out).not.toMatch(/[-*+] /);
    expect(out).toContain('quoted wisdom');
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).toContain('third');
  });

  it('turns paragraph breaks into sentence pauses and collapses whitespace', () => {
    const out = prepareSpeechText('First paragraph\n\nSecond   paragraph\nsame sentence');
    expect(out).toBe('First paragraph. Second paragraph same sentence');
  });

  it('removes table pipes', () => {
    const out = prepareSpeechText('| a | b |\n| 1 | 2 |');
    expect(out).not.toContain('|');
  });

  it('leaves text at or under the cap untouched', () => {
    const exact = 'a'.repeat(MAX_SPEECH_CHARS);
    expect(prepareSpeechText(exact)).toBe(exact);
  });

  it('caps output at MAX_SPEECH_CHARS', () => {
    const out = prepareSpeechText('word '.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });

  it('truncates at a sentence boundary, not mid-word', () => {
    // 300 sentences of ~15 chars: the cap lands inside sentence 140-ish, and
    // the result must end with the punctuation of a complete sentence.
    const sentence = 'This is a whole sentence. ';
    const out = prepareSpeechText(sentence.repeat(400));
    expect(out.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(out.endsWith('sentence.')).toBe(true);
  });

  it('falls back to a word boundary when the budget holds no sentence end', () => {
    const out = prepareSpeechText('supercalifragilistic '.repeat(500));
    expect(out.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(out.endsWith('supercalifragilistic')).toBe(true);
  });

  it('still returns text when the input is one unbroken token', () => {
    const out = prepareSpeechText('x'.repeat(MAX_SPEECH_CHARS * 2));
    expect(out).toBe('x'.repeat(MAX_SPEECH_CHARS));
  });
});
