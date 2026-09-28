import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { checkModelAvailability, discoverAndPersistNewModels } from '../../services/model-scout.js';
import { getProvider } from '../../providers/index.js';

describe('Google catalog discovery', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initDb(':memory:');
    db.exec(`DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'google');
      DELETE FROM models WHERE platform = 'google';`);
    const key = encrypt('test-google-catalog-key');
    db.prepare(`INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag)
      VALUES ('google', ?, ?, ?)`).run(key.encrypted, key.iv, key.authTag);
  });

  afterEach(() => {
    getDb().close();
    vi.restoreAllMocks();
  });

  it('follows pages with a bounded signal, deduplicates and stops repeated tokens without exposing the key in URLs', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [], nextPageToken: 'second' })))
      .mockResolvedValue(new Response(JSON.stringify({ models: [
        { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      ], nextPageToken: 'second' })));
    expect((await discoverAndPersistNewModels()).discovered.map(m => m.modelId)).toEqual(['gemini-3.8-live']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain('test-google-catalog-key');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(options?.headers).get('x-goog-api-key')).toBe('test-google-catalog-key');
    }
    expect(String(fetchSpy.mock.calls[1][0])).toContain('pageToken=second');
  });

  it.each(['success', '429'])('does not infer free pricing for a manually enabled unknown model from %s', async result => {
    const db = getDb();
    const id = db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, is_free)
      VALUES ('google', 'gemini-unknown', 'Unknown', 999, 999, 1, 0)`).run().lastInsertRowid;
    const probe = vi.spyOn(getProvider('google')!, 'chatCompletion');
    if (result === 'success') probe.mockResolvedValue({} as any);
    else probe.mockRejectedValue(new Error('429 quota exceeded'));
    expect((await checkModelAvailability(Number(id))).freeTierConfirmed).toBe(false);
    expect(db.prepare('SELECT free_tier_confirmed FROM model_availability WHERE model_db_id = ?').get(id)).toEqual({ free_tier_confirmed: 0 });
  });

  it('auto-enables only confirmed free Flash and Live with method-specific capabilities', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.1-flash-live-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-future-audio', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.8-flash-extended-thinking', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
    ] })));
    const result = await discoverAndPersistNewModels();
    expect(result.inserted).toHaveLength(6);
    const db = getDb();
    for (const [modelId, enabled, capabilities] of [
      ['gemini-3.8-flash', 1, ['chat', 'video', 'vision']],
      ['gemini-3.8-live', 1, ['realtime_audio']],
      ['gemini-3.1-flash-live-preview', 1, ['realtime_audio']],
      ['gemini-future-audio', 0, ['realtime_audio']],
      ['gemini-3.8-flash-extended-thinking', 0, ['chat']],
      ['gemini-3.8-flash-tts', 0, ['chat']],
    ] as const) {
      const row = db.prepare(`SELECT id, enabled, is_free, rpm_limit, rpd_limit, tpm_limit FROM models WHERE model_id = ?`).get(modelId) as any;
      expect(row, modelId).toMatchObject({ enabled, is_free: enabled, rpm_limit: null, rpd_limit: null, tpm_limit: null });
      expect(db.prepare('SELECT capability FROM model_capabilities WHERE model_db_id = ? ORDER BY capability').all(row.id)
        .map((c: any) => c.capability)).toEqual(capabilities);
      expect(db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(row.id)).toEqual({ enabled: modelId === 'gemini-3.8-flash' ? 1 : 0 });
      expect(db.prepare('SELECT free_tier_confirmed FROM model_availability WHERE model_db_id = ?').get(row.id)).toEqual({ free_tier_confirmed: enabled });
    }
  });
});
