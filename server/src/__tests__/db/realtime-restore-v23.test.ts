import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { selectSweepCandidateIds } from '../../services/model-scout.js';

/**
 * The scout probes Google with generateContent, but realtime models answer only
 * over bidiGenerateContent — so Google returns a 404 meaning "wrong endpoint",
 * which the retirement logic read as "removed". Two working Gemini realtime
 * models were disabled in production as a result.
 */
describe('V23 realtime model restore', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('leaves realtime-only models enabled', () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.model_id, m.enabled FROM models m
      WHERE EXISTS (
        SELECT 1 FROM model_capabilities c
        WHERE c.model_db_id = m.id AND c.enabled = 1 AND c.capability = 'realtime_audio'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_capabilities c2
        WHERE c2.model_db_id = m.id AND c2.enabled = 1 AND c2.capability IN ('chat', 'vision')
      )
    `).all() as { model_id: string; enabled: number }[];

    expect(rows.length, 'catalog should have realtime-only models').toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.enabled, `${row.model_id} must not be left retired`).toBe(1);
    }
  });

  it('excludes realtime-only models from the chat probe', () => {
    const db = getDb();
    const candidates = new Set(selectSweepCandidateIds(db));

    const realtimeOnly = db.prepare(`
      SELECT m.id, m.model_id FROM models m
      WHERE EXISTS (
        SELECT 1 FROM model_capabilities c
        WHERE c.model_db_id = m.id AND c.enabled = 1 AND c.capability = 'realtime_audio'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_capabilities c2
        WHERE c2.model_db_id = m.id AND c2.enabled = 1 AND c2.capability IN ('chat', 'vision')
      )
    `).all() as { id: number; model_id: string }[];

    for (const row of realtimeOnly) {
      expect(
        candidates.has(row.id),
        `${row.model_id} cannot answer a generateContent probe and must not be swept`,
      ).toBe(false);
    }
  });

  it('still sweeps ordinary chat models', () => {
    const db = getDb();
    const candidates = new Set(selectSweepCandidateIds(db));

    const chatModels = db.prepare(`
      SELECT m.id, m.model_id FROM models m
      JOIN model_capabilities c ON c.model_db_id = m.id
      WHERE m.enabled = 1 AND m.is_free = 1 AND c.capability = 'chat' AND c.enabled = 1
      LIMIT 5
    `).all() as { id: number; model_id: string }[];

    expect(chatModels.length).toBeGreaterThan(0);
    for (const row of chatModels) {
      expect(candidates.has(row.id), `${row.model_id} should still be swept`).toBe(true);
    }
  });
});
