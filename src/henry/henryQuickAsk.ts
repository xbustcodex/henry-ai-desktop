/**
 * henryQuickAsk — fires a pre-built prompt into Henry chat from any panel.
 * Navigates to chat, sets mode, injects context, and switches view.
 */

import { useStore } from '../store';

export interface QuickAskOptions {
  mode?: string;
  /** The question or prompt to fire */
  prompt: string;
  /** Optional context prefix injected before the prompt */
  context?: string;
  /** Whether to navigate to chat automatically */
  navigate?: boolean;
}

export function henryQuickAsk(opts: QuickAskOptions): void {
  const { prompt, mode = 'companion', context, navigate = true } = opts;

  const fullPrompt = context
    ? `${context}\n\n${prompt}`
    : prompt;

  try {
    if (mode !== 'companion') {
      localStorage.setItem('henry_operating_mode', mode);
    }
  } catch { /* ignore */ }

  if (navigate) {
    // Navigate first so ChatView mounts and registers event listeners
    useStore.getState().setCurrentView('chat');
    // Then inject prompt after a short delay
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('henry_inject_draft', {
          detail: { text: fullPrompt },
        })
      );
    }, 120);
  } else {
    window.dispatchEvent(
      new CustomEvent('henry_inject_draft', {
        detail: { text: fullPrompt },
      })
    );
  }
}

/** Pre-built quick-ask prompts for each panel */
export const PANEL_QUICK_ASK = {
  finance: () =>
    henryQuickAsk({
      prompt: 'Review my financial data. What are my income trends? Are expenses on track? What should I focus on this month?',
    }),

  journal: (entryText?: string) =>
    henryQuickAsk({
      mode: 'companion',
      prompt: 'Help me think through what I wrote in my journal today. What stands out? What should I act on?',
      context: entryText ? `Today's journal entry:\n${entryText.slice(0, 600)}` : undefined,
    }),

  captures: (captureText?: string) =>
    henryQuickAsk({
      prompt: captureText
        ? `I just captured this note: "${captureText}" — help me decide what to do with it. Should this be a task, reminder, project note, or something else?`
        : 'Help me route my unreviewed captures. What should become tasks? What needs follow-up? What can be archived?',
    }),

  weekly: () =>
    henryQuickAsk({
      mode: 'companion',
      prompt: "Let's do my weekly review. Walk me through: What did I accomplish this week? What's still open? What should carry into next week? What should I drop or delegate?",
    }),

  today: () =>
    henryQuickAsk({
      prompt: "Based on what you know about my projects and what I've been working on — what should I focus on today? Give me a clear starting point.",
    }),

  reminders: () =>
    henryQuickAsk({
      prompt: 'Review my reminders. What is overdue? What is coming up that I should prepare for?',
    }),

  contacts: (name?: string) =>
    henryQuickAsk({
      prompt: name
        ? `Give me a full briefing on ${name} — relationship context, what we've discussed, any follow-ups I should make, and how I can serve them better.`
        : 'Review my contacts. Who should I be reaching out to? Any relationships I might be neglecting?',
    }),

  secretary: () =>
    henryQuickAsk({
      mode: 'secretary',
      prompt: "What needs my attention today? Check my tasks, reminders, and any open threads — give me a clear action list for today.",
    }),

  costs: () =>
    henryQuickAsk({
      prompt: 'Analyze my AI usage costs. Am I using the right models for each task type? Where can I reduce spend without reducing quality?',
    }),

  workspace: (filePath?: string) =>
    henryQuickAsk({
      mode: 'developer',
      prompt: filePath
        ? `Help me understand and work with this file: ${filePath}. What does it do, what's important to know, and what could be improved?`
        : 'Review my workspace. What files or projects should I be focused on? What can I help you build or improve today?',
    }),

  focus: () =>
    henryQuickAsk({
      prompt: 'Based on what you know about my projects, tasks, and goals — what should I be working on right now? Give me one clear focus for the next hour.',
    }),
};
