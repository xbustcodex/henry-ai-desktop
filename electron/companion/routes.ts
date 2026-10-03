/**
 * Companion feature routes (rows 8.2 / 8.3 / 8.4 / 8.5 / 8.8).
 *
 * SECURITY — the whole point of this file's shape:
 *
 *   `handleCompanionRoute` is only ever called from syncBridge AFTER that file
 *   has resolved a valid device token. It is not mounted as a catch-all, it
 *   does not appear in the LAN companion-web allow-list, and it cannot be
 *   reached through the cloudflared tunnel without a token. It adds no public
 *   route and reads no pairing secret.
 *
 * Routes served (all behind the existing pairing + token guard):
 *   GET  /sync/companion/context      — assembled personality + emotion + voice
 *   GET  /sync/companion/personality
 *   POST /sync/companion/emotion      — record an observation
 *   GET  /sync/companion/graph        — memory graph (8.2)
 *   GET  /sync/companion/memory-graph — alias, descriptive name
 *   GET  /sync/companion/voice        — voice profile + the TTS params to use
 *   GET  /sync/companion/search       — cross-device memory search (8.8)
 *   POST /sync/companion/search-result— a peer answering that search (8.8)
 *   GET  /sync/companion/summaries    — latest daily/weekly rollup (8.7)
 *
 * `deps.authenticatedDeviceId` is required, not advisory. syncBridge already
 * refuses an untokened request before it ever calls this function; requiring
 * the caller's identity here means a future caller that forgets that step gets
 * a 401 rather than the entire companion surface.
 *
 * Returns true when the request was handled, so the caller can `return`.
 */

import type http from 'http';
import type Database from 'better-sqlite3';
import { buildMemoryGraph } from '../ipc/memoryGraph';
import { getMemoryRecallService } from '../knowledge/handlers';
import type { CompanionProfileService } from './personality';
import type { PeerSearchBridge, PeerSearchOutcome } from './peerSearch';

export interface CompanionRouteDeps {
  db: Database.Database;
  companion: CompanionProfileService;
  /** The paired device this request came from. Absent ⇒ refused. */
  authenticatedDeviceId?: string;
  /** How to reach the other paired devices. Absent ⇒ peer leg reports absent. */
  peerSearch?: PeerSearchBridge;
}

/** Minimal response writer, structurally compatible with syncBridge's. */
interface ResponseWriter {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: string): unknown;
}

function json(res: ResponseWriter, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Read a bounded, non-negative integer query parameter. */
function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Read the request body, refusing anything implausibly large. */
async function readJsonBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  // Executor form, not Promise.withResolvers: the project's TS lib target
  // predates ES2024, so the static helper is not in scope here.
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return finish({});
        const parsed: unknown = JSON.parse(raw);
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/** Every path this module serves, so syncBridge can gate it in one place. */
export const COMPANION_ROUTE_PATHS = [
  '/sync/companion/context',
  '/sync/companion/personality',
  '/sync/companion/emotion',
  '/sync/companion/graph',
  '/sync/companion/memory-graph',
  '/sync/companion/voice',
  '/sync/companion/search',
  '/sync/companion/summaries',
  '/sync/companion/search-result',
] as const;

export async function handleCompanionRoute(
  req: http.IncomingMessage,
  res: ResponseWriter,
  urlPath: string,
  url: URL,
  deps: CompanionRouteDeps,
): Promise<boolean> {
  if (!urlPath.startsWith('/sync/companion/')) return false;
  if (!COMPANION_ROUTE_PATHS.includes(urlPath as (typeof COMPANION_ROUTE_PATHS)[number])) {
    json(res, 404, { error: 'Unknown companion route' });
    return true;
  }
  // Defence in depth. syncBridge validates the device token before calling this
  // function, so in production this branch is unreachable — which is the point:
  // a future caller that reaches here without an identity is refused, not served.
  if (!deps.authenticatedDeviceId) {
    json(res, 401, { error: 'Unauthorized' });
    return true;
  }

  try {
    switch (urlPath) {
      // ── Assembled companion context (8.3 + 8.4 + 8.5 together) ────────
      case '/sync/companion/context': {
        json(res, 200, deps.companion.buildCompanionContext());
        return true;
      }

      case '/sync/companion/personality': {
        json(res, 200, deps.companion.getPersonality());
        return true;
      }

      // ── Emotional context (8.4) ──────────────────────────────────────
      case '/sync/companion/emotion': {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (!body) {
            json(res, 400, { error: 'Bad request' });
            return true;
          }
          json(res, 200, {
            emotion: deps.companion.observeEmotion({
              mood: typeof body.mood === 'string' ? body.mood : undefined,
              valence: typeof body.valence === 'number' ? body.valence : undefined,
              arousal: typeof body.arousal === 'number' ? body.arousal : undefined,
              intensity: typeof body.intensity === 'number' ? body.intensity : undefined,
              confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
              note: typeof body.note === 'string' ? body.note : undefined,
            }),
          });
          return true;
        }
        json(res, 200, {
          current: deps.companion.getEmotion(),
          history: deps.companion.emotionalHistory(boundedInt(url.searchParams.get('history'), 10, 1, 50)),
        });
        return true;
      }

      // ── Memory graph (8.2) ────────────────────────────────────────────
      case '/sync/companion/graph':
      case '/sync/companion/memory-graph': {
        const graph = buildMemoryGraph(deps.db);
        const limit = boundedInt(url.searchParams.get('limit'), 400, 1, 1500);
        const kept = new Set(graph.nodes.slice(0, limit).map((n) => n.id));
        json(res, 200, {
          nodes: graph.nodes.slice(0, limit),
          // An edge to a node we did not send is undrawable on the companion.
          edges: graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
          truncated: graph.nodes.length > limit,
          totalNodes: graph.nodes.length,
          totalEdges: graph.edges.length,
        });
        return true;
      }

      // ── Companion voice (8.5) ─────────────────────────────────────────
      case '/sync/companion/voice': {
        const voice = deps.companion.getVoiceProfile();
        json(res, 200, {
          ...voice,
          // The effective TTS parameters, so the companion speaks with the
          // configured voice instead of guessing from `style` alone.
          tts: { engine: voice.engine ?? undefined, voiceId: voice.voiceId ?? undefined, rate: voice.rate, pitch: voice.pitch },
        });
        return true;
      }

      // ── Cross-device memory search (8.8) ──────────────────────────────
      case '/sync/companion/search': {
        const query = (url.searchParams.get('q') ?? '').trim();
        const limit = boundedInt(url.searchParams.get('limit'), 10, 1, 50);
        if (!query) {
          json(res, 400, { error: 'q is required' });
          return true;
        }
        // `getMemoryRecallService` throws when memory handlers were never
        // registered (a partial boot). That is "not available", not a crash.
        let recall;
        try {
          recall = getMemoryRecallService();
        } catch {
          json(res, 503, { error: 'Memory recall is not available' });
          return true;
        }
        const result = await recall.recall(query, limit);

        // The peer leg. This is what makes the route cross-device rather than
        // a local search wearing a cross-device label: every other connected
        // device is actually asked, and each answer — or failure to answer —
        // is reported.
        const bridge = deps.peerSearch;
        const peers = bridge?.connectedDevices(deps.authenticatedDeviceId) ?? [];
        const outcomes: PeerSearchOutcome[] = bridge
          ? await Promise.all(peers.map((id) => bridge.search(id, query, limit)))
          : [];
        const remoteMemories = outcomes.flatMap((o) =>
          o.hits.map((hit) => ({
            ...hit,
            // The device that holds this memory. Without it a hit from a phone
            // is indistinguishable from one on the desktop.
            deviceId: o.deviceId,
            label: `${hit.label} (on ${o.deviceId})`,
          })),
        );
        const unreachable = outcomes.filter((o) => o.status !== 'answered');

        json(res, 200, {
          query,
          ...result,
          crossDevice: {
            peersAsked: peers.length,
            peersAnswered: outcomes.filter((o) => o.status === 'answered').length,
            peersUnreachable: unreachable.map((o) => o.deviceId),
            outcomes: outcomes.map((o) => ({ deviceId: o.deviceId, status: o.status, hits: o.hits.length, note: o.note })),
            memories: remoteMemories,
          },
          // Never let "nobody was there" read as "nothing matched". If a peer
          // could not be searched, the response says so in words.
          note: [
            result.note,
            ...(peers.length === 0
              ? ['No other device is connected, so this searched this device only.']
              : unreachable.length
                ? unreachable.map((o) => o.note).filter((n): n is string => Boolean(n))
                : []),
          ]
            .filter(Boolean)
            .join(' ') || undefined,
        });
        return true;
      }

      // ── A paired device answering a cross-device search (8.8) ──────────
      case '/sync/companion/search-result': {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST required' });
          return true;
        }
        const body = await readJsonBody(req);
        if (!body) {
          json(res, 400, { error: 'Bad request' });
          return true;
        }
        const outcome = deps.peerSearch?.deliver(body, deps.authenticatedDeviceId);
        if (!outcome) {
          json(res, 503, { error: 'Peer search is not available' });
          return true;
        }
        // A reply that matched nothing pending is reported as such rather than
        // accepted, so a stale or forged answer cannot look successful.
        json(res, outcome.accepted ? 202 : 404, outcome.accepted ? { accepted: true } : { error: outcome.reason });
        return true;
      }

      // ── Daily / weekly rollup (8.7) ───────────────────────────────────
      case '/sync/companion/summaries': {
        const limit = boundedInt(url.searchParams.get('limit'), 5, 1, 30);
        const type = url.searchParams.get('type');
        let sql = `SELECT id, summary_type, period_label, summary, created_at FROM memory_summaries WHERE 1=1`;
        const params: unknown[] = [];
        if (type === 'daily' || type === 'weekly' || type === 'monthly') {
          sql += ` AND summary_type = ?`;
          params.push(`${type}_rollup`);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const rows = deps.db.prepare(sql).all(...params) as Record<string, unknown>[];
        json(res, 200, {
          summaries: rows.map((r) => ({
            id: String(r.id),
            type: String(r.summary_type),
            period: String(r.period_label ?? ''),
            summary: String(r.summary),
            createdAt: String(r.created_at),
          })),
        });
        return true;
      }

      default:
        json(res, 404, { error: 'Unknown companion route' });
        return true;
    }
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    return true;
  }
}
