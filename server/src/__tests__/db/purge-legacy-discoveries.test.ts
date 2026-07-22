import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { purgeLegacyBazaarlinkDiscoveries } from '../../db/index.js';

function addModel(platform: string, modelId: string, enabled: number): number {
  return getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, is_free)
    VALUES (?, ?, ?, 99, 99, 'Medium', ?, 1)
  `).run(platform, modelId, modelId, enabled).lastInsertRowid as number;
}

function markDiscovered(modelDbId: number, discoverySource: string) {
  getDb().prepare(`
    INSERT INTO model_availability (model_db_id, status, discovery_source, free_tier_confirmed)
    VALUES (?, 'unknown', ?, 0)
  `).run(modelDbId, discoverySource);
}

const OLD = 'model-scout:2026-07-20T20:53:52.429Z'; // the bad pre-filter import
const NEW = 'model-scout:2026-08-01T10:00:00.000Z'; // a legitimate later discovery

describe('purgeLegacyBazaarlinkDiscoveries', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    // fallback_config is NO ACTION, so clear it before removing the models.
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'purge-%')").run();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'purge-%'").run();
  });

  it('removes the disabled rows imported before the scout filter existed', () => {
    const db = getDb();
    const junk = addModel('bazaarlink', 'purge-junk-image', 0);
    markDiscovered(junk, OLD);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 9999, 0)').run(junk);

    purgeLegacyBazaarlinkDiscoveries(db);

    expect(db.prepare('SELECT id FROM models WHERE id = ?').get(junk)).toBeUndefined();
    // fallback_config is NO ACTION, so it must be cleared explicitly or the
    // delete would fail the foreign key.
    expect(db.prepare('SELECT model_db_id FROM fallback_config WHERE model_db_id = ?').get(junk)).toBeUndefined();
    expect(db.prepare('SELECT model_db_id FROM model_availability WHERE model_db_id = ?').get(junk)).toBeUndefined();
  });

  it('keeps enabled models, seeded models, and later discoveries', () => {
    const db = getDb();
    const enabledDiscovered = addModel('bazaarlink', 'purge-enabled', 1);
    markDiscovered(enabledDiscovered, OLD);

    const seeded = addModel('bazaarlink', 'purge-seeded', 0); // no availability row

    const laterDiscovery = addModel('bazaarlink', 'purge-later', 0);
    markDiscovered(laterDiscovery, NEW);

    const otherPlatform = addModel('huggingface', 'purge-other', 0);
    markDiscovered(otherPlatform, OLD);

    purgeLegacyBazaarlinkDiscoveries(db);

    for (const [id, label] of [
      [enabledDiscovered, 'enabled model'],
      [seeded, 'seeded model'],
      [laterDiscovery, 'later discovery'],
      [otherPlatform, 'another provider'],
    ] as const) {
      expect(db.prepare('SELECT id FROM models WHERE id = ?').get(id), `${label} must survive`).toBeDefined();
    }
  });

  it('is idempotent', () => {
    const db = getDb();
    const junk = addModel('bazaarlink', 'purge-twice', 0);
    markDiscovered(junk, OLD);

    purgeLegacyBazaarlinkDiscoveries(db);
    expect(() => purgeLegacyBazaarlinkDiscoveries(db)).not.toThrow();
    expect(db.prepare('SELECT id FROM models WHERE id = ?').get(junk)).toBeUndefined();
  });
});
