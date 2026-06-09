import crypto from 'crypto';
import type {
  ChatMessage,
  ModelSweepJob,
  ModelSweepResult,
  Platform,
} from 'llmhub-shared/types.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { PROVIDER_METADATA } from '../lib/provider-metadata.js';
import { getProvider } from '../providers/index.js';
import { recordRequest, recordTokens, setCooldown } from './ratelimit.js';
import {
  recordModelFailure,
  recordRateLimitHit,
  recordSuccess,
  type ModelFailureCategory,
} from './router.js';
import { classifyProviderError, type ClassifiedProviderError } from './provider-errors.js';

interface SweepTarget {
  modelDbId: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  priority: number;
}

interface KeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

interface InternalModelSweepJob extends Omit<ModelSweepJob, 'elapsedMs' | 'estimatedRemainingMs'> {
  startedAtMs: number;
}

const jobs = new Map<string, InternalModelSweepJob>();
let activeJobId: string | null = null;

const SWEEP_MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'Reply exactly with OK.' },
];

export function startModelSweep(): ModelSweepJob {
  const active = activeJobId ? jobs.get(activeJobId) : undefined;
  if (active?.status === 'running') return snapshotJob(active);

  const targets = listSweepTargets();
  const now = new Date();
  const job: InternalModelSweepJob = {
    id: `sweep_${crypto.randomUUID()}`,
    status: 'running',
    total: targets.length,
    completed: 0,
    passed: 0,
    failed: 0,
    quarantined: 0,
    startedAt: now.toISOString(),
    startedAtMs: now.getTime(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    currentModel: null,
    note: targets.length > 0
      ? 'Testing chat-routable models. Failed models are quarantined out of routing.'
      : 'No chat-routable models with enabled keys were found.',
    results: [],
  };

  jobs.set(job.id, job);
  activeJobId = job.id;
  void runSweep(job.id, targets);
  return snapshotJob(job);
}

export function getModelSweepJob(id: string): ModelSweepJob | undefined {
  const job = jobs.get(id);
  return job ? snapshotJob(job) : undefined;
}

async function runSweep(jobId: string, targets: SweepTarget[]) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    for (const target of targets) {
      job.currentModel = `${target.platform}/${target.modelId}`;
      job.updatedAt = new Date().toISOString();

      const result = await testTarget(target);
      job.results.push(result);
      job.completed += 1;

      if (result.status === 'passed') {
        job.passed += 1;
      } else if (result.status === 'failed') {
        job.failed += 1;
        if (result.errorCategory && shouldCountAsQuarantine(result.errorCategory)) {
          job.quarantined += 1;
        }
      }

      job.updatedAt = new Date().toISOString();
    }

    job.status = 'completed';
    job.currentModel = null;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.note = `Completed ${job.completed}/${job.total}. Passed ${job.passed}, quarantined ${job.quarantined}.`;
  } catch (err: any) {
    job.status = 'failed';
    job.currentModel = null;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.note = `Sweep failed: ${err.message ?? String(err)}`;
  }
}

function listSweepTargets(): SweepTarget[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      m.id AS model_db_id,
      m.platform,
      m.model_id,
      m.display_name,
      fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN model_capabilities mc
      ON mc.model_db_id = m.id
      AND mc.capability = 'chat'
      AND mc.enabled = 1
    WHERE m.enabled = 1
      AND fc.enabled = 1
      AND (
        mc.id IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM model_capabilities any_mc
          WHERE any_mc.model_db_id = m.id
        )
      )
      AND EXISTS (
        SELECT 1 FROM api_keys ak
        WHERE ak.platform = m.platform
          AND ak.enabled = 1
          AND ak.status != 'invalid'
      )
    ORDER BY fc.priority ASC, m.intelligence_rank ASC, m.id ASC
  `).all() as Array<{
    model_db_id: number;
    platform: Platform;
    model_id: string;
    display_name: string;
    priority: number;
  }>;

  return rows.map(row => ({
    modelDbId: row.model_db_id,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name,
    priority: row.priority,
  }));
}

async function testTarget(target: SweepTarget): Promise<ModelSweepResult> {
  const provider = getProvider(target.platform);
  if (!provider) {
    recordModelFailure(target.modelDbId, 'provider', `No provider implementation for ${target.platform}`);
    return failureResult(target, 'provider', `No provider implementation for ${target.platform}`, 0, null);
  }

  const keys = getKeysForPlatform(target.platform);
  if (keys.length === 0) {
    return failureResult(target, 'auth', `No enabled keys for ${target.platform}`, 0, null);
  }

  let keyAttempts = 0;
  let lastFailure: ClassifiedProviderError | null = null;
  let lastError: Error | null = null;
  let lastLatency: number | null = null;

  for (const key of keys) {
    keyAttempts += 1;
    const started = Date.now();
    recordRequest(target.platform, target.modelId, key.id);

    try {
      const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      const response = await provider.chatCompletion(apiKey, SWEEP_MESSAGES, target.modelId, {
        max_tokens: 16,
        temperature: 0,
      });
      const latency = Date.now() - started;
      const usage = response.usage;
      const inputTokens = usage?.prompt_tokens ?? 4;
      const outputTokens = usage?.completion_tokens ?? 1;

      recordTokens(target.platform, target.modelId, key.id, inputTokens + outputTokens);
      recordSuccess(target.modelDbId);
      logSweepRequest(target.platform, target.modelId, 'success', inputTokens, outputTokens, latency, null);

      return {
        modelDbId: target.modelDbId,
        platform: target.platform,
        providerDisplayName: providerDisplayName(target.platform),
        modelId: target.modelId,
        displayName: target.displayName,
        status: 'passed',
        latencyMs: latency,
        errorCategory: null,
        error: null,
        keyAttempts,
      };
    } catch (err: any) {
      const latency = Date.now() - started;
      const failure = classifyProviderError(err);
      const message = err?.message ?? String(err);
      lastFailure = failure;
      lastError = err instanceof Error ? err : new Error(message);
      lastLatency = latency;

      logSweepRequest(target.platform, target.modelId, 'error', 4, 0, latency, message);
      if (failure.category === 'rate_limit') recordRateLimitHit(target.modelDbId);
      if (failure.keyCooldownMs > 0) setCooldown(target.platform, target.modelId, key.id, failure.keyCooldownMs);
      if (failure.skipModel) break;
    }
  }

  const category = lastFailure?.category ?? 'other';
  const message = lastError?.message ?? 'Model sweep failed without an error message.';
  if (shouldRecordRuntimeFailure(category)) {
    recordModelFailure(target.modelDbId, category, message);
  }

  return failureResult(target, category, message, keyAttempts, lastLatency);
}

function getKeysForPlatform(platform: Platform): KeyRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag
    FROM api_keys
    WHERE platform = ?
      AND enabled = 1
      AND status != 'invalid'
    ORDER BY id ASC
  `).all(platform) as KeyRow[];
}

function failureResult(
  target: SweepTarget,
  category: ModelFailureCategory,
  error: string,
  keyAttempts: number,
  latencyMs: number | null,
): ModelSweepResult {
  return {
    modelDbId: target.modelDbId,
    platform: target.platform,
    providerDisplayName: providerDisplayName(target.platform),
    modelId: target.modelId,
    displayName: target.displayName,
    status: 'failed',
    latencyMs,
    errorCategory: category,
    error,
    keyAttempts,
  };
}

function shouldRecordRuntimeFailure(category: ModelFailureCategory): boolean {
  return category !== 'auth';
}

function shouldCountAsQuarantine(category: ModelFailureCategory): boolean {
  return category !== 'auth' && category !== 'other';
}

function providerDisplayName(platform: Platform): string {
  return PROVIDER_METADATA[platform]?.displayName ?? platform;
}

function logSweepRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (err) {
    console.error('Failed to log model sweep request:', err);
  }
}

function snapshotJob(job: InternalModelSweepJob): ModelSweepJob {
  const elapsedMs = Date.now() - job.startedAtMs;
  const remaining = Math.max(0, job.total - job.completed);
  const estimatedRemainingMs = job.status === 'running' && job.completed > 0
    ? Math.round((elapsedMs / job.completed) * remaining)
    : job.status === 'running'
      ? null
      : 0;

  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    passed: job.passed,
    failed: job.failed,
    quarantined: job.quarantined,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    elapsedMs,
    estimatedRemainingMs,
    currentModel: job.currentModel,
    note: job.note,
    results: job.results.map(result => ({ ...result })),
  };
}
