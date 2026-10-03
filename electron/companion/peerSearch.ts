/**
 * Cross-device memory search — the peer leg of row 8.8.
 *
 * The desktop can already push to a paired device over its SSE stream, but
 * that direction cannot answer a question. So `/sync/companion/search` used to
 * return local results while presenting itself as a cross-device search: the
 * worst possible failure, because an empty peer result and a peer that was
 * never asked look identical to the caller.
 *
 * This module is the request/response layer that was missing. It correlates a
 * search sent down one device's SSE stream with the answer that device posts
 * back, and — the part that matters — it distinguishes four outcomes instead of
 * collapsing them into "no results":
 *
 *   answered  the device ran the search and replied
 *   absent    the device holds no live stream right now (never asked)
 *   timeout   the stream existed but nothing came back in time
 *   error     the device replied, but not with something usable
 *
 * A caller can therefore always tell "nothing matched" from "nobody was there".
 *
 * Security: this adds no route and no credential of its own. The transport is
 * the SSE stream a device only gets after pairing, and the reply leg is a
 * companion route mounted behind the existing token gate. A reply is matched
 * to a pending request by an opaque id, so one device cannot answer another's
 * request even if it guesses the shape.
 */

import { z } from 'zod';

/** How long to wait for a peer before reporting it as timed out. */
export const PEER_SEARCH_TIMEOUT_MS = 4000;

export type PeerSearchStatus = 'answered' | 'absent' | 'timeout' | 'error';

/** One memory hit as returned by a peer. Kept deliberately loose. */
export interface PeerMemoryHit {
  table: string;
  memoryType: string | null;
  label: string;
  detail: string;
  score: number;
}

export interface PeerSearchOutcome {
  deviceId: string;
  status: PeerSearchStatus;
  hits: PeerMemoryHit[];
  /** Human-readable explanation, always set for a non-answered outcome. */
  note?: string;
}

/** The request body a device sends to answer a search. Untrusted input. */
const ReplySchema = z.object({
  requestId: z.string().min(1).max(128),
  hits: z
    .array(
      z.object({
        table: z.string().max(64),
        memoryType: z.string().max(64).nullable().default(null),
        label: z.string().max(500),
        detail: z.string().max(4000),
        score: z.number().finite(),
      }),
    )
    .max(100)
    .default([]),
  error: z.string().max(300).optional(),
});

/**
 * The seam the host provides. `send` is fire-and-forget (the SSE stream
 * offers no delivery receipt); `isConnected` is what turns "no live stream"
 * into `absent` instead of making the caller sit through a timeout.
 */
export interface PeerSearchTransport {
  send(deviceId: string, event: { type: string; payload: unknown }): void;
  isConnected(deviceId: string): boolean;
}

interface Pending {
  deviceId: string;
  resolve(outcome: PeerSearchOutcome): void;
  timer: NodeJS.Timeout;
}

export class PeerSearchRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly transport: PeerSearchTransport,
    private readonly timeoutMs: number = PEER_SEARCH_TIMEOUT_MS,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * Ask one device to search its own memory.
   *
   * Never rejects: every failure mode resolves to a status the caller can
   * report, because the whole point is that an unreachable peer is visible
   * rather than indistinguishable from an empty result.
   */
  request(deviceId: string, query: string, limit: number): Promise<PeerSearchOutcome> {
    if (!this.transport.isConnected(deviceId)) {
      return Promise.resolve({
        deviceId,
        status: 'absent',
        hits: [],
        note: `${deviceId} is not connected — its memory was not searched.`,
      });
    }

    const requestId = this.newId();
    return new Promise<PeerSearchOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          deviceId,
          status: 'timeout',
          hits: [],
          note: `${deviceId} did not answer within ${this.timeoutMs}ms — its memory was not searched.`,
        });
      }, this.timeoutMs);
      // Do not hold the event loop open for a peer that never replies.
      timer.unref?.();

      this.pending.set(requestId, { deviceId, resolve, timer });

      try {
        this.transport.send(deviceId, {
          type: 'memory_search_request',
          payload: { requestId, query, limit },
        });
      } catch (e: unknown) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({
          deviceId,
          status: 'error',
          hits: [],
          note: `Could not reach ${deviceId}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });
  }

  /**
   * Accept a reply from a paired device. Returns whether it matched anything,
   * so the caller can answer 202 for a real reply and 404 for a stale or
   * forged one rather than pretending both were accepted.
   */
  deliver(body: unknown, fromDevice?: string): { accepted: boolean; reason?: string } {
    const parsed = ReplySchema.safeParse(body);
    if (!parsed.success) return { accepted: false, reason: 'malformed reply' };

    const pending = this.pending.get(parsed.data.requestId);
    if (!pending) return { accepted: false, reason: 'no such pending request' };
    // A device may only answer the request that was sent to it.
    if (fromDevice && fromDevice !== pending.deviceId) {
      return { accepted: false, reason: 'reply does not belong to this device' };
    }

    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.requestId);

    if (parsed.data.error) {
      pending.resolve({
        deviceId: pending.deviceId,
        status: 'error',
        hits: [],
        note: `${pending.deviceId} reported an error: ${parsed.data.error}`,
      });
      return { accepted: true };
    }
    pending.resolve({ deviceId: pending.deviceId, status: 'answered', hits: parsed.data.hits });
    return { accepted: true };
  }

  /** Outstanding requests. Exposed so a shutdown can report, not to poll. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Fail every outstanding request. Called when the sync server stops. */
  dispose(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve({
        deviceId: pending.deviceId,
        status: 'absent',
        hits: [],
        note: `${pending.deviceId} connection closed before it answered.`,
      });
    }
  }
}

/** The capability `routes.ts` depends on. Implemented over syncBridge's SSE table. */
export interface PeerSearchBridge {
  /** Devices holding a live stream, excluding the one that asked. */
  connectedDevices(exceptDeviceId?: string): string[];
  /** Ask one device to search its own memory. Never rejects. */
  search(deviceId: string, query: string, limit: number): Promise<PeerSearchOutcome>;
  /** Accept a reply from a paired device. */
  deliver(body: unknown, fromDevice?: string): { accepted: boolean; reason?: string };
}