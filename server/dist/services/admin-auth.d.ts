import type { Request, Response } from 'express';
export interface DashboardAuthStatus {
    pinEnabled: boolean;
    authenticated: boolean;
}
export declare function validateAdminPin(pin: string): string | null;
export declare function isDashboardPinEnabled(): boolean;
export declare function setDashboardPin(pin: string): void;
export declare function disableDashboardPin(): void;
export declare function verifyDashboardPin(pin: string): boolean;
export declare function setAdminSessionCookie(req: Request, res: Response): void;
export declare function clearAdminSessionCookie(req: Request, res: Response): void;
export declare function hasValidAdminSession(req: Request): boolean;
export declare function getDashboardAuthStatus(req: Request): DashboardAuthStatus;
export declare function getLoginLockSeconds(req: Request): number;
export declare function recordFailedLogin(req: Request): void;
export declare function clearLoginFailures(req: Request): void;
//# sourceMappingURL=admin-auth.d.ts.map