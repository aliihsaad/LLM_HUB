import Database from 'better-sqlite3';
/**
 * Initialize encryption key from env, DB, or generate a new one.
 * Must be called after DB is initialized.
 */
export declare function initEncryptionKey(db: Database.Database): void;
export declare function encrypt(text: string): {
    encrypted: string;
    iv: string;
    authTag: string;
};
export declare function decrypt(encrypted: string, iv: string, authTag: string): string;
export declare function maskKey(key: string): string;
//# sourceMappingURL=crypto.d.ts.map