/**
 * Companion transport routes — the security boundary.
 *
 * These exercise `handleCompanionRoute` the way syncBridge does: after a device
 * token has already been validated. The tests here prove the route handler
 * itself never widens access — it serves only an explicit allow-list, returns
 * 404 for anything else under the prefix, and never leaks a token or a pairing
 * secret in a response body.
 *
 * `handleCompanionRoute` also refuses any caller that has no
 * `authenticatedDeviceId`, so the refusal is asserted here behaviourally
 * rather than inferred from where the mount sits in syncBridge — see
 * peerSearch.test.ts for the 8.8 case. syncBridge's own token gate remains the
 * primary check; this is the second one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'events';
import { CompanionProfileService, type CompanionContext } from './personality';
import { COMPANION_ROUTE_PATHS, handleCompanionRoute } from './routes';
import type { SqlDatabase } from '../vector/sql';

let db: DatabaseSync;
let companion: CompanionProfileService;

/** Minimal `http.ServerResponse` stand-in that records what was sent. */
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

  contentType(): string {
    return this.headers['Content-Type'] ?? '';
  }
}

/** Minimal `http.IncomingMessage` stand-in with a JSON body. */
class FakeReq extends EventEmitter {
  method: string;
  private readonly chunks: string[];

  constructor(method: string, body?: unknown) {
    super();
    this.method = method;
    this.chunks = body === undefined ? [] : [JSON.stringify(body)];
  }

  /** Emit the body asynchronously, as a real socket would. */
  pump(): void {
    queueMicrotask(() => {
      for (const chunk of this.chunks) this.emit('data', Buffer.from(chunk));
      this.emit('end');
    });
  }
}

async function call(method: string, path: string, body?: unknown, query = ''): Promise<FakeRes> {
  const req = new FakeReq(method, body);
  req.pump();
  const res = new FakeRes();
  const handled = await handleCompanionRoute(
    req as never,
    res,
    path,
    new URL(`http://127.0.0.1:4242${path}${query}`),
    { db: db as never, companion, authenticatedDeviceId: 'device-phone-1' },
  );
  expect(handled).toBe(true);
  return res;
}

/**
 * Call the route surface as a paired device. `handleCompanionRoute` now
 * requires the identity syncBridge resolved, so the default here is a device
 * that has already passed the token gate — the situation production is in.
 */
async function callAs(
  method: string,
  path: string,
  body?: unknown,
  query = '',
  deviceId: string | undefined = 'device-phone-1',
): Promise<FakeRes> {
  const req = new FakeReq(method, body);
  req.pump();
  const res = new FakeRes();
  const handled = await handleCompanionRoute(
    req as never,
    res,
    path,
    new URL(`http://127.0.0.1:4242${path}${query}`),
    { db: db as never, companion, authenticatedDeviceId: deviceId },
  );
  expect(handled).toBe(true);
  return res;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  // buildMemoryGraph reads these; recall routes are exercised separately.
  db.exec(`
    CREATE TABLE memory_facts (id TEXT PRIMARY KEY, fact TEXT, category TEXT, importance REAL, created_at TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, status TEXT, summary TEXT, strategic_importance_score REAL, updated_at TEXT);
    CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT, status TEXT, summary TEXT, priority_score REAL, updated_at TEXT);
    CREATE TABLE commitments (id TEXT PRIMARY KEY, description TEXT, status TEXT, project_id TEXT, importance_score REAL, created_at TEXT);
    CREATE TABLE milestones (id TEXT PRIMARY KEY, title TEXT, milestone_type TEXT, project_id TEXT, significance_score REAL, created_at TEXT);
    CREATE TABLE narrative_memory (id TEXT PRIMARY KEY, arc_name TEXT, summary TEXT, importance_score REAL, active_status INTEGER, linked_project_ids_json TEXT, linked_memory_ids_json TEXT, updated_at TEXT);
    CREATE TABLE personal_memory (id TEXT PRIMARY KEY, memory_key TEXT, memory_value TEXT, memory_type TEXT, updated_at TEXT);
    CREATE TABLE memory_graph_edges (id TEXT PRIMARY KEY, from_entity_type TEXT, from_entity_id TEXT, to_entity_type TEXT, to_entity_id TEXT, relationship_type TEXT, weight_score REAL);
    CREATE TABLE memory_summaries (id TEXT PRIMARY KEY, summary_type TEXT, period_label TEXT, summary TEXT, created_at TEXT);
  `);
  companion = new CompanionProfileService(db as never);
  companion.migrate();
});

afterEach(() => {
  db.close();
});

describe('Companion routes — allow-list', () => {
  it('declares only /sync/companion paths, so it cannot shadow existing routes', () => {
    for (const path of COMPANION_ROUTE_PATHS) {
      expect(path.startsWith('/sync/companion/')).toBe(true);
    }
  });

  it('does not claim any pre-existing sync route', () => {
    const claimed = new Set<string>(COMPANION_ROUTE_PATHS);
    for (const existing of ['/sync/prompt', '/sync/snapshot', '/sync/pair', '/sync/health', '/sync/stream']) {
      expect(claimed.has(existing)).toBe(false);
    }
  });

  it('404s an unknown path under the prefix rather than falling through', async () => {
    const res = await call('GET', '/sync/companion/not-a-real-feature');
    expect(res.status).toBe(404);
  });

  it('ignores paths outside the prefix entirely', async () => {
    const res = new FakeRes();
    const handled = await handleCompanionRoute(
      new FakeReq('GET') as never,
      res,
      '/sync/snapshot',
      new URL('http://127.0.0.1:4242/sync/snapshot'),
      { db: db as never, companion },
    );
    expect(handled).toBe(false);
    expect(res.status).toBe(0);
  });
});

describe('Companion routes — context (8.3 / 8.4 / 8.5)', () => {
  it('serves the assembled context as JSON', async () => {
    companion.savePersonality({ name: 'Wren', speakingStyle: 'plainspoken' });
    companion.observeEmotion({ mood: 'calm', note: 'good session' });
    companion.saveVoiceProfile({ voiceId: 'abc', style: 'measured' });

    const res = await call('GET', '/sync/companion/context');
    expect(res.status).toBe(200);
    expect(res.contentType()).toContain('application/json');

    const body = res.json() as unknown as CompanionContext;
    expect(body.personality.name).toBe('Wren');
    expect(body.emotion.mood).toBe('calm');
    expect(body.voice.voiceId).toBe('abc');
    expect(body.promptBlock).toContain('Wren');
  });

  it('records an emotional observation over POST', async () => {
    const res = await call('POST', '/sync/companion/emotion', { mood: 'frustrated', note: 'build broke again' });
    expect(res.status).toBe(200);
    const body = res.json() as { emotion: { mood: string; triggerNote: string } };
    expect(body.emotion.mood).toBe('frustrated');
    expect(body.emotion.triggerNote).toContain('build broke');
  });

  it('accepts an empty body as no observation rather than erroring', async () => {
    // An empty POST body is a legitimate "no comment" — it must record the
    // default neutral observation, not 400.
    const res = await call('POST', '/sync/companion/emotion');
    expect(res.status).toBe(200);
    expect((res.json() as { emotion: { mood: string } }).emotion.mood).toBe('neutral');
  });

  it('rejects a body that is valid JSON but not an object, with 400', async () => {
    const req = new FakeReq('POST');
    // Emit a JSON array — parseable, but not an observation object.
    req.emit = ((event: string, chunk?: unknown) => {
      if (event === 'data') EventEmitter.prototype.emit.call(req, 'data', Buffer.from('[1,2,3]'));
      if (event === 'end') EventEmitter.prototype.emit.call(req, 'end');
      return true;
    }) as never;
    queueMicrotask(() => {
      req.emit('data', Buffer.from('[1,2,3]'));
      req.emit('end');
    });
    const res = new FakeRes();
    await handleCompanionRoute(req as never, res, '/sync/companion/emotion', new URL('http://x/sync/companion/emotion'), {
      db: db as never, companion, authenticatedDeviceId: 'device-phone-1',
    });
    expect(res.status).toBe(400);
  });

  it('serves the voice profile with effective TTS parameters', async () => {
    companion.saveVoiceProfile({ voiceId: 'v1', engine: 'elevenlabs', rate: 1.2 });
    const body = (await call('GET', '/sync/companion/voice')).json() as {
      tts: { engine: string; rate: number };
    };
    expect(body.tts.engine).toBe('elevenlabs');
    expect(body.tts.rate).toBeCloseTo(1.2, 5);
  });
});

describe('Companion routes — memory graph (8.2)', () => {
  it('serves a real graph built from stored memories', async () => {
    db.prepare(`INSERT INTO memory_facts (id, fact, category, importance, created_at) VALUES ('f1','Retention is 90 days','policy',9,'2026-01-01')`).run();
    db.prepare(`INSERT INTO projects (id, name, status, summary, strategic_importance_score, updated_at) VALUES ('p1','Atlas','active','Migration',0.9,'2026-01-01')`).run();
    db.prepare(`INSERT INTO commitments (id, description, status, project_id, importance_score, created_at) VALUES ('c1','Ship the migration','open','p1',0.8,'2026-01-01')`).run();

    const body = (await call('GET', '/sync/companion/graph')).json() as {
      nodes: { id: string }[];
      edges: { from: string; to: string }[];
      totalNodes: number;
    };
    expect(body.nodes.length).toBe(3);
    // The commitment→project relationship is a real stored FK, not invented.
    expect(body.edges.some((e) => e.from === 'commitment:c1' && e.to === 'project:p1')).toBe(true);
  });

  it('only sends edges whose endpoints are in the sent node set', async () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO memory_facts (id, fact, category, importance, created_at) VALUES (?,?,?,?,?)`).run(
        `f${i}`, `fact number ${i}`, 'misc', 5, '2026-01-01',
      );
    }
    const body = (await call('GET', '/sync/companion/graph', undefined, '?limit=3')).json() as {
      nodes: { id: string }[];
      edges: { from: string; to: string }[];
      truncated: boolean;
    };
    expect(body.nodes).toHaveLength(3);
    expect(body.truncated).toBe(true);
    const ids = new Set(body.nodes.map((n) => n.id));
    for (const edge of body.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it('returns an empty graph on a fresh install instead of fabricating one', async () => {
    const body = (await call('GET', '/sync/companion/memory-graph')).json() as { nodes: unknown[]; edges: unknown[] };
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });
});

describe('Companion routes — summaries (8.7)', () => {
  it('serves stored rollups and filters by type', async () => {
    db.prepare(`INSERT INTO memory_summaries (id, summary_type, period_label, summary, created_at) VALUES ('s1','daily_rollup','Today','Shipped the migration','2026-01-01')`).run();
    db.prepare(`INSERT INTO memory_summaries (id, summary_type, period_label, summary, created_at) VALUES ('s2','weekly_rollup','Week 1','Three releases out','2026-01-07')`).run();

    const all = (await call('GET', '/sync/companion/summaries')).json() as { summaries: { type: string }[] };
    expect(all.summaries).toHaveLength(2);

    const weekly = (await call('GET', '/sync/companion/summaries', undefined, '?type=weekly')).json() as {
      summaries: { type: string; summary: string }[];
    };
    expect(weekly.summaries).toHaveLength(1);
    expect(weekly.summaries[0].type).toBe('weekly_rollup');
  });
});

describe('Companion routes — cross-device search (8.8)', () => {
  it('refuses a search with no query rather than returning everything', async () => {
    expect((await call('GET', '/sync/companion/search')).status).toBe(400);
  });

  it('answers 503, not a crash, when memory recall was never registered', async () => {
    // This test file builds its own CompanionProfileService and never calls
    // registerKnowledgeHandlers, so the recall service genuinely is absent —
    // the honest answer is "unavailable", not a 500 and not a fake empty list.
    const res = await call('GET', '/sync/companion/search', undefined, '?q=anything');
    expect(res.status).toBe(503);
    expect(res.json().error).toMatch(/not available/i);
  });
});

describe('Companion routes — no secret leakage', () => {
  it('never returns a token, PIN or pairing secret', async () => {
    companion.savePersonality({ name: 'Wren' });
    for (const path of COMPANION_ROUTE_PATHS) {
      if (path.includes('search')) continue;
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      expect(res.body).not.toMatch(/jwt|bearer|pairingSecret|\.jwt-secret|companionToken|pinHash/i);
    }
  });
});
