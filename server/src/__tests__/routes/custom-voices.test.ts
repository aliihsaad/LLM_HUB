import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { selectSweepCandidateIds } from '../../services/model-scout.js';
import { setDashboardPin, disableDashboardPin } from '../../services/admin-auth.js';

const MODEL = 'gemini-3.8-flash-tts';
const wav = Buffer.alloc(48); wav.write('RIFF', 0); wav.write('WAVE', 8);
const voiceId = 'voice_test_custom';
describe('Gemini 3.8 speech and custom voices', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let base: string;
  let owner: number;
  const originalFetch = global.fetch;
  const upstream = vi.fn();
  async function call(path: string, body?: any) {
    return originalFetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function addKey(label: string) {
    const key = encrypt(label);
    return Number(getDb().prepare(`INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,enabled,status)
      VALUES ('google',?,?,?,?,1,'valid')`).run(label, key.encrypted, key.iv, key.authTag).lastInsertRowid);
  }
  function register() {
    getDb().prepare('INSERT INTO speech_voices (id,display_name,key_id,voice_type) VALUES (?,?,?,?)')
      .run(voiceId, 'Test voice', owner, 'prompted');
  }
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    getDb().exec('DELETE FROM speech_voices; DELETE FROM api_keys; DELETE FROM requests;');
    addKey('unrelated-project'); owner = addKey('voice-owner-project');
    upstream.mockReset();
    vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
      if (String(url).startsWith('https://generativelanguage.googleapis.com/')) return upstream(url, init);
      return originalFetch(url, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  it('protects custom voice creation and previews with dashboard authentication', async () => {
    setDashboardPin('test-only-1234');
    try {
      expect((await call('/api/voices')).status).toBe(401);
      expect((await call('/api/voices/design', { key_id: owner, display_name: 'No access', prompt: 'A calm warm voice.' })).status).toBe(401);
      expect((await call(`/api/voices/${voiceId}/preview`)).status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    } finally { disableDashboardPin(); }
  });
  it('exposes speech only and excludes 3.8 TTS from chat probes and fallback', async () => {
    const row = getDb().prepare('SELECT * FROM models WHERE model_id=?').get(MODEL) as any;
    const caps = getDb().prepare('SELECT capability FROM model_capabilities WHERE model_db_id=? AND enabled=1').all(row.id) as any[];
    expect(caps.map(c => c.capability).sort()).toEqual(['audio', 'speech']);
    expect(selectSweepCandidateIds(getDb())).not.toContain(row.id);
    expect(getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id=?').get(row.id)).toEqual({ enabled: 0 });
    const models = await (await call('/v1/models')).json() as any;
    expect(models.data.find((m: any) => m.id === MODEL).available).toBe(true);
  });
  it('creates a designed voice with the selected key and stores its binding', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ id: voiceId, type: 'prompted', sample_audio: { data: wav.toString('base64'), mime_type: 'audio/wav' } })));
    const res = await call('/api/voices/design', { key_id: owner, display_name: 'Calm voice', prompt: 'A calm, warm British narrator.' });
    expect(res.status).toBe(201);
    expect((await res.json() as any).voice.key_id).toBe(owner);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toMatch(/\/voices$/);
    expect(init.headers['x-goog-api-key']).toBe('voice-owner-project');
    expect(JSON.parse(init.body).voice.prompted.input).toBe('A calm, warm British narrator.');
  });
  it('validates an imported voice before saving and never rotates its owner key', async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ id: voiceId, display_name: 'Saved voice', type: 'prompted' })));
    expect((await call('/api/voices/import', { key_id: owner, voice_id: voiceId })).status).toBe(201);
    upstream.mockImplementation(async () => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }] }] })));
    for (const text of ['First sentence.', 'Second sentence.']) {
      const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: text, instructions: 'Warm and friendly' });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(wav);
    }
    for (const [, init] of upstream.mock.calls) expect(init.headers['x-goog-api-key']).toBe('voice-owner-project');
    const body = JSON.parse(upstream.mock.calls[1][1].body);
    expect(body.input[0].content[0].text).toBe('First sentence.');
    expect(body.input[0].content[0].annotations[0].style).toBe('Warm and friendly');
    expect(body.generation_config.speech_config[0].voice).toBe(voiceId);
    expect(body.store).toBe(false);
  });
  it('rejects unknown custom voices and other model families before calling Google', async () => {
    const unknown = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello' });
    expect(unknown.status).toBe(400);
    register();
    expect((await call('/v1/audio/speech', { model: 'gemini-3.1-flash-tts-preview', voice: voiceId, input: 'Hello' })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('does not use another project after a custom-voice error', async () => {
    register(); upstream.mockResolvedValue(new Response('{}', { status: 429 }));
    const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello' });
    expect(res.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('does not use another key when the owner was disabled', async () => {
    register(); getDb().prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(owner);
    const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello' });
    expect(res.status).not.toBe(200); expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects mismatched audio formats instead of corrupting WAV output', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ output_audio: { mime_type: 'audio/l16', data: 'AAAAAA==' } })));
    expect((await call('/v1/audio/speech', { model: MODEL, voice: 'Kore', input: 'Hello' })).status).toBe(502);
  });
  it('streams the first audio before Google finishes and preserves split SSE frames', async () => {
    register();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    upstream.mockImplementation(async () => new Response(new ReadableStream({
      async start(controller) {
        const frame = 'data: ' + JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: 'AAAAAA==' } }) + '\r\n\r\n';
        controller.enqueue(new TextEncoder().encode(frame.slice(0, 15)));
        controller.enqueue(new TextEncoder().encode(frame.slice(15)));
        await gate;
        controller.enqueue(new TextEncoder().encode(frame + 'event: interaction.completed\r\ndata: {"interaction":{"status":"completed"}}\r\n\r\n')); controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello', stream: true, response_format: 'pcm' });
    expect(res.status).toBe(200); expect(res.headers.get('content-length')).toBeNull();
    const reader = res.body!.getReader();
    const first = await reader.read(); expect(first.value?.length).toBe(4);
    finish();
    const second = await reader.read(); expect(second.value?.length).toBe(4);
    expect((await reader.read()).done).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('aborts upstream speech when the client stops playback', async () => {
    register();
    let signal: AbortSignal;
    upstream.mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: 'AAAAAA==' } }) + '\n\n'));
        signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      } }));
    });
    const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello', stream: true, response_format: 'pcm' });
    const reader = res.body!.getReader();
    await reader.read(); await reader.cancel();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('does not retry after a stream has emitted audio', async () => {
    register();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    upstream.mockImplementation(async () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: 'AAAAAA==' } }) + '\n\n'));
      await gate;
      controller.enqueue(new TextEncoder().encode('data: {"event_type":"error"}\n\n')); controller.close();
    } })));
    const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello', stream: true, response_format: 'pcm' });
    const reader = res.body!.getReader(); await reader.read(); finish();
    await expect(reader.read()).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('reports a truncated stream as an error even after receiving valid audio', async () => {
    register();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    upstream.mockImplementation(async () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data: 'AAAAAA==' } }) + '\n\n'));
      await gate; controller.close();
    } })));
    const res = await call('/v1/audio/speech', { model: MODEL, voice: voiceId, input: 'Hello', stream: true, response_format: 'pcm' });
    const reader = res.body!.getReader(); await reader.read(); finish();
    await expect(reader.read()).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
