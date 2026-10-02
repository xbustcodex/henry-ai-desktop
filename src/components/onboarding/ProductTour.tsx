/**
 * In-app tour — a short guided walkthrough shown once after onboarding.
 *
 * Paid 1.7.0 has this (recovered from its renderer: `tutorial:get-progress`
 * gated on `!settings.seenGuide`). Ours is our own: a linear, dismissible
 * sequence that points at real surfaces rather than a scripted animation, and
 * it is genuinely optional — nothing here can block the app.
 *
 * Progress is stored as a key so a crash mid-tour resumes rather than restarts.
 */
import { useCallback, useEffect, useState } from 'react';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Sidebar destination this step points at, when there is one. */
  view?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'chat',
    title: 'Talk to Henry',
    body: 'Chat is the main surface. Type, or hold the mic to speak. Attach files with the paperclip.',
    view: 'chat',
  },
  {
    id: 'computer',
    title: 'Henry can use your computer',
    body: 'Computer opens the control panel — apps, windows, files, clipboard and a terminal. Every action runs locally and asks before anything destructive.',
    view: 'computer',
  },
  {
    id: 'memory',
    title: 'Memory',
    body: 'Henry keeps what matters here: conversations, notes and what he learns about you and your work. Search it from the same panel.',
    view: 'memory',
  },
  {
    id: 'settings',
    title: 'Point Henry at a model',
    body: 'Add a provider key in Settings, or let him run entirely on Ollama on this machine. Nothing leaves your computer unless you add a cloud key.',
    view: 'settings',
  },
  {
    id: 'creators',
    title: 'Demo mode',
    body: 'Creators scripts a short exchange and plays it back as a full-screen orb — handy for filming. Press Ctrl+Shift+J to start it.',
    view: 'creators',
  },
  {
    id: 'customize',
    title: 'Make it yours',
    body: 'Accent, density and identity are yours to set. Everything is stored on this device.',
    view: 'customize',
  },
];

const KEY = 'tour_progress_v1';

function readProgress(): { done: boolean; index: number } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { done: false, index: 0 };
    const p = JSON.parse(raw) as { done?: unknown; index?: unknown };
    return {
      done: p.done === true,
      index: typeof p.index === 'number' && p.index >= 0 && p.index < TOUR_STEPS.length ? p.index : 0,
    };
  } catch {
    return { done: false, index: 0 };
  }
}

export function tourCompleted(): boolean {
  return readProgress().done;
}

/** Restart the tour from Settings. */
export function resetTour(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export default function Tour({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const [state, setState] = useState<{ open: boolean; index: number }>(() => {
    const p = readProgress();
    return { open: !p.done, index: p.index };
  });

  const persist = useCallback((index: number, done: boolean) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ index, done }));
    } catch {
      /* the tour is optional; losing its position is not worth an error */
    }
  }, []);

  const finish = useCallback(() => {
    persist(0, true);
    setState({ open: false, index: 0 });
  }, [persist]);

  const next = useCallback(() => {
    setState((s) => {
      const i = s.index + 1;
      if (i >= TOUR_STEPS.length) {
        persist(0, true);
        return { open: false, index: 0 };
      }
      persist(i, false);
      return { open: true, index: i };
    });
  }, [persist]);

  const prev = useCallback(() => {
    setState((s) => {
      const i = Math.max(0, s.index - 1);
      persist(i, false);
      return { open: true, index: i };
    });
  }, [persist]);

  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open, finish, next, prev]);

  if (!state.open) return null;
  const step = TOUR_STEPS[state.index];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center pb-16 pointer-events-none">
      <div
        className="pointer-events-auto w-full max-w-md bg-henry-surface border border-henry-accent/40 rounded-2xl p-4 shadow-2xl"
        role="dialog"
        aria-label="Product tour"
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-sm font-semibold text-henry-text">{step.title}</h3>
          <button
            onClick={finish}
            className="text-henry-text-muted hover:text-henry-text text-sm leading-none px-1"
            title="Skip the tour"
          >
            ✕
          </button>
        </div>
        <p className="text-xs text-henry-text-muted leading-relaxed">{step.body}</p>

        <div className="flex items-center gap-2 mt-3">
          <div className="flex gap-1 flex-1">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 rounded-full transition-all ${
                  i === state.index ? 'w-5 bg-henry-accent' : 'w-1.5 bg-henry-border'
                }`}
              />
            ))}
          </div>
          <span className="text-[10px] text-henry-text-muted">
            {state.index + 1}/{TOUR_STEPS.length}
          </span>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={prev}
            disabled={state.index === 0}
            className="px-3 py-1.5 rounded-lg border border-henry-border/40 text-xs text-henry-text disabled:opacity-35 hover:border-henry-accent/50"
          >
            Back
          </button>
          {step.view && onNavigate && (
            <button
              onClick={() => onNavigate(step.view!)}
              className="px-3 py-1.5 rounded-lg border border-henry-border/40 text-xs text-henry-text hover:border-henry-accent/50"
            >
              Show me
            </button>
          )}
          <button
            onClick={next}
            className="ml-auto px-3 py-1.5 rounded-lg bg-henry-accent text-white text-xs font-medium"
          >
            {state.index === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}