import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb } from '../../db/index.js';

it('preserves disabled speech settings, custom quotas and voice ownership across restarts', async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), 'hub-speech-'));
  let db = await initDb(join(dir, 'test.db'));
  try {
    const model = db.prepare("SELECT id FROM models WHERE model_id='gemini-3.8-flash-tts'").get() as { id: number };
    db.prepare('UPDATE models SET enabled=0,rpm_limit=7 WHERE id=?').run(model.id);
    db.prepare('UPDATE model_capabilities SET enabled=0 WHERE model_db_id=?').run(model.id);
    db.prepare("INSERT INTO speech_voices (id,display_name,voice_type) VALUES ('voice_saved','Saved voice','prompted')").run();
    db.close(); db = await initDb(join(dir, 'test.db'));
    expect(db.prepare('SELECT enabled,rpm_limit FROM models WHERE id=?').get(model.id)).toEqual({ enabled: 0, rpm_limit: 7 });
    expect(db.prepare('SELECT capability FROM model_capabilities WHERE model_db_id=? AND enabled=1').all(model.id)).toEqual([]);
    expect(db.prepare('SELECT id FROM speech_voices').all()).toEqual([{ id: 'voice_saved' }]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); }
});
