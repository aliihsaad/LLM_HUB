// In-memory sliding window rate limit tracker
// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map();
function getWindow(key) {
    let w = windows.get(key);
    if (!w) {
        w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
        windows.set(key, w);
    }
    return w;
}
function pruneTimestamps(timestamps, windowMs, now) {
    const cutoff = now - windowMs;
    return timestamps.filter(ts => ts > cutoff);
}
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
export function canMakeRequest(platform, modelId, keyId, limits) {
    const now = Date.now();
    if (limits.rpm !== null) {
        const key = `${platform}:${modelId}:${keyId}:rpm`;
        const w = getWindow(key);
        w.timestamps = pruneTimestamps(w.timestamps, MINUTE, now);
        if (w.timestamps.length >= limits.rpm)
            return false;
    }
    if (limits.rpd !== null) {
        const key = `${platform}:${modelId}:${keyId}:rpd`;
        const w = getWindow(key);
        w.timestamps = pruneTimestamps(w.timestamps, DAY, now);
        if (w.timestamps.length >= limits.rpd)
            return false;
    }
    return true;
}
export function canUseTokens(platform, modelId, keyId, estimatedTokens, limits) {
    const now = Date.now();
    if (limits.tpm !== null) {
        const key = `${platform}:${modelId}:${keyId}:tpm`;
        const w = getWindow(key);
        w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - MINUTE);
        const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
        if (used + estimatedTokens > limits.tpm)
            return false;
    }
    if (limits.tpd !== null) {
        const key = `${platform}:${modelId}:${keyId}:tpd`;
        const w = getWindow(key);
        w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - DAY);
        const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
        if (used + estimatedTokens > limits.tpd)
            return false;
    }
    return true;
}
export function recordRequest(platform, modelId, keyId) {
    const now = Date.now();
    const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
    getWindow(rpmKey).timestamps.push(now);
    const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
    getWindow(rpdKey).timestamps.push(now);
}
export function recordTokens(platform, modelId, keyId, tokens) {
    const now = Date.now();
    const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
    getWindow(tpmKey).tokenTimestamps.push({ ts: now, tokens });
    const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
    getWindow(tpdKey).tokenTimestamps.push({ ts: now, tokens });
}
// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map(); // key -> expiry timestamp
export function setCooldown(platform, modelId, keyId, durationMs = 60_000) {
    const key = `${platform}:${modelId}:${keyId}:cooldown`;
    cooldowns.set(key, Date.now() + durationMs);
}
export function isOnCooldown(platform, modelId, keyId) {
    const key = `${platform}:${modelId}:${keyId}:cooldown`;
    const expiry = cooldowns.get(key);
    if (!expiry)
        return false;
    if (Date.now() > expiry) {
        cooldowns.delete(key);
        return false;
    }
    return true;
}
export function getRateLimitStatus(platform, modelId, keyId, limits) {
    const now = Date.now();
    const rpmW = getWindow(`${platform}:${modelId}:${keyId}:rpm`);
    rpmW.timestamps = pruneTimestamps(rpmW.timestamps, MINUTE, now);
    const rpdW = getWindow(`${platform}:${modelId}:${keyId}:rpd`);
    rpdW.timestamps = pruneTimestamps(rpdW.timestamps, DAY, now);
    const tpmW = getWindow(`${platform}:${modelId}:${keyId}:tpm`);
    tpmW.tokenTimestamps = tpmW.tokenTimestamps.filter(t => t.ts > now - MINUTE);
    const tpmUsed = tpmW.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    return {
        rpm: { used: rpmW.timestamps.length, limit: limits.rpm },
        rpd: { used: rpdW.timestamps.length, limit: limits.rpd },
        tpm: { used: tpmUsed, limit: limits.tpm },
    };
}
//# sourceMappingURL=ratelimit.js.map