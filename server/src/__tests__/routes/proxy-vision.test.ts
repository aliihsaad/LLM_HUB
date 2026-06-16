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

describe('Vision chat proxy route', () => {
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

  it('accepts OpenAI image content arrays and routes them to a vision-capable provider', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_vision_test_key',
      label: 'vision',
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
              content: { parts: [{ text: 'The image contains a tiny red dot.' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: {
              promptTokenCount: 260,
              candidatesTokenCount: 8,
              totalTokenCount: 268,
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgo=',
            },
          },
        ],
      }],
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('google/');
    expect(providerBody.contents[0].parts).toEqual([
      { text: 'What is in this image?' },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    expect(body.choices[0].message.content).toContain('red dot');
  });

  it('routes explicit OpenRouter free vision models without converting image content arrays', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'openrouter',
      key: 'or_vision_test_key',
      label: 'openrouter vision',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    }];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://openrouter.ai/api/v1/chat/completions') {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'or-vision-test',
            object: 'chat.completion',
            created: 1,
            model: 'nex-agi/nex-n2-pro:free',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'The image was accepted by OpenRouter.' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'nex-agi/nex-n2-pro:free',
      messages,
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toBe('openrouter/nex-agi/nex-n2-pro:free');
    expect(providerBody.model).toBe('nex-agi/nex-n2-pro:free');
    expect(providerBody.messages).toEqual(messages);
    expect(body.choices[0].message.content).toContain('OpenRouter');
  });

  it('accepts local-image sized data URLs larger than the old 1mb JSON limit', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_large_vision_test_key',
      label: 'large-vision',
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
              content: { parts: [{ text: 'The large local image was accepted.' }] },
              finishReason: 'STOP',
            }],
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const largeBase64 = 'A'.repeat(1_200_000);
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this local image?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${largeBase64}` } },
        ],
      }],
    });

    expect(status).toBe(200);
    expect(providerBody.contents[0].parts[1].inlineData.data).toHaveLength(largeBase64.length);
    expect(body.choices[0].message.content).toContain('large local image');
  });
  it('accepts remote HTTPS image URLs and routes them to a vision-capable provider', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_remote_vision_test_key',
      label: 'remote-vision',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://cdn.example.test/chart.png') {
        const bytes = Buffer.from('remote-chart');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'image/png', 'content-length': '12' }),
          arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        } as any;
      }

      if (urlStr.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            candidates: [{
              content: { parts: [{ text: 'The remote image contains a chart.' }] },
              finishReason: 'STOP',
            }],
            usageMetadata: {
              promptTokenCount: 260,
              candidatesTokenCount: 8,
              totalTokenCount: 268,
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this remote image?' },
          { type: 'image_url', image_url: { url: 'https://cdn.example.test/chart.png' } },
        ],
      }],
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('google/');
    expect(providerBody.contents[0].parts).toEqual([
      { text: 'What is in this remote image?' },
      { inlineData: { mimeType: 'image/png', data: Buffer.from('remote-chart').toString('base64') } },
    ]);
    expect(body.choices[0].message.content).toContain('chart');
  });

  it('rejects an explicit text-only model for image input', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'mistral-large-latest',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      }],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('does not support vision');
  });
});
