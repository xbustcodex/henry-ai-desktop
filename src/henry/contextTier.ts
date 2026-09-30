/**
 * Henry AI — Context Tier System
 *
 * Classifies message intent and selects the appropriate context tier before
 * every AI call. Keeps Groq (and all providers) well within TPM limits.
 *
 * THREE TIERS:
 *   LIGHT  — default for most conversational turns.
 *            Core identity + mode + up to 8 recent messages (~1,500 sys tokens).
 *   MEDIUM — multi-turn reasoning, project work, follow-up threads.
 *            Adds top facts + short summary + 16 messages (~3,000 sys tokens).
 *   FULL   — rare: deep research, workspace-heavy tasks.
 *            Full existing system prompt (capped at existing OPTIONAL_BUDGET).
 *
 * TOKEN GUARD:
 *   Before sending, estimate total tokens. If over TOKEN_HARD_LIMIT, trim
 *   history automatically until the payload fits.
 */

import { log as henryLog } from './log';

// ── Token estimation ──────────────────────────────────────────────────────────

/** 1 token ≈ 4 chars (matches OpenAI's rough tokenizer average). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens for a messages array.
 * Adds 4 tokens per message for role/structure overhead.
 */
export function estimatePayloadTokens(
  messages: Array<{ role: string; content: string }>
): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * Hard cap: never send more than this many tokens to any provider.
 * Groq free-tier TPM limits make 6k the safe ceiling.
 */
// Per-provider context limits (in tokens)
// Groq 70b: 128k context. OpenAI GPT-4o: 128k. Claude: 200k.
// We reserve ~8k for system prompt and ~4k for output.
export const TOKEN_HARD_LIMIT = 50_000;  // safe for all major providers
export const TOKEN_HARD_LIMIT_GROQ = 100_000;  // Groq has 128k
export const TOKEN_HARD_LIMIT_ANTHROPIC = 180_000;  // Claude has 200k

// ── Context tiers ─────────────────────────────────────────────────────────────

export type ContextTier = 'light' | 'medium' | 'full';

/**
 * Per-tier history caps (message count, chars per message).
 * LIGHT: 6 recent messages, 1,200 chars each (~300 tokens ea)
 * MEDIUM: 10 messages, 2,000 chars each
 * FULL: 16 messages, 3,000 chars each
 */
export const TIER_HISTORY_CAPS: Record<
  ContextTier,
  { maxMessages: number; maxCharsEach: number }
> = {
  light:  { maxMessages: 6,  maxCharsEach: 1_200 },
  medium: { maxMessages: 10, maxCharsEach: 2_000 },
  full:   { maxMessages: 16, maxCharsEach: 3_000 },
};

/**
 * Per-tier memory block caps (facts, summary chars, workspace hints).
 * LIGHT sends no memory at all — identity + mode is enough for quick turns.
 * MEDIUM: top 3 facts + 600-char summary (fits ~150 tokens).
 * FULL: top 8 facts + 1,600-char summary.
 */
export const TIER_MEMORY_CAPS: Record<
  ContextTier,
  { maxFacts: number; maxSummaryChars: number; maxWorkspaceHints: number }
> = {
  light:  { maxFacts: 0, maxSummaryChars: 0,     maxWorkspaceHints: 0 },
  medium: { maxFacts: 3, maxSummaryChars: 600,   maxWorkspaceHints: 2 },
  full:   { maxFacts: 8, maxSummaryChars: 1_600, maxWorkspaceHints: 4 },
};

// ── Intent classification ─────────────────────────────────────────────────────

export type MessageIntent =
  | 'awareness'
  | 'integration_gmail'
  | 'integration_gcal'
  | 'integration_slack'
  | 'integration_github'
  | 'integration_notion'
  | 'integration_stripe'
  | 'integration_linear'
  | 'normal';

const AWARENESS_RE = /what can you do|are you aware|how can you help|who are you|what('?s| is) connected|what services|what (are|do) you (know|have access|see|track)|what('?s| is) (your|henry'?s?) capabilit/i;
const GMAIL_RE     = /\bemail\b|\bgmail\b|\binbox\b|\bmail\b/i;
const GCAL_RE      = /\bcalendar\b|\bschedule\b|\bevent\b|\bmeeting\b|\bappointment\b/i;
const SLACK_RE     = /\bslack\b|\bchannel\b/i;
const GITHUB_RE    = /\bgithub\b|\brepo\b|\bpull request\b|\bpr\b|\bgit issue\b/i;
const NOTION_RE    = /\bnotion\b/i;
const STRIPE_RE    = /\bstripe\b|\bpayment\b|\bcharge\b|\brevenue\b/i;
const LINEAR_RE    = /\blinear\b|\bticket\b|\bsprint\b/i;

export function classifyMessageIntent(message: string): MessageIntent {
  if (AWARENESS_RE.test(message))  return 'awareness';
  if (GMAIL_RE.test(message))      return 'integration_gmail';
  if (GCAL_RE.test(message))       return 'integration_gcal';
  if (SLACK_RE.test(message))      return 'integration_slack';
  if (GITHUB_RE.test(message))     return 'integration_github';
  if (NOTION_RE.test(message))     return 'integration_notion';
  if (STRIPE_RE.test(message))     return 'integration_stripe';
  if (LINEAR_RE.test(message))     return 'integration_linear';
  return 'normal';
}

/**
 * Pick the appropriate context tier given message intent and conversation depth.
 *
 * @param intent - Classified message intent.
 * @param historyLength - Number of messages in the current thread.
 * @param hasWorkspaceContext - True when a workspace file/folder is attached.
 */
export function selectContextTier(
  intent: MessageIntent,
  historyLength: number,
  hasWorkspaceContext: boolean
): ContextTier {
  if (hasWorkspaceContext) return 'medium';

  switch (intent) {
    case 'awareness':
      return 'light';
    case 'integration_gmail':
    case 'integration_gcal':
    case 'integration_slack':
    case 'integration_github':
    case 'integration_notion':
    case 'integration_stripe':
    case 'integration_linear':
      return 'light';
    case 'normal':
    default:
      if (historyLength > 20) return 'medium';
      return 'light';
  }
}

// ── History trimmer ───────────────────────────────────────────────────────────

/**
 * Trim message history so the full payload stays within `hardLimit` tokens.
 * Always preserves the most recent messages. Returns empty array if the system
 * prompt alone already exceeds the limit.
 */
export function trimHistoryToTokenBudget(
  history: Array<{ role: string; content: string }>,
  systemPromptTokens: number,
  hardLimit: number = TOKEN_HARD_LIMIT
): Array<{ role: string; content: string }> {
  const historyBudget = hardLimit - systemPromptTokens - 400;
  if (historyBudget <= 0) return [];

  const result: Array<{ role: string; content: string }> = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content) + 4;
    if (used + cost > historyBudget) break;
    result.unshift(history[i]);
    used += cost;
  }

  return result;
}

// ── Logging ───────────────────────────────────────────────────────────────────

export interface ContextLog {
  tier: ContextTier;
  intent: MessageIntent;
  systemTokens: number;
  historyTokensBefore: number;
  historyTokensAfter: number;
  totalTokens: number;
  historyCountBefore: number;
  historyCountAfter: number;
  trimmed: boolean;
  /** Optional list of named context blocks included in the system prompt. */
  includedBlocks?: string[];
}

export function logContextDecision(log: ContextLog): void {
  const over = log.totalTokens > TOKEN_HARD_LIMIT ? ` ⚠️ OVER LIMIT` : '';
  const trimNote = log.trimmed
    ? ` [trimmed ${log.historyCountBefore - log.historyCountAfter} msgs, -${log.historyTokensBefore - log.historyTokensAfter}t]`
    : '';
  const blocksNote = log.includedBlocks && log.includedBlocks.length > 0
    ? ` | blocks: ${log.includedBlocks.join(', ')}`
    : '';
  henryLog.debug(
    `[Henry:ctx] tier=${log.tier} intent=${log.intent} ` +
    `sys=${log.systemTokens}t hist=${log.historyTokensAfter}t ` +
    `total=${log.totalTokens}t${over}${trimNote}${blocksNote}`
  );
}
