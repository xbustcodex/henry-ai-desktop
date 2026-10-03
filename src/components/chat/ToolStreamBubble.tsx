/**
 * Provisional display for an in-flight agent tool round.
 *
 * Rendered only between an `agent:tool-stream-delta` and the turn's hand-off.
 * Two things this component must never do:
 *
 *  1. Look like the answer. On a tool-calling round the streamed text is often
 *     the model's raw tool-call JSON, which `-final` is about to erase. A
 *     neutral plain-text block with a "working" label keeps it legible without
 *     dressing it up as Henry's reply.
 *  2. Offer copy/save affordances. Deltas are display-only and are never
 *     persisted, so persisting them from here would contradict the runner's
 *     contract.
 */

export interface ToolStreamBubbleProps {
  text: string;
  /** 1-based round number from the runner, for the label. */
  round: number;
}

export default function ToolStreamBubble({ text, round }: ToolStreamBubbleProps) {
  if (!text) return null;
  return (
    <div className="flex gap-3 py-3 henry-msg-enter" data-testid="tool-stream-provisional">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-henry-accent/10 flex items-center justify-center text-sm">
        ⚙️
      </div>
      <div className="max-w-[80%] min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-henry-accent/10 text-henry-accent">
            Working · round {round}
          </span>
          <span className="text-[10px] text-henry-text-muted">provisional</span>
        </div>
        <div className="text-sm leading-relaxed text-henry-text-muted whitespace-pre-wrap break-words">
          {text}
        </div>
      </div>
    </div>
  );
}