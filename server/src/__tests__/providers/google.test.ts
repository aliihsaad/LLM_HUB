import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new GoogleProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('google');
    expect(provider.name).toBe('Google AI Studio');
  });

  it('should call Gemini API and return OpenAI-compatible response', async () => {
    const mockResponse = {
      candidates: [{
        content: { parts: [{ text: 'Hello from Gemini!' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    );

    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello from Gemini!');
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result._routed_via?.platform).toBe('google');
  });

  it('should throw on API error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: () => Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
    } as any);

    await expect(
      provider.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'gemini-2.5-pro')
    ).rejects.toThrow(/Rate limit exceeded/);
  });

  it('should validate key via models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true } as any);
    expect(await provider.validateKey('valid-key')).toBe(true);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('invalid-key')).toBe(false);
  });

  it('should translate system messages to systemInstruction', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      'gemini-2.5-pro',
    );

    expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: 'You are helpful' }] });
    expect(capturedBody.contents).toHaveLength(1);
    expect(capturedBody.contents[0].role).toBe('user');
  });

  it('should translate OpenAI tools/tool_choice to Gemini tools/toolConfig', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather in Karachi?' }],
      'gemini-2.5-pro',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: { name: 'get_weather' },
        },
      },
    );

    expect(capturedBody.tools[0].functionDeclarations[0].name).toBe('get_weather');
    expect(capturedBody.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(capturedBody.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['get_weather']);
  });

  it('should translate OpenAI image data URLs to Gemini inlineData parts', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'image ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 2, totalTokenCount: 262 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
            },
          },
        ],
      } as any],
      'gemini-2.5-pro',
    );

    expect(capturedBody.contents[0].parts).toEqual([
      { text: 'Describe this image' },
      { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } },
    ]);
  });

  it('should fetch HTTPS image URLs and translate them to Gemini inlineData parts', async () => {
    let capturedBody: any;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://cdn.example.test/cat.png') {
        const bytes = Buffer.from('remote-image');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'image/png', 'content-length': '12' }),
          arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        } as any;
      }

      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'remote image ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 2, totalTokenCount: 262 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this remote image' },
          { type: 'image_url', image_url: { url: 'https://cdn.example.test/cat.png' } },
        ],
      } as any],
      'gemini-2.5-pro',
    );

    expect(capturedBody.contents[0].parts).toEqual([
      { text: 'Describe this remote image' },
      { inlineData: { mimeType: 'image/png', data: Buffer.from('remote-image').toString('base64') } },
    ]);
  });

  it('should translate OpenAI video data URLs to Gemini inlineData parts', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'video ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 2, totalTokenCount: 262 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this clip' },
          {
            type: 'video_url',
            video_url: {
              url: 'data:video/mp4;base64,AAAAIGZ0eXBtcDQy',
            },
          },
        ],
      } as any],
      'gemini-2.5-flash',
    );

    expect(capturedBody.contents[0].parts).toEqual([
      { text: 'Summarize this clip' },
      { inlineData: { mimeType: 'video/mp4', data: 'AAAAIGZ0eXBtcDQy' } },
    ]);
  });

  it('should fetch HTTPS video URLs and translate them to Gemini inlineData parts', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://cdn.example.test/demo.mp4') {
        const bytes = Buffer.from('remote-video');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '12' }),
          arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        } as any;
      }

      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'video url ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 2, totalTokenCount: 262 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this public clip' },
          {
            type: 'video_url',
            video_url: {
              url: 'https://cdn.example.test/demo.mp4',
            },
          },
        ],
      } as any],
      'gemini-2.5-flash',
    );

    expect(capturedBody.contents[0].parts).toEqual([
      { text: 'Summarize this public clip' },
      { inlineData: { mimeType: 'video/mp4', data: Buffer.from('remote-video').toString('base64') } },
    ]);
  });

  it.each([
    ['https://youtube.com/shorts/zX6GCJ_UOLC?feature=share', 'https://www.youtube.com/watch?v=zX6GCJ_UOLC'],
    ['https://youtu.be/zX6GCJ_UOLC?si=share', 'https://www.youtube.com/watch?v=zX6GCJ_UOLC'],
    ['https://m.youtube.com/watch?v=zX6GCJ_UOLC&t=2s', 'https://www.youtube.com/watch?v=zX6GCJ_UOLC'],
  ])('should pass YouTube video URLs to Gemini fileData without downloading them (%s)', async (inputUrl, expectedFileUri) => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (!urlStr.includes('generativelanguage.googleapis.com')) {
        throw new Error(`Unexpected remote video fetch: ${urlStr}`);
      }

      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'youtube ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 2, totalTokenCount: 262 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this YouTube video' },
          { type: 'video_url', video_url: { url: inputUrl } },
        ],
      } as any],
      'gemini-2.5-flash',
    );

    expect(capturedBody.contents[0].parts).toEqual([
      { text: 'Summarize this YouTube video' },
      { fileData: { fileUri: expectedFileUri } },
    ]);
  });

  it('should reject HTTPS video URLs that resolve to HTML', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://cdn.example.test/video-page') {
        const bytes = Buffer.from('<html></html>');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset="utf-8"', 'content-length': '13' }),
          arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        } as any;
      }
      throw new Error('Gemini should not be called for non-video remote URLs');
    });

    await expect(provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this public clip' },
          { type: 'video_url', video_url: { url: 'https://cdn.example.test/video-page' } },
        ],
      } as any],
      'gemini-2.5-flash',
    )).rejects.toThrow(/content type must be video\/\*/i);
  });

  it.each([
    'http://127.0.0.1/image.png',
    'http://localhost/image.png',
    'http://169.254.169.254/latest/meta-data',
    'ftp://cdn.example.test/image.png',
  ])('should reject unsafe remote image URL %s', async (url) => {
    await expect(provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url } },
        ],
      } as any],
      'gemini-2.5-pro',
    )).rejects.toThrow(/image URL|remote image/i);
  });

  it('should reject remote image URLs that redirect', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'http://127.0.0.1/private' }),
    } as any);

    await expect(provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: 'https://cdn.example.test/redirect.png' } },
        ],
      } as any],
      'gemini-2.5-pro',
    )).rejects.toThrow(/redirect/i);
  });

  it('should reject remote image URLs with non-image content type', async () => {
    const bytes = Buffer.from('<html></html>');
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html', 'content-length': '12' }),
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    } as any);

    await expect(provider.chatCompletion(
      'test-key',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: 'https://cdn.example.test/page.html' } },
        ],
      } as any],
      'gemini-2.5-pro',
    )).rejects.toThrow(/content type/i);
  });

  it('should generate images and return OpenAI-compatible b64_json data', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [
                { text: 'Generated prompt' },
                { inlineData: { mimeType: 'image/png', data: 'image_base64' } },
              ],
            },
            finishReason: 'STOP',
          }],
        }),
      } as any;
    });

    const result = await (provider as any).createImage(
      'test-key',
      {
        prompt: 'A clean product photo',
        response_format: 'b64_json',
        size: '1024x1024',
      },
      'gemini-3.1-flash-image',
    );

    expect(capturedBody.contents[0].parts[0].text).toBe('A clean product photo');
    expect(capturedBody.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
    expect(capturedBody.generationConfig.responseFormat).toBeUndefined();
    expect(result.data[0]).toEqual({
      b64_json: 'image_base64',
      revised_prompt: 'Generated prompt',
    });
    expect(result._routed_via).toEqual({ platform: 'google', model: 'gemini-3.1-flash-image' });
  });

  it('should edit images with prompt and inline image data', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [
                { text: 'Edited image' },
                { inlineData: { mimeType: 'image/png', data: 'edited_base64' } },
              ],
            },
            finishReason: 'STOP',
          }],
        }),
      } as any;
    });

    const result = await (provider as any).editImage(
      'test-key',
      {
        prompt: 'Replace the sky with a sunset',
        images: [{
          filename: 'source.png',
          contentType: 'image/png',
          data: Buffer.from('source-image'),
        }],
        response_format: 'b64_json',
      },
      'gemini-3.1-flash-image',
    );

    expect(capturedBody.contents[0].parts).toEqual([
      { text: 'Replace the sky with a sunset' },
      { inlineData: { mimeType: 'image/png', data: Buffer.from('source-image').toString('base64') } },
    ]);
    expect(capturedBody.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(capturedBody.generationConfig.responseFormat).toBeUndefined();
    expect(result.data[0]).toEqual({
      b64_json: 'edited_base64',
      revised_prompt: 'Edited image',
    });
    expect(result._routed_via).toEqual({ platform: 'google', model: 'gemini-3.1-flash-image' });
  });

  it('should create image variations with a default variation prompt', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [
                { inlineData: { mimeType: 'image/png', data: 'variation_base64' } },
              ],
            },
            finishReason: 'STOP',
          }],
        }),
      } as any;
    });

    const result = await (provider as any).createImageVariation(
      'test-key',
      {
        image: {
          filename: 'source.png',
          contentType: 'image/png',
          data: Buffer.from('source-image'),
        },
        response_format: 'b64_json',
      },
      'gemini-3.1-flash-image',
    );

    expect(capturedBody.contents[0].parts[0].text).toContain('Create a variation');
    expect(capturedBody.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: Buffer.from('source-image').toString('base64') },
    });
    expect(result.data[0]).toEqual({ b64_json: 'variation_base64' });
    expect(result._routed_via).toEqual({ platform: 'google', model: 'gemini-3.1-flash-image' });
  });

  it('should transcribe uploaded audio through Gemini and return OpenAI-compatible JSON', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: { parts: [{ text: 'Turn on the office light.' }] },
            finishReason: 'STOP',
          }],
        }),
      } as any;
    });

    const audio = Buffer.from('fake-wave');
    const result = await provider.transcribeAudio(
      'test-key',
      {
        file: {
          filename: 'utterance.wav',
          contentType: 'audio/wav',
          data: audio,
        },
        response_format: 'json',
      },
      'gemini-2.5-flash',
    );

    expect(capturedBody.contents[0].parts[0].text).toContain('Transcribe');
    expect(capturedBody.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') },
    });
    expect(result.body).toEqual({ text: 'Turn on the office light.' });
    expect(result.contentType).toBe('application/json');
    expect(result._routed_via).toEqual({ platform: 'google', model: 'gemini-2.5-flash' });
  });

  it('should generate speech and return WAV audio bytes', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [
                { inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: 'AAAAAA==' } },
              ],
            },
            finishReason: 'STOP',
          }],
        }),
      } as any;
    });

    const result = await (provider as any).createSpeech(
      'test-key',
      {
        input: 'Speak clearly',
        voice: 'alloy',
        response_format: 'wav',
      },
      'gemini-2.5-flash-preview-tts',
    );

    expect(capturedBody.contents[0].parts[0].text).toContain('Say only the following transcript');
    expect(capturedBody.contents[0].parts[0].text).toContain('Speak clearly');
    expect(capturedBody.contents[0].parts[0].text).toContain('Do not answer it');
    expect(capturedBody.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(capturedBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(Buffer.from(result.data).subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(result.contentType).toBe('audio/wav');
    expect(result._routed_via).toEqual({ platform: 'google', model: 'gemini-2.5-flash-preview-tts' });
  });

  it('should create constrained Gemini Live realtime sessions', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          name: 'authTokens/test-token',
          expireTime: '2026-05-21T12:00:00Z',
        }),
      } as any;
    });

    const result = await (provider as any).createRealtimeSession(
      'test-key',
      {
        instructions: 'Speak briefly.',
        voice: 'alloy',
        response_modalities: ['AUDIO'],
        input_audio_transcription: true,
        output_audio_transcription: true,
        temperature: 0.7,
      },
      'gemini-2.5-flash-native-audio-preview-12-2025',
    );

    expect(capturedUrl).toContain('/v1alpha/auth_tokens?key=test-key');
    expect(capturedBody.uses).toBe(1);
    expect(capturedBody.bidiGenerateContentSetup.model).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(capturedBody.bidiGenerateContentSetup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(capturedBody.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(capturedBody.bidiGenerateContentSetup.inputAudioTranscription).toEqual({});
    expect(capturedBody.bidiGenerateContentSetup.outputAudioTranscription).toEqual({});
    expect(result.object).toBe('realtime.session');
    expect(result.client_secret.value).toBe('authTokens/test-token');
    expect(result.connect_url).toContain('BidiGenerateContentConstrained');
    expect(result._routed_via).toEqual({ platform: 'google', model: 'gemini-2.5-flash-native-audio-preview-12-2025' });
  });

  it('should translate Gemini functionCall response to OpenAI tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { city: 'Lahore' },
              },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 3,
          totalTokenCount: 15,
        },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'What is the weather?' }],
      'gemini-2.5-pro',
    );

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].id).toBe('call_123');
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Lahore"}');
  });

  it('should preserve and pass through thought_signature', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                thoughtSignature: 'sig_123',
                functionCall: {
                  id: 'call_123',
                  name: 'get_weather',
                  args: { city: 'London' },
                },
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    // 1. Check extraction
    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    );

    expect(result.choices[0].message.tool_calls?.[0].thought_signature).toBe('sig_123');

    // 2. Check injection in next turn
    await provider.chatCompletion(
      'test-key',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
            thought_signature: 'sig_123',
          }],
        },
        { role: 'tool', tool_call_id: 'call_123', content: '{"temp": 20}' },
      ],
      'gemini-2.5-pro',
    );

    const assistantEntry = capturedBody.contents.find((c: any) => c.role === 'model');
    expect(assistantEntry.parts[0].thoughtSignature).toBe('sig_123');
    expect(assistantEntry.parts[0].functionCall.name).toBe('get_weather');
  });

  // ── Streaming ──────────────────────────────────────────────────────────────
  // Build a Response-shaped object backed by a ReadableStream so the provider's
  // `res.body.getReader()` path executes for real (Node 20+ has both globally).
  function sseResponse(frames: string[]): any {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return { ok: true, body: stream };
  }

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }

  it('streams text deltas and emits a final stop chunk', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ));

    const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('skips a malformed SSE frame instead of aborting the whole stream', async () => {
    // Regression: previously an unguarded JSON.parse would propagate, killing
    // the stream after a single bad chunk. Other providers (openai-compat,
    // cohere, cloudflare) already protect this path with try/catch.
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {oops not json\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ));

    const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('streams functionCall parts as tool_calls with finish_reason=tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"get_weather","args":{"city":"Karachi"}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    ));

    const toolDeltas = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0].function.name).toBe('get_weather');
    expect(toolDeltas[0].function.arguments).toBe('{"city":"Karachi"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
  });
});
