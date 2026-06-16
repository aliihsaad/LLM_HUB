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

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Video chat proxy route', () => {
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

  it('auto-routes video_url requests to an OpenRouter video-capable model only', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'openrouter',
      key: 'or_video_auto_key',
      label: 'openrouter video',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Summarize this video.' },
        { type: 'video_url', video_url: { url: 'https://cdn.example.test/demo.mp4' } },
      ],
    }];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://openrouter.ai/api/v1/chat/completions') {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'or-video-auto-test',
            object: 'chat.completion',
            created: 1,
            model: 'minimax/minimax-m3',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'The video was accepted by OpenRouter.' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages,
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toBe('openrouter/minimax/minimax-m3');
    expect(providerBody.model).toBe('minimax/minimax-m3');
    expect(providerBody.messages).toEqual(messages);
    expect(body.choices[0].message.content).toContain('OpenRouter');
  });

  it('routes explicit OpenRouter video models without converting video_url content parts', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'openrouter',
      key: 'or_video_explicit_key',
      label: 'openrouter video',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this video.' },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAAIGZ0eXBtcDQy' } },
      ],
    }];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://openrouter.ai/api/v1/chat/completions') {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'or-video-explicit-test',
            object: 'chat.completion',
            created: 1,
            model: 'minimax/minimax-m3',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'The explicit video model was used.' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'minimax/minimax-m3',
      messages,
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toBe('openrouter/minimax/minimax-m3');
    expect(providerBody.messages).toEqual(messages);
    expect(body.choices[0].message.content).toContain('explicit video model');
  });

  it('routes explicit Google video models and converts video data URLs for Gemini', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_video_proxy_key',
      label: 'google video',
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
              content: { parts: [{ text: 'The Gemini video request was accepted.' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 8, totalTokenCount: 268 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this clip.' },
          { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAAIGZ0eXBtcDQy' } },
        ],
      }],
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toBe('google/gemini-2.5-flash');
    expect(providerBody.contents[0].parts).toEqual([
      { text: 'Summarize this clip.' },
      { inlineData: { mimeType: 'video/mp4', data: 'AAAAIGZ0eXBtcDQy' } },
    ]);
    expect(body.choices[0].message.content).toContain('Gemini video');
  });

  it('rejects an explicit non-video model for video_url input', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'mistral-large-latest',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this video?' },
          { type: 'video_url', video_url: { url: 'https://cdn.example.test/demo.mp4' } },
        ],
      }],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('does not support video');
  });
});
