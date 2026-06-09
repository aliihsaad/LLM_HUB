import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  EmbeddingInput,
  EmbeddingOptions,
  EmbeddingResponse,
  ImageEditRequest,
  ImageVariationRequest,
  ImageGenerationRequest,
  ImagesResponse,
  Platform,
  AudioTextResult,
  AudioTranscriptionRequest,
  AudioTranslationRequest,
  RealtimeSessionRequest,
  RealtimeSessionResponse,
  SpeechRequest,
  SpeechResult,
} from 'llmhub-shared/types.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  async createEmbedding(
    _apiKey: string,
    _input: EmbeddingInput,
    _modelId: string,
    _options?: EmbeddingOptions,
  ): Promise<EmbeddingResponse> {
    throw new Error(`${this.name} does not support embeddings`);
  }

  async createImage(
    _apiKey: string,
    _request: ImageGenerationRequest,
    _modelId: string,
  ): Promise<ImagesResponse> {
    throw new Error(`${this.name} does not support image generation`);
  }

  async editImage(
    _apiKey: string,
    _request: ImageEditRequest,
    _modelId: string,
  ): Promise<ImagesResponse> {
    throw new Error(`${this.name} does not support image edits`);
  }

  async createImageVariation(
    _apiKey: string,
    _request: ImageVariationRequest,
    _modelId: string,
  ): Promise<ImagesResponse> {
    throw new Error(`${this.name} does not support image variations`);
  }

  async createSpeech(
    _apiKey: string,
    _request: SpeechRequest,
    _modelId: string,
  ): Promise<SpeechResult> {
    throw new Error(`${this.name} does not support speech`);
  }

  async transcribeAudio(
    _apiKey: string,
    _request: AudioTranscriptionRequest,
    _modelId: string,
  ): Promise<AudioTextResult> {
    throw new Error(`${this.name} does not support transcription`);
  }

  async translateAudio(
    _apiKey: string,
    _request: AudioTranslationRequest,
    _modelId: string,
  ): Promise<AudioTextResult> {
    throw new Error(`${this.name} does not support translation`);
  }

  async createRealtimeSession(
    _apiKey: string,
    _request: RealtimeSessionRequest,
    _modelId: string,
  ): Promise<RealtimeSessionResponse> {
    throw new Error(`${this.name} does not support realtime sessions`);
  }

  abstract validateKey(apiKey: string): Promise<boolean>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
