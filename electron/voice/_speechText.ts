/**
 * _speechText.ts — Pure text-prep helpers for TTS.
 *
 * Keeps markdown out of Henry's mouth: code blocks become "code omitted",
 * links collapse to their text, and structural characters (#, *, backticks,
 * table pipes) are stripped. Pure module — no Electron imports — so it's
 * unit-testable under vitest's plain-Node environment.
 */
/**
 * Longest utterance we hand to a speech engine, in characters.
 *
 * The prepared text is fed to the engine as a single argument/stdin blob, and
 * the per-argument ceiling is a platform constant we do not control (Windows
 * caps a whole command line at 32 767 chars; POSIX caps one argument at
 * MAX_ARG_STRLEN). A runaway reply — a pasted log, a long generated table —
 * can cross it and fail the spawn outright, so the text is clipped before it
 * ever gets there. 2 000 characters is roughly three to four minutes of
 * speech: well past what anyone wants read aloud, and the point of a voice
 * reply is the summary, not the whole transcript.
 */
export const MAX_SPEECH_CHARS = 2000;

/** Strip markdown so text sounds natural when spoken aloud. */
export function prepareSpeechText(markdown: string): string {
  if (!markdown) return '';
  let t = markdown;

  // Fenced code blocks → a spoken placeholder.
  t = t.replace(/```[\s\S]*?```/g, ' code omitted. ');
  t = t.replace(/~~~[\s\S]*?~~~/g, ' code omitted. ');

  // Images → alt text; links → link text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Inline code → keep the content, drop the backticks.
  t = t.replace(/`([^`]*)`/g, '$1');

  // Headings, blockquotes, bullet markers (line-anchored, before emphasis).
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');

  // Bold / italic emphasis → plain text.
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/\b_([^_]+)_\b/g, '$1');

  // Any stray markdown characters + table pipes.
  t = t.replace(/[*#`]/g, '');
  t = t.replace(/\|/g, ' ');

  // Paragraph breaks become sentence pauses; collapse whitespace.
  t = t.replace(/\n{2,}/g, '. ');
  t = t.replace(/\n/g, ' ');
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/(\.\s*)+\./g, '.');

  return capForSpeech(t.trim());
}

/**
 * Clip to MAX_SPEECH_CHARS, preferring the last complete sentence inside the
 * budget so Henry never stops mid-word or mid-clause. Falls back to the last
 * word boundary, then to a hard cut, because a truncated sentence still beats
 * an unspeakable one.
 */
function capForSpeech(text: string): string {
  if (text.length <= MAX_SPEECH_CHARS) return text;
  const head = text.slice(0, MAX_SPEECH_CHARS);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
  );
  if (sentenceEnd > 0) return head.slice(0, sentenceEnd + 1).trim();
  const wordEnd = head.lastIndexOf(' ');
  if (wordEnd > 0) return head.slice(0, wordEnd).trim();
  return head.trim();
}
