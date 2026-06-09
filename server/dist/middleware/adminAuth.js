import { hasValidAdminSession, isDashboardPinEnabled } from '../services/admin-auth.js';
export function sendAdminAuthRequired(res) {
    res.status(401).json({
        error: {
            message: 'Dashboard PIN required',
            type: 'admin_auth_required',
        },
    });
}
export function adminAuthMiddleware(req, res, next) {
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
//# sourceMappingURL=adminAuth.js.map