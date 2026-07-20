import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { isFreeOnlyMode } from '../../lib/app-settings.js';

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

describe('free_only_mode setting', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('defaults to ON when the settings row is absent', () => {
    expect(isFreeOnlyMode(getDb())).toBe(true);
  });

  it('round-trips through the REST API', async () => {
    const off = await request(app, 'PUT', '/api/settings/free-only-mode', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.freeOnlyMode).toBe(false);
    expect(isFreeOnlyMode(getDb())).toBe(false);

    const read = await request(app, 'GET', '/api/settings/free-only-mode');
    expect(read.body.freeOnlyMode).toBe(false);

    const on = await request(app, 'PUT', '/api/settings/free-only-mode', { enabled: true });
    expect(on.body.freeOnlyMode).toBe(true);
    expect(isFreeOnlyMode(getDb())).toBe(true);
  });

  it('rejects a non-boolean body', async () => {
    const bad = await request(app, 'PUT', '/api/settings/free-only-mode', { enabled: 'yes' });
    expect(bad.status).toBe(400);
  });
});
