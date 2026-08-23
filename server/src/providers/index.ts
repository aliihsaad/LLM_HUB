import type { Platform } from 'llmhub-shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';

const providers = new Map<Platform, BaseProvider>();

function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}

// Google - unique Gemini API format
register(new GoogleProvider());

// Groq - OpenAI-compatible. Groq and Cerebras deliberately keep the 15s
// default: both run custom inference silicon and logged zero aborts in
// production (161 and 30 failures respectively, none of them timeouts).
register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
}));

// Cerebras - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
}));

// SambaNova - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'sambanova',
  name: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
  // 31 aborts logged; 6 of its 7 enabled rows are Frontier/Large.
  timeoutMs: 60000,
}));

// NVIDIA NIM - OpenAI-compatible. The catalog is almost entirely large models
// (70B Llamas, 120B/550B Nemotrons, DeepSeek/Kimi/MiniMax frontier tiers) and
// the shared free-credit pool is not latency-guaranteed, so first token
// regularly lands past the 15s default — meta/llama-3.1-70b-instruct was
// failing with "This operation was aborted". Worse, classifyProviderError maps
// an abort to a 120s key cooldown, so one slow request benched the whole
// provider. Bumped to the 60s used by the other slow cloud providers.
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  timeoutMs: 60000,
}));

// Mistral - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  // 11 aborts logged on the large models.
  timeoutMs: 60000,
}));

// OpenRouter - OpenAI-compatible with extra headers
register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3001',
    'X-Title': 'LLM-Hub',
  },
  // Largest catalog (25 enabled) and an aggregator that queues free-tier
  // traffic behind paid, so slow responses are routine. Matches the bump
  // BazaarLink already had for the same reason.
  timeoutMs: 60000,
}));

// GitHub Models — OpenAI-compatible. Catalog uses `<publisher>/<model>` ids
// (e.g. `openai/gpt-4.1`); the old Azure endpoint rejects that prefix with
// "Unknown model", so route to the current models.github.ai endpoint.
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.github.ai/inference',
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Hugging Face Inference Providers — OpenAI-compatible chat router.
register(new OpenAICompatProvider({
  platform: 'huggingface',
  name: 'Hugging Face Inference Providers',
  baseUrl: 'https://router.huggingface.co/v1',
  timeoutMs: 60000,
}));

// Vercel AI Gateway — OpenAI-compatible gateway with monthly free credits.
register(new OpenAICompatProvider({
  platform: 'vercel',
  name: 'Vercel AI Gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  timeoutMs: 60000,
}));

// ModelScope API Inference — OpenAI-compatible LLM API for selected models.
register(new OpenAICompatProvider({
  platform: 'modelscope',
  name: 'ModelScope API Inference',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  timeoutMs: 60000,
}));

// Qwen Cloud / DashScope international OpenAI-compatible endpoint.
register(new OpenAICompatProvider({
  platform: 'qwen',
  name: 'Qwen Cloud',
  baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  timeoutMs: 60000,
}));

// SiliconFlow — OpenAI-compatible API with fixed limits for free models.
register(new OpenAICompatProvider({
  platform: 'siliconflow',
  name: 'SiliconFlow',
  baseUrl: 'https://api.siliconflow.cn/v1',
  timeoutMs: 60000,
}));

// OVHcloud AI Endpoints — OpenAI-compatible API in the Kepler endpoint.
register(new OpenAICompatProvider({
  platform: 'ovhcloud',
  name: 'OVHcloud AI Endpoints',
  baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  timeoutMs: 60000,
}));

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  // 7 aborts logged; GLM frontier models are slow to first token.
  timeoutMs: 60000,
}));

// Ollama Cloud — OpenAI-compatible. Free plan: 1 concurrent model, 5h session
// caps, GPU-time-based quota (not per-token). Many catalog models on the
// /v1/models list are subscription-only — Free returns 403 with an explicit
// "this model requires a subscription" message. Catalog rows are filtered to
// confirmed-Free entries.
//
// Frontier reasoning models (glm-4.7, kimi-k2-thinking, cogito-2.1:671b)
// regularly take 30-90s on Ollama Cloud Free, so the timeout is bumped from
// the default 15s. Ollama returns reasoning in `message.reasoning` (not
// `reasoning_content`) — handled by normalizeChoices.
register(new OpenAICompatProvider({
  platform: 'ollama',
  name: 'Ollama Cloud',
  baseUrl: 'https://ollama.com/v1',
  timeoutMs: 120000,
}));

// Kilo AI Gateway — OpenAI-compatible aggregator. Anonymous access works
// (200 req/hr per IP) for the few :free routes still active; a Kilo API key
// raises the limit. Most named "free" routes in the docs have transitioned to
// paid ("free period ended") — probe before adding catalog rows.
register(new OpenAICompatProvider({
  platform: 'kilo',
  name: 'Kilo Gateway',
  baseUrl: 'https://api.kilo.ai/api/gateway/v1',
  // Aggregator fronting a 120B free route.
  timeoutMs: 60000,
}));

// Pollinations — OpenAI-compatible, anonymous tier. The chat completions
// endpoint lives at `/openai/v1/chat/completions` (NOT `/v1/...` — the
// `/openai` prefix is mandatory). Public model list returns one anonymous
// model (`openai-fast` = GPT-OSS 20B on OVH, tools=true).
register(new OpenAICompatProvider({
  platform: 'pollinations',
  name: 'Pollinations',
  baseUrl: 'https://text.pollinations.ai/openai/v1',
  // Measured 2026-08-23: 29.9s to respond across three trials on the
  // anonymous tier, so every request aborted at the 15s default.
  timeoutMs: 60000,
}));

// LLM7.io — OpenAI-compatible aggregator. 100 req/hr free; anonymous access
// also works for basic models. Wraps a handful of upstream models behind one
// token (GPT-OSS, Llama 3.1 Turbo via Meta, Codestral via Mistral, Ministral,
// GLM-4.6V-Flash).
register(new OpenAICompatProvider({
  platform: 'llm7',
  name: 'LLM7',
  baseUrl: 'https://api.llm7.io/v1',
  // 4 aborts logged; aggregator with a 400k-context frontier row.
  timeoutMs: 60000,
}));

// BazaarLink — OpenAI-compatible aggregator (keys start with sk-bl-). Bare
// model ids are canonical (`glm-5.1`); `provider/model` aliases also work.
// `auto:free` routes to zero-cost inference (4M tokens/day per account);
// other catalog models bill against the key's credit. Frontier models via
// an aggregator can be slow, so the timeout matches other aggregators.
register(new OpenAICompatProvider({
  platform: 'bazaarlink',
  name: 'BazaarLink',
  baseUrl: 'https://bazaarlink.ai/api/v1',
  timeoutMs: 60000,
}));

// Chutes was evaluated for V11 and dropped: probe with a free-tier key
// returned 402 on every model — "Quota exceeded and account balance is
// $0.0, please pay with fiat or send tao". The "free" tier requires a
// non-zero balance, which conflicts with the project's no-card criterion.

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
