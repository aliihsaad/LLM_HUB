import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendAdminAuthRequired } from '../middleware/adminAuth.js';
import {
  clearAdminSessionCookie,
  clearLoginFailures,
  disableDashboardPin,
  getDashboardAuthStatus,
  getLoginLockSeconds,
  hasValidAdminSession,
  isDashboardPinEnabled,
  recordFailedLogin,
  setAdminSessionCookie,
  setDashboardPin,
  verifyDashboardPin,
} from '../services/admin-auth.js';

export const authRouter = Router();

const loginSchema = z.object({
  pin: z.string(),
});

const configSchema = z.object({
  enabled: z.boolean(),
  pin: z.string().optional(),
});

authRouter.get('/status', (req: Request, res: Response) => {
  res.json(getDashboardAuthStatus(req));
});

authRouter.post('/login', (req: Request, res: Response) => {
  if (!isDashboardPinEnabled()) {
    clearAdminSessionCookie(req, res);
    res.json({ pinEnabled: false, authenticated: false });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'PIN is required', type: 'invalid_request_error' } });
    return;
  }

  const lockedForSeconds = getLoginLockSeconds(req);
  if (lockedForSeconds > 0) {
    res.status(429).json({
      error: {
        message: `Too many failed PIN attempts. Try again in ${lockedForSeconds} seconds.`,
        type: 'rate_limit_error',
      },
    });
    return;
  }

  if (!verifyDashboardPin(parsed.data.pin)) {
    recordFailedLogin(req);
    res.status(401).json({ error: { message: 'Invalid PIN', type: 'admin_auth_invalid' } });
    return;
  }

  clearLoginFailures(req);
  setAdminSessionCookie(req, res);
  res.json({ pinEnabled: true, authenticated: true });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  clearAdminSessionCookie(req, res);
  res.json({ pinEnabled: isDashboardPinEnabled(), authenticated: false });
});

authRouter.put('/config', (req: Request, res: Response) => {
  const currentlyEnabled = isDashboardPinEnabled();
  if (currentlyEnabled && !hasValidAdminSession(req)) {
    sendAdminAuthRequired(res);
    return;
  }

  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map(e => e.message).join(', '),
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    if (!parsed.data.enabled) {
      disableDashboardPin();
      clearAdminSessionCookie(req, res);
      res.json({ pinEnabled: false, authenticated: false });
      return;
    }

    if (!currentlyEnabled || parsed.data.pin !== undefined) {
      if (!parsed.data.pin) {
        res.status(400).json({ error: { message: 'PIN is required to enable dashboard auth', type: 'invalid_request_error' } });
        return;
      }

      setDashboardPin(parsed.data.pin);
    }

    setAdminSessionCookie(req, res);
    res.json({ pinEnabled: true, authenticated: true });
  } catch (error: any) {
    res.status(error.status ?? 500).json({
      error: {
        message: error.message ?? 'Failed to update dashboard auth settings',
        type: error.status === 400 ? 'invalid_request_error' : 'server_error',
      },
    });
  }
});
