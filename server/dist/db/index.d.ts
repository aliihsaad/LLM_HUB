import Database from 'better-sqlite3';
export declare function getDb(): Database.Database;
export declare function initDb(dbPath?: string): Promise<Database.Database>;
export declare function getUnifiedApiKey(): string;
export declare function regenerateUnifiedKey(): string;
//# sourceMappingURL=index.d.ts.map