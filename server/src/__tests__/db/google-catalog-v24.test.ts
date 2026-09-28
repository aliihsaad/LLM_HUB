import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb } from '../../db/index.js';

const flash = 'gemini-3.8-flash';
const live = 'gemini-3.8-live';
const fallback = 'gemini-3.1-flash-live-preview';
const native = 'gemini-2.5-flash-native-audio-preview-12-2025';
let dir: string;
let dbPath: string;
const model = (id: string) => getDb().prepare('SELECT * FROM models WHERE platform = ? AND model_id = ?').get('google', id) as any;
const caps = (id: string) => getDb().prepare(`SELECT capability FROM model_capabilities WHERE model_db_id = ? AND enabled = 1 ORDER BY capability`).all(model(id).id).map((r: any) => r.capability);
async function restart() { getDb().close(); await initDb(dbPath); }

describe('V24 Google catalog migration', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    dir = mkdtempSync(join(tmpdir(), 'google-catalog-v24-'));
    dbPath = join(dir, 'test.db');
    await initDb(dbPath);
  });
  afterEach(() => {
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('seeds free Flash and realtime-only Live with unknown quotas and keeps the 3.1 fallback', async () => {
    for (const id of [flash, live, fallback, native]) {
      expect(model(id), id).toMatchObject({ enabled: 1, is_free: 1, rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null });
    }
    expect(caps(flash)).toEqual(['chat', 'video', 'vision']);
    expect(caps(live)).toEqual(['realtime_audio']);
    expect(model(flash).intelligence_rank).toBeLessThan(999);
    expect(model(live).speed_rank).toBeLessThan(999);
    expect(getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(model(live).id)).toEqual({ enabled: 0 });
    await restart();
    for (const id of [live, fallback, native]) expect(model(id)).toMatchObject({ rpm_limit: null, rpd_limit: null, tpm_limit: null });
    expect(caps(live)).toEqual(['realtime_audio']);
    expect(getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(model(live).id)).toEqual({ enabled: 0 });
  });

  it('does not seed chat capabilities onto an unknown bidi-only discovery after restart', async () => {
    const db = getDb();
    const id = db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, is_free)
      VALUES ('google', 'gemini-future-audio', 'Unknown bidi', 999, 999, 0, 0)`).run().lastInsertRowid;
    db.prepare("INSERT INTO model_capabilities (model_db_id, capability, enabled) VALUES (?, 'realtime_audio', 0)").run(id);
    await restart();
    expect(getDb().prepare('SELECT capability FROM model_capabilities WHERE model_db_id = ? ORDER BY capability').all(id))
      .toEqual([{ capability: 'realtime_audio' }]);
    expect(model('gemini-future-audio')).toMatchObject({ enabled: 0, is_free: 0 });
  });

  it('repairs prior disabled discovery once, preserving custom quotas and later operator choices', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM settings WHERE key = 'v24_google_catalog_applied'`).run();
    for (const id of [flash, live, 'gemini-3.8-flash-extended-thinking', 'gemini-3.8-flash-tts']) {
      db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, is_free)
        VALUES ('google', ?, ?, 999, 999, 0, 0) ON CONFLICT(platform, model_id) DO UPDATE SET enabled = 0, is_free = 0, intelligence_rank = 999, speed_rank = 999`).run(id, id);
      for (const capability of ['chat', 'vision', 'video']) db.prepare(`INSERT INTO model_capabilities (model_db_id, capability, enabled) VALUES (?, ?, 0)
        ON CONFLICT(model_db_id, capability) DO UPDATE SET enabled = 0`).run(model(id).id, capability);
    }
    db.prepare('UPDATE models SET rpm_limit = 7, rpd_limit = 20, tpm_limit = 123456, tpd_limit = 98765 WHERE id = ?').run(model(fallback).id);
    db.prepare('UPDATE models SET rpm_limit = 5, rpd_limit = 20, tpm_limit = 250000 WHERE id = ?').run(model(native).id);
    await restart();
    expect(model(flash)).toMatchObject({ enabled: 1, is_free: 1 });
    expect(caps(flash)).toEqual(['chat', 'video', 'vision']);
    expect(caps(live)).toEqual(['realtime_audio']);
    expect(model(fallback)).toMatchObject({ enabled: 1, rpm_limit: 7, rpd_limit: null, tpm_limit: 123456, tpd_limit: 98765 });
    expect(model(native)).toMatchObject({ rpm_limit: null, rpd_limit: null, tpm_limit: null });
    for (const id of ['gemini-3.8-flash-extended-thinking', 'gemini-3.8-flash-tts']) expect(model(id)).toMatchObject({ enabled: 0, is_free: 0 });
    for (const id of [flash, live, fallback]) {
      getDb().prepare('UPDATE models SET enabled = 0, rpm_limit = 31 WHERE id = ?').run(model(id).id);
      getDb().prepare('UPDATE model_capabilities SET enabled = 0, priority = 77 WHERE model_db_id = ?').run(model(id).id);
    }
    await restart();
    for (const id of [flash, live, fallback]) {
      expect(model(id)).toMatchObject({ enabled: 0, rpm_limit: 31 });
      expect(caps(id)).toEqual([]);
    }
    expect(getDb().prepare(`SELECT value FROM settings WHERE key = 'v24_google_catalog_applied'`).get()).toEqual({ value: '1' });
  });
});
