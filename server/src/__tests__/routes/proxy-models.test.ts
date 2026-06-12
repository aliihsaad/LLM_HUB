import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

async function request(app: Express, method: string, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, { method });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

function addKey(platform: string, key: string) {
  const encrypted = encrypt(key);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'models-list', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted.encrypted, encrypted.iv, encrypted.authTag);
}

describe('OpenAI-compatible models list', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM model_runtime_health').run();
  });

  it('returns no routable models when no provider keys are configured', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models');

    expect(status).toBe(200);
    expect(body).toMatchObject({ object: 'list' });
    expect(body.data).toEqual([]);
  });

  it('returns configured available models with capability metadata', async () => {
    addKey('google', 'google-test-key');

    const { status, body } = await request(app, 'GET', '/v1/models');
    const models = body.data as Array<{
      id: string;
      owned_by: string;
      capabilities: string[];
      available: boolean;
      key_count: number;
    }>;
    const live = models.find(model => model.id === 'gemini-3.1-flash-live-preview');
    const nativeAudio = models.find(model => model.id === 'gemini-2.5-flash-native-audio-preview-12-2025');

    expect(status).toBe(200);
    expect(live).toMatchObject({
      owned_by: 'google',
      available: true,
      key_count: 1,
    });
    expect(live?.capabilities).toEqual(expect.arrayContaining(['audio', 'realtime_audio']));
    expect(nativeAudio?.capabilities).toEqual(expect.arrayContaining(['audio', 'realtime_audio']));
  });

  it('hides models blocked by runtime health from external clients', async () => {
    addKey('google', 'google-test-key');
    const db = getDb();
    const row = db.prepare(`
      SELECT id FROM models
      WHERE platform = 'google' AND model_id = 'gemini-3.5-flash'
    `).get() as { id: number } | undefined;
    expect(row).toBeDefined();

    db.prepare(`
      INSERT INTO model_runtime_health (
        model_db_id, status, failure_count, last_error_category,
        last_error, last_failed_at, blocked_until
      )
      VALUES (?, 'unavailable', 1, 'zero_quota', 'quota exhausted', datetime('now'), datetime('now', '+1 day'))
    `).run(row!.id);

    const { status, body } = await request(app, 'GET', '/v1/models');
    const ids = (body.data as Array<{ id: string }>).map(model => model.id);

    expect(status).toBe(200);
    expect(ids).not.toContain('gemini-3.5-flash');
  });
});
