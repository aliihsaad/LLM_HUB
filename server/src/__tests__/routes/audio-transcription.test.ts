import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function requestJson(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: payload, headers: res.headers };
}

async function requestMultipart(app: Express, path: string, form: FormData) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    body: form as any,
  });

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  let body: any = raw;
  if (contentType.includes('application/json')) {
    body = JSON.parse(raw);
  }

  server.close();
  return { status: res.status, body, headers: res.headers, raw };
}

function audioUploadForm(extra?: Record<string, string>) {
  const form = new FormData();
  form.set('model', 'auto');
  form.set('file', new Blob([Buffer.from('RIFFfake-wave')], { type: 'audio/wav' }), 'sample.wav');
  for (const [key, value] of Object.entries(extra ?? {})) {
    form.append(key, value);
  }
  return form;
}

describe('Audio transcription proxy routes', () => {
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

  it('routes multipart transcription requests to an audio-capable provider', async () => {
    await requestJson(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'groq_audio_test_key',
      label: 'transcription',
    });

    const origFetch = global.fetch;
    let providerBody: FormData | null = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/audio/transcriptions')) {
        providerBody = (init as any).body as FormData;
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ text: 'hello from audio' }),
          text: () => Promise.resolve(JSON.stringify({ text: 'hello from audio' })),
        } as any;
      }
      return origFetch(url, init);
    });

    const form = audioUploadForm({
      response_format: 'json',
      language: 'en',
      'timestamp_granularities[]': 'word',
    });

    const { status, body, headers } = await requestMultipart(app, '/v1/audio/transcriptions', form);

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('groq/whisper-large-v3-turbo');
    expect(body.text).toBe('hello from audio');
    expect(providerBody?.get('model')).toBe('whisper-large-v3-turbo');
    expect(providerBody?.get('language')).toBe('en');
    expect(providerBody?.get('timestamp_granularities[]')).toBe('word');
    const forwardedFile = providerBody?.get('file') as any;
    expect(forwardedFile?.name).toBe('sample.wav');
    expect(await forwardedFile.text()).toBe('RIFFfake-wave');
  });

  it('routes multipart translation requests to an audio-capable provider', async () => {
    await requestJson(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'groq_translation_test_key',
      label: 'translation',
    });

    const origFetch = global.fetch;
    let providerUrl = '';

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/audio/translations')) {
        providerUrl = urlStr;
        const body = (init as any).body as FormData;
        expect(body.get('model')).toBe('whisper-large-v3');
        expect(body.get('prompt')).toBe('technical meeting');
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ text: 'translated meeting notes' }),
          text: () => Promise.resolve(JSON.stringify({ text: 'translated meeting notes' })),
        } as any;
      }
      return origFetch(url, init);
    });

    const form = audioUploadForm({
      model: 'whisper-large-v3',
      response_format: 'json',
      prompt: 'technical meeting',
    });

    const { status, body, headers } = await requestMultipart(app, '/v1/audio/translations', form);

    expect(status).toBe(200);
    expect(providerUrl).toContain('/audio/translations');
    expect(headers.get('X-Routed-Via')).toContain('groq/whisper-large-v3');
    expect(body.text).toBe('translated meeting notes');
  });

  it('rejects an explicit non-audio model for transcription', async () => {
    const form = audioUploadForm({ model: 'mistral-large-latest' });

    const { status, body } = await requestMultipart(app, '/v1/audio/transcriptions', form);

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('does not support transcription');
  });
});
