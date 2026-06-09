import { Router } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey, getDb } from '../db/index.js';
import { getContext7Config } from '../services/knowledge-base.js';
export const settingsRouter = Router();
// Get the unified API key
settingsRouter.get('/api-key', (_req, res) => {
    res.json({ apiKey: getUnifiedApiKey() });
});
// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req, res) => {
    const newKey = regenerateUnifiedKey();
    res.json({ apiKey: newKey });
});
// Get Context7 configuration status
settingsRouter.get('/context7', (_req, res) => {
    const config = getContext7Config();
    res.json({
        configured: config.configured,
        apiUrl: config.apiUrl,
        apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : null,
    });
});
// Update Context7 configuration
settingsRouter.put('/context7', (req, res) => {
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
settingsRouter.delete('/context7', (_req, res) => {
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'context7_api_key'").run();
    res.json({
        message: 'Context7 configuration removed',
        configured: false,
    });
});
//# sourceMappingURL=settings.js.map