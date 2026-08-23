import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
      extraHeaders: { 'X-Custom': 'test' },
    });
  });

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('groq');
    expect(provider.name).toBe('TestProvider');
  });

  it('should call API with correct URL and headers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'test-model');

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody.messages[0].role).toBe('user');
  });

  it('should pass tool-calling params through untouched', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'my-key',
      [{ role: 'user', content: 'what is weather?' }],
      'test-model',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
        parallel_tool_calls: true,
      },
    );

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(capturedBody.parallel_tool_calls).toBe(true);
  });

  it('should create embeddings via the OpenAI-compatible embeddings endpoint', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          object: 'list',
          data: [
            { object: 'embedding', embedding: [0.1, 0.2], index: 0 },
            { object: 'embedding', embedding: [0.3, 0.4], index: 1 },
          ],
          model: 'embed-model',
          usage: { prompt_tokens: 4, total_tokens: 4 },
        }),
      } as any;
    });

    const result = await provider.createEmbedding(
      'my-key',
      ['one', 'two'],
      'embed-model',
      { encoding_format: 'float', dimensions: 2, user: 'test-user' },
    );

    expect(capturedUrl).toBe('https://api.test.com/v1/embeddings');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody).toEqual({
      model: 'embed-model',
      input: ['one', 'two'],
      encoding_format: 'float',
      dimensions: 2,
      user: 'test-user',
    });
    expect(result.object).toBe('list');
    expect(result.data).toHaveLength(2);
    expect(result._routed_via).toEqual({ platform: 'groq', model: 'embed-model' });
  });

  it('should generate images through OpenRouter image-only chat modalities', async () => {
    const openrouter = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    let capturedUrl = '';
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              images: [{ image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }],
            },
          }],
        }),
      } as any;
    });

    const result = await openrouter.createImage(
      'my-key',
      {
        prompt: 'A dashboard icon',
        response_format: 'b64_json',
        size: '1536x1024',
      },
      'sourceful/riverflow-v2.5-fast',
    );

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedBody).toMatchObject({
      model: 'sourceful/riverflow-v2.5-fast',
      messages: [{ role: 'user', content: 'A dashboard icon' }],
      modalities: ['image'],
      stream: false,
      image_config: { aspect_ratio: '3:2' },
    });
    expect(result.data[0]).toEqual({
      b64_json: 'aW1hZ2U=',
    });
    expect(result._routed_via).toEqual({ platform: 'openrouter', model: 'sourceful/riverflow-v2.5-fast' });
  });

  it('should request text and image modalities for OpenRouter Gemini image models', async () => {
    const openrouter = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: 'Prompt rewrite',
              images: [{ image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }],
            },
          }],
        }),
      } as any;
    });

    const result = await openrouter.createImage(
      'my-key',
      {
        prompt: 'A dashboard icon',
        response_format: 'b64_json',
      },
      'google/gemini-3.1-flash-image-preview',
    );

    expect(capturedBody.modalities).toEqual(['image', 'text']);
    expect(result.data[0]).toEqual({
      b64_json: 'aW1hZ2U=',
      revised_prompt: 'Prompt rewrite',
    });
  });

  it('should send image edit uploads to OpenRouter as image_url content parts', async () => {
    const openrouter = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              images: [{ imageUrl: { url: 'data:image/png;base64,ZWRpdA==' } }],
            },
          }],
        }),
      } as any;
    });

    const result = await openrouter.editImage(
      'my-key',
      {
        prompt: 'Make the background transparent',
        images: [{
          filename: 'source.png',
          contentType: 'image/png',
          data: Buffer.from('source-image'),
        }],
        response_format: 'url',
      },
      'sourceful/riverflow-v2.5-fast',
    );

    expect(capturedBody.messages[0].content).toEqual([
      { type: 'text', text: 'Make the background transparent' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('source-image').toString('base64')}` } },
    ]);
    expect(result.data[0]).toEqual({ url: 'data:image/png;base64,ZWRpdA==' });
  });

  it('should forward transcription requests to the OpenAI-compatible audio endpoint', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: FormData | null = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = (init as any).body as FormData;
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ text: 'transcribed text' }),
        text: () => Promise.resolve(JSON.stringify({ text: 'transcribed text' })),
      } as any;
    });

    const result = await (provider as any).transcribeAudio(
      'my-key',
      {
        file: {
          filename: 'sample.wav',
          contentType: 'audio/wav',
          data: Buffer.from('audio-bytes'),
        },
        language: 'en',
        response_format: 'json',
        timestamp_granularities: ['word'],
      },
      'whisper-large-v3-turbo',
    );

    expect(capturedUrl).toBe('https://api.test.com/v1/audio/transcriptions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody?.get('model')).toBe('whisper-large-v3-turbo');
    expect(capturedBody?.get('language')).toBe('en');
    expect(capturedBody?.get('timestamp_granularities[]')).toBe('word');
    const file = capturedBody?.get('file') as any;
    expect(file.name).toBe('sample.wav');
    expect(await file.text()).toBe('audio-bytes');
    expect(result.body).toEqual({ text: 'transcribed text' });
    expect(result._routed_via).toEqual({ platform: 'groq', model: 'whisper-large-v3-turbo' });
  });

  it('should forward translation requests to the OpenAI-compatible audio endpoint', async () => {
    let capturedUrl = '';
    let capturedBody: FormData | null = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedBody = (init as any).body as FormData;
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ text: 'translated text' }),
        text: () => Promise.resolve(JSON.stringify({ text: 'translated text' })),
      } as any;
    });

    const result = await (provider as any).translateAudio(
      'my-key',
      {
        file: {
          filename: 'sample.m4a',
          contentType: 'audio/mp4',
          data: Buffer.from('audio-m4a'),
        },
        prompt: 'domain words',
        response_format: 'json',
      },
      'whisper-large-v3',
    );

    expect(capturedUrl).toBe('https://api.test.com/v1/audio/translations');
    expect(capturedBody?.get('model')).toBe('whisper-large-v3');
    expect(capturedBody?.get('prompt')).toBe('domain words');
    expect(result.body).toEqual({ text: 'translated text' });
    expect(result._routed_via).toEqual({ platform: 'groq', model: 'whisper-large-v3' });
  });

  it('should throw on error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Rate Limited',
      json: () => Promise.resolve({ error: { message: 'Too many requests' } }),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Too many requests/);
  });

  it('should throw when a 2xx response body contains an OpenAI-style error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({
        error: {
          message: 'Provider returned error',
          code: 429,
        },
      }),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Provider returned error/);
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('validateKey returns false on confirmed 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('bad')).toBe(false);
  });

  it('validateKey propagates transport errors instead of swallowing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(provider.validateKey('any')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('folds reasoning_content into content when content is empty (Z.ai glm-4.5-flash style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'the actual answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('the actual answer');
  });

  it('flattens array content into a string (Mistral magistral style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('part one part two');
  });

  it('folds reasoning into content when content is empty (Ollama style — bare `reasoning` field)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning: 'ollama answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('ollama answer');
  });

  it('prefers reasoning_content over reasoning when both are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'preferred', reasoning: 'fallback' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('preferred');
  });

  it('does NOT fold reasoning_content when tool_calls are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'I am thinking about the tool',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('leaves real string content untouched', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'normal answer', reasoning_content: 'should not override' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('normal answer');
  });
});

describe('OpenAICompatProvider - platform instances', () => {
  // Mirrors the actual registrations in server/src/providers/index.ts.
  // Update both when adding/removing a platform.
  const platforms = [
    { platform: 'groq',       name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1' },
    { platform: 'cerebras',   name: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1' },
    { platform: 'sambanova',  name: 'SambaNova',     baseUrl: 'https://api.sambanova.ai/v1' },
    { platform: 'nvidia',     name: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { platform: 'mistral',    name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1' },
    { platform: 'openrouter', name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1' },
    { platform: 'github',     name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
    { platform: 'zhipu',      name: 'Zhipu AI',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  ] as const;

  for (const p of platforms) {
    it(`${p.name} provider should make requests to ${p.baseUrl}`, async () => {
      const provider = new OpenAICompatProvider(p as any);

      let capturedUrl = '';
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        capturedUrl = url as string;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'id', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
      expect(capturedUrl).toContain(p.baseUrl);
      expect(result._routed_via?.platform).toBe(p.platform);
    });
  }
});

describe('provider error body extraction', () => {
  function mockErrorResponse(status: number, statusText: string, body: unknown) {
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: false,
      status,
      statusText,
      json: () => Promise.resolve(body),
    } as any));
  }

  const nvidia = () => new OpenAICompatProvider({
    platform: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  });

  const call = (p: OpenAICompatProvider) =>
    p.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');

  // NVIDIA NIM answers RFC 7807 problem+json with no `error` envelope. Reading
  // only `error.message` fell through to statusText, turning a fully explained
  // retirement into "NVIDIA NIM API error 410: Gone".
  it('surfaces the RFC 7807 detail field NVIDIA returns', async () => {
    mockErrorResponse(410, 'Gone', {
      type: 'about:blank',
      title: 'Gone',
      status: 410,
      detail: "The model 'minimaxai/minimax-m2.7' has reached its end of life on 2026-07-27T00:00:00Z and is no longer available.",
    });

    await expect(call(nvidia())).rejects.toThrow(/reached its end of life on 2026-07-27/);
  });

  it('keeps the status code prefix alongside the problem+json detail', async () => {
    mockErrorResponse(403, 'Forbidden', {
      status: 403, title: 'Forbidden', detail: 'Authorization failed',
    });

    await expect(call(nvidia())).rejects.toThrow('NVIDIA NIM API error 403: Forbidden: Authorization failed');
  });

  it('still prefers the OpenAI error.message shape when present', async () => {
    mockErrorResponse(429, 'Too Many Requests', {
      error: { message: 'Rate limit reached for model', type: 'rate_limit_error' },
    });

    await expect(call(nvidia())).rejects.toThrow('NVIDIA NIM API error 429: Rate limit reached for model');
  });

  it('falls back to title, then statusText, when no detail is given', async () => {
    mockErrorResponse(404, 'Not Found', { status: 404, title: 'Not Found' });
    await expect(call(nvidia())).rejects.toThrow('NVIDIA NIM API error 404: Not Found');

    mockErrorResponse(502, 'Bad Gateway', {});
    await expect(call(nvidia())).rejects.toThrow('NVIDIA NIM API error 502: Bad Gateway');
  });

  it('reads a bare message field from aggregators that skip the envelope', async () => {
    mockErrorResponse(400, 'Bad Request', { message: 'model is required' });
    await expect(call(nvidia())).rejects.toThrow('NVIDIA NIM API error 400: model is required');
  });
});

describe('nested 2xx error bodies', () => {
  // OpenRouter reports upstream failures as HTTP 200 with an `error` object
  // and often omits `message`, putting the reason in `metadata.raw`. 531 of
  // the VPS's 682 OpenRouter failures logged as the opaque
  // "OpenRouter API error 429: Provider returned error".
  function mockOkBody(body: unknown) {
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
    } as any));
  }

  const openrouter = () => new OpenAICompatProvider({
    platform: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  });

  const call = (p: OpenAICompatProvider) =>
    p.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');

  it('surfaces metadata.raw when the error object has no message', async () => {
    mockOkBody({
      error: {
        code: 429,
        metadata: { provider_name: 'Targon', raw: 'Rate limit exceeded: free-models-per-day' },
      },
    });

    await expect(call(openrouter())).rejects.toThrow(
      'OpenRouter API error 429: Targon: Rate limit exceeded: free-models-per-day',
    );
  });

  it('reads a structured metadata.raw object', async () => {
    mockOkBody({
      error: { code: 502, metadata: { raw: { message: 'upstream exploded' } } },
    });

    await expect(call(openrouter())).rejects.toThrow('OpenRouter API error 502: upstream exploded');
  });

  it('names the upstream provider when only that is given', async () => {
    mockOkBody({ error: { code: 503, metadata: { provider_name: 'Chutes' } } });
    await expect(call(openrouter())).rejects.toThrow(
      'OpenRouter API error 503: upstream Chutes returned an error',
    );
  });

  it('still prefers an explicit message over metadata', async () => {
    mockOkBody({
      error: { code: 400, message: 'context length exceeded', metadata: { raw: 'ignore me' } },
    });

    await expect(call(openrouter())).rejects.toThrow(
      'OpenRouter API error 400: context length exceeded',
    );
  });

  it('falls back to the generic text when nothing usable is present', async () => {
    mockOkBody({ error: { code: 500 } });
    await expect(call(openrouter())).rejects.toThrow('OpenRouter API error 500: Provider returned error');
  });
});
