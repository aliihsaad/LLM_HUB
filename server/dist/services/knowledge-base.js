/**
 * Context7 Knowledge Base Service
 *
 * Integrates with Context7 MCP (or a configured endpoint) to fetch
 * up-to-date API documentation and schemas for all providers.
 * Stores knowledge in the local DB for fast querying.
 *
 * If Context7 API is not configured, shows an admin warning and
 * falls back to locally-seeded documentation.
 */
import { getDb } from '../db/index.js';
import { listProviderMetadata } from '../lib/provider-metadata.js';
const DEFAULT_CONTEXT7_API_URL = 'https://context7.com/api/v2';
const CONTEXT7_TOPICS = {
    free_tier_limits: 'free tier limits rate limits quotas pricing tokens RPM RPD TPM context window',
    api_reference: 'API reference endpoints chat completions models embeddings images audio streaming request response',
    authentication: 'authentication API key bearer token headers base URL authorization',
};
// In-memory cache for fast repeated queries
const knowledgeCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let context7WarningLogged = false;
function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? null;
}
function normalizeSetting(value) {
    return value?.trim() || null;
}
/**
 * Get Context7 API configuration from dashboard-stored key or env override.
 * The endpoint URL is fixed and does not need operator configuration.
 */
export function getContext7Config() {
    const apiUrl = DEFAULT_CONTEXT7_API_URL;
    const apiKey = normalizeSetting(process.env.CONTEXT7_API_KEY)
        || normalizeSetting(getSetting('context7_api_key'));
    return {
        apiUrl,
        apiKey,
        configured: Boolean(apiUrl && apiKey),
    };
}
/**
 * Log a warning banner if Context7 is not configured.
 * Only logs once per process lifetime.
 */
export function logContext7Warning() {
    if (context7WarningLogged)
        return;
    const config = getContext7Config();
    if (!config.configured) {
        console.warn(`
╔════════════════════════════════════════════════════════════════╗
║  ⚠️  CONTEXT7 API NOT CONFIGURED                               ║
╠════════════════════════════════════════════════════════════════╣
║  Knowledge base is running with locally-seeded defaults.       ║
║  To enable live Context7 integration:                          ║
║                                                                ║
║  1. Get a Context7 API key from https://context7.ai            ║
║  2. Set CONTEXT7_API_KEY in your .env file                    ║
║     or configure the key in dashboard Settings.                ║
╚════════════════════════════════════════════════════════════════╝
`);
        context7WarningLogged = true;
    }
}
/**
 * Check if Context7 is configured and healthy.
 */
export function isContext7Configured() {
    return getContext7Config().configured;
}
/**
 * Initialize the knowledge_base table if not exists.
 * Called during DB setup.
 */
export function initKnowledgeBase(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      source_url TEXT,
      version TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_verified_at TEXT,
      UNIQUE(provider, topic)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_provider ON knowledge_base(provider);
    CREATE INDEX IF NOT EXISTS idx_kb_topic ON knowledge_base(topic);
  `);
}
/**
 * Fetch provider documentation from Context7 API.
 */
export async function fetchFromContext7(provider, topic) {
    const config = getContext7Config();
    if (!config.configured || !config.apiUrl) {
        logContext7Warning();
        return null;
    }
    const providerMetadata = listProviderMetadata().find(item => item.platform === provider);
    const library = await resolveContext7Library(providerMetadata?.displayName ?? provider, providerMetadata?.docsUrl, config);
    if (!library)
        return null;
    return fetchContext7Topic(library.id, CONTEXT7_TOPICS[topic] ?? topic, config);
}
function getContext7Headers(config) {
    const headers = { Accept: 'application/json' };
    if (config.apiKey)
        headers.Authorization = `Bearer ${config.apiKey}`;
    return headers;
}
async function fetchContext7Json(url, config) {
    const res = await fetch(url.toString(), {
        headers: getContext7Headers(config),
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) {
        throw new Error('Context7 authentication failed. Check the API key in Settings.');
    }
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? body?.error ?? `Context7 request failed with HTTP ${res.status}`);
    }
    return await res.json();
}
async function resolveContext7Library(libraryName, docsUrl, config) {
    if (!config.apiUrl)
        return null;
    const url = new URL(`${config.apiUrl}/libs/search`);
    url.searchParams.set('libraryName', libraryName);
    url.searchParams.set('query', docsUrl ? `${libraryName} API documentation ${docsUrl}` : `${libraryName} API documentation`);
    const data = await fetchContext7Json(url, config);
    return data.results?.[0] ?? null;
}
async function fetchContext7Topic(libraryId, query, config) {
    if (!config.apiUrl)
        return null;
    const url = new URL(`${config.apiUrl}/context`);
    url.searchParams.set('libraryId', libraryId);
    url.searchParams.set('query', query);
    url.searchParams.set('type', 'json');
    const data = await fetchContext7Json(url, config);
    return formatContext7Context(data);
}
function formatContext7Context(data) {
    const sections = [];
    for (const snippet of data.infoSnippets ?? []) {
        if (!snippet.content)
            continue;
        sections.push([snippet.title, snippet.content].filter(Boolean).join('\n'));
    }
    for (const snippet of data.codeSnippets ?? []) {
        const code = (snippet.codeList ?? [])
            .map(item => item.code)
            .filter((value) => Boolean(value))
            .join('\n\n');
        if (!code)
            continue;
        sections.push([snippet.codeTitle, code].filter(Boolean).join('\n'));
    }
    const content = sections.join('\n\n---\n\n').trim();
    return content || null;
}
/**
 * Sync provider documentation from Context7 API.
 * Falls back to local knowledge if Context7 is not configured.
 */
export async function syncContext7Knowledge() {
    const config = getContext7Config();
    if (!config.configured) {
        logContext7Warning();
        return { synced: 0, failed: 0, providers: [] };
    }
    const providers = listProviderMetadata();
    const topics = Object.keys(CONTEXT7_TOPICS);
    let synced = 0;
    let failed = 0;
    const providerResults = [];
    for (const provider of providers) {
        let providerSynced = 0;
        let providerFailed = 0;
        try {
            const library = await resolveContext7Library(provider.displayName, provider.docsUrl, config);
            if (!library) {
                providerFailed = topics.length;
                failed += providerFailed;
                providerResults.push({
                    provider: provider.platform,
                    displayName: provider.displayName,
                    synced: providerSynced,
                    failed: providerFailed,
                });
                continue;
            }
            for (const topic of topics) {
                const content = await fetchContext7Topic(library.id, CONTEXT7_TOPICS[topic], config);
                if (content) {
                    const sourceUrl = library.id.startsWith('/')
                        ? `https://context7.com${library.id}`
                        : config.apiUrl ?? undefined;
                    storeKnowledge(provider.platform, topic, content, sourceUrl, undefined);
                    synced++;
                    providerSynced++;
                }
                else {
                    failed++;
                    providerFailed++;
                }
            }
        }
        catch (err) {
            if (String(err.message).includes('authentication failed')) {
                throw err;
            }
            providerFailed = topics.length - providerSynced;
            failed += providerFailed;
            console.warn(`[Context7] ${provider.displayName}: ${err.message}`);
        }
        providerResults.push({
            provider: provider.platform,
            displayName: provider.displayName,
            synced: providerSynced,
            failed: providerFailed,
        });
    }
    console.log(`[Context7] Sync complete: ${synced} entries synced, ${failed} failed`);
    return { synced, failed, providers: providerResults };
}
/**
 * Store a knowledge entry in the database.
 */
export function storeKnowledge(provider, topic, content, sourceUrl, version) {
    const db = getDb();
    db.prepare(`
    INSERT INTO knowledge_base (provider, topic, content, source_url, version, fetched_at, last_verified_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(provider, topic) DO UPDATE SET
      content = excluded.content,
      source_url = COALESCE(excluded.source_url, knowledge_base.source_url),
      version = COALESCE(excluded.version, knowledge_base.version),
      fetched_at = excluded.fetched_at,
      last_verified_at = excluded.last_verified_at
  `).run(provider, topic, content, sourceUrl ?? null, version ?? null);
}
/**
 * Get per-provider documentation sync status for the dashboard.
 */
export function getKnowledgeSyncStatus() {
    const db = getDb();
    const rows = db.prepare(`
    SELECT
      provider,
      COUNT(*) AS topics,
      MAX(fetched_at) AS last_fetched_at,
      MAX(last_verified_at) AS last_verified_at
    FROM knowledge_base
    GROUP BY provider
  `).all();
    const byProvider = new Map(rows.map(row => [row.provider, row]));
    return listProviderMetadata().map(provider => {
        const row = byProvider.get(provider.platform);
        const topics = row?.topics ?? 0;
        return {
            provider: provider.platform,
            displayName: provider.displayName,
            docsUrl: provider.docsUrl,
            topics,
            lastFetchedAt: row?.last_fetched_at ?? null,
            lastVerifiedAt: row?.last_verified_at ?? null,
            status: topics > 0 ? 'synced' : 'missing',
        };
    });
}
/**
 * Query knowledge base for a specific question.
 * Returns matching entries ranked by relevance (simple substring matching).
 */
export function queryKnowledge(query) {
    const cacheKey = `${query.provider ?? 'all'}:${query.query}`;
    const cached = knowledgeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.entries;
    }
    const db = getDb();
    const keywords = query.query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    const limit = query.limit ?? 5;
    let sql = `
    SELECT id, provider, topic, content, source_url, version, fetched_at, last_verified_at
    FROM knowledge_base
    WHERE 1=1
  `;
    const params = [];
    if (query.provider) {
        sql += ` AND provider = ?`;
        params.push(query.provider);
    }
    const rows = db.prepare(sql).all(...params);
    // Score each row by keyword matches
    const scored = rows.map(row => {
        const text = `${row.topic} ${row.content}`.toLowerCase();
        const score = keywords.reduce((sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0);
        return { row, score };
    }).filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    const entries = scored.map(s => ({
        id: s.row.id,
        provider: s.row.provider,
        topic: s.row.topic,
        content: s.row.content,
        sourceUrl: s.row.source_url ?? undefined,
        version: s.row.version ?? undefined,
        fetchedAt: s.row.fetched_at,
        lastVerifiedAt: s.row.last_verified_at ?? undefined,
    }));
    knowledgeCache.set(cacheKey, { entries, timestamp: Date.now() });
    return entries;
}
/**
 * Get all knowledge entries for a provider.
 */
export function getProviderKnowledge(provider) {
    const db = getDb();
    const rows = db.prepare(`
    SELECT id, provider, topic, content, source_url, version, fetched_at, last_verified_at
    FROM knowledge_base
    WHERE provider = ?
    ORDER BY topic ASC
  `).all(provider);
    return rows.map(r => ({
        id: r.id,
        provider: r.provider,
        topic: r.topic,
        content: r.content,
        sourceUrl: r.source_url ?? undefined,
        version: r.version ?? undefined,
        fetchedAt: r.fetched_at,
        lastVerifiedAt: r.last_verified_at ?? undefined,
    }));
}
/**
 * Seed the knowledge base with some essential provider integration docs.
 * This is a fallback until Context7 MCP is fully configured.
 */
export function seedDefaultKnowledge() {
    const config = getContext7Config();
    if (!config.configured) {
        logContext7Warning();
    }
    const defaults = [
        {
            provider: 'google',
            topic: 'free_tier_limits',
            content: `Google Gemini Free Tier (as of June 2026):
- gemini-2.5-flash: 10 RPM, 20 RPD, ~3M tokens/month
- gemini-2.5-flash-lite: 15 RPM, 20 RPD, ~3M tokens/month
- gemini-3.1-pro-preview: 5 RPM, 20 RPD (free tier confirmed via quota errors)
- gemini-3-flash-preview: 10 RPM, 20 RPD
- All models: 1M context window
- Key restrictions: Project-based quotas, not key-based. Multiple keys on same project share quota.`,
        },
        {
            provider: 'groq',
            topic: 'free_tier_limits',
            content: `Groq Free Tier (as of June 2026):
- 30 RPM per model
- 1000 RPD for most models (14.4k for llama-3.1-8b-instant)
- TPM varies by model: 6k-12k
- Very fast inference (< 100ms for small models)
- Supports streaming, tool calling, JSON mode`,
        },
        {
            provider: 'openrouter',
            topic: 'free_tier_limits',
            content: `OpenRouter Free Tier (as of June 2026):
- 20 RPM shared across all :free models
- 50-200 RPD depending on credits (200 with $10 lifetime topup)
- ~6M tokens/month shared pool
- Supports most capabilities: chat, vision, tool calling
- Models come and go frequently — check /api/v1/models for current :free list`,
        },
        {
            provider: 'cerebras',
            topic: 'free_tier_limits',
            content: `Cerebras Free Tier (as of June 2026):
- 30 RPM shared across all models
- 1M TPD (tokens per day)
- ~30M tokens/month
- Extremely fast inference on wafer-scale hardware
- Currently supports: qwen3-235b, qwen3-coder-480b`,
        },
        {
            provider: 'mistral',
            topic: 'free_tier_limits',
            content: `Mistral Experiment Tier (as of June 2026):
- 2 RPM shared across ALL experiment models
- 500k TPM
- ~1B tokens/month shared pool
- Available models: codestral, devstral, mistral-large, magistral-medium
- Best for: Code generation, general chat`,
        },
        {
            provider: 'github',
            topic: 'free_tier_limits',
            content: `GitHub Models Free Tier (as of June 2026):
- 10 RPM, 50 RPD (Low-tier models)
- ~9M tokens/month
- Models: gpt-4.1, gpt-4o
- Explicitly for experimentation/prototyping per ToS
- Good for: Testing OpenAI-compatible integrations`,
        },
        {
            provider: 'cloudflare',
            topic: 'free_tier_limits',
            content: `Cloudflare Workers AI Free Tier (as of June 2026):
- 10K Neurons/day shared across all @cf/* models
- No RPM/RPD limits (quota-based)
- ~18-45M tokens/month equivalent
- Models: Llama 3.3, GPT-OSS, GLM-4.7, Kimi K2.6, Granite 4
- Best for: High-throughput, low-latency applications`,
        },
        {
            provider: 'samba',
            topic: 'free_tier_limits',
            content: `SambaNova Free Tier (as of June 2026):
- 20 RPM, 20 RPD, 200K TPD shared across free models
- ~3M tokens/month
- Models: DeepSeek V3.1/V3.2, Llama 4 Maverick, GPT-OSS, Gemma 3
- Fast inference on SN30L hardware`,
        },
        {
            provider: 'general',
            topic: 'routing_best_practices',
            content: `LLM-Hub Pro Max Routing Best Practices:
1. Use 'model: auto' for automatic routing
2. For coding tasks, the router prefers 'best_for_code' category
3. For vision tasks, requires vision-capable models with image_url content
4. Sticky sessions keep multi-turn conversations on the same model for 30 min
5. Rate limit penalties automatically demote frequently-429 models
6. Use category headers for specific task types:
   - x-requested-category: best_for_code
   - x-requested-category: best_for_reasoning
   - x-requested-category: fast
   - x-requested-category: precise`,
        },
    ];
    for (const entry of defaults) {
        storeKnowledge(entry.provider, entry.topic, entry.content);
    }
    console.log(`[Knowledge] Seeded ${defaults.length} default knowledge entries`);
}
/**
 * Search knowledge across all providers.
 */
export function searchAllKnowledge(query, limit = 10) {
    return queryKnowledge({ query, limit });
}
//# sourceMappingURL=knowledge-base.js.map