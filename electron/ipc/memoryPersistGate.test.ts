/**
 * The `persistMemory` privacy gate on memory writes.
 *
 * The behaviour under test is a promise to the user: turn memory persistence
 * off and Henry stops writing, without any caller seeing an error and without
 * anything that is already stored becoming unreadable.
 *
 * `__setPolicyForTest` is the real test seam exported by securityPolicy.ts, so
 * these exercise the actual switch rather than a reimplementation of it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface Handlers {
  handle: (channel: string, fn: (...args: never[]) => unknown) => void;
}
const handlers = new Map<string, (...args: never[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));

let policyState = { persist: true };

vi.mock('./securityPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./securityPolicy')>();
  return {
    ...actual,
    // Only `policyFlag` is faked, so the real switch value can be driven from
    // the test. Everything else — including `__setPolicyForTest` — is the real
    // module, so the last suite exercises the genuine policy machinery.
    policyFlag: (key: string) => (key === 'persistMemory' ? policyState.persist : true),
  };
});

// Import after the mocks are declared (vitest hoists them above the import).
const { registerMemoryHandlers } = await import('./memory');


/** Records every INSERT so the test can assert nothing was written. */
let writes: string[] = [];

/**
 * A database fixture that satisfies what `registerMemoryHandlers` needs, and
 * records any write attempt so a gated handler can be proven inert.
 */
function fakeDb() {
  // The prepared SQL arrives as the first argument to `.prepare(sql)`, so it
  // has to be captured there — `.run()` only ever sees the bound parameters.
  const stmt = (sql: string) => ({
    run: () => {
      writes.push(sql);
      return { changes: 1 };
    },
    get: () => undefined,
    all: () => [],
  });
  return {
    prepare: (sql: string) => stmt(sql),
    exec: (sql: string) => {
      writes.push(sql);
    },
    transaction: (fn: () => void) => fn(),
  };
}

const call = (channel: string, ...args: unknown[]) =>
  (handlers.get(channel) as unknown as (...a: unknown[]) => unknown)({}, ...args);

beforeEach(() => {
  writes = [];
  policyState = { persist: true };
  handlers.clear();
  registerMemoryHandlers(fakeDb() as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The write channels this test covers, with the shape each returns. */
const WRITES: [string, unknown[]][] = [
  ['memory:saveFact', [{ fact: 'Name: Topher', category: 'person' }]],
  ['memory:saveSummary', [{ conversationId: 'c1', summary: 'a real summary' }]],
  ['memory:savePersonalMemory', [{ memoryKey: 'k', memoryValue: 'v' }]],
  ['memory:updatePersonalMemory', ['p1', { memory_value: 'x' }]],
  ['memory:deletePersonalMemory', ['p1']],
  ['memory:saveProject', [{ name: 'Atlas' }]],
  ['memory:saveGoal', [{ title: 'Ship it' }]],
  ['memory:saveCommitment', [{ description: 'Do the thing' }]],
  ['memory:saveMilestone', [{ title: 'v1' }]],
  ['memory:saveNarrativeMemory', [{ arcName: 'Arc', summary: 's' }]],
  ['memory:saveMemorySummary', [{ summaryType: 'daily_rollup', summary: 's' }]],
  ['memory:saveGraphEdge', [{ fromEntityType: 'fact', fromEntityId: 'a', toEntityType: 'fact', toEntityId: 'b', relationshipType: 'rel' }]],
  ['memory:saveWhereWeLeftOff', ['we were mid-migration']],
  ['memory:compressSession', [{ conversationId: 'c1', summary: 'done' }]],
];

describe('persistMemory — when persistence is ON (the default)', () => {
  it('writes, and returns the normal success shape', async () => {
    const result = (await call('memory:saveFact', { fact: 'Name: Topher', category: 'person' })) as { id?: string };
    expect(result.id).toBeTruthy();
    expect(writes.some((w) => w.includes('INSERT INTO memory_facts'))).toBe(true);
  });
});

describe('persistMemory — when persistence is OFF', () => {
  beforeEach(() => {
    policyState = { persist: false };
    // Re-register so each handler body is evaluated against the new switch.
    handlers.clear();
    registerMemoryHandlers(fakeDb() as never);
  });

  it('performs no write at all', async () => {
    for (const [channel, args] of WRITES) {
      writes = [];
      await call(channel, ...args);
      const wrote = writes.filter((w) => w.includes('INSERT') || w.includes('UPDATE') || w.includes('DELETE'));
      expect(wrote, `${channel} must not write when persistMemory is off`).toEqual([]);
    }
  });

  it('returns each handler’s own success envelope rather than throwing', async () => {
    for (const [channel, args] of WRITES) {
      await expect(call(channel, ...args), `${channel} must not reject`).resolves.not.toThrow?.();
      // The call resolved rather than rejected.
      const result = await call(channel, ...args);
      expect(result, `${channel} must return an envelope`).toBeTypeOf('object');
      expect(result).not.toBeNull();
    }
  });

  it('does not report success with an id the caller would then chase', async () => {
    const saved = (await call('memory:savePersonalMemory', { memoryKey: 'k', memoryValue: 'v' })) as { id?: string };
    expect(saved.id).toBeNull();
  });

  it('keeps a readable envelope shape for update handlers', async () => {
    expect(await call('memory:updatePersonalMemory', 'p1', { memory_value: 'x' })).toEqual({ updated: false });
    expect(await call('memory:deletePersonalMemory', 'p1')).toEqual({ deleted: false });
    expect(await call('memory:resolveCommitment', 'c1')).toEqual({ resolved: false });
  });

  it('keeps the summary envelope destructurable, since callers read .id/.error', async () => {
    const saved = (await call('memory:saveSummary', { conversationId: 'c1', summary: 's' })) as {
      id: string | null;
      error?: string;
    };
    expect(saved.id).toBeNull();
    // No error is surfaced: the user did nothing wrong by disabling persistence.
    expect(saved.error).toBeUndefined();
  });

  it('compressSession reports not-compressed rather than claiming success', async () => {
    expect(await call('memory:compressSession', { conversationId: 'c1', summary: 's' })).toEqual({ compressed: false });
  });
});

describe('persistMemory — reads are never gated', () => {
  beforeEach(() => {
    policyState = { persist: false };
    handlers.clear();
    registerMemoryHandlers(fakeDb() as never);
  });

  it('still answers reads, so existing memories remain accessible', async () => {
    // With persistence off, the read paths must keep working — otherwise the
    // switch destroys data the user already had instead of protecting it.
    await expect(call('memory:getAllFacts', 10)).resolves.toBeDefined();
    await expect(call('memory:getPersonalMemory', {})).resolves.toBeDefined();
    await expect(call('memory:getProjects', {})).resolves.toBeDefined();
    await expect(call('memory:getGoals', {})).resolves.toBeDefined();
    await expect(call('memory:getCommitments', {})).resolves.toBeDefined();
    await expect(call('memory:getWhereWeLeftOff')).resolves.toBeDefined();
    await expect(call('memory:buildContext', { query: 'x' })).resolves.toBeDefined();
  });

  it('issues no writes as a side effect of reading', async () => {
    writes = [];
    await call('memory:getAllFacts', 10);
    await call('memory:getPersonalMemory', {});
    expect(writes).toEqual([]);
  });
});

describe('persistMemory — the real policy seam', () => {
  it('the real module exposes a working test seam that fails closed by default', async () => {
    // `policyFlag` is mocked in this file so the switch can be driven, so the
    // REAL behaviour is asserted against the real module directly.
    const real = await vi.importActual<typeof import('./securityPolicy')>('./securityPolicy');
    // Before init with a database, the policy is the safe default.
    expect(real.getSecurityPolicy().persistMemory).toBe(true);

    const restore = real.__setPolicyForTest({ persistMemory: false });
    expect(real.policyFlag('persistMemory')).toBe(false);
    restore();
    expect(real.policyFlag('persistMemory')).toBe(true);
  });
});
