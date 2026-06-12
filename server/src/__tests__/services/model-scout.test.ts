import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { discoverAndPersistNewModels } from '../../services/model-scout.js';

describe('Model scout discovery', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    for (const modelId of ['test/vision-free:free', 'test/text-free:free']) {
      const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get('openrouter', modelId) as { id: number } | undefined;
      if (row) {
        db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
        db.prepare('DELETE FROM model_availability WHERE model_db_id = ?').run(row.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists OpenRouter image-input models with the vision capability', async () => {
    const db = getDb();
    const key = encrypt('or_dynamic_vision_key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('openrouter', 'dynamic vision', key.encrypted, key.iv, key.authTag, 'healthy', 1);

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://openrouter.ai/api/v1/models') {
        return {
          ok: true,
          json: () => Promise.resolve({
            data: [
              {
                id: 'test/vision-free:free',
                name: 'Test Vision Free',
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
                pricing: { prompt: '0', completion: '0' },
              },
              {
                id: 'test/text-free:free',
                name: 'Test Text Free',
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                pricing: { prompt: '0', completion: '0' },
              },
            ],
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const result = await discoverAndPersistNewModels();

    expect(result.inserted.map(model => model.modelId)).toEqual([
      'test/vision-free:free',
      'test/text-free:free',
    ]);

    const rows = db.prepare(`
      SELECT m.model_id, mc.capability
      FROM models m
      JOIN model_capabilities mc ON mc.model_db_id = m.id
      WHERE m.platform = 'openrouter'
        AND m.model_id IN ('test/vision-free:free', 'test/text-free:free')
      ORDER BY m.model_id, mc.capability
    `).all() as Array<{ model_id: string; capability: string }>;

    expect(rows).toEqual([
      { model_id: 'test/text-free:free', capability: 'chat' },
      { model_id: 'test/vision-free:free', capability: 'chat' },
      { model_id: 'test/vision-free:free', capability: 'vision' },
    ]);
  });
});
