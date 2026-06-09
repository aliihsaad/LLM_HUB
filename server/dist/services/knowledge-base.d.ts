/**
 * Context7 Knowledge Base Service
 *
 * Integrates with Context7 MCP (or a configured endpoint) to fetch
 * up-to-date API documentation and schemas for all providers.
 * Stores knowledge in the local DB for fast querying.
 *
 * If Context7 API is not configured, shows an admin warning and
 * falls back to locally-seeded documentation.
 */
import { getDb } from '../db/index.js';
export interface KnowledgeEntry {
    id: number;
    provider: string;
    topic: string;
    content: string;
    sourceUrl?: string;
    version?: string;
    fetchedAt: string;
    lastVerifiedAt?: string;
}
export interface Context7Query {
    query: string;
    provider?: string;
    limit?: number;
}
export interface Context7Config {
    apiUrl: string | null;
    apiKey: string | null;
    configured: boolean;
}
export interface KnowledgeSyncProviderResult {
    provider: string;
    displayName: string;
    synced: number;
    failed: number;
}
export interface KnowledgeSyncResult {
    synced: number;
    failed: number;
    providers: KnowledgeSyncProviderResult[];
}
export interface KnowledgeProviderStatus {
    provider: string;
    displayName: string;
    docsUrl: string;
    topics: number;
    lastFetchedAt: string | null;
    lastVerifiedAt: string | null;
    status: 'synced' | 'missing';
}
/**
 * Get Context7 API configuration from dashboard-stored key or env override.
 * The endpoint URL is fixed and does not need operator configuration.
 */
export declare function getContext7Config(): Context7Config;
/**
 * Log a warning banner if Context7 is not configured.
 * Only logs once per process lifetime.
 */
export declare function logContext7Warning(): void;
/**
 * Check if Context7 is configured and healthy.
 */
export declare function isContext7Configured(): boolean;
/**
 * Initialize the knowledge_base table if not exists.
 * Called during DB setup.
 */
export declare function initKnowledgeBase(db: ReturnType<typeof getDb>): void;
/**
 * Fetch provider documentation from Context7 API.
 */
export declare function fetchFromContext7(provider: string, topic: string): Promise<string | null>;
/**
 * Sync provider documentation from Context7 API.
 * Falls back to local knowledge if Context7 is not configured.
 */
export declare function syncContext7Knowledge(): Promise<KnowledgeSyncResult>;
/**
 * Store a knowledge entry in the database.
 */
export declare function storeKnowledge(provider: string, topic: string, content: string, sourceUrl?: string, version?: string): void;
/**
 * Get per-provider documentation sync status for the dashboard.
 */
export declare function getKnowledgeSyncStatus(): KnowledgeProviderStatus[];
/**
 * Query knowledge base for a specific question.
 * Returns matching entries ranked by relevance (simple substring matching).
 */
export declare function queryKnowledge(query: Context7Query): KnowledgeEntry[];
/**
 * Get all knowledge entries for a provider.
 */
export declare function getProviderKnowledge(provider: string): KnowledgeEntry[];
/**
 * Seed the knowledge base with some essential provider integration docs.
 * This is a fallback until Context7 MCP is fully configured.
 */
export declare function seedDefaultKnowledge(): void;
/**
 * Search knowledge across all providers.
 */
export declare function searchAllKnowledge(query: string, limit?: number): KnowledgeEntry[];
//# sourceMappingURL=knowledge-base.d.ts.map