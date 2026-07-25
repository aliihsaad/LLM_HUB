import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getUnifiedApiKey, initDb } from '../../db/index.js';

async function request(
  app: Express,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'auth probe' }] }),
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

describe('proxy API authentication behind a local reverse proxy', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('requires the unified key when proxy headers are present', async () => {
    const missing = await request(app, { 'X-Forwarded-For': '198.51.100.20' });
    expect(missing.status).toBe(401);
    expect(missing.body.error.type).toBe('authentication_error');

    const wrong = await request(app, {
      'X-Forwarded-For': '198.51.100.20',
      Authorization: 'Bearer wrong-key',
    });
    expect(wrong.status).toBe(401);
  });

  it('accepts the unified key for proxied requests', async () => {
    const authorized = await request(app, {
      'X-Forwarded-For': '198.51.100.20',
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    });
    expect(authorized.status).not.toBe(401);
  });

  it('keeps direct loopback requests keyless', async () => {
    const local = await request(app);
    expect(local.status).not.toBe(401);
  });
});
