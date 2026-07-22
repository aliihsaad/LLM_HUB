import type { ModelSweepJob, Platform } from 'llmhub-shared/types.js';
interface SweepTarget {
    modelDbId: number;
    platform: Platform;
    modelId: string;
    displayName: string;
    priority: number;
}
export declare function startModelSweep(): ModelSweepJob;
export declare function getModelSweepJob(id: string): ModelSweepJob | undefined;
/** Sweep candidates feeding the dashboard "test all models now" action, which
 *  makes real chatCompletion calls. Gated the same way as selectSweepCandidateIds
 *  in model-scout.ts: paid rows are excluded while free-only mode is on so the
 *  sweep never spends key credit. */
export declare function listSweepTargets(): SweepTarget[];
export {};
//# sourceMappingURL=model-sweeps.d.ts.map