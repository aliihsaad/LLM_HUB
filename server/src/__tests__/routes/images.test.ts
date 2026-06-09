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

async function requestMultipart(app: Express, path: string, form: FormData) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    body: form as any,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function imageUploadForm(fields?: Record<string, string>) {
  const form = new FormData();
  form.set('image', new Blob([Buffer.from('fake-png')], { type: 'image/png' }), 'source.png');
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, value);
  }
  return form;
}

describe('Images proxy route', () => {
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

  it('routes OpenAI image generation requests to an image-capable provider', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_image_test_key',
      label: 'images',
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
                  { text: 'A compact prompt rewrite.' },
                  { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
                ],
              },
              finishReason: 'STOP',
            }],
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/images/generations', {
      prompt: 'A tiny red dot on a white background',
      response_format: 'b64_json',
      size: '1024x1024',
    });

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('google/gemini-3.1-flash-image-preview');
    expect(providerBody.contents).toEqual([{ parts: [{ text: 'A tiny red dot on a white background' }] }]);
    expect(providerBody.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(body.data[0]).toEqual({
      b64_json: 'iVBORw0KGgo=',
      revised_prompt: 'A compact prompt rewrite.',
    });
  });

  it('rejects an explicit non-image model', async () => {
    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'mistral-large-latest',
      prompt: 'A geometric icon',
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('does not support image generation');
  });

  it('routes image edit multipart requests to an image edit-capable provider', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_image_edit_key',
      label: 'image-edit',
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
                  { text: 'Edited prompt' },
                  { inlineData: { mimeType: 'image/png', data: 'edited_base64' } },
                ],
              },
              finishReason: 'STOP',
            }],
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const form = imageUploadForm({
      prompt: 'Make the background transparent',
      response_format: 'b64_json',
      size: '1024x1024',
    });

    const { status, body, headers } = await requestMultipart(app, '/v1/images/edits', form);

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('google/gemini-3.1-flash-image-preview');
    expect(providerBody.contents[0].parts[0]).toEqual({ text: 'Make the background transparent' });
    expect(providerBody.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') },
    });
    expect(providerBody.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(body.data[0]).toEqual({
      b64_json: 'edited_base64',
      revised_prompt: 'Edited prompt',
    });
  });

  it('forwards repeated edit image fields to the provider', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_multi_image_edit_key',
      label: 'multi-image-edit',
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
                  { inlineData: { mimeType: 'image/png', data: 'combined_base64' } },
                ],
              },
              finishReason: 'STOP',
            }],
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const form = new FormData();
    form.append('image', new Blob([Buffer.from('image-one')], { type: 'image/png' }), 'one.png');
    form.append('image', new Blob([Buffer.from('image-two')], { type: 'image/png' }), 'two.png');
    form.set('prompt', 'Combine these into one product scene');
    form.set('response_format', 'b64_json');

    const { status } = await requestMultipart(app, '/v1/images/edits', form);

    expect(status).toBe(200);
    expect(providerBody.contents[0].parts).toEqual([
      { text: 'Combine these into one product scene' },
      { inlineData: { mimeType: 'image/png', data: Buffer.from('image-one').toString('base64') } },
      { inlineData: { mimeType: 'image/png', data: Buffer.from('image-two').toString('base64') } },
    ]);
  });

  it('routes image variation multipart requests to an image variation-capable provider', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_image_variation_key',
      label: 'image-variation',
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
                  { inlineData: { mimeType: 'image/png', data: 'variation_base64' } },
                ],
              },
              finishReason: 'STOP',
            }],
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const form = imageUploadForm({ response_format: 'b64_json' });

    const { status, body, headers } = await requestMultipart(app, '/v1/images/variations', form);

    expect(status).toBe(200);
    expect(headers.get('X-Routed-Via')).toContain('google/gemini-3.1-flash-image-preview');
    expect(providerBody.contents[0].parts[0].text).toContain('Create a variation');
    expect(providerBody.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') },
    });
    expect(body.data[0].b64_json).toBe('variation_base64');
  });

  it('rejects an explicit non-image-edit model', async () => {
    const form = imageUploadForm({
      model: 'mistral-large-latest',
      prompt: 'Edit this image',
    });

    const { status, body } = await requestMultipart(app, '/v1/images/edits', form);

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('does not support image edits');
  });
});
