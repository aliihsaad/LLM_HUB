// ---- Platform & Model Types ----

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
export type Platform =
  | 'google'
  | 'groq'
  | 'cerebras'
  | 'sambanova'
  | 'nvidia'
  | 'mistral'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'huggingface'
  | 'vercel'
  | 'modelscope'
  | 'qwen'
  | 'siliconflow'
  | 'ovhcloud'
  | 'zhipu'
  | 'ollama'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'bazaarlink';

export interface Model {
  id: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
}

export type ModelCapability = 'chat' | 'embeddings' | 'vision' | 'video' | 'images' | 'audio';

export interface CapabilityLight {
  supportedModels: number;
  configured: boolean;
  status: 'configured' | 'missing_key' | 'unsupported';
}

export interface ProviderMetadata {
  platform: Platform;
  displayName: string;
  docsUrl: string;
  keyUrl?: string;
  consoleUrl?: string;
  apiBaseUrl: string;
  requiresKey: boolean;
}

export interface ProviderCapabilitySummary extends ProviderMetadata {
  keyCount: number;
  capabilities: Record<ModelCapability, CapabilityLight>;
}

export interface CapabilitiesResponse {
  capabilities: ModelCapability[];
  providers: ProviderCapabilitySummary[];
}

export interface ProvidersResponse {
  providers: ProviderMetadata[];
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
}

// ---- Model Sweep Types ----

export type ModelSweepStatus = 'running' | 'completed' | 'failed';
export type ModelSweepResultStatus = 'passed' | 'failed' | 'skipped';
export type ModelSweepErrorCategory =
  | 'zero_quota'
  | 'rate_limit'
  | 'model_unavailable'
  | 'timeout'
  | 'provider'
  | 'auth'
  | 'other';

export interface ModelSweepResult {
  modelDbId: number;
  platform: Platform | string;
  providerDisplayName: string;
  modelId: string;
  displayName: string;
  status: ModelSweepResultStatus;
  latencyMs: number | null;
  errorCategory: ModelSweepErrorCategory | null;
  error: string | null;
  keyAttempts: number;
}

export interface ModelSweepJob {
  id: string;
  status: ModelSweepStatus;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  quarantined: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  currentModel: string | null;
  note: string;
  results: ModelSweepResult[];
}

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: {
      name: string;
    };
  };

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface ChatVideoUrlContentPart {
  type: 'video_url';
  video_url: {
    url: string;
  };
}

export type ChatContentPart = ChatTextContentPart | ChatImageUrlContentPart | ChatVideoUrlContentPart;
export type ChatMessageContent = string | ChatContentPart[] | null;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
}

// ---- Embeddings Types ----

export type EmbeddingInput = string | string[] | number[] | number[][];

export interface EmbeddingOptions {
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface EmbeddingRequest extends EmbeddingOptions {
  model?: string;
  input: EmbeddingInput;
}

export interface Embedding {
  object: 'embedding';
  embedding: number[] | string;
  index: number;
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: Embedding[];
  model: string;
  usage: EmbeddingUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

// ---- Images Types ----

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: 'auto' | 'standard' | 'hd' | 'low' | 'medium' | 'high';
  response_format?: 'url' | 'b64_json';
  style?: 'vivid' | 'natural';
  user?: string;
}

export interface ImageData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImagesResponse {
  created: number;
  data: ImageData[];
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export interface ImageFileUpload {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface ImageEditRequest {
  model?: string;
  images: ImageFileUpload[];
  mask?: ImageFileUpload;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
  user?: string;
}

export interface ImageVariationRequest {
  model?: string;
  image: ImageFileUpload;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
  user?: string;
}

// ---- Audio / Speech Types ----

export type SpeechResponseFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface SpeechRequest {
  model?: string;
  input: string;
  voice: string;
  response_format?: SpeechResponseFormat;
  speed?: number;
  instructions?: string;
  user?: string;
}

export interface SpeechResult {
  data: Uint8Array;
  contentType: string;
  format: SpeechResponseFormat;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export type AudioTextResponseFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';

export interface AudioFileUpload {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface AudioTranscriptionRequest {
  model?: string;
  file?: AudioFileUpload;
  url?: string;
  language?: string;
  prompt?: string;
  response_format?: AudioTextResponseFormat;
  temperature?: number;
  timestamp_granularities?: Array<'word' | 'segment'>;
  user?: string;
}

export interface AudioTranslationRequest {
  model?: string;
  file?: AudioFileUpload;
  url?: string;
  prompt?: string;
  response_format?: AudioTextResponseFormat;
  temperature?: number;
  user?: string;
}

export interface AudioTextResult {
  body: unknown;
  contentType: string;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

// ---- Realtime Audio Types ----

export type RealtimeResponseModality = 'AUDIO' | 'TEXT';

export interface RealtimeSessionRequest {
  model?: string;
  provider?: 'google';
  instructions?: string;
  voice?: string;
  response_modalities?: RealtimeResponseModality[];
  input_audio_transcription?: boolean;
  output_audio_transcription?: boolean;
  temperature?: number;
  expires_in_seconds?: number;
  user?: string;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
}

export interface RealtimeSessionResponse {
  object: 'realtime.session';
  id: string;
  provider: Platform;
  model: string;
  expires_at: number;
  client_secret: {
    value: string;
    expires_at: number;
  };
  connect_url: string;
  config: {
    response_modalities: RealtimeResponseModality[];
    input_audio_transcription?: boolean;
    output_audio_transcription?: boolean;
    voice?: string;
    instructions?: string;
    temperature?: number;
    tools?: string[];
  };
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  estimatedCostSavings: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export type UsagePressure = 'low' | 'medium' | 'high' | 'critical';
export type UsageEstimateSource = 'local_tokens' | 'session_mint';

export interface UsageEstimateModel {
  platform: Platform | string;
  modelId: string;
  displayName: string;
  requests: number;
  usedTokens: number;
  estimatedMonthlyBudget: number;
  usagePercent: number;
  pressure: UsagePressure;
  usageText: string;
  usageSource: UsageEstimateSource;
}

export interface UsageEstimateProvider {
  platform: Platform | string;
  requests: number;
  activeKeyCount: number;
  modelCount: number;
  usedTokens: number;
  estimatedMonthlyBudget: number;
  usagePercent: number;
  pressure: UsagePressure;
  usageText: string;
  topModels: UsageEstimateModel[];
}

export interface UsageEstimatesResponse {
  range: string;
  generatedAt: string;
  note: string;
  total: {
    usedTokens: number;
    estimatedMonthlyBudget: number;
    usagePercent: number;
    pressure: UsagePressure;
    usageText: string;
  };
  providers: UsageEstimateProvider[];
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- Logs / Diagnostics Types ----

export type LogErrorCategory =
  | 'zero_quota'
  | 'rate_limit'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'timeout'
  | 'provider'
  | 'routing'
  | 'other';

export type DiagnosticSeverity = 'info' | 'warning' | 'critical';

export interface LogSummary {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  activeProviders: number;
}

export interface DiagnosticFlag {
  id: string;
  category: LogErrorCategory;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  recommendation: string;
  count: number;
  platform: Platform | string;
  modelId: string | null;
}

export interface ProviderRanking {
  rank: number;
  platform: Platform | string;
  score: number;
  status: 'excellent' | 'good' | 'degraded' | 'blocked' | 'idle';
  requests: number;
  errors: number;
  successRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  keyCount: number;
  healthyKeys: number;
  invalidKeys: number;
  penalty: number;
  topFlag: LogErrorCategory | null;
  recommendation: string;
}

export interface LogEntry {
  id: number;
  platform: Platform | string;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  errorCategory: LogErrorCategory | null;
  severity: DiagnosticSeverity;
  suggestion: string;
  createdAt: string;
}

export interface LogsDiagnosticsResponse {
  summary: LogSummary;
  flags: DiagnosticFlag[];
  rankings: ProviderRanking[];
  recent: LogEntry[];
}

// ---- Rate Limit Types ----

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}
