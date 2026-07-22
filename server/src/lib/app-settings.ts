import type Database from 'better-sqlite3';

const FREE_ONLY_KEY = 'free_only_mode';

/** Free-tier-only mode. Default ON when the settings row is absent. */
export function isFreeOnlyMode(db: Database.Database): boolean {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(FREE_ONLY_KEY) as { value: string } | undefined;
  return row ? row.value === '1' : true;
}

export function setFreeOnlyMode(db: Database.Database, on: boolean): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(FREE_ONLY_KEY, on ? '1' : '0');
}
