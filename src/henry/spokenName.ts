/**
 * How Henry is addressed out loud.
 *
 * The brand is written "H.E.N.R.Y". Speech synthesis reads that as five
 * letters — "aitch ee en ar why" — which is not how anyone says the name, and
 * it makes every spoken greeting sound wrong. Paid 1.7.0 has a three-line
 * equivalent (`shared/spoken-assistant-name.ts`) that collapses the styled
 * form before it reaches TTS.
 *
 * Ours is written from the same intent: normalise whatever the user called the
 * assistant, and hand TTS something pronounceable.
 */

/** The styled brand, e.g. "H.E.N.R.Y". Kept separate from the styled-AI form. */
const STYLED = /H\s*[.·•]\s*E\s*[.·•]\s*N\s*[.·•]\s*R\s*[.·•]\s*Y/gi;

/** Reserved words that are never a person's name. */
const NOT_A_NAME = new Set([
  '', 'henry', 'assistant', 'ai', 'bot', 'hey', 'sir', 'mr', 'mrs', 'you', 'it', 'none',
]);

/**
 * Turn a configured display name into something worth speaking.
 *
 * Returns an empty string when the name carries nothing to say, so callers can
 * skip the prefix entirely rather than say "Henry," before every sentence.
 */
export function spokenAssistantName(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  // "H.E.N.R.Y" -> "Henry" before anything else looks at it.
  const deStyled = value.replace(STYLED, 'Henry');
  if (NOT_A_NAME.has(deStyled.toLowerCase())) return '';
  // Keep it short: a long display name makes for an unwieldy spoken prefix.
  return deStyled.slice(0, 24).trim();
}

/**
 * Strip the styled brand from text that is ABOUT TO BE SPOKEN, without adding
 * anything.
 *
 * This is deliberately not a prefix. The greeting already substitutes the
 * owner's name into its salutation ("Afternoon, JARVIS. Systems are online."),
 * so prefixing here would speak the name twice. The only thing needed is to
 * stop TTS reading "H.E.N.R.Y" as five letters.
 */
export function withSpokenName(text: string, raw: string | null | undefined): string {
  // `raw` is unused for the transformation itself but kept in the signature so
  // the call site reads as "speak this, addressed to that person" and so a
  // future caller can opt into prefixing deliberately.
  void raw;
  // Replace only the styled letters; any trailing " AI" is left in place so it
  // still reads correctly.
  return text.replace(STYLED, 'Henry');
}
