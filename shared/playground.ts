import type { CapabilitiesResponse, ModelCapability } from './types.js';

export type PlaygroundCapabilityMode =
  | 'chat'
  | 'gemini_generate'
  | 'gemini_stream'
  | 'vision'
  | 'embeddings'
  | 'image_generation'
  | 'image_edit'
  | 'image_variation'
  | 'speech'
  | 'transcription'
  | 'translation'
  | 'realtime';

export type PlaygroundRequestKind = 'json' | 'multipart' | 'binary';

export type PlaygroundRouteCapability =
  | 'chat'
  | 'embeddings'
  | 'vision'
  | 'image_generation'
  | 'image_edit'
  | 'image_variation'
  | 'speech'
  | 'transcription'
  | 'translation'
  | 'realtime_audio';

export interface PlaygroundModelCapabilityOption {
  enabled?: boolean;
  keyCount?: number;
  capabilities?: readonly string[];
}

export interface PlaygroundModeDefinition {
  id: PlaygroundCapabilityMode;
  capability: ModelCapability;
  label: string;
  endpoint: string;
  requestKind: PlaygroundRequestKind;
}

export const PLAYGROUND_MODES: PlaygroundModeDefinition[] = [
  {
    id: 'chat',
    capability: 'chat',
    label: 'Chat',
    endpoint: '/v1/chat/completions',
    requestKind: 'json',
  },
  {
    id: 'gemini_generate',
    capability: 'chat',
    label: 'Gemini generate',
    endpoint: '/gemini/v1beta/models/gemini-2.5-flash:generateContent',
    requestKind: 'json',
  },
  {
    id: 'gemini_stream',
    capability: 'chat',
    label: 'Gemini stream',
    endpoint: '/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent',
    requestKind: 'json',
  },
  {
    id: 'vision',
    capability: 'vision',
    label: 'Vision',
    endpoint: '/v1/chat/completions',
    requestKind: 'json',
  },
  {
    id: 'embeddings',
    capability: 'embeddings',
    label: 'Embeddings',
    endpoint: '/v1/embeddings',
    requestKind: 'json',
  },
  {
    id: 'image_generation',
    capability: 'images',
    label: 'Image generation',
    endpoint: '/v1/images/generations',
    requestKind: 'json',
  },
  {
    id: 'image_edit',
    capability: 'images',
    label: 'Image edit',
    endpoint: '/v1/images/edits',
    requestKind: 'multipart',
  },
  {
    id: 'image_variation',
    capability: 'images',
    label: 'Image variation',
    endpoint: '/v1/images/variations',
    requestKind: 'multipart',
  },
  {
    id: 'speech',
    capability: 'audio',
    label: 'Speech',
    endpoint: '/v1/audio/speech',
    requestKind: 'binary',
  },
  {
    id: 'transcription',
    capability: 'audio',
    label: 'Transcription',
    endpoint: '/v1/audio/transcriptions',
    requestKind: 'multipart',
  },
  {
    id: 'translation',
    capability: 'audio',
    label: 'Translation',
    endpoint: '/v1/audio/translations',
    requestKind: 'multipart',
  },
  {
    id: 'realtime',
    capability: 'audio',
    label: 'Realtime session',
    endpoint: '/v1/realtime/sessions',
    requestKind: 'json',
  },
];

export function getPlaygroundMode(mode: PlaygroundCapabilityMode): PlaygroundModeDefinition {
  const definition = PLAYGROUND_MODES.find(item => item.id === mode);
  if (!definition) throw new Error(`Unknown playground mode: ${mode}`);
  return definition;
}

export function getPlaygroundRouteCapability(mode: PlaygroundCapabilityMode): PlaygroundRouteCapability {
  switch (mode) {
    case 'embeddings':
      return 'embeddings';
    case 'vision':
      return 'vision';
    case 'image_generation':
      return 'image_generation';
    case 'image_edit':
      return 'image_edit';
    case 'image_variation':
      return 'image_variation';
    case 'speech':
      return 'speech';
    case 'transcription':
      return 'transcription';
    case 'translation':
      return 'translation';
    case 'realtime':
      return 'realtime_audio';
    case 'chat':
    case 'gemini_generate':
    case 'gemini_stream':
      return 'chat';
  }
}

export function filterPlaygroundModelsForMode<T extends PlaygroundModelCapabilityOption>(
  models: readonly T[],
  mode: PlaygroundCapabilityMode,
): T[] {
  const capability = getPlaygroundRouteCapability(mode);
  return models.filter(model => {
    if (model.enabled === false) return false;
    if ((model.keyCount ?? 1) <= 0) return false;
    return model.capabilities?.includes(capability) === true;
  });
}

export function getConfiguredProviderCount(response: CapabilitiesResponse | undefined, mode: PlaygroundCapabilityMode): number {
  if (!response) return 0;
  const capability = getPlaygroundMode(mode).capability;
  return response.providers.filter(provider => provider.capabilities[capability]?.configured).length;
}

export function getSupportedModelCount(response: CapabilitiesResponse | undefined, mode: PlaygroundCapabilityMode): number {
  if (!response) return 0;
  const capability = getPlaygroundMode(mode).capability;
  return response.providers.reduce((total, provider) => {
    return total + (provider.capabilities[capability]?.supportedModels ?? 0);
  }, 0);
}

export function isPlaygroundModeConfigured(response: CapabilitiesResponse | undefined, mode: PlaygroundCapabilityMode): boolean {
  return getConfiguredProviderCount(response, mode) > 0;
}
