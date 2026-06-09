import type { Platform, ProviderMetadata } from 'llmhub-shared/types.js';
export declare const PLATFORM_ORDER: readonly ["google", "groq", "cerebras", "sambanova", "nvidia", "mistral", "openrouter", "github", "cohere", "cloudflare", "huggingface", "vercel", "modelscope", "qwen", "siliconflow", "ovhcloud", "zhipu", "ollama", "kilo", "pollinations", "llm7"];
export declare const PROVIDER_METADATA: Record<Platform, ProviderMetadata>;
export declare function listProviderMetadata(): ProviderMetadata[];
export declare function getProviderMetadata(platform: Platform): ProviderMetadata;
//# sourceMappingURL=provider-metadata.d.ts.map