/**
 * Renderer-side consumer for the agent tool-streaming channel.
 *
 * The main process emits two channels while an agent turn runs
 * (`electron/agent/toolRunner.ts`):
 *
 *   `agent:tool-stream-delta` { round, text }    — provisional, per delta
 *   `agent:tool-stream-final`  { round, content } — authoritative, per round
 *
 * Both are bridged by the preload as `onAgentToolStreamDelta` /
 * `onAgentToolStreamFinal`. Until something subscribes, an agent turn is
 * visually identical to a non-streaming one: the runner's deltas are forwarded
 * and then nothing displays them, so the user watches raw tool-call JSON go by
 * (or nothing at all) and the answer lands as one block at the end.
 *
 * ── The duplication trap ────────────────────────────────────────────────────
 * The turn's authoritative answer ALSO arrives on the normal chunk channel:
 * `electron/ipc/ai.ts` awaits the whole tool conversation, then calls
 * `onChunk(answer)` once before `onDone(answer)`. So the last round's `-final`
 * content and the answer chunk are the SAME TEXT. Appending the tool stream into
 * the same buffer the chunks go to shows the answer twice.
 *
 * The round boundary is therefore explicit in the state, not implicit in a
 * truncation: a tool round holds a provisional buffer, `-final` replaces that
 * round's buffer wholesale, and `answer-chunk` is the turn's hand-off — it
 * ends the tool region for good, so the answer is displayed by exactly one
 * consumer. See `answerStarted`.
 *
 * Provisional text is display-only. It is never persisted, never written to the
 * message transcript, and never included in a cancelled turn's saved message —
 * `settle` exists so an error, a cancellation, or the end of a turn can never
 * leave a raw tool call stuck on screen.
 */

/** The renderer-visible shape of `agent:tool-stream-delta`. */
export interface ToolStreamDeltaPayload {
  round: number;
  text: string;
}

/** The renderer-visible shape of `agent:tool-stream-final`. */
export interface ToolStreamFinalPayload {
  round: number;
  content: string;
}

/**
 * Structural view of the preload bridge. Every member is optional: a build
 * whose preload predates the channel, or a web mock, must degrade to "no
 * streaming" rather than throw during render.
 */
export interface ToolStreamBridge {
  onAgentToolStreamDelta?: (cb: (p: unknown) => void) => (() => void) | undefined;
  onAgentToolStreamFinal?: (cb: (p: unknown) => void) => (() => void) | undefined;
}

export interface ToolStreamState {
  /** True between `begin` and `settle`; gates every incoming event. */
  turnActive: boolean;
  /** Round whose text is currently displayed, or null when nothing is. */
  activeRound: number | null;
  /** Provisional display text for `activeRound`. Never persisted. */
  text: string;
  /** Round whose `-final` has replaced its provisional text, or null. */
  settledRound: number | null;
  /**
   * The turn's authoritative answer has begun arriving on the chunk channel.
   * From here the answer bubble owns the text, so the tool region is emptied
   * rather than left to compete with it.
   */
  answerStarted: boolean;
}

export const initialToolStreamState: ToolStreamState = {
  turnActive: false,
  activeRound: null,
  text: '',
  settledRound: null,
  answerStarted: false,
};

export type ToolStreamAction =
  | { type: 'begin' }
  | { type: 'delta'; payload: unknown }
  | { type: 'final'; payload: unknown }
  | { type: 'answer-chunk' }
  | { type: 'settle' };

function isRound(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/** Round number from an untrusted payload, or null when it is not usable. */
function readRound(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const round = (payload as { round?: unknown }).round;
  return isRound(round) ? round : null;
}

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Pure transition for one agent turn's tool-stream events.
 *
 * Every branch returns the previous state object for rejected input, so a
 * malformed payload is a no-op rather than a corrupted buffer.
 */
export function toolStreamReducer(
  state: ToolStreamState,
  action: ToolStreamAction,
): ToolStreamState {
  switch (action.type) {
    case 'begin':
      return { ...initialToolStreamState, turnActive: true };

    case 'delta': {
      if (!state.turnActive || state.answerStarted) return state;
      const round = readRound(action.payload);
      // An empty delta carries no text; the runner already filters these, and
      // appending '' would still start a phantom round.
      const text = readString(action.payload, 'text');
      if (round === null || text === null || text === '') return state;
      // A round number below the one on screen is a late straggler from a round
      // already replaced; letting it append would splice old text onto new.
      if (state.activeRound !== null && round < state.activeRound) return state;
      // A new round's first delta starts that round's buffer rather than
      // appending to the previous round's settled text.
      if (state.activeRound !== round) {
        return { ...state, activeRound: round, text, settledRound: null };
      }
      return { ...state, text: state.text + text };
    }

    case 'final': {
      if (!state.turnActive || state.answerStarted) return state;
      const round = readRound(action.payload);
      // `-final` content MAY legitimately be empty: on a tool-calling round the
      // model's whole output was the raw tool call, so the authoritative text
      // for that round is ''. That empty string is what erases the JSON.
      const content = readString(action.payload, 'content');
      if (round === null || content === null) return state;
      if (state.activeRound !== null && round < state.activeRound) return state;
      // Replaces the round's provisional text wholesale — never appends.
      return { ...state, activeRound: round, text: content, settledRound: round };
    }

    case 'answer-chunk':
      // Only meaningful if a tool region was open; otherwise this is a plain
      // non-agent stream and there is nothing to hand off.
      if (!state.turnActive) return state;
      return { ...state, answerStarted: true, activeRound: null, text: '', settledRound: null };

    case 'settle':
      // Terminal for the turn: done, error, or cancelled. Guarantees no
      // provisional text survives the turn that produced it.
      if (!state.turnActive && state.activeRound === null && state.text === '') return state;
      return { ...initialToolStreamState };
  }
}

/** The text the tool region should display right now. '' means render nothing. */
export function selectToolStreamText(state: ToolStreamState): string {
  if (!state.turnActive || state.answerStarted) return '';
  return state.text;
}

export type ToolStreamDispatch = (action: ToolStreamAction) => void;

export interface ToolStreamChannel {
  /** Idempotent. A second call while subscribed adds no second listener. */
  subscribe(): void;
  /** Idempotent, and safe when never subscribed. */
  unsubscribe(): void;
  readonly subscribed: boolean;
}

/**
 * Owns the bridge listeners for the tool-stream channel.
 *
 * Subscription is guarded rather than left to React's effect ordering: a
 * double `subscribe` would register a second pair of IPC listeners, and since
 * every delta is an append, the same text would land twice in the buffer.
 */
export function createToolStreamChannel(
  bridge: ToolStreamBridge | undefined,
  dispatch: ToolStreamDispatch,
): ToolStreamChannel {
  let teardown: (() => void) | null = null;

  return {
    get subscribed(): boolean {
      return teardown !== null;
    },
    subscribe(): void {
      if (teardown) return;
      const offDelta = bridge?.onAgentToolStreamDelta?.((p) => dispatch({ type: 'delta', payload: p }));
      const offFinal = bridge?.onAgentToolStreamFinal?.((p) => dispatch({ type: 'final', payload: p }));
      const offs = [offDelta, offFinal].filter((f): f is () => void => typeof f === 'function');
      teardown = () => {
        for (const off of offs) {
          try {
            off();
          } catch {
            /* a bridge that throws on removal must not break the others */
          }
        }
      };
    },
    unsubscribe(): void {
      const t = teardown;
      teardown = null;
      t?.();
    },
  };
}