/**
 * Tests for the renderer consumer of the agent tool-stream channel.
 *
 * Scope, stated plainly: these tests drive `toolStreamReducer` and
 * `createToolStreamChannel` — the exact objects `useToolStream` wires to the
 * preload callbacks and `ChatView` renders from. They prove the buffer's
 * behaviour and the subscription lifecycle.
 *
 * They do NOT prove the React/DOM binding: this repo's vitest config runs
 * `environment: 'node'` with no jsdom and no testing-library, and no fake DOM
 * environment was added here. Whether the provisional bubble actually appears
 * on screen during a real agent turn is UNVERIFIED by this file and needs the
 * live test on the installed package.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createToolStreamChannel,
  initialToolStreamState,
  selectToolStreamText,
  toolStreamReducer,
  type ToolStreamBridge,
  type ToolStreamAction,
  type ToolStreamState,
} from './toolStreamBuffer';

/** Fold a list of actions from the initial state. */
function run(...actions: ToolStreamAction[]): ToolStreamState {
  return actions.reduce(toolStreamReducer, initialToolStreamState);
}
const begin = { type: 'begin' } as const;
const delta = (round: number, text: string) => ({ type: 'delta', payload: { round, text } }) as const;
const final = (round: number, content: string) => ({ type: 'final', payload: { round, content } }) as const;
const answerChunk = { type: 'answer-chunk' } as const;
const settle = { type: 'settle' } as const;

/** The visible text for a state — the single thing a renderer would display. */
const visible = (s: ToolStreamState) => selectToolStreamText(s);

describe('tool-stream buffer — provisional display', () => {
  it('accumulates deltas within one round', () => {
    const s = run(begin, delta(1, 'Checking'), delta(1, ' the'), delta(1, ' weather.'));
    expect(visible(s)).toBe('Checking the weather.');
  });

  it('ignores events outside an active turn', () => {
    const s = run(delta(1, 'Checking'), final(1, 'done'), answerChunk);
    expect(visible(s)).toBe('');
    expect(s.turnActive).toBe(false);
  });

  it('shows nothing until the first delta of the turn', () => {
    expect(visible(run(begin))).toBe('');
  });
});

describe('tool-stream buffer — the answer appears exactly once', () => {
  // The real agent sequence, end to end: two tool-calling rounds then the
  // answer round, after which `electron/ipc/ai.ts` emits the answer AGAIN on the
  // normal chunk channel. Anything that appends the tool stream into the chunk
  // buffer shows this answer twice.
  it('hands the answer off to the chunk channel instead of duplicating it', () => {
    const s = run(
      begin,
      // Round 1: model streams its raw tool call as text, then `-final` with the
      // round's real content, which is empty on a pure tool-call round.
      delta(1, '{"name":"get_weather"'),
      delta(1, ',"city":"London"}'),
      final(1, ''),
      // Round 2 streams the answer.
      delta(2, 'It is 18'),
      delta(2, 'C in London.'),
      final(2, 'It is 18C in London.'),
      // …and then the same answer arrives on the chunk channel.
      answerChunk,
    );
    expect(visible(s)).toBe('');
    expect(s.answerStarted).toBe(true);
  });

  it('drops the answer as soon as the first chunk lands, mid-answer', () => {
    const s = run(begin, delta(1, 'Working on it'), answerChunk);
    expect(visible(s)).toBe('');
  });

  it('a plain non-agent turn is unaffected', () => {
    const s = run(begin, answerChunk, settle);
    expect(visible(s)).toBe('');
    expect(s.answerStarted).toBe(false);
  });

  it('refuses deltas that arrive after the hand-off', () => {
    const after = run(begin, answerChunk, delta(2, 'late answer text'));
    expect(visible(after)).toBe('');
  });
});

describe('tool-stream buffer — round boundaries', () => {
  it('`-final` replaces the round rather than appending to it', () => {
    const s = run(begin, delta(1, '{"name":"get_weather"}'), final(1, 'Let me check that.'));
    expect(visible(s)).toBe('Let me check that.');
  });

  it('an empty `-final` erases the raw tool call it replaces', () => {
    const s = run(begin, delta(1, '{"name":"get_weather"}'), final(1, ''));
    expect(visible(s)).toBe('');
    expect(s.settledRound).toBe(1);
  });

  it('a new round starts a fresh buffer instead of appending', () => {
    const s = run(
      begin,
      delta(1, 'Round one text.'),
      final(1, 'Round one final.'),
      delta(2, 'Round'),
      delta(2, ' two text.'),
    );
    expect(visible(s)).toBe('Round two text.');
  });

  it('ignores a straggler from a superseded round', () => {
    const s = run(
      begin,
      delta(2, 'Second round.'),
      delta(1, '{"name":"stale"}'),
      delta(2, ' continued'),
    );
    expect(visible(s)).toBe('Second round. continued');
  });

  it('ignores a `-final` for a superseded round', () => {
    const s = run(
      begin,
      delta(2, 'Second round.'),
      final(1, 'stale final'),
    );
    expect(visible(s)).toBe('Second round.');
  });

  it('`-final` works for a round whose deltas were never seen', () => {
    const s = run(begin, final(3, 'Recovered content.'));
    expect(visible(s)).toBe('Recovered content.');
  });
});

describe('tool-stream buffer — malformed payloads', () => {
  const bad: unknown[] = [
    undefined,
    null,
    'a string',
    42,
    true,
    {},
    { round: 1 },
    { text: 'no round' },
    { round: '1', text: 'round as string' },
    { round: 0, text: 'round zero' },
    { round: -1, text: 'negative round' },
    { round: 1.5, text: 'fractional round' },
    { round: NaN, text: 'NaN round' },
    { round: Infinity, text: 'infinite round' },
    { round: 1, text: 123 },
    { round: 1, text: null },
    { round: 1, text: undefined },
    { round: 1, text: { nested: 'object' } },
    { round: 1, text: '' },
    { round: 1, text: ['a'] },
  ];

  it.each(bad)('a delta payload of %j does not throw or corrupt the buffer', (payload) => {
    const seeded = run(begin, delta(1, 'good text'));
    const s = toolStreamReducer(seeded, { type: 'delta', payload });
    expect(visible(s)).toBe('good text');
    expect(s.activeRound).toBe(1);
  });

  it.each(bad)('a `-final` payload of %j does not throw or corrupt the buffer', (payload) => {
    const seeded = run(begin, delta(1, 'good text'));
    const s = toolStreamReducer(seeded, { type: 'final', payload });
    expect(visible(s)).toBe('good text');
    expect(s.settledRound).toBeNull();
  });

  it('does not throw when the whole event stream is malformed', () => {
    expect(() => {
      let s = initialToolStreamState;
      for (const payload of bad) {
        s = toolStreamReducer(s, { type: 'delta', payload });
        s = toolStreamReducer(s, { type: 'final', payload });
      }
    }).not.toThrow();
  });

  it('does not start a round from an empty delta', () => {
    const s = run(begin, delta(1, ''));
    expect(s.activeRound).toBeNull();
    expect(visible(s)).toBe('');
  });

  it('accepts whitespace-only delta text', () => {
    // A model emits whitespace deltas routinely; they are real content.
    const s = run(begin, delta(1, ' '), delta(1, '\n'));
    expect(visible(s)).toBe(' \n');
  });
});

describe('tool-stream buffer — error and cancellation leave nothing stuck', () => {
  it('`settle` clears a half-streamed round (error path)', () => {
    const s = run(begin, delta(1, '{"name":"get_weat'), settle);
    expect(visible(s)).toBe('');
    expect(s.turnActive).toBe(false);
    expect(s.activeRound).toBeNull();
    expect(s.text).toBe('');
  });

  it('`settle` after a `-final` also clears (cancellation mid-round)', () => {
    const s = run(begin, delta(1, 'partial answer'), final(1, ''), settle);
    expect(visible(s)).toBe('');
    expect(s.settledRound).toBeNull();
  });

  it('a new turn after an error starts from a clean buffer', () => {
    const s = run(begin, delta(1, 'leftover'), settle, begin, delta(1, 'fresh'));
    expect(visible(s)).toBe('fresh');
  });

  it('a delta from a previous turn cannot leak into the next one', () => {
    const s = run(begin, delta(1, 'old turn'), settle, begin);
    expect(visible(s)).toBe('');
    const late = toolStreamReducer(s, { type: 'delta', payload: { round: 1, text: 'straggler' } });
    // The turn is open but the buffer is empty; a genuinely new delta still works.
    expect(visible(late)).toBe('straggler');
  });

  it('`settle` is idempotent', () => {
    const once = run(begin, delta(1, 'x'), settle);
    const twice = toolStreamReducer(once, settle);
    expect(twice).toEqual(once);
  });
});

// ── Subscription lifecycle ────────────────────────────────────────────────

/** A stand-in for the preload bridge that records its listeners. */
function fakeBridge() {
  const listeners = { delta: new Set<(p: unknown) => void>(), final: new Set<(p: unknown) => void>() };
  let added = 0;
  let removed = 0;
  const bridge: ToolStreamBridge = {
    onAgentToolStreamDelta: (cb) => {
      added++;
      listeners.delta.add(cb);
      return () => {
        removed++;
        listeners.delta.delete(cb);
      };
    },
    onAgentToolStreamFinal: (cb) => {
      added++;
      listeners.final.add(cb);
      return () => {
        removed++;
        listeners.final.delete(cb);
      };
    },
  };
  return {
    bridge,
    listeners,
    get liveCount() {
      return listeners.delta.size + listeners.final.size;
    },
    get added() {
      return added;
    },
    get removed() {
      return removed;
    },
    emitDelta: (p: unknown) => {
      for (const cb of [...listeners.delta]) cb(p);
    },
    emitFinal: (p: unknown) => {
      for (const cb of [...listeners.final]) cb(p);
    },
  };
}

describe('tool-stream channel — subscription lifecycle', () => {
  it('subscribes to both channels exactly once', () => {
    const f = fakeBridge();
    const ch = createToolStreamChannel(f.bridge, vi.fn());
    ch.subscribe();
    expect(f.added).toBe(2);
    expect(f.liveCount).toBe(2);
    expect(ch.subscribed).toBe(true);
  });

  it('unsubscribes cleanly, leaving no listener behind', () => {
    const f = fakeBridge();
    const ch = createToolStreamChannel(f.bridge, vi.fn());
    ch.subscribe();
    ch.unsubscribe();
    expect(f.removed).toBe(2);
    expect(f.liveCount).toBe(0);
    expect(ch.subscribed).toBe(false);
  });

  it('unsubscribe is safe when never subscribed', () => {
    const f = fakeBridge();
    const ch = createToolStreamChannel(f.bridge, vi.fn());
    expect(() => ch.unsubscribe()).not.toThrow();
    expect(f.added).toBe(0);
  });

  it('unsubscribe is idempotent', () => {
    const f = fakeBridge();
    const ch = createToolStreamChannel(f.bridge, vi.fn());
    ch.subscribe();
    ch.unsubscribe();
    ch.unsubscribe();
    expect(f.removed).toBe(2);
  });

  it('a duplicate subscribe does not add a second listener or double-append', () => {
    const f = fakeBridge();
    let s = initialToolStreamState;
    const ch = createToolStreamChannel(f.bridge, (a) => {
      s = toolStreamReducer(s, a);
    });
    ch.subscribe();
    ch.subscribe();
    ch.subscribe();
    expect(f.added).toBe(2);
    expect(f.liveCount).toBe(2);

    s = toolStreamReducer(s, begin);
    f.emitDelta({ round: 1, text: 'hello' });
    expect(visible(s)).toBe('hello');
  });

  it('resubscribing after unmount does not leak the old listeners', () => {
    const f = fakeBridge();
    const ch = createToolStreamChannel(f.bridge, vi.fn());
    ch.subscribe();
    ch.unsubscribe();
    ch.subscribe();
    expect(f.liveCount).toBe(2);
    ch.unsubscribe();
    expect(f.liveCount).toBe(0);
  });

  it('events after unsubscribe reach nobody', () => {
    const f = fakeBridge();
    const dispatch = vi.fn();
    const ch = createToolStreamChannel(f.bridge, dispatch);
    ch.subscribe();
    ch.unsubscribe();
    f.emitDelta({ round: 1, text: 'too late' });
    f.emitFinal({ round: 1, content: 'too late' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('survives a bridge with no tool-stream members at all', () => {
    const dispatch = vi.fn();
    const ch = createToolStreamChannel({}, dispatch);
    expect(() => ch.subscribe()).not.toThrow();
    expect(ch.subscribed).toBe(true);
    expect(() => ch.unsubscribe()).not.toThrow();
  });

  it('survives a missing bridge', () => {
    const ch = createToolStreamChannel(undefined, vi.fn());
    expect(() => {
      ch.subscribe();
      ch.unsubscribe();
    }).not.toThrow();
  });

  it('a throwing unsubscribe does not prevent the other listener from being removed', () => {
    const removed: string[] = [];
    const bridge: ToolStreamBridge = {
      onAgentToolStreamDelta: () => () => {
        throw new Error('delta removal failed');
      },
      onAgentToolStreamFinal: () => () => {
        removed.push('final');
      },
    };
    const ch = createToolStreamChannel(bridge, vi.fn());
    ch.subscribe();
    expect(() => ch.unsubscribe()).not.toThrow();
    expect(removed).toEqual(['final']);
  });
});

describe('tool-stream channel — full turn through the real bridge callbacks', () => {
  // Drives the channel exactly as the preload would: subscribe, push the
  // runner's events through the registered callbacks, feed the answer chunk,
  // settle. This is the path the renderer actually takes.
  it('a two-round agent turn ends with the answer owned by the chunk channel', () => {
    const f = fakeBridge();
    let s = initialToolStreamState;
    const ch = createToolStreamChannel(f.bridge, (a) => {
      s = toolStreamReducer(s, a);
    });
    ch.subscribe();

    s = toolStreamReducer(s, begin);

    // Round 1 — raw tool-call JSON streams, then is erased by `-final`.
    f.emitDelta({ round: 1, text: '{"name":"get_' });
    expect(visible(s)).toBe('{"name":"get_');
    f.emitDelta({ round: 1, text: 'weather","city":"London"}' });
    expect(visible(s)).toBe('{"name":"get_weather","city":"London"}');
    f.emitFinal({ round: 1, content: '' });
    expect(visible(s)).toBe('');

    // Round 2 — the answer round.
    f.emitDelta({ round: 2, text: "It's 18" });
    f.emitDelta({ round: 2, text: 'C in London.' });
    expect(visible(s)).toBe("It's 18C in London.");
    f.emitFinal({ round: 2, content: "It's 18C in London." });
    expect(visible(s)).toBe("It's 18C in London.");

    // `electron/ipc/ai.ts` then calls onChunk with that same answer.
    s = toolStreamReducer(s, answerChunk);
    expect(visible(s)).toBe('');

    // …and onDone.
    s = toolStreamReducer(s, settle);
    expect(visible(s)).toBe('');

    ch.unsubscribe();
    expect(f.liveCount).toBe(0);
  });

  it('a malformed burst mid-turn leaves the visible text intact', () => {
    const f = fakeBridge();
    let s = initialToolStreamState;
    const ch = createToolStreamChannel(f.bridge, (a) => {
      s = toolStreamReducer(s, a);
    });
    ch.subscribe();
    s = toolStreamReducer(s, begin);

    f.emitDelta({ round: 1, text: 'Working' });
    expect(() => {
      f.emitDelta(undefined);
      f.emitDelta(null);
      f.emitDelta({ text: 'no round' });
      f.emitDelta({ round: 'x', text: 'bad round' });
      f.emitFinal({ round: 1 });
      f.emitFinal({ content: 'no round' });
    }).not.toThrow();
    expect(visible(s)).toBe('Working');

    ch.unsubscribe();
  });

  it('cancellation mid-round leaves nothing to persist', () => {
    const f = fakeBridge();
    let s = initialToolStreamState;
    const ch = createToolStreamChannel(f.bridge, (a) => {
      s = toolStreamReducer(s, a);
    });
    ch.subscribe();
    s = toolStreamReducer(s, begin);
    f.emitDelta({ round: 1, text: '{"name":"get_weather"}' });
    f.emitFinal({ round: 1, content: '' });
    f.emitDelta({ round: 2, text: 'Partial ans' });

    // cancelStream() calls settleTurn(); nothing provisional may remain.
    s = toolStreamReducer(s, settle);
    expect(visible(s)).toBe('');
    expect(s.text).toBe('');

    ch.unsubscribe();
  });

  it('an error mid-turn leaves nothing stuck', () => {
    const f = fakeBridge();
    let s = initialToolStreamState;
    const ch = createToolStreamChannel(f.bridge, (a) => {
      s = toolStreamReducer(s, a);
    });
    ch.subscribe();
    s = toolStreamReducer(s, begin);
    f.emitDelta({ round: 1, text: 'Half a tool' });

    // stream.onError() calls settleTurn() before the fallback branch runs.
    s = toolStreamReducer(s, settle);
    expect(visible(s)).toBe('');
    expect(s.turnActive).toBe(false);

    ch.unsubscribe();
  });
});