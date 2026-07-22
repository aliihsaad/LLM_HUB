import type Database from 'better-sqlite3';
/** Free-tier-only mode. Default ON when the settings row is absent. */
export declare function isFreeOnlyMode(db: Database.Database): boolean;
export declare function setFreeOnlyMode(db: Database.Database, on: boolean): void;
//# sourceMappingURL=app-settings.d.ts.map