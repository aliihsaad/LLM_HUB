import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: unknown, cookie?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data, headers: res.headers };
}

function firstCookie(headers: Headers): string {
  const raw = headers.get('set-cookie');
  expect(raw).toBeTruthy();
  return raw!.split(';')[0];
}

describe('Dashboard PIN auth', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key LIKE 'admin_%'").run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('blocks management APIs after enabling a PIN and accepts a valid login cookie', async () => {
    const enabled = await request(app, 'PUT', '/api/auth/config', {
      enabled: true,
      pin: '123456',
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ pinEnabled: true, authenticated: true });

    const blocked = await request(app, 'GET', '/api/keys');
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.type).toBe('admin_auth_required');

    const badLogin = await request(app, 'POST', '/api/auth/login', { pin: '000000' });
    expect(badLogin.status).toBe(401);

    const login = await request(app, 'POST', '/api/auth/login', { pin: '123456' });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ pinEnabled: true, authenticated: true });

    const allowed = await request(app, 'GET', '/api/keys', undefined, firstCookie(login.headers));
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual([]);
  });

  it('requires an authenticated session to change config while PIN auth is enabled', async () => {
    await request(app, 'PUT', '/api/auth/config', {
      enabled: true,
      pin: '246810',
    });

    const denied = await request(app, 'PUT', '/api/auth/config', { enabled: false });
    expect(denied.status).toBe(401);
    expect(denied.body.error.type).toBe('admin_auth_required');
  });

  it('disables PIN auth from an authenticated session and re-opens management APIs', async () => {
    await request(app, 'PUT', '/api/auth/config', {
      enabled: true,
      pin: '135790',
    });
    const login = await request(app, 'POST', '/api/auth/login', { pin: '135790' });
    const cookie = firstCookie(login.headers);

    const disabled = await request(app, 'PUT', '/api/auth/config', { enabled: false }, cookie);
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ pinEnabled: false, authenticated: false });

    const allowed = await request(app, 'GET', '/api/keys');
    expect(allowed.status).toBe(200);
  });

  it('does not put the OpenAI-compatible /v1 surface behind the dashboard PIN', async () => {
    await request(app, 'PUT', '/api/auth/config', {
      enabled: true,
      pin: '112233',
    });

    const models = await request(app, 'GET', '/v1/models');
    expect(models.status).toBe(200);
    expect(models.body.object).toBe('list');
  });
});
