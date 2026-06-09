import { Router } from 'express';
import type { Request, Response } from 'express';
import type {
  DiagnosticFlag,
  DiagnosticSeverity,
  LogEntry,
  LogErrorCategory,
  LogsDiagnosticsResponse,
  ProviderRanking,
} from 'llmhub-shared/types.js';
import { getDb } from '../db/index.js';
import { getAllPenalties } from '../services/router.js';

export const logsRouter = Router();

type StatusFilter = 'all' | 'success' | 'error';
type RangeFilter = '24h' | '7d' | '30d';

interface RequestRow {
  id: number;
  platform: string;
  model_id: string;
  status: 'success' | 'error';
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error: string | null;
  created_at: string;
}

interface ClassifiedError {
  category: LogErrorCategory;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  recommendation: string;
}

const severityRank: Record<DiagnosticSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

function getSinceTimestamp(range: RangeFilter): string {
  const now = Date.now();
  const ms = range === '24h'
    ? 24 * 60 * 60 * 1000
    : range === '30d'
      ? 30 * 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
  return new Date(now - ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseRange(value: unknown): RangeFilter {
  return value === '24h' || value === '30d' || value === '7d' ? value : '7d';
}

function parseStatus(value: unknown): StatusFilter {
  return value === 'success' || value === 'error' || value === 'all' ? value : 'all';
}

function parseLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function classifyError(error: string | null): ClassifiedError {
  const message = (error ?? '').toLowerCase();
  const isZeroQuotaLimit = /(?:quota|rate|request|token|capacity|free[_ -]?tier|limit).{0,200}\blimit\s*[:=]\s*0\b/s.test(message)
    || /\blimit\s*[:=]\s*0\b.{0,200}(?:quota|rate|request|token|capacity|free[_ -]?tier)/s.test(message);

  if (message.includes('all models exhausted') || message.includes('add more api keys') || message.includes('no models') || message.includes('missing key')) {
    return {
      category: 'routing',
      severity: 'warning',
      title: 'Routing exhausted',
      detail: 'The router could not find an available key/model for the requested capability.',
      recommendation: 'Add keys for that capability, enable matching models, or wait for cooldowns and rate windows to clear.',
    };
  }

  if (isZeroQuotaLimit) {
    return {
      category: 'zero_quota',
      severity: 'critical',
      title: 'Zero-quota model quarantine',
      detail: 'The provider reported a zero quota limit for this model, so extra keys will repeat the same failure unless they belong to an eligible project or tier.',
      recommendation: 'Keep this model quarantined until you confirm the provider account/project has quota, then retry with explicit confirmation.',
    };
  }

  if (message.includes('429') || message.includes('rate limit') || message.includes('too many') || message.includes('quota') || message.includes('resource_exhausted')) {
    return {
      category: 'rate_limit',
      severity: 'warning',
      title: 'Rate limit or quota hit',
      detail: 'A provider rejected traffic because a free-tier quota or request window was exhausted.',
      recommendation: 'Add another separate-account key, lower this provider priority, or wait for the quota window to reset.',
    };
  }

  if (message.includes('401') || message.includes('unauthorized') || message.includes('invalid api key') || message.includes('invalid key') || message.includes('api key not valid')) {
    return {
      category: 'auth',
      severity: 'critical',
      title: 'Authentication failed',
      detail: 'A provider rejected the stored API key.',
      recommendation: 'Re-check the key on the Keys page, replace invalid keys, or remove keys that belong to disabled accounts.',
    };
  }

  if (message.includes('403') || message.includes('forbidden') || message.includes('subscription') || message.includes('permission') || message.includes('requires a paid')) {
    return {
      category: 'forbidden',
      severity: 'critical',
      title: 'Access denied',
      detail: 'The key is valid but the provider blocked this model or endpoint for the account.',
      recommendation: 'Disable the unavailable model or use a provider/model available on the current account tier.',
    };
  }

  if (message.includes('404') || message.includes('not found') || message.includes('model does not exist') || message.includes('unavailable_model')) {
    return {
      category: 'not_found',
      severity: 'warning',
      title: 'Model unavailable',
      detail: 'A catalog model is missing or unavailable for this provider key.',
      recommendation: 'Disable the model in the fallback chain or update the catalog entry after confirming the provider model list.',
    };
  }

  if (message.includes('timeout') || message.includes('aborted') || message.includes('etimedout') || message.includes('econnrefused') || message.includes('econnreset')) {
    return {
      category: 'timeout',
      severity: 'warning',
      title: 'Connection or timeout issue',
      detail: 'The provider or network path did not complete the request cleanly.',
      recommendation: 'Retry later, keep this provider lower in the fallback chain, or prefer faster providers for latency-sensitive calls.',
    };
  }

  if (message.includes('500') || message.includes('503') || message.includes('internal server') || message.includes('unavailable')) {
    return {
      category: 'provider',
      severity: 'warning',
      title: 'Provider service error',
      detail: 'The upstream provider returned a transient service failure.',
      recommendation: 'Leave fallback enabled so another provider can serve requests while this one recovers.',
    };
  }

  return {
    category: 'other',
    severity: 'info',
    title: 'Unclassified provider error',
    detail: 'The error did not match a known diagnostic pattern.',
    recommendation: 'Inspect the raw message and add a classifier if this repeats.',
  };
}

function buildWhere(req: Request): { whereSql: string; params: unknown[]; limit: number } {
  const range = parseRange(req.query.range);
  const status = parseStatus(req.query.status);
  const platform = typeof req.query.platform === 'string' ? req.query.platform.trim() : '';
  const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';

  const clauses = ['created_at >= ?'];
  const params: unknown[] = [getSinceTimestamp(range)];

  if (status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  }

  if (platform) {
    clauses.push('platform = ?');
    params.push(platform);
  }

  if (model) {
    clauses.push('model_id = ?');
    params.push(model);
  }

  return {
    whereSql: clauses.join(' AND '),
    params,
    limit: parseLimit(req.query.limit),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

logsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { whereSql, params, limit } = buildWhere(req);

  const summaryRow = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
      AVG(latency_ms) AS avg_latency_ms,
      SUM(input_tokens) AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      COUNT(DISTINCT platform) AS active_providers
    FROM requests
    WHERE ${whereSql}
  `).get(...params) as any;

  const totalRequests = summaryRow.total_requests ?? 0;
  const successCount = summaryRow.success_count ?? 0;
  const errorCount = summaryRow.error_count ?? 0;

  const recentRows = db.prepare(`
    SELECT id, platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at
    FROM requests
    WHERE ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params, limit) as RequestRow[];

  const aggregateRows = db.prepare(`
    SELECT
      platform,
      COUNT(*) AS requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
      AVG(latency_ms) AS avg_latency_ms,
      SUM(input_tokens + output_tokens) AS total_tokens
    FROM requests
    WHERE ${whereSql}
    GROUP BY platform
  `).all(...params) as any[];

  const errorRows = db.prepare(`
    SELECT platform, model_id, error, COUNT(*) AS count
    FROM requests
    WHERE ${whereSql} AND status = 'error'
    GROUP BY platform, model_id, error
    ORDER BY count DESC
  `).all(...params) as { platform: string; model_id: string; error: string | null; count: number }[];

  const keyRows = db.prepare(`
    SELECT
      platform,
      COUNT(*) AS total_keys,
      SUM(CASE WHEN enabled = 1 AND status != 'invalid' THEN 1 ELSE 0 END) AS key_count,
      SUM(CASE WHEN enabled = 1 AND status = 'healthy' THEN 1 ELSE 0 END) AS healthy_keys,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid_keys
    FROM api_keys
    GROUP BY platform
  `).all() as { platform: string; total_keys: number; key_count: number; healthy_keys: number; invalid_keys: number }[];

  const keyStats = new Map(keyRows.map(row => [row.platform, row]));
  const penaltyByPlatform = new Map<string, number>();
  for (const penalty of getAllPenalties()) {
    const row = db.prepare('SELECT platform FROM models WHERE id = ?').get(penalty.modelDbId) as { platform: string } | undefined;
    if (!row) continue;
    penaltyByPlatform.set(row.platform, (penaltyByPlatform.get(row.platform) ?? 0) + penalty.penalty);
  }

  const flagMap = new Map<string, DiagnosticFlag>();
  const topFlagByPlatform = new Map<string, { category: LogErrorCategory; count: number; severity: DiagnosticSeverity; recommendation: string }>();
  for (const row of errorRows) {
    const classified = classifyError(row.error);
    const key = `${row.platform}:${classified.category}`;
    const existing = flagMap.get(key);
    if (existing) {
      existing.count += row.count;
      existing.modelId = existing.modelId === row.model_id ? existing.modelId : null;
    } else {
      flagMap.set(key, {
        id: key,
        category: classified.category,
        severity: classified.severity,
        title: classified.title,
        detail: classified.detail,
        recommendation: classified.recommendation,
        count: row.count,
        platform: row.platform,
        modelId: row.model_id,
      });
    }

    const topFlag = topFlagByPlatform.get(row.platform);
    if (!topFlag || row.count > topFlag.count || severityRank[classified.severity] > severityRank[topFlag.severity]) {
      topFlagByPlatform.set(row.platform, {
        category: classified.category,
        count: row.count,
        severity: classified.severity,
        recommendation: classified.recommendation,
      });
    }
  }

  const flags = Array.from(flagMap.values()).sort((a, b) => {
    const severityDelta = severityRank[b.severity] - severityRank[a.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.count - a.count;
  });

  const rankings = aggregateRows.map((row): Omit<ProviderRanking, 'rank'> => {
    const requests = row.requests ?? 0;
    const errors = row.error_count ?? 0;
    const successRate = requests > 0 ? ((row.success_count ?? 0) / requests) * 100 : 0;
    const avgLatencyMs = Math.round(row.avg_latency_ms ?? 0);
    const latencyScore = Math.max(0, 100 - Math.min(avgLatencyMs, 10_000) / 100);
    const keys = keyStats.get(row.platform);
    const keyCount = keys?.key_count ?? 0;
    const healthyKeys = keys?.healthy_keys ?? 0;
    const invalidKeys = keys?.invalid_keys ?? 0;
    const keyHealthScore = keyCount > 0 ? (healthyKeys / keyCount) * 100 : 0;
    const volumeScore = Math.min(requests, 10) * 10;
    const penalty = penaltyByPlatform.get(row.platform) ?? 0;
    const score = Math.max(0, round1(
      successRate * 0.55
      + latencyScore * 0.20
      + keyHealthScore * 0.15
      + volumeScore * 0.10
      - Math.min(30, penalty * 3),
    ));
    const topFlagEntry = topFlagByPlatform.get(row.platform);
    const topFlag = topFlagEntry?.category ?? null;

    const status: ProviderRanking['status'] = keyCount === 0
      ? 'blocked'
      : requests === 0
        ? 'idle'
        : successRate >= 95 && avgLatencyMs <= 2_000
          ? 'excellent'
          : successRate >= 75
            ? 'good'
            : 'degraded';

    const recommendation = status === 'excellent'
      ? 'Keep this provider high in the fallback chain for this workload.'
      : status === 'blocked'
        ? 'Add a healthy key or remove stale traffic for this provider.'
        : topFlag
          ? topFlagEntry!.recommendation
          : 'Watch this provider before promoting it higher in fallback order.';

    return {
      platform: row.platform,
      score,
      status,
      requests,
      errors,
      successRate: round1(successRate),
      avgLatencyMs,
      totalTokens: row.total_tokens ?? 0,
      keyCount,
      healthyKeys,
      invalidKeys,
      penalty,
      topFlag,
      recommendation,
    };
  })
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const recent: LogEntry[] = recentRows.map(row => {
    if (row.status === 'success') {
      return {
        id: row.id,
        platform: row.platform,
        modelId: row.model_id,
        status: row.status,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        latencyMs: row.latency_ms,
        error: row.error,
        errorCategory: null,
        severity: 'info',
        suggestion: 'Request completed successfully.',
        createdAt: row.created_at,
      };
    }

    const classified = classifyError(row.error);
    return {
      id: row.id,
      platform: row.platform,
      modelId: row.model_id,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      error: row.error,
      errorCategory: classified.category,
      severity: classified.severity,
      suggestion: classified.recommendation,
      createdAt: row.created_at,
    };
  });

  const body: LogsDiagnosticsResponse = {
    summary: {
      totalRequests,
      successCount,
      errorCount,
      successRate: totalRequests > 0 ? round1((successCount / totalRequests) * 100) : 0,
      avgLatencyMs: Math.round(summaryRow.avg_latency_ms ?? 0),
      totalInputTokens: summaryRow.total_input_tokens ?? 0,
      totalOutputTokens: summaryRow.total_output_tokens ?? 0,
      totalTokens: (summaryRow.total_input_tokens ?? 0) + (summaryRow.total_output_tokens ?? 0),
      activeProviders: summaryRow.active_providers ?? 0,
    },
    flags,
    rankings,
    recent,
  };

  res.json(body);
});
