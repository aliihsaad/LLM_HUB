import type { KeyStatus } from 'llmhub-shared/types.js';
export declare function checkKeyHealth(keyId: number): Promise<KeyStatus>;
export declare function checkAllKeys(): Promise<void>;
export declare function startHealthChecker(): void;
export declare function stopHealthChecker(): void;
//# sourceMappingURL=health.d.ts.map