/**
 * Voice diagnostics must never become the thing that leaks a key, so the
 * redaction is tested as carefully as the extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  redact,
  extractTraceIds,
  recordCapture,
  listCaptures,
  clearCaptures,
  voiceSummary,
} from './voiceDiagnostics';

describe('redaction', () => {
  it('removes OpenAI-style keys', () => {
    expect(redact('failed with sk-abcdefghijklmnop')).not.toContain('sk-abcdefghijklmnop');
  });
  it('removes Anthropic keys', () => {
    expect(redact('key sk-ant-abcdefghijklmnop rejected')).not.toContain('sk-ant-abcdefghijklmnop');
  });
  it('removes Groq keys', () => {
    expect(redact('gsk_abcdefghijklmnop')).not.toContain('gsk_abcdefghijklmnop');
  });
  it('removes Google keys', () => {
    expect(redact('AIzaSyABCDEFGHIJKLMNOPQRST')).not.toContain('AIzaSyABCDEFGHIJKLMNOPQRST');
  });
  it('removes JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl';
    expect(redact(`token ${jwt}`)).not.toContain(jwt);
  });
  it('removes key/value pairs however they are labelled', () => {
    for (const form of ['api_key: hunter2hunter2', 'apiKey=hunter2hunter2', 'authorization: Bearer abcdefghijkl']) {
      expect(redact(form)).not.toContain('hunter2hunter2');
    }
  });
  it('caps absurdly long strings', () => {
    expect(redact('x'.repeat(10_000)).length).toBeLessThanOrEqual(2000);
  });
  it('leaves ordinary text alone', () => {
    expect(redact('whisper-cli not installed')).toBe('whisper-cli not installed');
  });
});

describe('trace id extraction', () => {
  it('pulls an HTTP status out of a provider error', () => {
    expect(extractTraceIds(new Error('upstream returned status 502')).httpStatus).toBe(502);
  });
  it('pulls a server request id', () => {
    const e = extractTraceIds(new Error('failed (x-request-id: req-abc123def)'));
    expect(e.serverRequestId).toBeTruthy();
  });
  it('pulls a provider request id', () => {
    const e = extractTraceIds(new Error('gateway said provider_request_id: prov-xyz987'));
    expect(e.providerRequestId).toContain('prov-xyz987');
  });
  it('returns a redacted summary', () => {
    expect(extractTraceIds(new Error('bad key sk-abcdefghijklmnop')).summary).not.toContain('sk-abcdefghijklmnop');
  });
  it('does not invent ids that were never there', () => {
    const e = extractTraceIds(new Error('something went wrong'));
    expect(e.httpStatus).toBeUndefined();
    expect(e.serverRequestId).toBeUndefined();
  });
});

describe('capture records', () => {
  it('keeps a bounded history newest-first', () => {
    clearCaptures();
    for (let i = 0; i < 5; i++) {
      recordCapture({ stopReason: 'user', recordingMs: i * 100, chunkCount: 1, trackMuted: false, trackReadyState: 'live', ok: true });
    }
    const list = listCaptures();
    expect(list.length).toBe(5);
    expect(list[0].recordingMs).toBeGreaterThan(list[4].recordingMs);
  });

  it('redacts the stored error, not just the summary', () => {
    clearCaptures();
    recordCapture({
      stopReason: 'error', recordingMs: 10, chunkCount: 1,
      trackMuted: null, trackReadyState: 'ended',
      ok: false, error: 'auth failed for sk-abcdefghijklmnop',
    });
    expect(JSON.stringify(listCaptures())).not.toContain('sk-abcdefghijklmnop');
  });

  it('summarises failures and the usual stop reason', () => {
    clearCaptures();
    recordCapture({ stopReason: 'silence', recordingMs: 1, chunkCount: 1, trackMuted: false, trackReadyState: 'live', ok: true });
    recordCapture({ stopReason: 'silence', recordingMs: 1, chunkCount: 1, trackMuted: false, trackReadyState: 'live', ok: true });
    recordCapture({ stopReason: 'error', recordingMs: 1, chunkCount: 0, trackMuted: null, trackReadyState: 'ended', ok: false, error: 'boom' });
    const s = voiceSummary();
    expect(s.captures).toBe(3);
    expect(s.failures).toBe(1);
    expect(s.commonStopReason).toBe('silence');
    expect(s.lastFailure?.error).toBe('boom');
  });

  it('clears', () => {
    recordCapture({ stopReason: 'user', recordingMs: 1, chunkCount: 1, trackMuted: false, trackReadyState: 'live', ok: true });
    clearCaptures();
    expect(listCaptures()).toHaveLength(0);
  });
});