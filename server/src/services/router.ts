import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

export type ModelFailureCategory =
  | 'zero_quota'
  | 'rate_limit'
  | 'model_unavailable'
  | 'timeout'
  | 'provider'
  | 'auth'
  | 'other';

export interface ModelRuntimeHealth {
  modelDbId: number;
  status: 'healthy' | 'degraded' | 'unavailable';
  failureCount: number;
  lastErrorCategory: ModelFailureCategory | null;
  lastError: string | null;
  lastFailedAt: string | null;
  lastSuccessAt: string | null;
  blockedUntil: string | null;
}

export type ModelCapability =
  | 'chat'
  | 'embeddings'
  | 'vision'
  | 'images'
  | 'image_generation'
  | 'image_edit'
  | 'image_variation'
  | 'audio'
  | 'speech'
  | 'transcription'
  | 'translation'
  | 'realtime_audio';

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

const MODEL_BLOCK_MS: Record<ModelFailureCategory, number> = {
  zero_quota: 365 * 24 * 60 * 60 * 1000,
  rate_limit: 2 * 60 * 1000,
  model_unavailable: 24 * 60 * 60 * 1000,
  timeout: 5 * 60 * 1000,
  provider: 2 * 60 * 1000,
  auth: 0,
  other: 0,
};

function toSqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function nowSql(): string {
  return toSqlTimestamp(Date.now());
}

function isModelRuntimeBlocked(db: ReturnType<typeof getDb>, modelDbId: number): boolean {
  const row = db.prepare(`
    SELECT status, last_error_category, blocked_until
    FROM model_runtime_health
    WHERE model_db_id = ?
      AND (blocked_until IS NOT NULL OR last_error_category = 'zero_quota')
  `).get(modelDbId) as { status: string; last_error_category: string | null; blocked_until: string | null } | undefined;

  if (!row) return false;
  if (row.status === 'unavailable' && row.last_error_category === 'zero_quota') return true;
  if (!row.blocked_until) return false;
  if (row.blocked_until > nowSql()) return true;

  db.prepare(`
    UPDATE model_runtime_health
       SET blocked_until = NULL,
           status = CASE WHEN status = 'unavailable' THEN 'degraded' ELSE status END
     WHERE model_db_id = ?
  `).run(modelDbId);
  return false;
}

export function recordModelFailure(
  modelDbId: number,
  category: ModelFailureCategory,
  message: string,
  blockMs = MODEL_BLOCK_MS[category],
) {
  const db = getDb();
  const status = category === 'model_unavailable' || category === 'zero_quota' ? 'unavailable' : 'degraded';
  const blockedUntil = blockMs > 0 ? toSqlTimestamp(Date.now() + blockMs) : null;
  const clippedMessage = message.slice(0, 1000);

  db.prepare(`
    INSERT INTO model_runtime_health (
      model_db_id, status, failure_count, last_error_category,
      last_error, last_failed_at, blocked_until
    )
    VALUES (?, ?, 1, ?, ?, datetime('now'), ?)
    ON CONFLICT(model_db_id) DO UPDATE SET
      status = excluded.status,
      failure_count = model_runtime_health.failure_count + 1,
      last_error_category = excluded.last_error_category,
      last_error = excluded.last_error,
      last_failed_at = excluded.last_failed_at,
      blocked_until = COALESCE(excluded.blocked_until, model_runtime_health.blocked_until)
  `).run(modelDbId, status, category, clippedMessage, blockedUntil);
}

export function recordModelHealthSuccess(modelDbId: number) {
  const db = getDb();
  db.prepare(`
    INSERT INTO model_runtime_health (
      model_db_id, status, failure_count, last_success_at, blocked_until
    )
    VALUES (?, 'healthy', 0, datetime('now'), NULL)
    ON CONFLICT(model_db_id) DO UPDATE SET
      status = 'healthy',
      failure_count = 0,
      last_success_at = excluded.last_success_at,
      blocked_until = NULL
  `).run(modelDbId);
}

export function getModelRuntimeHealth(): ModelRuntimeHealth[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      model_db_id,
      status,
      failure_count,
      last_error_category,
      last_error,
      last_failed_at,
      last_success_at,
      blocked_until
    FROM model_runtime_health
  `).all() as any[];

  return rows.map(row => ({
    modelDbId: row.model_db_id,
    status: row.status,
    failureCount: row.failure_count,
    lastErrorCategory: row.last_error_category,
    lastError: row.last_error,
    lastFailedAt: row.last_failed_at,
    lastSuccessAt: row.last_success_at,
    blockedUntil: row.blocked_until,
  }));
}

export function clearModelRuntimeHealth(modelDbId: number) {
  const db = getDb();
  db.prepare('DELETE FROM model_runtime_health WHERE model_db_id = ?').run(modelDbId);
}

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
  recordModelHealthSuccess(modelDbId);
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  skipModelDbIds?: Set<number>,
  category?: string,
  platformFilter?: string,
): RouteResult {
  return routeRequestInternal(
    estimatedTokens,
    skipKeys,
    preferredModelDbId,
    skipModelDbIds,
    category,
    platformFilter,
  );
}

export function routeRequestInternal(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  skipModelDbIds?: Set<number>,
  category?: string,
  platformFilter?: string,
): RouteResult {
  const db = getDb();

  // Get fallback chain ordered by priority
  const categorySql = category
    ? `
      SELECT fc.model_db_id, fc.priority, fc.enabled
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = fc.model_db_id
        AND mc.capability = 'chat'
        AND mc.enabled = 1
      WHERE m.category = ?
        AND (mc.id IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM model_capabilities any_mc
             WHERE any_mc.model_db_id = fc.model_db_id
           ))
        ${platformFilter ? 'AND m.platform = ?' : ''}
      ORDER BY fc.priority ASC
    `
    : `
      SELECT fc.model_db_id, fc.priority, fc.enabled
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = fc.model_db_id
        AND mc.capability = 'chat'
        AND mc.enabled = 1
      WHERE (mc.id IS NOT NULL
         OR NOT EXISTS (
           SELECT 1 FROM model_capabilities any_mc
           WHERE any_mc.model_db_id = fc.model_db_id
         ))
        ${platformFilter ? 'AND m.platform = ?' : ''}
      ORDER BY fc.priority ASC
    `;
  const fallbackChain = category
    ? db.prepare(categorySql).all(...(platformFilter ? [category, platformFilter] : [category])) as FallbackRow[]
    : db.prepare(categorySql).all(...(platformFilter ? [platformFilter] : [])) as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;
    if (skipModelDbIds?.has(entry.model_db_id)) continue;
    if (isModelRuntimeBlocked(db, entry.model_db_id)) continue;

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Get all healthy, enabled keys for this platform
    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(model.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) continue;

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      // Check cooldown (from previous 429s)
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);
      const decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    roundRobinIndex.set(rrKey, idx);
    
    // We don't explicitly penalize the model here because the fact that we 
    // couldn't find a key means we will naturally move to the next model 
    // in the `sortedChain` for THIS specific request.
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}

/**
 * Route a request for a specific model capability such as embeddings.
 * Capability routes are intentionally independent from the chat fallback
 * chain so endpoint-specific models cannot accidentally serve chat traffic.
 */
export function routeCapabilityRequest(
  capability: ModelCapability,
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  requestedModel?: string,
  skipModelDbIds?: Set<number>,
  platformFilter?: string,
): RouteResult {
  const db = getDb();

  const capabilityRows = db.prepare(`
    SELECT mc.model_db_id, mc.priority, mc.enabled
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    WHERE mc.capability = ?
      AND mc.enabled = 1
      AND m.enabled = 1
      AND (? IS NULL OR m.model_id = ?)
      ${platformFilter ? 'AND m.platform = ?' : ''}
    ORDER BY mc.priority ASC, m.intelligence_rank ASC
  `).all(capability, requestedModel ?? null, requestedModel ?? null, ...(platformFilter ? [platformFilter] : [])) as FallbackRow[];

  for (const entry of capabilityRows) {
    if (!entry.enabled) continue;
    if (skipModelDbIds?.has(entry.model_db_id)) continue;
    if (isModelRuntimeBlocked(db, entry.model_db_id)) continue;

    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(model.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) continue;

    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    const rrKey = `${capability}:${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      roundRobinIndex.set(rrKey, idx);
      const decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
      };
    }

    roundRobinIndex.set(rrKey, idx);
  }

  const target = requestedModel ? ` for model '${requestedModel}'` : '';
  const err = new Error(`All ${capability} models exhausted${target}. Add more API keys or wait for rate limits to reset.`) as any;
  err.status = 429;
  throw err;
}
