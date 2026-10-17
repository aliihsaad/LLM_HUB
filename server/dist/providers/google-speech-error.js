export class GoogleSpeechError extends Error {
    status;
    quota;
    constructor(status, quota) {
        super(quota ? speechQuotaMessage(quota) : `Google voice request failed (HTTP ${status}).`);
        this.status = status;
        this.quota = quota;
    }
}
export function speechQuotaMessage(quota) {
    const limit = quota.requestLimit !== undefined && quota.period
        ? ` (${quota.requestLimit} requests per ${quota.period})` : '';
    return `Google speech ${quota.kind === 'daily_quota_exceeded' ? 'daily quota exhausted' : 'rate limit reached'}${limit}. Retry after ${new Date(quota.retryAt).toISOString()}.`;
}
function retrySeconds(header, now) {
    if (!header)
        return;
    const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 366 * 86400 ? seconds : undefined;
}
export function speechErrorFromPayload(status, payload, retryAfter = null) {
    const error = payload?.error ?? payload;
    const code = error?.code;
    if (['quota_exceeded', 'rate_limit_exceeded', 'too_many_requests', 'RESOURCE_EXHAUSTED'].includes(code))
        status = 429;
    if (status !== 429)
        return new GoogleSpeechError(status);
    const message = typeof error?.message === 'string' ? error.message.slice(0, 8192) : '';
    const match = /\blimit:\s*(\d{1,9})\s+requests?\s+per\s+(day|minute|second)\b/i.exec(message);
    const period = match?.[2].toLowerCase();
    const now = Date.now();
    let seconds = retrySeconds(retryAfter, now);
    if (seconds === undefined) {
        const info = Array.isArray(error?.details) && error.details.find((d) => d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
        if (typeof info?.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/.test(info.retryDelay))
            seconds = retrySeconds(info.retryDelay.slice(0, -1), now);
        const delay = /\bretry in\s+(?:(\d{1,3})h)?(?:(\d{1,2})m)?(?:(\d{1,2})s)?\b/i.exec(message);
        if (seconds === undefined && delay && delay.slice(1).some(Boolean)) {
            seconds = Number(delay[1] ?? 0) * 3600 + Number(delay[2] ?? 0) * 60 + Number(delay[3] ?? 0);
        }
    }
    return new GoogleSpeechError(429, {
        kind: code === 'quota_exceeded' || period === 'day' || /daily quota|requests per day/i.test(message)
            ? 'daily_quota_exceeded' : 'rate_limit_exceeded',
        // No invented daily reset when Google supplies none. A short backoff is only a retry hint.
        retryAt: now + Math.max(1, Math.ceil(seconds ?? 60)) * 1000,
        ...(match ? { requestLimit: Number(match[1]), period } : {}),
    });
}
export async function readGoogleSpeechError(response) {
    // Bound error-body reads, and never preserve the untrusted body on the error object.
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
        const decoder = new TextDecoder();
        try {
            while (text.length < 16_384) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                text += decoder.decode(value, { stream: true });
            }
        }
        catch { /* HTTP status remains useful if the body is truncated. */ }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
    let payload;
    try {
        payload = JSON.parse(text.slice(0, 16_384));
    }
    catch { /* non-JSON provider failure */ }
    return speechErrorFromPayload(response.status, payload, response.headers.get('retry-after'));
}
//# sourceMappingURL=google-speech-error.js.map