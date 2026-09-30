/**
 * Smart Suggestion Chips — surfaces contextual follow-up actions
 * after Henry responds, based on message content patterns.
 */

export interface SmartSuggestion {
  id: string;
  label: string;
  prompt: string;
  icon: string;
}

interface SuggestionRule {
  patterns: RegExp[];
  suggestions: SmartSuggestion[];
}

const RULES: SuggestionRule[] = [
  {
    patterns: [/client|crm|prospect|follow.?up|proposal/i],
    suggestions: [
      { id: 'crm_brief', label: 'Briefing', prompt: 'Give me a full client briefing for our next interaction', icon: '📋' },
      { id: 'crm_email', label: 'Draft email', prompt: 'Draft a follow-up email I can send them today', icon: '✉️' },
      { id: 'crm_next', label: 'Next action', prompt: 'What is the single best next action with this client?', icon: '→' },
    ],
  },
  {
    patterns: [/invoice|payment|revenue|expense|budget|finance|money/i],
    suggestions: [
      { id: 'fin_summary', label: 'Monthly summary', prompt: 'Summarize my financial position this month', icon: '📊' },
      { id: 'fin_action', label: 'What to prioritize', prompt: 'What financial action should I take this week?', icon: '🎯' },
    ],
  },
  {
    patterns: [/project|deadline|milestone|launch|shipping/i],
    suggestions: [
      { id: 'proj_status', label: 'Project status', prompt: 'Give me a status summary of my active projects', icon: '🚀' },
      { id: 'proj_blocker', label: 'Find blockers', prompt: 'What is the biggest blocker in my current projects?', icon: '🧱' },
    ],
  },
  {
    patterns: [/remind|reminder|due|deadline|schedule|meeting/i],
    suggestions: [
      { id: 'rem_set', label: 'Set reminder', prompt: 'Set a reminder for this', icon: '🔔' },
      { id: 'rem_week', label: 'What\'s due this week', prompt: 'What do I have due or scheduled this week?', icon: '📅' },
    ],
  },
  {
    patterns: [/code|bug|error|function|component|deploy|build/i],
    suggestions: [
      { id: 'code_review', label: 'Review this', prompt: 'Review this code for issues, edge cases, and improvements', icon: '🔍' },
      { id: 'code_test', label: 'Write tests', prompt: 'Write unit tests for this', icon: '🧪' },
      { id: 'code_doc', label: 'Add docs', prompt: 'Add clear documentation and comments to this code', icon: '📝' },
    ],
  },
  {
    patterns: [/write|draft|email|post|blog|copy|message/i],
    suggestions: [
      { id: 'write_refine', label: 'Refine tone', prompt: 'Refine the tone — make it sharper and more confident', icon: '✍️' },
      { id: 'write_shorter', label: 'Make shorter', prompt: 'Cut this down to the essential — half the words', icon: '✂️' },
      { id: 'write_subject', label: 'Better subject', prompt: 'Write 3 stronger subject line options', icon: '💡' },
    ],
  },
];

export function getSmartSuggestions(
  assistantContent: string,
  userContent: string
): SmartSuggestion[] {
  const combined = `${userContent} ${assistantContent}`.slice(0, 500);
  
  for (const rule of RULES) {
    const matched = rule.patterns.some(p => p.test(combined));
    if (matched) {
      return rule.suggestions.slice(0, 3);
    }
  }
  return [];
}
