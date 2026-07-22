import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { setFreeOnlyMode } from '../../lib/app-settings.js';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('free-only in fallback + sweep surfaces', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => setFreeOnlyMode(getDb(), true));

  it('fallback GET still lists paid rows but tags them isFree=false', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    const rows = body.chain ?? body;
    const paid = rows.find((r: { modelId: string }) => r.modelId === 'claude-opus-4.7');
    expect(paid).toBeDefined();
    expect(paid.isFree).toBe(false);
    const free = rows.find((r: { modelId: string }) => r.modelId === 'auto:free');
    expect(free.isFree).toBe(true);
  });

  it('sweep candidate selection skips paid rows when ON and includes them when OFF', async () => {
    const db = getDb();
    const { selectSweepCandidateIds } = await import('../../services/model-scout.js');
    const onIds = selectSweepCandidateIds(db);
    const paidRow = db.prepare(
      "SELECT id FROM models WHERE platform = 'bazaarlink' AND model_id = 'claude-opus-4.7'",
    ).get() as { id: number };
    expect(onIds).not.toContain(paidRow.id);

    setFreeOnlyMode(db, false);
    const offIds = selectSweepCandidateIds(db);
    expect(offIds).toContain(paidRow.id);
  });

  // The Gemini-native compatibility route (/gemini/v1beta/models/:modelAction)
  // resolves models straight from the catalog and never runs through
  // resolveRoutableModel(), so it needs its own bridge onto is_free. There is
  // no naturally-paid Google catalog row today (only BazaarLink rows are
  // flagged paid), so these tests flip is_free on an existing, normally-free
  // Google model to simulate one and confirm the route now honors it.
  describe('free-only bridging in the Gemini-native compatibility route', () => {
    const GOOGLE_TEST_MODEL = 'gemini-2.5-flash';

    afterEach(() => {
      getDb().prepare(
        "UPDATE models SET is_free = 1 WHERE platform = 'google' AND model_id = ?",
      ).run(GOOGLE_TEST_MODEL);
    });

    it('blocks a paid google model on the Gemini-native path with the same 403 shape', async () => {
      const db = getDb();
      db.prepare(
        "UPDATE models SET is_free = 0 WHERE platform = 'google' AND model_id = ?",
      ).run(GOOGLE_TEST_MODEL);

      const { status, body } = await request(
        app,
        'POST',
        `/gemini/v1beta/models/${GOOGLE_TEST_MODEL}:generateContent`,
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      );

      expect(status).toBe(403);
      expect(body.error.code).toBe('paid_model_blocked');
      expect(body.error.message).toContain('free-tier');
    });

    it('does not block the same google model on the Gemini-native path when free-only is OFF', async () => {
      const db = getDb();
      db.prepare(
        "UPDATE models SET is_free = 0 WHERE platform = 'google' AND model_id = ?",
      ).run(GOOGLE_TEST_MODEL);
      setFreeOnlyMode(db, false);

      const { status } = await request(
        app,
        'POST',
        `/gemini/v1beta/models/${GOOGLE_TEST_MODEL}:generateContent`,
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      );

      // Upstream call fails in tests (no real key) — the point is it is NOT the 403 gate.
      expect(status).not.toBe(403);
    });
  });
});
