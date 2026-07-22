import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Live-verified 2026-07-22 against ai.google.dev pricing ("Free of charge" vs
// "Not available") and a real generateContent probe.
// Gemma 4 is free on the Gemini API too, but is intentionally not seeded — a
// same-model_id BazaarLink row shadows it in resolveRoutableModel. See V17.
const NEW_FREE_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
];

const PAID_GOOGLE_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-pro-preview',
];

describe('V17 Google catalog refresh', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds the new free-tier Google models as enabled and free', () => {
    const db = getDb();
    for (const modelId of NEW_FREE_MODELS) {
      const row = db
        .prepare("SELECT enabled, is_free, context_window FROM models WHERE platform = 'google' AND model_id = ?")
        .get(modelId) as { enabled: number; is_free: number; context_window: number | null } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} should be enabled`).toBe(1);
      expect(row!.is_free, `${modelId} should be free-tier`).toBe(1);
      expect(row!.context_window, `${modelId} should declare a context window`).toBeGreaterThan(0);
    }
  });

  it('flags paid-only Google models so free-only mode blocks them', () => {
    const db = getDb();
    for (const modelId of PAID_GOOGLE_MODELS) {
      const row = db
        .prepare("SELECT is_free FROM models WHERE platform = 'google' AND model_id = ?")
        .get(modelId) as { is_free: number } | undefined;
      if (!row) continue; // not every paid id is seeded on a fresh DB
      expect(row.is_free, `${modelId} must be marked paid`).toBe(0);
    }
  });

  it('keeps the established free Google chat models free', () => {
    const db = getDb();
    for (const modelId of ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      const row = db
        .prepare("SELECT is_free FROM models WHERE platform = 'google' AND model_id = ?")
        .get(modelId) as { is_free: number } | undefined;
      expect(row?.is_free, `${modelId} should stay free`).toBe(1);
    }
  });

  it('gives the new chat models a routable chat capability', () => {
    const db = getDb();
    for (const modelId of NEW_FREE_MODELS) {
      const cap = db
        .prepare(`
          SELECT mc.enabled FROM model_capabilities mc
            JOIN models m ON m.id = mc.model_db_id
           WHERE m.platform = 'google' AND m.model_id = ? AND mc.capability = 'chat'
        `)
        .get(modelId) as { enabled: number } | undefined;
      expect(cap, `${modelId} should have a chat capability row`).toBeDefined();
      expect(cap!.enabled).toBe(1);
    }
  });
});
