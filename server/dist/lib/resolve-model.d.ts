import type Database from 'better-sqlite3';
import type { Response } from 'express';
export type Resolution = {
    kind: 'ok';
    id: number;
} | {
    kind: 'not_found';
} | {
    kind: 'disabled';
} | {
    kind: 'capability_missing';
    capability: string;
} | {
    kind: 'paid_blocked';
};
/**
 * Resolve an explicitly requested model id to a routable catalog row.
 * Order of precedence: unknown → capability → disabled → paid (so error
 * messages never leak paid-model existence distinctions before validity).
 */
export declare function resolveRoutableModel(db: Database.Database, modelId: string, requiredCapability?: string | null): Resolution;
/** Send the standard error payload for a non-ok resolution. */
export declare function sendResolutionError(res: Response, modelId: string, r: Resolution): void;
//# sourceMappingURL=resolve-model.d.ts.map