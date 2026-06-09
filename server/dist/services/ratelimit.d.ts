export declare function canMakeRequest(platform: string, modelId: string, keyId: number, limits: {
    rpm: number | null;
    rpd: number | null;
    tpm: number | null;
    tpd: number | null;
}): boolean;
export declare function canUseTokens(platform: string, modelId: string, keyId: number, estimatedTokens: number, limits: {
    tpm: number | null;
    tpd: number | null;
}): boolean;
export declare function recordRequest(platform: string, modelId: string, keyId: number): void;
export declare function recordTokens(platform: string, modelId: string, keyId: number, tokens: number): void;
export declare function setCooldown(platform: string, modelId: string, keyId: number, durationMs?: number): void;
export declare function isOnCooldown(platform: string, modelId: string, keyId: number): boolean;
export declare function getRateLimitStatus(platform: string, modelId: string, keyId: number, limits: {
    rpm: number | null;
    rpd: number | null;
    tpm: number | null;
    tpd: number | null;
}): {
    rpm: {
        used: number;
        limit: number | null;
    };
    rpd: {
        used: number;
        limit: number | null;
    };
    tpm: {
        used: number;
        limit: number | null;
    };
};
//# sourceMappingURL=ratelimit.d.ts.map