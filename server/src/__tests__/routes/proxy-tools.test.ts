import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Proxy tool-calling support', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_tool_test',
      label: 'proxy-tools',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes tools/tool_choice to provider and returns tool_calls', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Karachi"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      // No `model` → auto-route via fallback chain.
      messages: [{ role: 'user', content: 'What is the weather in Karachi?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'required',
    });

    expect(status).toBe(200);
    expect(providerBody.tools).toHaveLength(1);
    expect(providerBody.tool_choice).toBe('required');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('accepts assistant tool_calls + tool messages in follow-up turns', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-final',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'It is 30C in Karachi.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'Weather in Karachi?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Karachi"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_weather_1',
          content: '{"temp_c":30}',
        },
      ],
    });

    expect(status).toBe(200);
    expect(providerBody.messages[1].role).toBe('assistant');
    expect(providerBody.messages[1].content).toBeNull();
    expect(providerBody.messages[1].tool_calls).toHaveLength(1);
    expect(providerBody.messages[2].role).toBe('tool');
    expect(providerBody.messages[2].tool_call_id).toBe('call_weather_1');
    expect(body.choices[0].message.content).toContain('30C');
  });

  it('includes tool schemas when choosing a model context window', async () => {
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    const insertModel = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank,
        speed_rank, size_label, context_window, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const small = insertModel.run(
      'groq', 'test-tool-small', 'Test Tool Small', 1, 1, 'Small', 32768,
    );
    const large = insertModel.run(
      'groq', 'test-tool-large', 'Test Tool Large', 2, 1, 'Large', 131072,
    );
    const addFallback = db.prepare(
      'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
    );
    addFallback.run(Number(small.lastInsertRowid), 1);
    addFallback.run(Number(large.lastInsertRowid), 2);

    const origFetch = global.fetch;
    let providerBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-context-route',
            object: 'chat.completion',
            created: 123,
            model: providerBody.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 50_000, completion_tokens: 1, total_tokens: 50_001 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Reply ok.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'large_schema_tool',
          description: 'x'.repeat(200_000),
          parameters: { type: 'object', properties: {} },
        },
      }],
      max_tokens: 1_000,
    });

    expect(status).toBe(200);
    expect(providerBody.model).toBe('test-tool-large');
  });
});
