import { Router } from 'express';
import type { Request, Response } from 'express';
import type { CapabilitiesResponse, ModelCapability, Platform, ProvidersResponse } from 'llmhub-shared/types.js';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { getProviderMetadata, listProviderMetadata, PLATFORM_ORDER } from '../lib/provider-metadata.js';

export const modelsRouter = Router();

const CAPABILITIES: ModelCapability[] = ['chat', 'embeddings', 'vision', 'images', 'audio'];

modelsRouter.get('/providers', (_req: Request, res: Response) => {
  const result: ProvidersResponse = {
    providers: listProviderMetadata(),
  };

  res.json(result);
});

modelsRouter.get('/capabilities', (_req: Request, res: Response) => {
  const db = getDb();

  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1 AND status != 'invalid'
    GROUP BY platform
  `).all() as { platform: Platform; count: number }[];

  const capabilityCounts = db.prepare(`
    SELECT m.platform, mc.capability, COUNT(*) as supported_models
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    WHERE m.enabled = 1 AND mc.enabled = 1
    GROUP BY m.platform, mc.capability
  `).all() as { platform: Platform; capability: ModelCapability; supported_models: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));
  const supportMap = new Map(
    capabilityCounts.map(c => [`${c.platform}:${c.capability}`, c.supported_models]),
  );

  const result: CapabilitiesResponse = {
    capabilities: CAPABILITIES,
    providers: PLATFORM_ORDER.map(platform => {
      const keyCount = keyCountMap.get(platform) ?? 0;
      const capabilities = Object.fromEntries(
        CAPABILITIES.map(capability => {
          const supportedModels = supportMap.get(`${platform}:${capability}`) ?? 0;
          const configured = supportedModels > 0 && keyCount > 0;
          const status = configured
            ? 'configured'
            : supportedModels > 0
              ? 'missing_key'
              : 'unsupported';
          return [capability, { supportedModels, configured, status }];
        }),
      ) as CapabilitiesResponse['providers'][number]['capabilities'];

      return { ...getProviderMetadata(platform), keyCount, capabilities };
    }),
  };

  res.json(result);
});

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  const capabilities = db.prepare(`
    SELECT mc.model_db_id, mc.capability
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    WHERE m.enabled = 1 AND mc.enabled = 1
    ORDER BY mc.priority ASC, mc.capability ASC
  `).all() as { model_db_id: number; capability: string }[];
  const capabilitiesByModel = new Map<number, string[]>();
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
  `).all() as { platform: string; count: number }[];

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
    enabled: m.enabled === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
    capabilities: capabilitiesByModel.get(m.id) ?? [],
  }));

  res.json(result);
});
