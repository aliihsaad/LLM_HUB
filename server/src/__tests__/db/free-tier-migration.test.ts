import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

const PAID_BZL = [
  'claude-opus-4.7', 'gpt-5.5', 'claude-sonnet-4.6', 'gemini-3-flash-preview',
  'gpt-5.4', 'kimi-k2.6', 'minimax-m3', 'glm-5.1', 'deepseek-v3.2',
  'qwen3.6-plus', 'gpt-5.4-mini', 'claude-haiku-4.5',
];

describe('V16 free-tier migration', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds is_free defaulting to 1 for rows no migration explicitly flags', () => {
    const db = getDb();
    // V17 later flags a handful of paid Google rows, so this asserts the column
    // DEFAULT rather than a blanket "everything non-bazaarlink is free".
    const unflagged = db.prepare(`
      SELECT COUNT(*) n FROM models
       WHERE platform NOT IN ('bazaarlink', 'google')
         AND is_free != 1
    `).get() as { n: number };
    expect(unflagged.n).toBe(0);

    const knownFree = db.prepare(
      "SELECT is_free FROM models WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'",
    ).get() as { is_free: number } | undefined;
    expect(knownFree?.is_free).toBe(1);
  });

  it('flags exactly the 12 paid bazaarlink rows and keeps free routes free', () => {
    const db = getDb();
    const paid = db.prepare(
      "SELECT model_id FROM models WHERE platform = 'bazaarlink' AND is_free = 0 ORDER BY model_id",
    ).all() as { model_id: string }[];
    expect(paid.map(r => r.model_id).sort()).toEqual([...PAID_BZL].sort());
    const free = db.prepare(
      "SELECT is_free FROM models WHERE platform = 'bazaarlink' AND model_id = 'auto:free'",
    ).get() as { is_free: number };
    expect(free.is_free).toBe(1);
  });
});
