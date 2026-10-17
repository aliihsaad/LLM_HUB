import type { SpeechQuota } from '../providers/google-speech-error.js';
/** Observed provider cooldowns survive restarts; they do not invent per-key daily allowances. */
export declare function recordSpeechQuota(keyId: number, model: string, quota: SpeechQuota): void;
export declare function getSpeechQuota(keyId: number, model: string): SpeechQuota | undefined;
//# sourceMappingURL=speech-quota.d.ts.map