import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { clearModelRuntimeHealth, getAllPenalties, getModelRuntimeHealth } from '../services/router.js';
import { PROVIDER_METADATA } from '../lib/provider-metadata.js';
export const fallbackRouter = Router();
function parseBudget(s) {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m)
        return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
}
// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    LEFT JOIN model_capabilities mc
      ON mc.model_db_id = m.id
      AND mc.capability = 'chat'
    WHERE mc.id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM model_capabilities any_mc
         WHERE any_mc.model_db_id = m.id
       )
    ORDER BY fc.priority ASC
  `).all();
    // Count enabled keys per platform
    const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1 AND status != 'invalid'
    GROUP BY platform
  `).all();
    const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));
    // Get current dynamic penalties
    const penalties = getAllPenalties();
    const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));
    const runtimeHealth = getModelRuntimeHealth();
    const runtimeHealthMap = new Map(runtimeHealth.map(h => [h.modelDbId, h]));
    res.json(rows.map(r => {
        const penalty = penaltyMap.get(r.model_db_id);
        const health = runtimeHealthMap.get(r.model_db_id);
        const keyCount = keyCountMap.get(r.platform) ?? 0;
        const baseBudget = parseBudget(r.monthly_token_budget);
        const effectiveBudget = baseBudget * keyCount;
        return {
            modelDbId: r.model_db_id,
            priority: r.priority,
            effectivePriority: r.priority + (penalty?.penalty ?? 0),
            penalty: penalty?.penalty ?? 0,
            rateLimitHits: penalty?.count ?? 0,
            enabled: r.enabled === 1,
            platform: r.platform,
            providerDisplayName: PROVIDER_METADATA[r.platform]?.displayName ?? r.platform,
            modelId: r.model_id,
            displayName: r.display_name,
            intelligenceRank: r.intelligence_rank,
            speedRank: r.speed_rank,
            sizeLabel: r.size_label,
            rpmLimit: r.rpm_limit,
            rpdLimit: r.rpd_limit,
            monthlyTokenBudget: r.monthly_token_budget,
            baseBudget,
            effectiveBudget,
            keyCount,
            runtimeStatus: health?.status ?? 'healthy',
            runtimeBlockedUntil: health?.blockedUntil ?? null,
            lastErrorCategory: health?.lastErrorCategory ?? null,
            lastError: health?.lastError ?? null,
            failureCount: health?.failureCount ?? 0,
            requiresConfirmation: health?.lastErrorCategory === 'zero_quota',
        };
    }));
});
const updateSchema = z.array(z.object({
    modelDbId: z.number(),
    priority: z.number(),
    enabled: z.boolean(),
}));
const toggleSchema = z.object({
    enabled: z.boolean(),
});
const retrySchema = z.object({
    confirm: z.boolean().optional(),
});
// Update fallback chain (full replace)
fallbackRouter.put('/', (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
        return;
    }
    const db = getDb();
    const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);
    const enableModel = db.prepare('UPDATE models SET enabled = 1 WHERE id = ?');
    const enableChatCapability = db.prepare(`
    UPDATE model_capabilities SET enabled = 1 WHERE model_db_id = ? AND capability = 'chat'
  `);
    const updateAll = db.transaction(() => {
        for (const entry of parsed.data) {
            update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
            if (entry.enabled) {
                enableModel.run(entry.modelDbId);
                enableChatCapability.run(entry.modelDbId);
            }
        }
    });
    updateAll();
    res.json({ success: true });
});
fallbackRouter.patch('/:modelDbId', (req, res) => {
    const modelDbId = Number(req.params.modelDbId);
    if (!Number.isInteger(modelDbId) || modelDbId <= 0) {
        res.status(400).json({ error: { message: 'Invalid model ID' } });
        return;
    }
    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
        return;
    }
    const db = getDb();
    const update = db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?');
    const enableModel = db.prepare('UPDATE models SET enabled = 1 WHERE id = ?');
    const enableChatCapability = db.prepare(`
    UPDATE model_capabilities SET enabled = 1 WHERE model_db_id = ? AND capability = 'chat'
  `);
    const tx = db.transaction(() => {
        const result = update.run(parsed.data.enabled ? 1 : 0, modelDbId);
        if (parsed.data.enabled) {
            enableModel.run(modelDbId);
            enableChatCapability.run(modelDbId);
        }
        return result;
    });
    const result = tx();
    if (result.changes === 0) {
        res.status(404).json({ error: { message: 'Fallback model not found' } });
        return;
    }
    res.json({ success: true, modelDbId, enabled: parsed.data.enabled });
});
fallbackRouter.post('/:modelDbId/retry', (req, res) => {
    const modelDbId = Number(req.params.modelDbId);
    if (!Number.isInteger(modelDbId) || modelDbId <= 0) {
        res.status(400).json({ error: { message: 'Invalid model ID' } });
        return;
    }
    const parsed = retrySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
        return;
    }
    const db = getDb();
    const row = db.prepare(`
    SELECT m.id, m.model_id, m.platform
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.id = ?
  `).get(modelDbId);
    if (!row) {
        res.status(404).json({ error: { message: 'Fallback model not found' } });
        return;
    }
    const health = db.prepare(`
    SELECT last_error_category
    FROM model_runtime_health
    WHERE model_db_id = ?
  `).get(modelDbId);
    const requiresConfirmation = health?.last_error_category === 'zero_quota';
    if (requiresConfirmation && parsed.data.confirm !== true) {
        res.status(409).json({
            error: {
                message: 'This model was quarantined because the provider reported zero quota. Confirm before enabling it again.',
                type: 'confirmation_required',
                code: 'confirmation_required',
            },
            requiresConfirmation: true,
            modelDbId,
            platform: row.platform,
            modelId: row.model_id,
        });
        return;
    }
    clearModelRuntimeHealth(modelDbId);
    res.json({
        success: true,
        modelDbId,
        platform: row.platform,
        modelId: row.model_id,
        runtimeStatus: 'healthy',
    });
});
// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS = {
    intelligence: 'm.intelligence_rank ASC',
    speed: 'm.speed_rank ASC',
    budget: "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC",
};
fallbackRouter.post('/sort/:preset', (req, res) => {
    const preset = String(req.params.preset);
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
        res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
        return;
    }
    const db = getDb();
    const models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all();
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    const reorder = db.transaction(() => {
        for (let i = 0; i < models.length; i++) {
            update.run(i + 1, models[i].id);
        }
    });
    reorder();
    res.json({ success: true, preset });
});
// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req, res) => {
    const db = getDb();
    // Get platforms that have enabled keys
    const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1 AND ak.status != 'invalid'
  `).all();
    const platformSet = new Set(platforms.map(p => p.platform));
    const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1 AND status != 'invalid'
    GROUP BY platform
  `).all();
    const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));
    // Get monthly budget per configured model, ordered by fallback priority.
    // The draggable fallback chain is chat-only, but this budget view should also
    // include endpoint-specific models such as realtime audio and speech.
    const models = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
           fc.priority, COALESCE(rh.status, 'healthy') AS runtime_status,
           rh.blocked_until,
           COALESCE((
             SELECT GROUP_CONCAT(mc.capability)
             FROM model_capabilities mc
             WHERE mc.model_db_id = m.id AND mc.enabled = 1
           ), '') AS capabilities
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN model_runtime_health rh ON rh.model_db_id = m.id
    WHERE m.enabled = 1
      AND fc.enabled = 1
      AND COALESCE(rh.status, 'healthy') = 'healthy'
      AND rh.blocked_until IS NULL
    ORDER BY fc.priority ASC
  `).all();
    // Build per-model breakdown (only platforms with keys)
    const modelBudgets = models
        .filter(m => platformSet.has(m.platform))
        .map(m => {
        const keyCount = keyCountMap.get(m.platform) ?? 0;
        const baseBudget = parseBudget(m.monthly_token_budget);
        const effectiveBudget = baseBudget * keyCount;
        return {
            modelDbId: m.id,
            displayName: m.display_name,
            platform: m.platform,
            providerDisplayName: PROVIDER_METADATA[m.platform]?.displayName ?? m.platform,
            modelId: m.model_id,
            monthlyTokenBudget: m.monthly_token_budget,
            baseBudget,
            keyCount,
            effectiveBudget,
            budget: effectiveBudget,
            runtimeStatus: m.runtime_status,
            capabilities: m.capabilities ? m.capabilities.split(',').filter(Boolean) : [],
        };
    });
    const totalBudget = modelBudgets.reduce((s, m) => s + m.effectiveBudget, 0);
    // Tokens used this month
    const usage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
  `).get();
    res.json({
        totalBudget,
        totalUsed: usage.total_used,
        models: modelBudgets,
    });
});
//# sourceMappingURL=fallback.js.map