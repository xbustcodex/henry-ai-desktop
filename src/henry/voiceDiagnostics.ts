/**
 * Voice diagnostics.
 *
 * Paid 1.7.0 records what actually happened on every capture (voice-diagnostics.ts):
 * recording id, duration, chunk count, why recording stopped, and whether the
 * mic track was muted or ready — then, when something fails, pulls the HTTP
 * status and both request ids out of the error so a failure can be traced to a
 * specific request. Ours threw bare `Error.message` strings, which meant the
 * single most useful field in a voice bug report simply did not exist.
 *
 * Everything here is local. Nothing is transmitted, and secrets are redacted
 * before anything is retained.
 */

const MAX_RECORDS = 50;

/** Cap on any single retained string, so a runaway error cannot fill memory. */
const MAX_TEXT = 2000;

/** Keys and value shapes that must never be written down. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})/g,
  /\b(sk-ant-[A-Za-z0-9_-]{8,})/g,
  /\b(gsk_[A-Za-z0-9]{8,})/g,
  /\b(AIza[A-Za-z0-9_-]{20,})/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g,
  /(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)["']?[^"'\s,}]{6,}/gi,
];

export function redact(text: string): string {
  let out = text.slice(0, MAX_TEXT);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (m.includes(':') && m.includes('=') ? `${m.split(/[:=]/)[0]}=<redacted>` : '<redacted>'));
  }
  return out;
}

export interface VoiceCaptureRecord {
  id: string;
  at: number;
  /** How the capture ended. */
  stopReason: 'user' | 'silence' | 'timeout' | 'error' | 'unavailable';
  recordingMs: number;
  /** Chunks handed to the transcriber. */
  chunkCount: number;
  /** True when the mic track existed but was muted. */
  trackMuted: boolean | null;
  /** 'live' | 'ended' | 'no-track' — was the track actually usable. */
  trackReadyState: string | null;
  queueDepth?: number;
  ok?: boolean;
  error?: string;
  httpStatus?: number;
  serverRequestId?: string;
  providerRequestId?: string;
}

let records: VoiceCaptureRecord[] = [];
let seq = 0;

export function recordCapture(rec: Omit<VoiceCaptureRecord, 'id' | 'at'>): VoiceCaptureRecord {
  const entry: VoiceCaptureRecord = {
    ...rec,
    id: `vc_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    at: Date.now(),
    error: rec.error ? redact(rec.error) : undefined,
    detail: undefined,
  } as VoiceCaptureRecord;
  records.push(entry);
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  return entry;
}

export function listCaptures(limit = 20): VoiceCaptureRecord[] {
  return records.slice(-Math.min(Math.max(1, limit), MAX_RECORDS)).reverse();
}

export function clearCaptures(): void {
  records = [];
}

/**
 * Pull the traceable bits out of an error without keeping the whole thing.
 *
 * Provider errors routinely carry an HTTP status and one or two request ids;
 * those are what make a voice failure traceable, and they were being thrown
 * away with the rest of the message.
 */
export function extractTraceIds(error: unknown): {
  httpStatus?: number;
  serverRequestId?: string;
  providerRequestId?: string;
  summary?: string;
} {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const httpStatus = /\b(?:status|statusCode|http)[\s:=]{0,4}(\d{3})\b/i.exec(text)?.[1];
  const serverRequestId =
    /\b(?:x-request-id|request-id)[\s:=]{0,4}([A-Za-z0-9_-]{6,})/i.exec(text)?.[1] ??
    /\breq-[A-Za-z0-9-]{6,}\b/.exec(text)?.[0];
  const providerRequestId =
    /\bprovider[-_]request[-_]id\b[\s:=]{0,4}([A-Za-z0-9_-]{6,})/i.exec(text)?.[1] ??
    /\bprov-[A-Za-z0-9-]{6,}\b/.exec(text)?.[0];
  return {
    httpStatus: httpStatus ? Number(httpStatus) : undefined,
    serverRequestId,
    providerRequestId,
    summary: text ? redact(text) : undefined,
  };
}

/** One-line health read for the Settings panel. */
export function voiceSummary(): {
  captures: number;
  failures: number;
  lastFailure?: VoiceCaptureRecord;
  commonStopReason?: string;
} {
  const failures = records.filter((r) => !r.ok);
  const reasons = new Map<string, number>();
  for (const r of records) reasons.set(r.stopReason, (reasons.get(r.stopReason) ?? 0) + 1);
  const commonStopReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    captures: records.length,
    failures: failures.length,
    lastFailure: failures[failures.length - 1],
    commonStopReason,
  };
}