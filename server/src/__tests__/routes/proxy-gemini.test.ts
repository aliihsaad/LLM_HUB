import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

const nativeFetch = global.fetch;

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await nativeFetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try {
    json = JSON.parse(data);
  } catch {}

  return { status: res.status, body: json, raw: data, headers: res.headers };
}

describe('Gemini proxy compatibility route', () => {
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

  it('forwards generateContent requests to Google and returns Gemini response', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google-gemini-key',
      label: 'gemini',
    });

    const origFetch = global.fetch;
    let forwardedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')) {
        forwardedBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            candidates: [{
              content: { parts: [{ text: 'gemini worked' }] },
            }],
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 3,
              totalTokenCount: 15,
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/gemini/v1beta/models/gemini-2.5-flash:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { temperature: 0.5 },
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe('google/gemini-2.5-flash');
    expect(body.candidates?.[0]?.content?.parts?.[0]?.text).toBe('gemini worked');
    expect(forwardedBody.contents[0].parts[0].text).toBe('hello');
  });

  it('streams Gemini content as server-sent events', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google-gemini-stream-key',
      label: 'gemini-stream',
    });

    const streamResponse = `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\ndata: [DONE]\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(streamResponse);
        controller.enqueue(bytes);
        controller.close();
      },
    });

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      body: stream,
      json: () => Promise.resolve({}),
    } as any);

    const { status, raw, headers } = await request(app, 'POST', '/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent', {
      contents: [{ role: 'user', parts: [{ text: 'stream me' }] }],
    });

    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('text/event-stream');
    expect(raw).toContain('"Hello"');
    expect(raw).toContain('[DONE]');
  });

  it('rejects non-google model IDs for the Gemini endpoint', async () => {
    const { status, body } = await request(app, 'POST', '/gemini/v1beta/models/llama-3.3-70b-versatile:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'not supported' }] }],
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe('model_not_found');
    expect(body.error?.message).toContain('not available via Gemini compatibility');
  });
});
