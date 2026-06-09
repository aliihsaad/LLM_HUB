import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter, geminiProxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { logsRouter } from './routes/logs.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { modelSweepsRouter } from './routes/model-sweeps.js';
import { authRouter } from './routes/auth.js';
import { adminAuthMiddleware } from './middleware/adminAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import modelScoutRouter from './routes/model-scout.js';
import modelCategoriesRouter from './routes/model-categories.js';
import knowledgeRouter from './routes/knowledge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_BODY_LIMIT = '25mb';

export function createApp() {
  const app = express();

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors());
  // Local vision requests can embed image data URLs in JSON. Keep this aligned
  // with the multipart image/audio limit so local files work consistently.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  // Public auth endpoints. The config route enforces its own session check
  // once a dashboard PIN is already enabled.
  app.use('/api/auth', authRouter);

  // Dashboard/admin API routes are open by default for local-first use, and
  // require a valid dashboard session only after the owner enables PIN auth.
  app.use('/api', adminAuthMiddleware);

  // API routes
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/model-sweeps', modelSweepsRouter);
  app.use('/api/model-availability', modelScoutRouter);
  app.use('/api', modelCategoriesRouter);
  app.use('/api', knowledgeRouter);

  // OpenAI-compatible proxy
  app.use('/v1', proxyRouter);
  // Google Gemini-compatible proxy
  app.use('/gemini', geminiProxyRouter);

  // Health check
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path.startsWith('/gemini/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
