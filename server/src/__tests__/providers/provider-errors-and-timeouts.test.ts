import { describe, it, expect, vi, afterEach } from 'vitest';
import { readProviderErrorText } from '../../providers/base.js';
import { getProvider } from '../../providers/index.js';
import { CohereProvider } from '../../providers/cohere.js';

describe('readProviderErrorText', () => {
  // Every shape below was captured from a live provider on 2026-08-23 by
  // sending an invalid bearer token. Before this helper, anything that was not
  // `error.message` collapsed to res.statusText.
  const cases: Array<[string, unknown, string]> = [
    ['Groq / OpenRouter envelope', { error: { message: 'Invalid API Key' } }, 'Invalid API Key'],
    ['Cerebras bare message', { message: 'Wrong API Key' }, 'Wrong API Key'],
    ['Cohere bare message', { id: 'x', message: 'Incorrect API key provided' }, 'Incorrect API key provided'],
    ['Mistral bare detail', { detail: 'Invalid API Key' }, 'Invalid API Key'],
    ['Hugging Face string error', { error: 'Invalid username or password.' }, 'Invalid username or password.'],
    ['Cloudflare errors array', { success: false, errors: [{ code: 7003, message: 'Could not route' }] }, 'Could not route'],
    [
      'NVIDIA RFC 7807',
      { type: 'about:blank', title: 'Gone', status: 410, detail: "The model 'x' has reached its end of life" },
      "Gone: The model 'x' has reached its end of life",
    ],
    ['RFC 7807 title only', { status: 404, title: 'Not Found' }, 'Not Found'],
  ];

  for (const [name, body, expected] of cases) {
    it(`reads the ${name}`, () => {
      expect(readProviderErrorText(body, 'STATUSTEXT')).toBe(expected);
    });
  }

  it('falls back to statusText for unusable bodies', () => {
    for (const body of [{}, null, undefined, 'a string', { error: {} }, { message: '   ' }]) {
      expect(readProviderErrorText(body, 'Bad Gateway')).toBe('Bad Gateway');
    }
  });
});

describe('Cohere error extraction', () => {
  afterEach(() => vi.restoreAllMocks());

  // Cohere answers {"id":"...","message":"..."} with no `error` envelope, so
  // reading error.message showed only "Unauthorized".
  it('surfaces the bare message field Cohere returns', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({
        id: '1c998246',
        message: 'Incorrect API key provided: ****-123. You can find your API key at https://dashboard.cohere.com/api-keys.',
      }),
    } as any));

    await expect(
      new CohereProvider().chatCompletion('bad-key', [{ role: 'user', content: 'hi' }], 'command-r'),
    ).rejects.toThrow(/Incorrect API key provided/);
  });
});

describe('provider HTTP timeouts', () => {
  // Production abort counts before these overrides: nvidia 182, google 67,
  // sambanova 31, mistral 11, zhipu 7, llm7 4. An abort also costs a 120s key
  // cooldown in classifyProviderError, so a slow provider benches itself.
  const SLOW_PROVIDERS = [
    'google', 'nvidia', 'sambanova', 'mistral', 'openrouter', 'zhipu',
    'kilo', 'llm7', 'pollinations', 'cohere', 'cloudflare',
    'huggingface', 'vercel', 'modelscope', 'qwen', 'siliconflow',
    'ovhcloud', 'bazaarlink', 'ollama',
  ] as const;

  // Custom inference silicon; zero aborts logged despite 161 and 30 failures.
  const FAST_PROVIDERS = ['groq', 'cerebras'] as const;

  const timeoutOf = (platform: string): number | undefined => {
    const p = getProvider(platform as never) as unknown as {
      timeoutMs?: number;
      defaultTimeoutMs?: number;
    } | undefined;
    if (!p) return undefined;
    return p.timeoutMs ?? p.defaultTimeoutMs;
  };

  for (const platform of SLOW_PROVIDERS) {
    it(`${platform} allows more than the 15s default`, () => {
      const ms = timeoutOf(platform);
      expect(ms, `${platform} should be registered`).toBeDefined();
      expect(ms!, `${platform} must not run on the 15s default`).toBeGreaterThanOrEqual(60000);
    });
  }

  for (const platform of FAST_PROVIDERS) {
    it(`${platform} deliberately keeps the fast default`, () => {
      expect(timeoutOf(platform)).toBe(15000);
    });
  }
});
