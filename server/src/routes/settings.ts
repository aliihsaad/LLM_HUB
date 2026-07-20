import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey, getDb } from '../db/index.js';
import { getContext7Config } from '../services/knowledge-base.js';
import { isFreeOnlyMode, setFreeOnlyMode } from '../lib/app-settings.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Get Context7 configuration status
settingsRouter.get('/context7', (_req: Request, res: Response) => {
  const config = getContext7Config();
  res.json({
    configured: config.configured,
    apiUrl: config.apiUrl,
    apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : null,
  });
});

// Update Context7 configuration
settingsRouter.put('/context7', (req: Request, res: Response) => {
  const { apiKey } = req.body;

  const db = getDb();

  if (apiKey !== undefined) {
    db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('context7_api_key', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(apiKey);
  }

  const config = getContext7Config();
  res.json({
    message: 'Context7 configuration updated',
    configured: config.configured,
  });
});

// Delete Context7 configuration
settingsRouter.delete('/context7', (_req: Request, res: Response) => {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'context7_api_key'").run();

  res.json({
    message: 'Context7 configuration removed',
    configured: false,
  });
});

// Free-tier-only mode (default ON): hides/blocks paid catalog rows.
settingsRouter.get('/free-only-mode', (_req: Request, res: Response) => {
  res.json({ freeOnlyMode: isFreeOnlyMode(getDb()) });
});

settingsRouter.put('/free-only-mode', (req: Request, res: Response) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: "Body must be { enabled: boolean }" });
    return;
  }
  setFreeOnlyMode(getDb(), enabled);
  res.json({ freeOnlyMode: isFreeOnlyMode(getDb()) });
});
