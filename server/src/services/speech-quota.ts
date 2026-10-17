import { getDb } from '../db/index.js';
import type { SpeechQuota } from '../providers/google-speech-error.js';

/** Observed provider cooldowns survive restarts; they do not invent per-key daily allowances. */
export function recordSpeechQuota(keyId: number, model: string, quota: SpeechQuota): void {
  getDb().prepare(`INSERT INTO speech_quota (key_id,model_id,retry_at,kind,request_limit,period)
    VALUES (?,?,?,?,?,?) ON CONFLICT(key_id,model_id) DO UPDATE SET
    retry_at=excluded.retry_at,kind=excluded.kind,request_limit=excluded.request_limit,period=excluded.period
    WHERE excluded.retry_at >= speech_quota.retry_at`).run(
    keyId, model, quota.retryAt, quota.kind, quota.requestLimit ?? null, quota.period ?? null,
  );
}

export function getSpeechQuota(keyId: number, model: string): SpeechQuota | undefined {
  const row = getDb().prepare(`SELECT retry_at,kind,request_limit,period FROM speech_quota
    WHERE key_id=? AND model_id=? AND retry_at>?`).get(keyId, model, Date.now()) as any;
  return row ? { kind: row.kind, retryAt: row.retry_at,
    ...(row.request_limit !== null ? { requestLimit: row.request_limit, period: row.period } : {}) } : undefined;
}
