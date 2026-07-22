import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  isBazaarlinkFreeChatEntry,
  applyPricingDrift,
} from '../../services/model-scout.js';

describe('scout pricing classification', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('accepts zero-priced chat entries and rejects image/video and priced ones', () => {
    const freeChat = {
      id: 'deepseek/deepseek-v4-flash:free',
      context_length: 1048576,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['text'] },
    };
    const videoGen = {
      id: 'bytedance/seedance-2.0',
      context_length: 0,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['video'] },
    };
    const paidChat = {
      id: 'glm-5.2',
      context_length: 1048576,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      architecture: { output_modalities: ['text'] },
    };
    expect(isBazaarlinkFreeChatEntry(freeChat)).toBe(true);
    expect(isBazaarlinkFreeChatEntry(videoGen)).toBe(false);
    expect(isBazaarlinkFreeChatEntry(paidChat)).toBe(false);
  });

  it('flips is_free on pricing drift and disables rows missing upstream', () => {
    const db = getDb();
    // auto:free drifts to paid; glm-5.1 vanishes from the upstream list.
    const upstream = [
      { id: 'auto:free', pricing: { prompt: '0.000001', completion: '0.000001' } },
      { id: 'claude-opus-4.7', pricing: { prompt: '0.000015', completion: '0.000075' } },
      // ...the rest of the bazaarlink ids except glm-5.1, pricing irrelevant here
      ...['gpt-5.5','claude-sonnet-4.6','gemini-3-flash-preview','gpt-5.4','kimi-k2.6',
          'minimax-m3','deepseek-v3.2','qwen3.6-plus','gpt-5.4-mini','claude-haiku-4.5',
          'deepseek/deepseek-v4-flash:free']
        .map(id => ({ id, pricing: { prompt: '0.000001', completion: '0.000001' } })),
    ];

    const result = applyPricingDrift(db, 'bazaarlink', upstream);
    expect(result.becamePaid).toContain('auto:free');
    expect(result.wentMissing).toContain('glm-5.1');

    const auto = db.prepare(
      "SELECT is_free FROM models WHERE platform='bazaarlink' AND model_id='auto:free'",
    ).get() as { is_free: number };
    expect(auto.is_free).toBe(0);

    const glm = db.prepare(
      "SELECT enabled FROM models WHERE platform='bazaarlink' AND model_id='glm-5.1'",
    ).get() as { enabled: number };
    expect(glm.enabled).toBe(0);
  });
});
