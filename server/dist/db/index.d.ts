import Database from 'better-sqlite3';
export declare function getDb(): Database.Database;
export declare function initDb(dbPath?: string): Promise<Database.Database>;
/**
 * One-time cleanup: remove the BazaarLink rows imported before the scout's
 * chat filter existed.
 *
 * On 2026-07-20 the scout pulled BazaarLink's entire ~260-model catalog in
 * batches of MAX_DISCOVERED_PER_PLATFORM, including ~245 text-to-image and
 * text-to-video models (wan2.1-t2i, happyhorse, Z-Image-Turbo) and paid chat
 * models that can never serve /v1/chat/completions. They landed disabled — so
 * nothing could route to them — but they clutter the catalog and inflate the
 * "unknown / never scanned" counters on Model Status.
 *
 * isBazaarlinkFreeChatEntry now rejects all of them at discovery (verified
 * against the live catalog: 2 of 260 pass), so this only clears the historical
 * residue. Scoped deliberately narrowly:
 *   - platform bazaarlink only (other providers import catalogs by design)
 *   - disabled only (never touch something in use)
 *   - auto-discovered only (seeded/curated rows have no discovery_source)
 *   - discovered before the cutoff, so a later legitimate discovery that an
 *     operator chooses to disable is never swept up
 *
 * fallback_config is ON DELETE NO ACTION and must be cleared first;
 * model_availability / model_capabilities / model_runtime_health cascade.
 */
export declare function purgeLegacyBazaarlinkDiscoveries(db: Database.Database): void;
export declare function getUnifiedApiKey(): string;
export declare function regenerateUnifiedKey(): string;
//# sourceMappingURL=index.d.ts.map