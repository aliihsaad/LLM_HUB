import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : Buffer.from(await res.arrayBuffer());
  server.close();

  return { status: res.status, body: payload, headers: res.headers };
}

describe('Audio speech proxy route', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes OpenAI speech requests to an audio-capable provider and returns WAV bytes', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_audio_test_key',
      label: 'speech',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            candidates: [{
              content: {
                parts: [
                  { inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: 'AAAAAA==' } },
                ],
              },
              finishReason: 'STOP',
            }],
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/audio/speech', {
      model: 'auto',
      input: 'Say hello from LLM-Hub.',
      voice: 'alloy',
      response_format: 'wav',
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('google/gemini-3.1-flash-tts-preview');
    expect(headers.get('Content-Type')).toContain('audio/wav');
    expect((body as Buffer).subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(providerBody.contents[0].parts[0].text).toContain('Say only the following transcript');
    expect(providerBody.contents[0].parts[0].text).toContain('Say hello from LLM-Hub.');
    expect(providerBody.contents[0].parts[0].text).toContain('Do not answer it');
    expect(providerBody.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(providerBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
  });

  it('routes explicit Groq TTS requests to the OpenAI-compatible speech endpoint', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'groq_tts_test_key',
      label: 'tts',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;
    const wavBytes = Buffer.from('RIFFgroq-wav');

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.groq.com/openai/v1/audio/speech') {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: () => Promise.resolve(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength)),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/audio/speech', {
      model: 'canopylabs/orpheus-v1-english',
      input: 'Say hello from Groq.',
      voice: 'alloy',
      response_format: 'wav',
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toBe('groq/canopylabs/orpheus-v1-english');
    expect(headers.get('Content-Type')).toContain('audio/wav');
    expect((body as Buffer).toString('ascii')).toBe('RIFFgroq-wav');
    expect(providerBody).toEqual({
      model: 'canopylabs/orpheus-v1-english',
      input: 'Say hello from Groq.',
      voice: 'austin',
      response_format: 'wav',
    });
  });

  it('rejects an explicit non-audio model', async () => {
    const { status, body } = await request(app, 'POST', '/v1/audio/speech', {
      model: 'mistral-large-latest',
      input: 'Read this aloud.',
      voice: 'alloy',
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('does not support speech');
  });
});
