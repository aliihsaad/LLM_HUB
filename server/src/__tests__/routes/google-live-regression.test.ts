import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';
import { createApp } from '../../app.js';
import { routeCapabilityRequest } from '../../services/router.js';
import { isOnCooldown, recordRequest } from '../../services/ratelimit.js';
import { GoogleProvider } from '../../providers/google.js';

const model = 'gemini-3.1-flash-live-preview';
function addKey(value: string) {
  const encrypted = encrypt(value);
  return Number(getDb().prepare("INSERT INTO api_keys(platform,encrypted_key,iv,auth_tag,status,enabled) VALUES('google',?,?,?,'healthy',1)").run(encrypted.encrypted, encrypted.iv, encrypted.authTag).lastInsertRowid);
}
async function requestSession(body: Record<string, unknown> = { model }, path = '/v1/realtime/sessions') {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const port = (server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } finally { server.close(); }
}
let nextKeyId = 10000;
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  await initDb(':memory:');
  // Rate counters are process-local; never reuse key IDs across isolated DB fixtures.
  nextKeyId += 100;
  getDb().prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('api_keys',?)").run(nextKeyId);
  // Existing catalog limit, deliberately explicit so custom limits remain enforced.
  getDb().prepare('UPDATE models SET rpm_limit=NULL,rpd_limit=20 WHERE model_id=?').run(model);
});
afterEach(() => vi.restoreAllMocks());

describe('Google Live routing failure regression', () => {
  it('retries another credential when Google rejects an invalid key with HTTP 400', async () => {
    addKey('bad'); addKey('good');
    const provider = getProvider('google')!;
    const spy = vi.spyOn(provider, 'createRealtimeSession')
      .mockRejectedValueOnce(new Error('Google API error 400: API key not valid. Please pass a valid API key.'))
      .mockResolvedValueOnce({ model, object: 'realtime.session' } as any);
    const result = await requestSession();
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).not.toBe(spy.mock.calls[1][0]);
  });

  it('does not globally cool down healthy keys because a 429 retry delay contains 401', async () => {
    const ids = [addKey('first'), addKey('second')];
    vi.spyOn(getProvider('google')!, 'createRealtimeSession').mockRejectedValue(
      new Error('Google API error 429: Resource exhausted; please retry in 0.401 seconds.'),
    );
    const result = await requestSession();
    expect(result.status).toBe(429);
    expect(result.body.error.code).toBe('rate_limit');
    for (const id of ids) expect(isOnCooldown('google', 'gemini-3.8-live', id)).toBe(false);
  });

  it('keeps the final local cap distinct from a previous authentication failure', async () => {
    addKey('invalid');
    const limited = addKey('limited');
    for (let i=0;i<20;i++) recordRequest('google', model, limited);
    vi.spyOn(getProvider('google')!, 'createRealtimeSession').mockRejectedValue(
      new Error('Google API error 400: API key not valid.'),
    );
    const result = await requestSession();
    expect(result.status).toBe(429);
    expect(result.body.error.code).toBe('local_routing_limited');
    expect(result.body.error.type).toBe('routing_error');
    expect(result.body.error.diagnostics.localRequestLimit).toBe(1);
    expect(result.body.error.previous_provider_failure.category).toBe('auth');
  });

  it('preserves the non-Live embeddings terminal authentication contract', async () => {
    addKey('invalid');
    const row = getDb().prepare('SELECT id FROM models WHERE model_id=?').get(model) as { id: number };
    getDb().prepare("INSERT INTO model_capabilities(model_db_id,capability,enabled,priority) VALUES(?,'embeddings',1,1)").run(row.id);
    const spy = vi.spyOn(getProvider('google')!, 'createEmbedding').mockRejectedValue(
      new Error('Google API error 401: Unauthorized'),
    );
    const result = await requestSession({ model, input: 'test' }, '/v1/embeddings');
    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe('provider_error');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('excludes an invalid Live key on subsequent requests and other models until cooldown expires', async () => {
    const invalid = addKey('invalid');
    const good = addKey('good');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const spy = vi.spyOn(getProvider('google')!, 'createRealtimeSession')
      .mockRejectedValueOnce(new Error('Google API error 400: API key not valid.'))
      .mockResolvedValue({ model, object: 'realtime.session' } as any);
    getDb().prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(good);
    expect((await requestSession()).status).toBe(503);
    getDb().prepare('UPDATE api_keys SET enabled=1 WHERE id=?').run(good);
    expect((await requestSession()).status).toBe(200);
    expect((await requestSession()).status).toBe(200);
    expect(spy.mock.calls.slice(1).every(call => call[0] === 'good')).toBe(true);
    expect(isOnCooldown('google', 'gemini-3.8-live', invalid)).toBe(true);
    expect(isOnCooldown('google', 'gemini-3.8-live', good)).toBe(false);
    vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    expect(isOnCooldown('google', 'gemini-3.8-live', invalid)).toBe(false);
  });

  it('can create more than twenty sessions after removing the inherited daily cap', async () => {
    addKey('working');
    getDb().prepare('UPDATE models SET rpd_limit=NULL WHERE model_id=?').run(model);
    const spy = vi.spyOn(getProvider('google')!, 'createRealtimeSession')
      .mockResolvedValue({ model, object: 'realtime.session' } as any);
    for (let i=0;i<21;i++) expect((await requestSession()).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(21);
  });

  it('identifies the local request cap instead of claiming Google quota exhaustion', () => {
    const id = addKey('limited');
    for (let i=0;i<20;i++) recordRequest('google', model, id);
    let error: any;
    try { routeCapabilityRequest('realtime_audio', 1, undefined, model); } catch (e) { error=e; }
    expect(error.status).toBe(429);
    expect(error.code).toBe('local_routing_limited');
    expect(error.diagnostics.localRequestLimit).toBe(1);
    expect(error.message).toContain('local');
    expect(error.message).not.toContain('Add more API keys');
  });

  it('reports missing eligible credentials as unavailable, not quota exhaustion', () => {
    let error: any;
    try { routeCapabilityRequest('realtime_audio', 1, undefined, model); } catch(e) { error=e; }
    expect(error.status).toBe(503);
    expect(error.code).toBe('no_eligible_route');
    expect(error.diagnostics.noEligibleKeys).toBe(1);
  });

  it('does not label a Google high-demand 503 as rate-limited', async () => {
    addKey('outage');
    vi.spyOn(getProvider('google')!, 'createRealtimeSession').mockRejectedValue(new Error('Google API error 503: high demand'));
    const result = await requestSession();
    expect(result.status).toBe(503);
    expect(result.body.error.type).toBe('provider_unavailable');
    expect(result.body.error.message).not.toContain('rate-limited');
  });
});

describe('Google credential health', () => {
  it('rejects API_KEY_INVALID 400 responses instead of marking them healthy', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({error:{message:'API key not valid. Please pass a valid API key.',details:[{reason:'API_KEY_INVALID'}]}}), {status:400}));
    expect(await new GoogleProvider().validateKey('bad')).toBe(false);
  });
  it('keeps transient Google failure distinct from invalid authentication', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({error:{message:'Unavailable'}}),{status:503}));
    await expect(new GoogleProvider().validateKey('healthy')).rejects.toThrow('503');
  });
});
