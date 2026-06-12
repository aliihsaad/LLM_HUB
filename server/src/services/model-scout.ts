import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { categorizeModel } from './model-categorizer.js';
import type { Platform } from 'llmhub-shared/types.js';

const SCOUT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export interface AvailabilityCheck {
  modelDbId: number;
  platform: Platform;
  modelId: string;
  status: 'free' | 'rate_limited' | 'deprecated' | 'error' | 'unknown';
  lastCheckAt: string;
  lastError?: string;
  discoverySource?: string;
  freeTierConfirmed: boolean;
}

export interface DiscoveredModelCandidate {
  platform: Platform;
  modelId: string;
  displayName: string;
  enabledByDefault?: boolean;
  capabilities?: DiscoveredModelCapability[];
}

export interface DiscoveredModelResult {
  discovered: DiscoveredModelCandidate[];
  inserted: DiscoveredModelCandidate[];
  skippedKnown: DiscoveredModelCandidate[];
  insertedCount: number;
  skippedKnownCount: number;
  insertedModelIds: number[];
}

const CATALOG_SYNC_PLATFORMS = new Set<Platform>([
  'huggingface',
  'vercel',
  'modelscope',
  'qwen',
  'siliconflow',
  'ovhcloud',
]);

const MAX_DISCOVERED_PER_PLATFORM = 100;
const GOOGLE_MODELS_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GOOGLE_FREE_CHAT_MODELS = new Map<string, string>([
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gemini-3-flash-preview', 'Gemini 3 Flash Preview'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
  ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'],
  ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'],
]);

interface GoogleModelListResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
}

type DiscoveredModelCapability = 'chat' | 'vision';

interface OpenAICompatModelListEntry {
  id?: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

function isZeroPrice(value: string | undefined): boolean {
  if (value == null) return false;
  return Number(value) === 0;
}

function supportsImageInput(entry: OpenAICompatModelListEntry): boolean {
  const inputModalities = entry.architecture?.input_modalities ?? [];
  if (inputModalities.some(modality => modality.toLowerCase() === 'image')) return true;
  return entry.architecture?.modality?.toLowerCase().includes('image') === true;
}

async function discoverGoogleModels(apiKey: string, knownSet: Set<string>): Promise<DiscoveredModelCandidate[]> {
  const res = await fetch(`${GOOGLE_MODELS_API_BASE}/models?key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) return [];

  const data = await res.json() as GoogleModelListResponse;
  const discoveries: DiscoveredModelCandidate[] = [];

  for (const entry of data.models ?? []) {
    const modelId = entry.name?.replace(/^models\//, '');
    if (!modelId || knownSet.has(modelId)) continue;
    if (!entry.supportedGenerationMethods?.includes('generateContent')) continue;

    const displayName = GOOGLE_FREE_CHAT_MODELS.get(modelId);
    if (!displayName) continue;

    discoveries.push({
      platform: 'google',
      modelId,
      displayName: entry.displayName ?? displayName,
      enabledByDefault: true,
      capabilities: ['chat', 'vision'],
    });
  }

  return discoveries;
}

/**
 * Check if a specific model is still available on the free tier.
 * 
 * Strategy per platform:
 * — OpenAI-compatible: try a cheap /v1/models or /v1/chat/completions probe.
 * — Google: hit the model-specific generateContent endpoint with a dummy prompt.
 * — Cloudflare: hit the @cf/{model}/ai/run endpoint.
 * 
 * A 200 with content = free, 429 = rate_limited (still free), 401/403 = deprecated or invalid key,
 * 404 = deprecated (model removed), transport error = error.
 */
export async function checkModelAvailability(modelDbId: number): Promise<AvailabilityCheck> {
  const db = getDb();

  const model = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, k.id AS key_id, k.encrypted_key, k.iv, k.auth_tag
    FROM models m
    LEFT JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1
    WHERE m.id = ?
    ORDER BY k.id DESC
    LIMIT 1
  `).get(modelDbId) as {
    id: number;
    platform: string;
    model_id: string;
    display_name: string;
    key_id: number | null;
    encrypted_key: string | null;
    iv: string | null;
    auth_tag: string | null;
  } | undefined;

  if (!model) {
    return {
      modelDbId,
      platform: 'unknown' as Platform,
      modelId: 'unknown',
      status: 'error',
      lastCheckAt: new Date().toISOString(),
      lastError: 'Model not found in DB',
      freeTierConfirmed: false,
    };
  }

  const platform = model.platform as Platform;
  const modelId = model.model_id;

  // No configured key for this platform
  if (!model.key_id || !model.encrypted_key) {
    return {
      modelDbId,
      platform,
      modelId,
      status: 'unknown',
      lastCheckAt: new Date().toISOString(),
      lastError: 'No active API key configured for this platform',
      freeTierConfirmed: false,
    };
  }

  const apiKey = decrypt(model.encrypted_key, model.iv!, model.auth_tag!);
  const provider = getProvider(platform);

  if (!provider) {
    return {
      modelDbId,
      platform,
      modelId,
      status: 'error',
      lastCheckAt: new Date().toISOString(),
      lastError: `No provider adapter for platform ${platform}`,
      freeTierConfirmed: false,
    };
  }

  try {
    // Probe strategy: try a minimal chat completion with max_tokens=1
    // This is cheap and confirms the model is reachable and responsive
    const probeMessages = [{ role: 'user' as const, content: 'hi' }];
    
    const res = await provider.chatCompletion(apiKey, probeMessages, modelId, {
      max_tokens: 1,
      temperature: 0,
    });

    // If we get here, the model responded successfully
    const check: AvailabilityCheck = {
      modelDbId,
      platform,
      modelId,
      status: 'free',
      lastCheckAt: new Date().toISOString(),
      freeTierConfirmed: true,
    };

    db.prepare(`
      INSERT INTO model_availability (model_db_id, status, last_check_at, free_tier_confirmed)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(model_db_id) DO UPDATE SET
        status = excluded.status,
        last_check_at = excluded.last_check_at,
        last_error = NULL,
        free_tier_confirmed = excluded.free_tier_confirmed
    `).run(check.modelDbId, check.status, check.lastCheckAt, check.freeTierConfirmed ? 1 : 0);

    return check;

  } catch (err: any) {
    let status: AvailabilityCheck['status'] = 'error';
    let freeTierConfirmed = false;

    // Parse error to determine status
    const message = err.message as string;
    
    if (message?.includes('429') || message?.toLowerCase().includes('rate limit')) {
      status = 'rate_limited';
      freeTierConfirmed = true; // We hit a rate limit, which means it IS free
    } else if (message?.includes('404') || message?.toLowerCase().includes('not found')) {
      status = 'deprecated';
    } else if (message?.includes('401') || message?.includes('403')) {
      status = 'error';
    }

    const check: AvailabilityCheck = {
      modelDbId,
      platform,
      modelId,
      status,
      lastCheckAt: new Date().toISOString(),
      lastError: message,
      freeTierConfirmed,
    };

    db.prepare(`
      INSERT INTO model_availability (model_db_id, status, last_check_at, last_error, free_tier_confirmed)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(model_db_id) DO UPDATE SET
        status = excluded.status,
        last_check_at = excluded.last_check_at,
        last_error = excluded.last_error,
        free_tier_confirmed = excluded.free_tier_confirmed
    `).run(check.modelDbId, check.status, check.lastCheckAt, check.lastError ?? null, check.freeTierConfirmed ? 1 : 0);

    return check;
  }
}

/**
 * Check all enabled models in batches with delays to avoid rate limits.
 */
export async function scoutAllModels(delayMs = 2000): Promise<AvailabilityCheck[]> {
  const db = getDb();
  const models = db.prepare(`
    SELECT id FROM models WHERE enabled = 1
  `).all() as { id: number }[];

  console.log(`[ModelScout] Checking ${models.length} models...`);
  const results: AvailabilityCheck[] = [];

  for (const { id } of models) {
    try {
      const result = await checkModelAvailability(id);
      results.push(result);
      console.log(`[ModelScout] ${result.platform}/${result.modelId} → ${result.status}`);
      
      // Delay between checks to avoid hitting rate limits
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    } catch (err) {
      console.error(`[ModelScout] Unexpected error checking model ${id}:`, err);
    }
  }

  console.log(`[ModelScout] Check complete. ${results.filter(r => r.status === 'free').length}/${results.length} models confirmed free.`);
  return results;
}

/**
 * Discover new free models by querying each provider's /v1/models endpoint.
 */
export async function discoverNewModels(): Promise<DiscoveredModelCandidate[]> {
  const db = getDb();
  const discoveries: DiscoveredModelCandidate[] = [];

  const platforms = db.prepare(`
    SELECT DISTINCT platform FROM api_keys WHERE enabled = 1
  `).all() as { platform: string }[];

  for (const { platform } of platforms) {
    const provider = getProvider(platform as Platform);
    const keyRow = db.prepare(`
      SELECT encrypted_key, iv, auth_tag FROM api_keys
      WHERE platform = ? AND enabled = 1
      ORDER BY id DESC LIMIT 1
    `).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;

    if (!keyRow) continue;

    const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    const knownModels = db.prepare(`SELECT model_id FROM models WHERE platform = ?`).all(platform) as { model_id: string }[];
    const knownSet = new Set(knownModels.map(m => m.model_id));

    if (platform === 'google') {
      try {
        discoveries.push(...await discoverGoogleModels(apiKey, knownSet));
      } catch (err) {
        console.warn('[ModelScout] Could not list models for google:', err);
      }
      continue;
    }

    if (!provider || typeof (provider as any).baseUrl !== 'string') continue;

    const baseUrl = (provider as any).baseUrl as string;

    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!res.ok) continue;

      const data = await res.json() as { data?: OpenAICompatModelListEntry[] };

      let discoveredForPlatform = 0;
      for (const entry of data.data ?? []) {
        if (!entry.id) continue;
        if (knownSet.has(entry.id)) continue;

        // Heuristic: explicit free models become routable immediately. Credit-
        // based/trial providers are persisted disabled so the catalog stays
        // current without silently routing into paid-only models.
        const hasZeroPricing = platform === 'openrouter' && isZeroPrice(entry.pricing?.prompt) && isZeroPrice(entry.pricing?.completion);
        const isLikelyFree = /:free|free-tier|free model|trial|sandbox/i.test(`${entry.id} ${entry.name ?? ''}`) || hasZeroPricing;
        const shouldPersist = isLikelyFree || CATALOG_SYNC_PLATFORMS.has(platform as Platform);
        if (!shouldPersist) continue;

        const capabilities: DiscoveredModelCapability[] = ['chat'];
        if (platform === 'openrouter' && supportsImageInput(entry)) {
          capabilities.push('vision');
        }

        discoveries.push({
          platform: platform as Platform,
          modelId: entry.id,
          displayName: entry.name ?? entry.id,
          enabledByDefault: isLikelyFree,
          capabilities,
        });

        discoveredForPlatform++;
        if (discoveredForPlatform >= MAX_DISCOVERED_PER_PLATFORM) break;
      }
    } catch (err) {
      console.warn(`[ModelScout] Could not list models for ${platform}:`, err);
    }
  }

  return discoveries;
}

/**
 * Discover new free models and add them to the catalog.
 *
 * New models receive a discovery_source in model_availability so UI can show
 * them as newly introduced catalog entries.
 */
export async function discoverAndPersistNewModels(): Promise<DiscoveredModelResult> {
  const db = getDb();
  const discovered = await discoverNewModels();

  if (discovered.length === 0) {
    return {
      discovered: [],
      inserted: [],
      skippedKnown: [],
      insertedCount: 0,
      skippedKnownCount: 0,
      insertedModelIds: [],
    };
  }

  const now = new Date().toISOString();
  const discoverySource = `model-scout:${now}`;

  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
      monthly_token_budget, context_window, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateCategory = db.prepare(`
    UPDATE models
      SET category = ?, specializations = ?
    WHERE id = ?
  `);

  const insertFallback = db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, ?)
  `);

  const insertAvailability = db.prepare(`
    INSERT INTO model_availability (model_db_id, status, discovery_source, free_tier_confirmed)
    VALUES (?, 'unknown', ?, ?)
  `);

  const addCapability = db.prepare(`
    INSERT OR IGNORE INTO model_capabilities (model_db_id, capability, priority, enabled)
    VALUES (?, ?, 999, ?)
  `);

  const getModelId = db.prepare(`
    SELECT id FROM models WHERE platform = ? AND model_id = ?
  `);

  const row = db.prepare(`SELECT COALESCE(MAX(priority), 0) AS priority FROM fallback_config`).get() as { priority: number };
  let nextPriority = row.priority + 1;
  const inserted: DiscoveredModelCandidate[] = [];
  const insertedModelIds: number[] = [];
  const skippedKnown: DiscoveredModelCandidate[] = [];

  const tx = db.transaction(() => {
    for (const candidate of discovered) {
      const existing = getModelId.get(candidate.platform, candidate.modelId) as { id: number } | undefined;
      if (existing) {
        skippedKnown.push(candidate);
        continue;
      }

      const intelligenceRank = 999;
      const speedRank = 999;
      const categorize = categorizeModel(candidate.modelId, candidate.displayName, intelligenceRank, speedRank, 'Large');
      const enabled = candidate.enabledByDefault === false ? 0 : 1;

      const result = insertModel.run(
        candidate.platform,
        candidate.modelId,
        candidate.displayName,
        intelligenceRank,
        speedRank,
        'Large',
        null,
        null,
        null,
        null,
        '~? (discovered)',
        null,
        enabled,
      );

      if (result.changes !== 1) {
        skippedKnown.push(candidate);
        continue;
      }

      const modelDbId = Number(result.lastInsertRowid);
      updateCategory.run(categorize.category, categorize.specializations.join(','), modelDbId);
      insertFallback.run(modelDbId, nextPriority++, enabled);
      insertAvailability.run(modelDbId, discoverySource, enabled);
      // New discovered rows are assumed chat-capable by default. Providers
      // that expose modality metadata can add narrower capability routes too.
      for (const capability of new Set(candidate.capabilities ?? ['chat'])) {
        addCapability.run(modelDbId, capability, enabled);
      }

      inserted.push(candidate);
      insertedModelIds.push(modelDbId);
    }
  });

  tx();

  return {
    discovered,
    inserted,
    skippedKnown,
    insertedCount: inserted.length,
    skippedKnownCount: skippedKnown.length,
    insertedModelIds,
  };
}

// — Background scheduler —

let scoutIntervalId: ReturnType<typeof setInterval> | null = null;

export function startModelScout(): void {
  if (scoutIntervalId) return;
  console.log(`[ModelScout] Starting scout (every ${SCOUT_INTERVAL_MS / 60000} minutes)`);

  // Run immediately on start, then on interval.
  runScoutCycle().catch(err => console.error('[ModelScout] Initial scout failed:', err));

  scoutIntervalId = setInterval(() => {
    runScoutCycle().catch(err => console.error('[ModelScout] Scheduled scout failed:', err));
  }, SCOUT_INTERVAL_MS);
}

async function runScoutCycle(): Promise<void> {
  const discovery = await discoverAndPersistNewModels();
  if (discovery.insertedCount > 0) {
    console.log(`[ModelScout] Discovered ${discovery.discovered.length} candidates, added ${discovery.insertedCount} catalog entries`);
  }
  await scoutAllModels();
}

export function stopModelScout(): void {
  if (scoutIntervalId) {
    clearInterval(scoutIntervalId);
    scoutIntervalId = null;
  }
}
