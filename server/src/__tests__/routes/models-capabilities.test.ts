import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Models capabilities API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('returns provider capability lights with configured key state', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'openrouter',
      key: 'or_capability_test_key',
      label: 'capabilities',
    });

    const { status, body } = await request(app, 'GET', '/api/models/capabilities');

    expect(status).toBe(200);
    expect(body.capabilities).toEqual(['chat', 'embeddings', 'vision', 'video', 'images', 'audio']);

    const openrouter = body.providers.find((p: any) => p.platform === 'openrouter');
    expect(openrouter.displayName).toBe('OpenRouter');
    expect(openrouter.docsUrl).toBe('https://openrouter.ai/docs/api/reference/overview');
    expect(openrouter.keyUrl).toBe('https://openrouter.ai/settings/keys');
    expect(openrouter.keyCount).toBe(1);
    expect(openrouter.capabilities.chat.supportedModels).toBeGreaterThan(0);
    expect(openrouter.capabilities.chat.configured).toBe(true);
    expect(openrouter.capabilities.embeddings.supportedModels).toBeGreaterThan(0);
    expect(openrouter.capabilities.embeddings.configured).toBe(true);
    expect(openrouter.capabilities.vision.supportedModels).toBeGreaterThan(0);
    expect(openrouter.capabilities.vision.configured).toBe(true);
    expect(openrouter.capabilities.vision.status).toBe('configured');
    expect(openrouter.capabilities.video.supportedModels).toBeGreaterThan(0);
    expect(openrouter.capabilities.video.configured).toBe(true);
    expect(openrouter.capabilities.video.status).toBe('configured');

    const groq = body.providers.find((p: any) => p.platform === 'groq');
    expect(groq.keyCount).toBe(0);
    expect(groq.capabilities.chat.supportedModels).toBeGreaterThan(0);
    expect(groq.capabilities.chat.configured).toBe(false);
    expect(groq.capabilities.embeddings.supportedModels).toBe(0);
    expect(groq.capabilities.embeddings.configured).toBe(false);
  });

  it('returns provider helper links for the supported provider list', async () => {
    const { status, body } = await request(app, 'GET', '/api/models/providers');

    expect(status).toBe(200);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'google',
          displayName: 'Google AI Studio',
          docsUrl: 'https://ai.google.dev/gemini-api/docs',
          keyUrl: 'https://aistudio.google.com/app/apikey',
        }),
        expect.objectContaining({
          platform: 'cloudflare',
          displayName: 'Cloudflare Workers AI',
          docsUrl: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
          keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
        }),
        expect.objectContaining({
          platform: 'llm7',
          displayName: 'LLM7',
          docsUrl: 'https://docs.llm7.io/quickstart',
          keyUrl: 'https://token.llm7.io/',
        }),
        expect.objectContaining({
          platform: 'bazaarlink',
          displayName: 'BazaarLink',
          docsUrl: 'https://bazaarlink.ai',
          keyUrl: 'https://bazaarlink.ai',
        }),
      ]),
    );
  });

  it('seeds the BazaarLink catalog with chat capability and the free auto route', async () => {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT model_id, display_name, enabled, context_window
           FROM models WHERE platform = 'bazaarlink' ORDER BY intelligence_rank ASC`,
      )
      .all() as { model_id: string; display_name: string; enabled: number; context_window: number | null }[];

    // Live-probed July 2026: bare ids are canonical (aliases carry provider/model form).
    expect(rows.length).toBeGreaterThanOrEqual(13);
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('auto:free');
    expect(ids).toContain('claude-sonnet-4.6');
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('glm-5.1');
    for (const row of rows) expect(row.enabled).toBe(1);

    const chatCapable = db
      .prepare(
        `SELECT COUNT(*) as n FROM model_capabilities mc
           JOIN models m ON m.id = mc.model_db_id
          WHERE m.platform = 'bazaarlink' AND mc.capability = 'chat' AND mc.enabled = 1`,
      )
      .get() as { n: number };
    expect(chatCapable.n).toBeGreaterThanOrEqual(13);
  });

  it('registers BazaarLink as an OpenAI-compatible provider', async () => {
    const { getProvider } = await import('../../providers/index.js');
    const provider = getProvider('bazaarlink');
    expect(provider).toBeDefined();
    expect(provider!.name).toBe('BazaarLink');
  });

  it('marks Google vision as configured when Google keys are present', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_vision_capability_key',
      label: 'vision',
    });

    const { status, body } = await request(app, 'GET', '/api/models/capabilities');

    expect(status).toBe(200);
    const google = body.providers.find((p: any) => p.platform === 'google');
    expect(google.keyCount).toBe(1);
    expect(google.capabilities.vision.supportedModels).toBeGreaterThan(0);
    expect(google.capabilities.vision.configured).toBe(true);
    expect(google.capabilities.vision.status).toBe('configured');
  });

  it('marks Google video as configured when Google keys are present', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_video_capability_key',
      label: 'video',
    });

    const { status, body } = await request(app, 'GET', '/api/models/capabilities');

    expect(status).toBe(200);
    const google = body.providers.find((p: any) => p.platform === 'google');
    expect(google.keyCount).toBe(1);
    expect(google.capabilities.video.supportedModels).toBeGreaterThan(0);
    expect(google.capabilities.video.configured).toBe(true);
    expect(google.capabilities.video.status).toBe('configured');
  });

  it('marks Google images as configured when Google keys are present', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_image_capability_key',
      label: 'images',
    });

    const { status, body } = await request(app, 'GET', '/api/models/capabilities');

    expect(status).toBe(200);
    const google = body.providers.find((p: any) => p.platform === 'google');
    expect(google.keyCount).toBe(1);
    expect(google.capabilities.images.supportedModels).toBeGreaterThan(0);
    expect(google.capabilities.images.configured).toBe(true);
    expect(google.capabilities.images.status).toBe('configured');
  });

  it('marks Google audio as configured when Google keys are present', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_audio_capability_key',
      label: 'audio',
    });

    const { status, body } = await request(app, 'GET', '/api/models/capabilities');

    expect(status).toBe(200);
    const google = body.providers.find((p: any) => p.platform === 'google');
    expect(google.keyCount).toBe(1);
    expect(google.capabilities.audio.supportedModels).toBeGreaterThan(1);
    expect(google.capabilities.audio.configured).toBe(true);
    expect(google.capabilities.audio.status).toBe('configured');
  });

  it('marks Groq audio transcription as configured when Groq keys are present', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'groq_audio_capability_key',
      label: 'audio',
    });

    const { status, body } = await request(app, 'GET', '/api/models/capabilities');

    expect(status).toBe(200);
    const groq = body.providers.find((p: any) => p.platform === 'groq');
    expect(groq.keyCount).toBe(1);
    expect(groq.capabilities.audio.supportedModels).toBeGreaterThan(0);
    expect(groq.capabilities.audio.configured).toBe(true);
    expect(groq.capabilities.audio.status).toBe('configured');
  });
});
