/**
 * Binds the agent tool-stream channel to React.
 *
 * The subscription pattern mirrors `ChatView`'s existing `onWorkerMessage`
 * effect (mount → subscribe, unmount → release), but the channel object is held
 * in a ref and the listeners are registered once. The bridge callbacks are only
 * ever invoked for the turn that `beginTurn` opened, and the reducer refuses
 * everything outside an active turn, so a late IPC event from a previous turn
 * cannot resurrect text on the next one.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  createToolStreamChannel,
  initialToolStreamState,
  selectToolStreamText,
  toolStreamReducer,
  type ToolStreamBridge,
  type ToolStreamChannel,
  type ToolStreamDispatch,
} from '@/henry/toolStreamBuffer';

export interface UseToolStream {
  /** Provisional text for the current round. '' renders nothing. */
  text: string;
  /** Round the provisional text belongs to, or 0 when nothing is showing. */
  round: number;
  /** True while a tool round has text on screen. */
  active: boolean;
  /** Open a turn. Call where streaming starts. */
  beginTurn: () => void;
  /** The turn's authoritative answer began arriving on the chunk channel. */
  noteAnswerChunk: () => void;
  /** Close the turn — done, error, or cancelled. */
  settleTurn: () => void;
}

export function useToolStream(bridge: ToolStreamBridge | undefined): UseToolStream {
  const [state, dispatch] = useReducer(toolStreamReducer, initialToolStreamState);

  // The reducer's dispatch is stable, and the channel only reads it through the
  // ref, so a re-render never has to re-register IPC listeners.
  const dispatchRef = useRef<ToolStreamDispatch>(dispatch);
  dispatchRef.current = dispatch;

  const channelRef = useRef<ToolStreamChannel | null>(null);
  if (channelRef.current === null) {
    channelRef.current = createToolStreamChannel(bridge, (a) => dispatchRef.current(a));
  }

  useEffect(() => {
    const channel = channelRef.current!;
    channel.subscribe();
    return () => channel.unsubscribe();
  }, []);

  const beginTurn = useCallback(() => dispatch({ type: 'begin' }), []);
  const noteAnswerChunk = useCallback(() => dispatch({ type: 'answer-chunk' }), []);
  const settleTurn = useCallback(() => dispatch({ type: 'settle' }), []);
  const text = selectToolStreamText(state);
  return {
    text,
    round: text ? (state.activeRound ?? 0) : 0,
    active: text.trim() !== '',
    beginTurn,
    noteAnswerChunk,
    settleTurn,
  };
}