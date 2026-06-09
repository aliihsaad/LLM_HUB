import { Router } from 'express';
import { getDb } from '../db/index.js';
export const analyticsRouter = Router();
// Map range to a JS-computed ISO timestamp passed as a bind parameter,
// so the SQL string never includes user-controlled fragments.
function getSinceTimestamp(range) {
    const now = Date.now();
    switch (range) {
        case '24h':
            return new Date(now - 24 * 60 * 60 * 1000).toISOString();
        case '30d':
            return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
        case '7d':
        default:
            return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    }
}
function parseBudget(value) {
    const match = value.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!match)
        return 0;
    const high = Number.parseFloat(match[2] ?? match[1]);
    const unit = match[3] === 'M' ? 1_000_000 : match[3] === 'K' ? 1_000 : 1;
    return Number.isFinite(high) ? high * unit : 0;
}
function formatTokens(value) {
    if (value >= 1_000_000_000)
        return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000)
        return `${(value / 1_000).toFixed(1)}K`;
    return String(Math.round(value));
}
function usagePercent(usedTokens, budget) {
    if (budget <= 0)
        return usedTokens > 0 ? 100 : 0;
    return Math.min(999, Math.round((usedTokens / budget) * 100));
}
function usagePressure(percent) {
    if (percent >= 95)
        return 'critical';
    if (percent >= 80)
        return 'high';
    if (percent >= 50)
        return 'medium';
    return 'low';
}
function usageText(usedTokens, budget, percent) {
    if (budget <= 0)
        return `${formatTokens(usedTokens)} used; no estimate configured`;
    return `${formatTokens(usedTokens)} used of ${formatTokens(budget)} est/mo (${percent}%)`;
}
function isRealtimeSessionModel(modelId) {
    const normalized = modelId.toLowerCase();
    return normalized.includes('native-audio') || normalized.includes('realtime');
}
// Text-ready estimated usage by provider/model. These estimates are based on
// local requests routed through this app and catalog monthly-token budgets.
analyticsRouter.get('/usage-estimates', (req, res) => {
    const range = req.query.range ?? '7d';
    const since = getSinceTimestamp(range);
    const db = getDb();
    const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1 AND status != 'invalid'
    GROUP BY platform
  `).all();
    const keyCountMap = new Map(keyCounts.map(row => [row.platform, row.count]));
    const modelBudgets = db.prepare(`
    SELECT platform, model_id, display_name, monthly_token_budget
    FROM models
    WHERE enabled = 1
  `).all();
    const modelBudgetMap = new Map();
    const providerBudgetMap = new Map();
    const providerModelCountMap = new Map();
    for (const model of modelBudgets) {
        const activeKeyCount = keyCountMap.get(model.platform) ?? 0;
        const estimatedMonthlyBudget = parseBudget(model.monthly_token_budget) * activeKeyCount;
        const key = `${model.platform}:${model.model_id}`;
        modelBudgetMap.set(key, {
            platform: model.platform,
            modelId: model.model_id,
            displayName: model.display_name,
            estimatedMonthlyBudget,
        });
        providerBudgetMap.set(model.platform, (providerBudgetMap.get(model.platform) ?? 0) + estimatedMonthlyBudget);
        if (estimatedMonthlyBudget > 0) {
            providerModelCountMap.set(model.platform, (providerModelCountMap.get(model.platform) ?? 0) + 1);
        }
    }
    const usageRows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      COALESCE(m.display_name, r.model_id) as display_name,
      COUNT(*) as requests,
      COALESCE(SUM(r.input_tokens + r.output_tokens), 0) as used_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
  `).all(since);
    const providerUsageMap = new Map();
    const modelsByProvider = new Map();
    for (const row of usageRows) {
        const key = `${row.platform}:${row.model_id}`;
        const budget = modelBudgetMap.get(key)?.estimatedMonthlyBudget ?? 0;
        const percent = usagePercent(row.used_tokens, budget);
        const providerUsage = providerUsageMap.get(row.platform) ?? { requests: 0, usedTokens: 0 };
        providerUsage.requests += row.requests;
        providerUsage.usedTokens += row.used_tokens;
        providerUsageMap.set(row.platform, providerUsage);
        const modelEstimate = {
            platform: row.platform,
            modelId: row.model_id,
            displayName: modelBudgetMap.get(key)?.displayName ?? row.display_name,
            requests: row.requests,
            usedTokens: row.used_tokens,
            estimatedMonthlyBudget: budget,
            usagePercent: percent,
            pressure: usagePressure(percent),
            usageText: usageText(row.used_tokens, budget, percent),
            usageSource: isRealtimeSessionModel(row.model_id) ? 'session_mint' : 'local_tokens',
        };
        const models = modelsByProvider.get(row.platform) ?? [];
        models.push(modelEstimate);
        modelsByProvider.set(row.platform, models);
    }
    const providerNames = new Set([
        ...providerBudgetMap.keys(),
        ...providerUsageMap.keys(),
    ]);
    const providers = Array.from(providerNames)
        .map(platform => {
        const usedTokens = providerUsageMap.get(platform)?.usedTokens ?? 0;
        const requests = providerUsageMap.get(platform)?.requests ?? 0;
        const estimatedMonthlyBudget = providerBudgetMap.get(platform) ?? 0;
        const percent = usagePercent(usedTokens, estimatedMonthlyBudget);
        const topModels = (modelsByProvider.get(platform) ?? [])
            .sort((a, b) => b.usedTokens - a.usedTokens);
        return {
            platform,
            requests,
            activeKeyCount: keyCountMap.get(platform) ?? 0,
            modelCount: providerModelCountMap.get(platform) ?? 0,
            usedTokens,
            estimatedMonthlyBudget,
            usagePercent: percent,
            pressure: usagePressure(percent),
            usageText: usageText(usedTokens, estimatedMonthlyBudget, percent),
            topModels,
        };
    })
        .filter(row => row.usedTokens > 0 || row.estimatedMonthlyBudget > 0)
        .sort((a, b) => b.usedTokens - a.usedTokens || b.estimatedMonthlyBudget - a.estimatedMonthlyBudget);
    const totalUsed = providers.reduce((sum, provider) => sum + provider.usedTokens, 0);
    const totalBudget = providers.reduce((sum, provider) => sum + provider.estimatedMonthlyBudget, 0);
    const totalPercent = usagePercent(totalUsed, totalBudget);
    res.json({
        range,
        generatedAt: new Date().toISOString(),
        note: 'Estimated from requests routed through this app and catalog monthly-token budgets; external provider dashboard usage is not included. Direct realtime audio frames are counted only as session-mint requests unless routed through a server relay.',
        total: {
            usedTokens: totalUsed,
            estimatedMonthlyBudget: totalBudget,
            usagePercent: totalPercent,
            pressure: usagePressure(totalPercent),
            usageText: usageText(totalUsed, totalBudget, totalPercent),
        },
        providers,
    });
});
// Summary stats
analyticsRouter.get('/summary', (req, res) => {
    const range = req.query.range ?? '7d';
    const since = getSinceTimestamp(range);
    const db = getDb();
    const stats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM requests
    WHERE created_at >= ?
  `).get(since);
    const totalRequests = stats.total_requests ?? 0;
    const successRate = totalRequests > 0 ? (stats.success_count / totalRequests) * 100 : 0;
    const totalTokens = (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0);
    // Estimate cost savings: average ~$3/M input + $15/M output tokens (GPT-4o pricing)
    const inputCost = ((stats.total_input_tokens ?? 0) / 1_000_000) * 3;
    const outputCost = ((stats.total_output_tokens ?? 0) / 1_000_000) * 15;
    res.json({
        totalRequests,
        successRate: Math.round(successRate * 10) / 10,
        totalInputTokens: stats.total_input_tokens ?? 0,
        totalOutputTokens: stats.total_output_tokens ?? 0,
        avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
        estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
    });
});
// Stats grouped by model
analyticsRouter.get('/by-model', (req, res) => {
    const range = req.query.range ?? '7d';
    const since = getSinceTimestamp(range);
    const db = getDb();
    const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(since);
    res.json(rows.map(r => ({
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name ?? r.model_id,
        requests: r.requests,
        successRate: Math.round(r.success_rate * 10) / 10,
        avgLatencyMs: Math.round(r.avg_latency_ms),
        totalInputTokens: r.total_input_tokens ?? 0,
        totalOutputTokens: r.total_output_tokens ?? 0,
    })));
});
// Stats grouped by platform
analyticsRouter.get('/by-platform', (req, res) => {
    const range = req.query.range ?? '7d';
    const since = getSinceTimestamp(range);
    const db = getDb();
    const rows = db.prepare(`
    SELECT
      platform,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(latency_ms) as avg_latency_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform
    ORDER BY requests DESC
  `).all(since);
    res.json(rows.map(r => ({
        platform: r.platform,
        requests: r.requests,
        successRate: Math.round(r.success_rate * 10) / 10,
        avgLatencyMs: Math.round(r.avg_latency_ms),
        totalInputTokens: r.total_input_tokens ?? 0,
        totalOutputTokens: r.total_output_tokens ?? 0,
    })));
});
// Timeline data
analyticsRouter.get('/timeline', (req, res) => {
    const range = req.query.range ?? '7d';
    const interval = req.query.interval ?? (range === '24h' ? 'hour' : 'day');
    const since = getSinceTimestamp(range);
    const db = getDb();
    // dateFormat is a hardcoded whitelist — never user-controlled.
    const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';
    const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', created_at) as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests
    WHERE created_at >= ?
    GROUP BY strftime('${dateFormat}', created_at)
    ORDER BY timestamp ASC
  `).all(since);
    res.json(rows.map(r => ({
        timestamp: r.timestamp,
        requests: r.requests,
        successCount: r.success_count,
        failureCount: r.failure_count,
    })));
});
// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req, res) => {
    const range = req.query.range ?? '7d';
    const since = getSinceTimestamp(range);
    const db = getDb();
    // Group errors by category (extract the key part of the error message)
    const rows = db.prepare(`
    SELECT
      platform,
      model_id,
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform, error_category
    ORDER BY count DESC
  `).all(since);
    // Also get totals by category
    const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY category
    ORDER BY count DESC
  `).all(since);
    // Errors by platform
    const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform
    ORDER BY count DESC
  `).all(since);
    res.json({
        byCategory,
        byPlatform,
        detailed: rows,
    });
});
// Recent errors
analyticsRouter.get('/errors', (req, res) => {
    const range = req.query.range ?? '7d';
    const since = getSinceTimestamp(range);
    const db = getDb();
    const rows = db.prepare(`
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(since);
    res.json(rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        error: r.error,
        latencyMs: r.latency_ms,
        createdAt: r.created_at,
    })));
});
//# sourceMappingURL=analytics.js.map