/** Keep only quota facts: provider messages can contain transcripts, URLs or credentials. */
export interface SpeechQuota {
    kind: 'daily_quota_exceeded' | 'rate_limit_exceeded';
    retryAt: number;
    requestLimit?: number;
    period?: 'day' | 'minute' | 'second';
}
export declare class GoogleSpeechError extends Error {
    status: number;
    quota?: SpeechQuota | undefined;
    constructor(status: number, quota?: SpeechQuota | undefined);
}
export declare function speechQuotaMessage(quota: SpeechQuota): string;
export declare function speechErrorFromPayload(status: number, payload: any, retryAfter?: string | null): GoogleSpeechError;
export declare function readGoogleSpeechError(response: Response): Promise<GoogleSpeechError>;
//# sourceMappingURL=google-speech-error.d.ts.map