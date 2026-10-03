/**
 * Cross-device memory search (row 8.8).
 *
 * The route existed and called itself a cross-device search while querying one
 * device. A caller could not tell that from the response, which is the specific
 * failure these tests exist to rule out: "nothing matched" and "nobody was
 * asked" must never look the same.
 *
 * The tests drive two real layers, not mocks of the code under test:
 *   - `PeerSearchRegistry`, the correlation layer over the SSE stream, with a
 *     transport that records what was actually sent so a test can see the
 *     request leave the desktop.
 *   - `handleCompanionRoute`, driven exactly as syncBridge drives it, with a
 *     real `PeerSearchRegistry` behind the `peerSearch` dependency and a real
 *     reply delivered back through `POST /sync/companion/search-result`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'events';
import { CompanionProfileService } from './personality';
import { handleCompanionRoute } from './routes';
import {
  PeerSearchRegistry,
  type PeerMemoryHit,
  type PeerSearchOutcome,
  type PeerSearchTransport,
} from './peerSearch';
import type Database from 'better-sqlite3';

/** A deterministic local answer, standing in for this machine's own recall. */
const LOCAL_MEMORIES = [
  {
    id: 'local-1',
    table: 'personal_memory',
    memoryType: 'policy',
    trigger: null,
    label: 'retention',
    detail: 'Archived projects are purged after ninety days',
    score: 0.71,
    updatedAt: '2026-10-03T00:00:00.000Z',
    significance: { strategic: 0.9, emotional: 0.4, confidence: 0.9 },
  },
];

const recallModule = vi.hoisted(() => ({
  recall: vi.fn(async () => ({
    memories: LOCAL_MEMORIES,
    backend: 'ollama' as const,
    model: 'nomic-embed-text',
  })),
  available: true,
}));
const thrown = vi.hoisted(() => new Error('Memory recall is not initialised.'));

vi.mock('../knowledge/handlers', () => ({
  getMemoryRecallService: () => {
    if (!recallModule.available) throw thrown;
    return { recall: recallModule.recall };
  },
}));

class FakeRes {
  status = 0;
  body = '';
  private headers: Record<string, string> = {};
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }
  end(chunk?: string): this {
    this.body = chunk ?? '';
    return this;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

class FakeReq extends EventEmitter {
  method: string;
  private readonly chunks: string[];
  constructor(method: string, body?: unknown) {
    super();
    this.method = method;
    this.chunks = body === undefined ? [] : [JSON.stringify(body)];
  }
  pump(): void {
    queueMicrotask(() => {
      for (const chunk of this.chunks) this.emit('data', Buffer.from(chunk));
      this.emit('end');
    });
  }
}

let db: DatabaseSync;
let companion: CompanionProfileService;

/** A scripted transport: records sends, and answers on demand. */
class ScriptedTransport implements PeerSearchTransport {
  readonly sent: { deviceId: string; event: { type: string; payload: unknown } }[] = [];
  private readonly online: Set<string>;

  constructor(online: string[]) {
    this.online = new Set(online);
  }

  send(deviceId: string, event: { type: string; payload: unknown }): void {
    this.sent.push({ deviceId, event });
  }

  isConnected(deviceId: string): boolean {
    return this.online.has(deviceId);
  }
}

let ids = 0;
const nextId = (): string => `req-${++ids}`;

beforeEach(() => {
  ids = 0;
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE memory_summaries (id TEXT PRIMARY KEY, summary_type TEXT, period_label TEXT, summary TEXT, created_at TEXT);
  `);
  companion = new CompanionProfileService(db as never);
  companion.migrate();
  recallModule.available = true;
});

afterEach(() => {
  db.close();
});

interface CrossDeviceBody {
  query: string;
  note?: string;
  crossDevice: {
    peersAsked: number;
    peersAnswered: number;
    peersUnreachable: string[];
    outcomes: { deviceId: string; status: string; hits: number; note?: string }[];
    memories: (PeerMemoryHit & { deviceId: string })[];
  };
}

async function searchCrossDevice(
  opts: {
    registry?: PeerSearchRegistry;
    transport?: ScriptedTransport;
    /** `null` means "the token gate never resolved an identity". */
    deviceId?: string | null;
    query?: string;
  } = {},
): Promise<FakeRes> {
  const transport = opts.transport ?? new ScriptedTransport([]);
  const registry =
    opts.registry ??
    new PeerSearchRegistry(transport, 120, nextId);
  const req = new FakeReq('GET');
  req.pump();
  const res = new FakeRes();
  const handled = await handleCompanionRoute(
    req as never,
    res,
    '/sync/companion/search',
    new URL(`http://127.0.0.1:4242/sync/companion/search?q=${encodeURIComponent(opts.query ?? 'retention')}`),
    {
      db: db as unknown as Database.Database,
      companion,
      // `null` means the token gate never resolved an identity.
      authenticatedDeviceId: opts.deviceId === null ? undefined : (opts.deviceId ?? 'device-phone-1'),
      peerSearch: {
        connectedDevices: (except) =>
          [...new Set(['device-phone-1', 'device-tablet-2'].filter((id) => id !== except && transport.isConnected(id)))],
        search: (id, query, limit) => registry.request(id, query, limit),
        deliver: (body, from) => registry.deliver(body, from),
      },
    },
  );
  expect(handled).toBe(true);
  return res;
}

describe('8.8 — without a device token the search is refused', () => {
  it('answers 401 for every companion path when no identity was established', async () => {
    const req = new FakeReq('GET');
    req.pump();
    const res = new FakeRes();
    const handled = await handleCompanionRoute(
      req as never,
      res,
      '/sync/companion/search',
      new URL('http://127.0.0.1:4242/sync/companion/search?q=anything'),
      { db: db as never, companion },
    );
    expect(handled).toBe(true);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('memories');
  });

  it('refuses the reply endpoint too, so an unauthenticated device cannot inject results', async () => {
    const req = new FakeReq('POST', { requestId: 'req-1', hits: [] });
    req.pump();
    const res = new FakeRes();
    await handleCompanionRoute(
      req as never,
      res,
      '/sync/companion/search-result',
      new URL('http://127.0.0.1:4242/sync/companion/search-result'),
      { db: db as never, companion },
    );
    expect(res.status).toBe(401);
  });

  it('never reaches the recall service without an identity', async () => {
    recallModule.recall.mockClear();
    await searchCrossDevice({ deviceId: null });
    expect(recallModule.recall).not.toHaveBeenCalled();
  });
});

describe('8.8 — a peer that is not there is reported, not disguised as an empty result', () => {
  it('says nothing was searched cross-device when no other device is connected', async () => {
    const res = await searchCrossDevice();
    expect(res.status).toBe(200);
    const body = res.json() as unknown as CrossDeviceBody;

    expect(body.crossDevice.peersAsked).toBe(0);
    expect(body.crossDevice.memories).toEqual([]);
    // The local answer is still there — and it is clearly labelled as local.
    expect(body.note).toMatch(/this device only/i);
  });

  it('asks every other connected device and merges what they return', async () => {
    const transport = new ScriptedTransport(['device-phone-1', 'device-tablet-2']);
    const registry = new PeerSearchRegistry(transport, 120, nextId);
    const pending = searchCrossDevice({ registry, transport });

    // The request genuinely left the desktop for the other device.
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0].deviceId).toBe('device-tablet-2');
    expect(transport.sent[0].event.type).toBe('memory_search_request');
    const requestId = (transport.sent[0].event.payload as { requestId: string }).requestId;
    expect(requestId).toBe('req-1');

    const reply = await postSearchResult(registry, 'device-tablet-2', {
      requestId,
      hits: [
        { table: 'personal_memory', memoryType: 'lesson', label: 'retention-lesson', detail: 'Purge at 60 days', score: 0.8 },
      ],
    });
    expect(reply.status).toBe(202);

    const body = (await pending).json() as unknown as CrossDeviceBody;
    expect(body.crossDevice.peersAsked).toBe(1);
    expect(body.crossDevice.peersAnswered).toBe(1);
    expect(body.crossDevice.peersUnreachable).toEqual([]);
    expect(body.crossDevice.memories).toHaveLength(1);
    expect(body.crossDevice.memories[0].deviceId).toBe('device-tablet-2');
    // Attributed, so a remote hit is never mistaken for a local one.
    expect(body.crossDevice.memories[0].label).toContain('device-tablet-2');
  });

  it('reports a connected peer that never answers as unreachable, not as no results', async () => {
    const transport = new ScriptedTransport(['device-phone-1', 'device-tablet-2']);
    const registry = new PeerSearchRegistry(transport, 40, nextId);

    const res = await searchCrossDevice({ registry, transport });
    expect(res.status).toBe(200);
    const body = res.json() as unknown as CrossDeviceBody;

    expect(body.crossDevice.peersAsked).toBe(1);
    expect(body.crossDevice.peersAnswered).toBe(0);
    expect(body.crossDevice.peersUnreachable).toEqual(['device-tablet-2']);
    expect(body.crossDevice.outcomes[0].status).toBe('timeout');
    expect(body.crossDevice.memories).toEqual([]);
    // In words, at the top level, where a human will actually see it.
    expect(body.note).toMatch(/did not answer/i);
  });

  it('asks nobody and says so, rather than naming a device that was never reachable', async () => {
    // The phone is the only device on the stream, and it is the one asking.
    const transport = new ScriptedTransport(['device-phone-1']);
    const res = await searchCrossDevice({ transport });
    const body = res.json() as unknown as CrossDeviceBody;

    expect(body.crossDevice.peersAsked).toBe(0);
    expect(body.crossDevice.outcomes).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(body.note).toMatch(/this device only/i);
  });
});

describe('8.8 — the reply endpoint cannot be spoofed', () => {
  it('rejects a reply that matches no pending request', async () => {
    const transport = new ScriptedTransport([]);
    const registry = new PeerSearchRegistry(transport, 120, nextId);

    const res = await postSearchResult(registry, 'device-tablet-2', {
      requestId: 'never-sent',
      hits: [],
    });
    expect(res.status).toBe(404);
    expect(res.json().error).toMatch(/no such pending request/i);
  });

  it('rejects a reply from a device the request was not sent to', async () => {
    const transport = new ScriptedTransport(['device-tablet-2']);
    const registry = new PeerSearchRegistry(transport, 5000, nextId);
    const pending = registry.request('device-tablet-2', 'retention', 10);

    const res = await postSearchResult(registry, 'device-evil-3', { requestId: 'req-1', hits: [] });
    expect(res.status).toBe(404);
    expect(res.json().error).toMatch(/does not belong to this device/i);

    registry.dispose();
    expect((await pending).status).toBe('absent');
  });

  it('rejects a malformed reply instead of accepting partial data', async () => {
    const transport = new ScriptedTransport([]);
    const registry = new PeerSearchRegistry(transport, 120, nextId);
    const res = await postSearchResult(registry, 'device-tablet-2', { hits: 'not-an-array' });
    expect(res.status).toBe(404);
  });

  it('requires POST', async () => {
    const transport = new ScriptedTransport([]);
    const registry = new PeerSearchRegistry(transport, 120, nextId);
    const req = new FakeReq('GET');
    req.pump();
    const res = new FakeRes();
    await handleCompanionRoute(
      req as never,
      res,
      '/sync/companion/search-result',
      new URL('http://127.0.0.1:4242/sync/companion/search-result'),
      {
        db: db as unknown as Database.Database,
        companion,
        authenticatedDeviceId: 'device-tablet-2',
        peerSearch: {
          connectedDevices: () => [],
          search: (id, q, l) => registry.request(id, q, l),
          deliver: (body, from) => registry.deliver(body, from),
        },
      },
    );
    expect(res.status).toBe(405);
  });
});

describe('8.8 — the registry reports each failure mode distinctly', () => {
  let transport: ScriptedTransport;
  let registry: PeerSearchRegistry;

  beforeEach(() => {
    transport = new ScriptedTransport(['device-tablet-2']);
    registry = new PeerSearchRegistry(transport, 50, nextId);
  });

  afterEach(() => {
    registry.dispose();
  });

  it('answers without waiting when the device has no stream', async () => {
    const offline = new PeerSearchRegistry(new ScriptedTransport([]), 50, nextId);
    const outcome: PeerSearchOutcome = await offline.request('device-tablet-2', 'retention', 10);
    expect(outcome.status).toBe('absent');
    expect(outcome.hits).toEqual([]);
    // Nothing was sent, so nothing was wasted waiting for it.
    expect(outcome.note).toMatch(/not connected/i);
  });

  it('times out a device that accepts the request and never replies', async () => {
    const outcome = await registry.request('device-tablet-2', 'retention', 10);
    expect(outcome.status).toBe('timeout');
    expect(transport.sent).toHaveLength(1);
  });

  it('surfaces an error the device reported', async () => {
    const pending = registry.request('device-tablet-2', 'retention', 10);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    registry.deliver({ requestId: 'req-1', error: 'database locked' }, 'device-tablet-2');
    const outcome = await pending;
    expect(outcome.status).toBe('error');
    expect(outcome.note).toMatch(/database locked/);
  });

  it('does not leak a pending request after it resolves', async () => {
    const pending = registry.request('device-tablet-2', 'retention', 10);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(registry.pendingCount).toBe(1);
    registry.deliver({ requestId: 'req-1', hits: [] }, 'device-tablet-2');
    await pending;
    expect(registry.pendingCount).toBe(0);
  });

  it('fails every outstanding request when the connection closes', async () => {
    const pending = registry.request('device-tablet-2', 'retention', 10);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    registry.dispose();
    const outcome = await pending;
    expect(outcome.status).toBe('absent');
    expect(outcome.note).toMatch(/closed before it answered/i);
  });
});

describe('8.8 — recall being unavailable is still not an empty result', () => {
  it('answers 503 rather than pretending there was nothing to find', async () => {
    recallModule.available = false;
    const res = await searchCrossDevice();
    expect(res.status).toBe(503);
    expect(res.json().error).toMatch(/not available/i);
    expect(res.body).not.toContain('memories');
  });
});

async function postSearchResult(
  registry: PeerSearchRegistry,
  fromDevice: string,
  body: unknown,
): Promise<FakeRes> {
  const req = new FakeReq('POST', body);
  req.pump();
  const res = new FakeRes();
  await handleCompanionRoute(
    req as never,
    res,
    '/sync/companion/search-result',
    new URL('http://127.0.0.1:4242/sync/companion/search-result'),
    {
      db: db as unknown as Database.Database,
      companion,
      authenticatedDeviceId: fromDevice,
      peerSearch: {
        connectedDevices: () => [],
        search: (id, q, l) => registry.request(id, q, l),
        deliver: (payload, from) => registry.deliver(payload, from),
      },
    },
  );
  return res;
}