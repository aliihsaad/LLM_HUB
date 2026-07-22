import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { resolveRoutableModel } from '../../lib/resolve-model.js';
import { setFreeOnlyMode } from '../../lib/app-settings.js';

function insertModel(row: {
  platform: string;
  modelId: string;
  enabled: number;
  isFree: number;
}) {
  return getDb().prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, is_free
    ) VALUES (?, ?, ?, 50, 50, 'Medium', 'test', 128000, ?, ?)
  `).run(row.platform, row.modelId, `${row.platform} ${row.modelId}`, row.enabled, row.isFree)
    .lastInsertRowid as number;
}

describe('resolveRoutableModel with duplicate model ids across providers', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'dup-%'").run();
    db.prepare("DELETE FROM api_keys WHERE platform IN ('google', 'bazaarlink')").run();
    setFreeOnlyMode(db, true);
  });

  it('prefers the enabled row over a disabled row inserted earlier', () => {
    const db = getDb();
    // The shadowing row is inserted FIRST so it has the lower id — the old
    // implementation used a bare `.get()` and always picked this one.
    insertModel({ platform: 'bazaarlink', modelId: 'dup-chat', enabled: 0, isFree: 0 });
    const googleId = insertModel({ platform: 'google', modelId: 'dup-chat', enabled: 1, isFree: 1 });

    const resolution = resolveRoutableModel(db, 'dup-chat');
    expect(resolution.kind).toBe('ok');
    expect(resolution.kind === 'ok' && resolution.id).toBe(googleId);
  });

  it('prefers a provider that actually has a configured key', () => {
    const db = getDb();
    const noKeyId = insertModel({ platform: 'bazaarlink', modelId: 'dup-keyed', enabled: 1, isFree: 1 });
    const keyedId = insertModel({ platform: 'google', modelId: 'dup-keyed', enabled: 1, isFree: 1 });
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at)
      VALUES ('google', 'k', 'x', 'y', 'z', 'healthy', 1, datetime('now'))
    `).run();

    const resolution = resolveRoutableModel(db, 'dup-keyed');
    expect(resolution.kind).toBe('ok');
    expect(resolution.kind === 'ok' && resolution.id).toBe(keyedId);
    expect(resolution.kind === 'ok' && resolution.id).not.toBe(noKeyId);
  });

  it('prefers the free row over a paid duplicate while free-only mode is on', () => {
    const db = getDb();
    insertModel({ platform: 'bazaarlink', modelId: 'dup-priced', enabled: 1, isFree: 0 });
    const freeId = insertModel({ platform: 'google', modelId: 'dup-priced', enabled: 1, isFree: 1 });

    const resolution = resolveRoutableModel(db, 'dup-priced');
    expect(resolution.kind).toBe('ok');
    expect(resolution.kind === 'ok' && resolution.id).toBe(freeId);
  });

  it('still reports disabled when every duplicate is disabled', () => {
    const db = getDb();
    insertModel({ platform: 'bazaarlink', modelId: 'dup-off', enabled: 0, isFree: 1 });
    insertModel({ platform: 'google', modelId: 'dup-off', enabled: 0, isFree: 1 });

    expect(resolveRoutableModel(db, 'dup-off').kind).toBe('disabled');
  });

  it('still reports paid_blocked when every duplicate is paid and free-only is on', () => {
    const db = getDb();
    insertModel({ platform: 'bazaarlink', modelId: 'dup-paid', enabled: 1, isFree: 0 });
    insertModel({ platform: 'google', modelId: 'dup-paid', enabled: 1, isFree: 0 });

    expect(resolveRoutableModel(db, 'dup-paid').kind).toBe('paid_blocked');
  });

  it('still reports not_found for an unknown id', () => {
    expect(resolveRoutableModel(getDb(), 'dup-nope').kind).toBe('not_found');
  });
});
