import { Router } from 'express';
import { getDb } from '../db/index.js';
import { discoverAndPersistNewModels, discoverNewModels, scoutAllModels, } from '../services/model-scout.js';
const router = Router();
/**
 * GET /api/model-availability
 * Returns availability status for all models.
 */
router.get('/', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
    SELECT 
      m.id,
      m.platform,
      m.model_id,
      m.display_name,
      m.enabled,
      COALESCE(a.status, 'unknown') AS availability_status,
      a.last_check_at,
      a.last_error,
      a.discovery_source,
      a.free_tier_confirmed
    FROM models m
    LEFT JOIN model_availability a ON a.model_db_id = m.id
    ORDER BY m.platform, m.intelligence_rank ASC
  `).all();
    res.json({
        models: rows.map(r => ({
            id: r.id,
            platform: r.platform,
            modelId: r.model_id,
            displayName: r.display_name,
            enabled: Boolean(r.enabled),
            availabilityStatus: r.availability_status,
            lastCheckAt: r.last_check_at,
            lastError: r.availability_status === 'unknown'
                ? r.last_error ?? 'Not scanned yet'
                : r.last_error,
            discoverySource: r.discovery_source,
            freeTierConfirmed: Boolean(r.free_tier_confirmed),
        })),
        checkedAt: new Date().toISOString(),
    });
});
/**
 * POST /api/model-availability/check
 * Trigger a manual availability check for all models (or a specific model).
 */
router.post('/check', async (req, res) => {
    const { modelId } = req.body;
    try {
        if (modelId) {
            const db = getDb();
            const model = db.prepare('SELECT id FROM models WHERE model_id = ?').get(modelId);
            if (!model) {
                res.status(404).json({ error: 'Model not found' });
                return;
            }
            const { checkModelAvailability } = await import('../services/model-scout.js');
            const result = await checkModelAvailability(model.id);
            res.json(result);
            return;
        }
        const results = await scoutAllModels(1000);
        res.json({
            checked: results.length,
            free: results.filter(r => r.status === 'free').length,
            rateLimited: results.filter(r => r.status === 'rate_limited').length,
            deprecated: results.filter(r => r.status === 'deprecated').length,
            error: results.filter(r => r.status === 'error').length,
            unknown: results.filter(r => r.status === 'unknown').length,
            results,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * GET /api/model-availability/discover
 * Discover new free models from provider catalogs.
 */
router.get('/discover', async (_req, res) => {
    try {
        const discoveries = await discoverNewModels();
        res.json({
            discoveries,
            count: discoveries.length,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * POST /api/model-availability/discover
 * Discover and persist new free models into the catalog.
 */
router.post('/discover', async (_req, res) => {
    try {
        const result = await discoverAndPersistNewModels();
        res.json({
            discovered: result.discovered,
            inserted: result.inserted,
            skippedKnown: result.skippedKnown,
            discoveredCount: result.discovered.length,
            insertedCount: result.insertedCount,
            skippedKnownCount: result.skippedKnownCount,
            insertedModelIds: result.insertedModelIds,
            message: `Discovered ${result.discovered.length} models, added ${result.insertedCount} new entries.`,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=model-scout.js.map