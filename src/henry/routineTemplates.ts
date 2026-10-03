/**
 * Ready-made Routine templates — "start from an idea".
 *
 * Paid 1.7.0 ships this as the `ideas` tab beside its automations list: "Start
 * quickly with ready-made ideas". Ours had a blank-state form where you had to
 * know what a cron expression is before you could do anything useful.
 *
 * A template is plain data describing a Routine that is genuinely useful, so
 * picking one and editing it beats writing one from scratch. Each carries the
 * prompt written as Henry would run it, not as a label.
 *
 * Local-only: nothing here reaches the network, and no template is enabled until
 * the user starts it.
 */

export interface RoutineTemplate {
  id: string;
  name: string;
  /** Grouping shown as a filter in the Ideas tab. */
  category: 'Morning' | 'Business' | 'Wellbeing' | 'Maintenance';
  description: string;
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  cronExpression: string;
  /** A readable form of the schedule, shown on the card. */
  scheduleLabel: string;
  /** The instruction Henry runs, written to be executed as written. */
  prompt: string;
}

/**
 * Weekday helper, so the cron strings below stay readable. Standard cron:
 * 0=Sunday … 6=Saturday.
 */
const WEEKDAYS = '1-5'; // Mon–Fri
const EVERY_DAY = '*';
const EVERY_MONTH = '*';

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'morning-brief',
    name: 'Morning briefing',
    category: 'Morning',
    description: 'A short summary of what is due today, coming up, and anything overdue.',
    cronExpression: `0 7 * * ${WEEKDAYS}`,
    scheduleLabel: 'Weekdays at 7:00',
    prompt:
      'Give me a morning briefing. Keep it under 150 words: anything overdue first, then what is due today, then what is coming up. If there is genuinely nothing, say so in one line rather than padding it.',
  },
  {
    id: 'daily-review',
    name: 'Daily review',
    category: 'Wellbeing',
    description: 'Closes the day: what moved, what slipped, and one thing to pick up tomorrow.',
    cronExpression: `30 17 * * ${EVERY_DAY}`,
    scheduleLabel: 'Every day at 17:30',
    prompt:
      "Review today with me. What moved forward, what slipped, and what is the single most useful thing to pick up tomorrow? Be specific and brief — no motivational filler.",
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    category: 'Business',
    description: 'A Sunday look at open commitments and the goals they serve.',
    cronExpression: `0 16 * * 0`,
    scheduleLabel: 'Sundays at 16:00',
    prompt:
      'Run a weekly review. List commitments that are overdue or have been open more than a week, group them by the goal they serve, and flag any goal with nothing moving against it.',
  },
  {
    id: 'client-followup',
    name: 'Client follow-up check',
    category: 'Business',
    description: 'Surfaces open client commitments that have gone quiet.',
    cronExpression: `0 9 * * ${WEEKDAYS}`,
    scheduleLabel: 'Weekdays at 09:00',
    prompt:
      'Check my client commitments. Which ones have been promised but not delivered for more than a week? Give me name, what was promised, and how long it has been. If everything is on track, say so in one line.',
  },
  {
    id: 'inbox-triage',
    name: 'Inbox triage',
    category: 'Business',
    description: 'Sorts new mail into what needs a reply today and what does not.',
    cronExpression: `0 8 * * ${WEEKDAYS}`,
    scheduleLabel: 'Weekdays at 08:00',
    prompt:
      'Triage my new mail into three buckets: needs a reply today, needs a reply this week, and no reply needed. For the first bucket give me the one-line gist of each so I can decide without opening them.',
  },
  {
    id: 'quotes-expiring',
    name: 'Quotes going cold',
    category: 'Business',
    description: 'Quotes sent but not followed up, before they go stale.',
    cronExpression: `0 10 * * ${WEEKDAYS}`,
    scheduleLabel: 'Weekdays at 10:00',
    prompt:
      'Which quotes have gone out but had no follow-up for more than three days? Show value, days waiting, and who it went to. Nothing older than 30 days unless it is high value.',
  },
  {
    id: 'machine-check',
    name: 'Machine and filament check',
    category: 'Maintenance',
    description: 'Flags low filament and machines idle or offline.',
    cronExpression: `0 11 * * 1`,
    scheduleLabel: 'Mondays at 11:00',
    prompt:
      'Check my machines and materials. Tell me which machines are offline or idle, and which filament types are running low. Only mention things that actually need attention.',
  },
  {
    id: 'capture-review',
    name: 'Capture review',
    category: 'Wellbeing',
    description: 'Clears quick voice and text notes down to what matters.',
    cronExpression: `0 18 * * ${EVERY_DAY}`,
    scheduleLabel: 'Every day at 18:00',
    prompt:
      'Review my recent captures. Group them into: worth acting on, worth remembering, and noise I can drop. Anything in the first group gets one suggested next step.',
  },
];

export const TEMPLATE_CATEGORIES = ['Morning', 'Business', 'Wellbeing', 'Maintenance'] as const;

export function templatesByCategory(category?: RoutineTemplate['category']): RoutineTemplate[] {
  return category ? ROUTINE_TEMPLATES.filter((t) => t.category === category) : ROUTINE_TEMPLATES;
}

export function findTemplate(id: string): RoutineTemplate | undefined {
  return ROUTINE_TEMPLATES.find((t) => t.id === id);
}

/** What `addRoutine` expects, built from a template. */
export function templateToRoutineInput(template: RoutineTemplate): {
  name: string;
  description: string;
  prompt: string;
  cronExpression: string;
  enabled: boolean;
} {
  return {
    name: template.name,
    description: template.description,
    prompt: template.prompt,
    cronExpression: template.cronExpression,
    enabled: true,
  };
}

/**
 * A template is only a good shortcut if its cron actually means what it says.
 * Cheap sanity check used by the tests.
 */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,\-]+$/.test(p));
}