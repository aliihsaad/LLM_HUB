import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  queryKnowledge,
  getProviderKnowledge,
  storeKnowledge,
  searchAllKnowledge,
  getContext7Config,
  getKnowledgeSyncStatus,
  isContext7Configured,
  syncContext7Knowledge,
} from '../services/knowledge-base.js';

const router = Router();

/**
 * GET /api/knowledge/query?q=...&provider=...&limit=5
 * Search the knowledge base for a specific question.
 */
router.get('/knowledge/query', (req: Request, res: Response) => {
  const { q, provider, limit } = req.query;

  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Missing query parameter "q"' });
    return;
  }

  const results = queryKnowledge({
    query: q,
    provider: typeof provider === 'string' ? provider : undefined,
    limit: typeof limit === 'string' ? parseInt(limit, 10) : 5,
  });

  res.json({
    query: q,
    count: results.length,
    results,
  });
});

/**
 * GET /api/knowledge/providers/:provider
 * Get all knowledge entries for a specific provider.
 */
router.get('/knowledge/providers/:provider', (req: Request, res: Response) => {
  const provider = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
  const entries = getProviderKnowledge(provider);

  res.json({
    provider,
    count: entries.length,
    entries,
  });
});

/**
 * GET /api/knowledge/search?q=...&limit=10
 * Global search across all knowledge entries.
 */
router.get('/knowledge/search', (req: Request, res: Response) => {
  const { q, limit } = req.query;

  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Missing query parameter "q"' });
    return;
  }

  const results = searchAllKnowledge(q, typeof limit === 'string' ? parseInt(limit, 10) : 10);

  res.json({
    query: q,
    count: results.length,
    results,
  });
});

/**
 * POST /api/knowledge
 * Add or update a knowledge entry (admin only).
 */
router.post('/knowledge', (req: Request, res: Response) => {
  const { provider, topic, content, sourceUrl, version } = req.body;

  if (!provider || !topic || !content) {
    res.status(400).json({
      error: 'Missing required fields: provider, topic, content',
    });
    return;
  }

  storeKnowledge(provider, topic, content, sourceUrl, version);

  res.json({
    message: 'Knowledge entry stored',
    provider,
    topic,
  });
});

/**
 * GET /api/knowledge/config
 * Get Context7 configuration status.
 */
router.get('/knowledge/config', (_req: Request, res: Response) => {
  const config = getContext7Config();
  res.json({
    configured: config.configured,
    apiUrl: config.apiUrl,
    apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : null,
  });
});

/**
 * GET /api/knowledge/status
 * Get documentation sync status for all provider integrations.
 */
router.get('/knowledge/status', (_req: Request, res: Response) => {
  const config = getContext7Config();
  const providers = getKnowledgeSyncStatus();
  const syncedProviders = providers.filter(provider => provider.status === 'synced').length;
  const lastSyncedAt = providers
    .map(provider => provider.lastVerifiedAt ?? provider.lastFetchedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  res.json({
    configured: config.configured,
    apiUrl: config.apiUrl,
    providerCount: providers.length,
    syncedProviders,
    missingProviders: providers.length - syncedProviders,
    lastSyncedAt,
    providers,
  });
});

/**
 * POST /api/knowledge/sync
 * Trigger a manual sync from Context7 API.
 */
router.post('/knowledge/sync', async (_req: Request, res: Response) => {
  if (!isContext7Configured()) {
    res.status(400).json({
      error: 'Context7 API is not configured',
      message: 'Add CONTEXT7_API_KEY to your .env file or Settings',
    });
    return;
  }

  try {
    const result = await syncContext7Knowledge();
    res.json({
      message: 'Context7 sync complete',
      ...result,
    });
  } catch (err: any) {
    res.status(502).json({
      error: 'context7_sync_failed',
      message: err.message ?? 'Context7 sync failed',
    });
  }
});

export default router;
