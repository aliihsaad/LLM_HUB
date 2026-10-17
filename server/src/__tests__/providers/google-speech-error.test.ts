import { afterEach, describe, expect, it, vi } from 'vitest';
import { readGoogleSpeechError, speechErrorFromPayload } from '../../providers/google-speech-error.js';

afterEach(() => vi.restoreAllMocks());
describe('Google speech error diagnostics', () => {
  it('keeps authoritative Retry-After and only allowlisted quota facts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const error = await readGoogleSpeechError(Response.json({ error: {
      code: 'too_many_requests', message: 'limit: 10 requests per day on Free Tier. retry in 1s. KEY=private-token transcript private-words',
    } }, { status: 429, headers: { 'Retry-After': '80145' } }));
    expect(error.status).toBe(429);
    expect(error.quota).toEqual({ kind: 'daily_quota_exceeded', requestLimit: 10, period: 'day', retryAt: 1_800_080_145_000 });
    expect(error.message).toContain('10 requests per day');
    expect(error.message + JSON.stringify(error)).not.toContain('private-');
  });
  it('handles date headers, RPC retry hints, minute limits and malformed bodies', async () => {
    const now = Date.parse('2026-10-17T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const date = speechErrorFromPayload(429, { error: { message: 'limit: 2 requests per minute' } }, 'Sat, 17 Oct 2026 00:00:30 GMT');
    expect(date.quota).toMatchObject({ kind: 'rate_limit_exceeded', retryAt: now + 30000, period: 'minute', requestLimit: 2 });
    const rpc = speechErrorFromPayload(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' }] } });
    expect(rpc.quota?.retryAt).toBe(now + 13000);
    const html = await readGoogleSpeechError(new Response('<html>private-key</html>', { status: 503 }));
    expect(html.status).toBe(503); expect(html.quota).toBeUndefined(); expect(html.message).not.toContain('private-key');
  });
  it('does not interpret arbitrary non-quota errors as a rate limit', () => {
    const error = speechErrorFromPayload(403, { error: { message: 'private payload: 429 limit: 10 requests per day' } });
    expect(error.status).toBe(403); expect(error.quota).toBeUndefined();
  });
});
