import { describe, expect, it } from 'vitest';
import type { CapabilitiesResponse } from 'llmhub-shared/types.js';
import {
  getConfiguredProviderCount,
  getPlaygroundRouteCapability,
  getPlaygroundMode,
  getSupportedModelCount,
  filterPlaygroundModelsForMode,
  isPlaygroundModeConfigured,
  PLAYGROUND_MODES,
} from 'llmhub-shared/playground.js';

const capabilities: CapabilitiesResponse = {
  capabilities: ['chat', 'embeddings', 'vision', 'video', 'images', 'audio'],
  providers: [
    {
      platform: 'google',
      displayName: 'Google AI Studio',
      docsUrl: 'https://ai.google.dev/gemini-api/docs',
      apiBaseUrl: 'https://generativelanguage.googleapis.com',
      requiresKey: true,
      keyCount: 1,
      capabilities: {
        chat: { supportedModels: 5, configured: true, status: 'configured' },
        embeddings: { supportedModels: 0, configured: false, status: 'unsupported' },
        vision: { supportedModels: 5, configured: true, status: 'configured' },
        video: { supportedModels: 2, configured: true, status: 'configured' },
        images: { supportedModels: 1, configured: true, status: 'configured' },
        audio: { supportedModels: 2, configured: true, status: 'configured' },
      },
    },
    {
      platform: 'openrouter',
      displayName: 'OpenRouter',
      docsUrl: 'https://openrouter.ai/docs/api/reference/overview',
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      requiresKey: true,
      keyCount: 0,
      capabilities: {
        chat: { supportedModels: 19, configured: false, status: 'missing_key' },
        embeddings: { supportedModels: 3, configured: false, status: 'missing_key' },
        vision: { supportedModels: 0, configured: false, status: 'unsupported' },
        video: { supportedModels: 4, configured: false, status: 'missing_key' },
        images: { supportedModels: 0, configured: false, status: 'unsupported' },
        audio: { supportedModels: 0, configured: false, status: 'unsupported' },
      },
    },
  ],
};

describe('playground capability helpers', () => {
  it('defines test modes for every user-facing capability endpoint', () => {
    expect(PLAYGROUND_MODES.map(mode => mode.id)).toEqual([
      'chat',
      'gemini_generate',
      'gemini_stream',
      'vision',
      'video',
      'embeddings',
      'image_generation',
      'image_edit',
      'image_variation',
      'speech',
      'transcription',
      'translation',
      'realtime',
    ]);

    expect(getPlaygroundMode('image_generation')).toMatchObject({
      capability: 'images',
      endpoint: '/v1/images/generations',
    });
    expect(getPlaygroundMode('video')).toMatchObject({
      capability: 'video',
      endpoint: '/v1/chat/completions',
      requestKind: 'json',
    });
    expect(getPlaygroundMode('realtime')).toMatchObject({
      capability: 'audio',
      endpoint: '/v1/realtime/sessions',
    });
  });

  it('summarizes configured providers and supported models for a playground mode', () => {
    expect(isPlaygroundModeConfigured(capabilities, 'vision')).toBe(true);
    expect(getConfiguredProviderCount(capabilities, 'vision')).toBe(1);
    expect(getSupportedModelCount(capabilities, 'vision')).toBe(5);

    expect(isPlaygroundModeConfigured(capabilities, 'video')).toBe(true);
    expect(getConfiguredProviderCount(capabilities, 'video')).toBe(1);
    expect(getSupportedModelCount(capabilities, 'video')).toBe(6);

    expect(isPlaygroundModeConfigured(capabilities, 'embeddings')).toBe(false);
    expect(getConfiguredProviderCount(capabilities, 'embeddings')).toBe(0);
    expect(getSupportedModelCount(capabilities, 'embeddings')).toBe(3);
  });

  it('filters model selectors to models that support the active route capability', () => {
    const models = [
      { modelId: 'chat-model', enabled: true, keyCount: 1, capabilities: ['chat'] },
      { modelId: 'vision-model', enabled: true, keyCount: 1, capabilities: ['chat', 'vision'] },
      { modelId: 'video-model', enabled: true, keyCount: 1, capabilities: ['chat', 'video'] },
      { modelId: 'speech-model', enabled: true, keyCount: 1, capabilities: ['audio', 'speech'] },
      { modelId: 'realtime-model', enabled: true, keyCount: 1, capabilities: ['audio', 'realtime_audio'] },
      { modelId: 'missing-key', enabled: true, keyCount: 0, capabilities: ['vision'] },
      { modelId: 'disabled', enabled: false, keyCount: 1, capabilities: ['vision'] },
    ];

    expect(getPlaygroundRouteCapability('speech')).toBe('speech');
    expect(getPlaygroundRouteCapability('realtime')).toBe('realtime_audio');
    expect(filterPlaygroundModelsForMode(models, 'vision').map(model => model.modelId)).toEqual(['vision-model']);
    expect(filterPlaygroundModelsForMode(models, 'video').map(model => model.modelId)).toEqual(['video-model']);
    expect(filterPlaygroundModelsForMode(models, 'speech').map(model => model.modelId)).toEqual(['speech-model']);
    expect(filterPlaygroundModelsForMode(models, 'realtime').map(model => model.modelId)).toEqual(['realtime-model']);
  });
});
