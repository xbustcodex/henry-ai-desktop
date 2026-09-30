import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for the conversation-summary handlers in registerMemoryHandlers.
 *
 * The renderer reads `saveSummary` as an `{ id, error }` envelope
 * (MemoryAwarenessPanel destructures both fields), and `getSummary` as a full
 * `conversation_summaries` row. Both were wrong: the failure path returned a
 * bare `null` (so `saved.error` threw), and `getSummary` was declared
 * `string | null` while returning a row / `undefined`.
 *
 * The DB is a small in-memory stand-in because better-sqlite3 is compiled for
 * Electron's ABI. It fails loudly if the SQL it keys on changes shape: the
 * round-trip assertions below would then see an empty table.
 */
const h = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      // Electron itself throws on a second handle() for one channel, so a
      // duplicate registration is a startup crash, not a silent overwrite.
      if (h.handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`);
      h.handlers.set(channel, fn);
    },
    on: () => {},
  },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' },
  shell: {},
  dialog: {},
}));

import { registerMemoryHandlers } from './memory';

interface SummaryRow {
  id: string;
  conversation_id: string;
  summary: string;
  message_count: number;
  token_count: number;
  created_at: string;
}

function fakeDb(opts: { throwOnInsert?: boolean } = {}) {
  const rows: SummaryRow[] = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO conversation_summaries')) {
            if (opts.throwOnInsert) throw new Error('disk full');
            rows.push({
              id: args[0] as string,
              conversation_id: args[1] as string,
              summary: args[2] as string,
              message_count: args[3] as number,
              token_count: args[4] as number,
              created_at: args[5] as string,
            });
          }
          return { changes: 1 };
        },
        get: (convId: string) => {
          const hit = rows.filter((r) => r.conversation_id === convId);
          return hit.length ? hit[hit.length - 1] : undefined;
        },
        all: () => rows,
      };
    },
    transaction: (fn: (...a: unknown[]) => unknown) => fn,
  };
}

const call = (channel: string) => h.handlers.get(channel)!;

describe('memory conversation summaries', () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it('saveSummary failure keeps the { id, error } envelope', async () => {
    registerMemoryHandlers(fakeDb({ throwOnInsert: true }) as never);

    const res = await call('memory:saveSummary')({}, { conversationId: 'c1', summary: 'a real summary' });

    // A bare null here made the renderer's `saved.error` throw a TypeError
    // instead of surfacing the database error.
    expect(res).toEqual({ id: null, error: 'disk full' });
  });

  it('saveSummary rejects an empty summary with the same envelope', async () => {
    registerMemoryHandlers(fakeDb() as never);

    const res = await call('memory:saveSummary')({}, { conversationId: 'c1', summary: '   ' }) as { id: string | null; error?: string };

    expect(res.id).toBeNull();
    expect(res.error).toBeTruthy();
  });

  it('getSummary returns the full row, not a bare string', async () => {
    const db = fakeDb();
    registerMemoryHandlers(db as never);

    await call('memory:saveSummary')({}, { conversationId: 'c1', summary: 'Henry ships things.', messageCount: 4, tokenCount: 9 });
    const row = await call('memory:getSummary')({}, 'c1') as SummaryRow;

    expect(row.summary).toBe('Henry ships things.');
    expect(row.conversation_id).toBe('c1');
    expect(row.message_count).toBe(4);
    expect(row.token_count).toBe(9);
  });

  it('getSummary returns null — never undefined — when there is no summary', async () => {
    registerMemoryHandlers(fakeDb() as never);

    // better-sqlite3's .get() yields undefined; the IPC contract is `| null`.
    await expect(call('memory:getSummary')({}, 'nope')).resolves.toBeNull();
  });
});
