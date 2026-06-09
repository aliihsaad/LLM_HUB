import type { NextFunction, Request, Response } from 'express';
import { hasValidAdminSession, isDashboardPinEnabled } from '../services/admin-auth.js';

export function sendAdminAuthRequired(res: Response) {
  res.status(401).json({
    error: {
      message: 'Dashboard PIN required',
      type: 'admin_auth_required',
    },
  });
}

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isDashboardPinEnabled()) {
    next();
    return;
  }

  if (hasValidAdminSession(req)) {
    next();
    return;
  }

  sendAdminAuthRequired(res);
}
