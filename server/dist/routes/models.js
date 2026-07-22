import { Router } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { getProviderMetadata, listProviderMetadata, PLATFORM_ORDER } from '../lib/provider-metadata.js';
export const modelsRouter = Router();
const CAPABILITIES = ['chat', 'embeddings', 'vision', 'video', 'images', 'audio'];
modelsRouter.get('/providers', (_req, res) => {
    const result = {
        providers: listProviderMetadata(),
    };
    res.json(result);
});
modelsRouter.get('/capabilities', (_req, res) => {
    const db = getDb();
    const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1 AND status != 'invalid'
    GROUP BY platform
  `).all();
    const capabilityCounts = db.prepare(`
    SELECT m.platform, mc.capability, COUNT(*) as supported_models
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    WHERE m.enabled = 1 AND mc.enabled = 1
    GROUP BY m.platform, mc.capability
  `).all();
    const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));
    const supportMap = new Map(capabilityCounts.map(c => [`${c.platform}:${c.capability}`, c.supported_models]));
    const result = {
        capabilities: CAPABILITIES,
        providers: PLATFORM_ORDER.map(platform => {
            const keyCount = keyCountMap.get(platform) ?? 0;
            const capabilities = Object.fromEntries(CAPABILITIES.map(capability => {
                const supportedModels = supportMap.get(`${platform}:${capability}`) ?? 0;
                const configured = supportedModels > 0 && keyCount > 0;
                const status = configured
                    ? 'configured'
                    : supportedModels > 0
                        ? 'missing_key'
                        : 'unsupported';
                return [capability, { supportedModels, configured, status }];
            }));
            return { ...getProviderMetadata(platform), keyCount, capabilities };
        }),
    };
    res.json(result);
});
// List all models with availability info
modelsRouter.get('/', (_req, res) => {
    const db = getDb();
    const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all();
    const capabilities = db.prepare(`
    SELECT mc.model_db_id, mc.capability
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    WHERE m.enabled = 1 AND mc.enabled = 1
    ORDER BY mc.priority ASC, mc.capability ASC
  `).all();
    const capabilitiesByModel = new Map();
    for (const capability of capabilities) {
        const existing = capabilitiesByModel.get(capability.model_db_id) ?? [];
        existing.push(capability.capability);
        capabilitiesByModel.set(capability.model_db_id, existing);
    }
    // Count keys per platform
    const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1 AND status != 'invalid'
    GROUP BY platform
  `).all();
    const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));
    const result = models.map(m => ({
        id: m.id,
        modelDbId: m.id,
        platform: m.platform,
        modelId: m.model_id,
        displayName: m.display_name,
        intelligenceRank: m.intelligence_rank,
        speedRank: m.speed_rank,
        sizeLabel: m.size_label,
        rpmLimit: m.rpm_limit,
        rpdLimit: m.rpd_limit,
        tpmLimit: m.tpm_limit,
        tpdLimit: m.tpd_limit,
        monthlyTokenBudget: m.monthly_token_budget,
        contextWindow: m.context_window,
        isFree: m.is_free === 1,
        enabled: m.enabled === 1,
        priority: m.priority,
        fallbackEnabled: m.fallback_enabled === 1,
        hasProvider: hasProvider(m.platform),
        keyCount: keyCountMap.get(m.platform) ?? 0,
        capabilities: capabilitiesByModel.get(m.id) ?? [],
    }));
    res.json(result);
});
//# sourceMappingURL=models.js.map