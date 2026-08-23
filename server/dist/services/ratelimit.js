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
/** Cooldown key covering every model on a platform for one credential. */
function keyScopedCooldownId(platform, keyId) {
    return `${platform}:*:${keyId}:cooldown`;
}
/**
 * Bench a credential across ALL models on its platform.
 *
 * Some failures are properties of the account, not the model: a Google project
 * denied access answers 403 for every model it owns. A per-model cooldown
 * cannot express that, so the router kept re-selecting the bad credential once
 * per model — one denied Google project produced 50 logged 403s across the
 * catalog while its dashboard row still read "healthy".
 */
export function setKeyCooldown(platform, keyId, durationMs = 60_000) {
    cooldowns.set(keyScopedCooldownId(platform, keyId), Date.now() + durationMs);
}
function isExpired(id) {
    const expiry = cooldowns.get(id);
    if (!expiry)
        return true;
    if (Date.now() > expiry) {
        cooldowns.delete(id);
        return true;
    }
    return false;
}
export function isOnCooldown(platform, modelId, keyId) {
    // A key-scoped cooldown outranks the per-model one: if the credential itself
    // is benched, no model on that platform can use it.
    if (!isExpired(keyScopedCooldownId(platform, keyId)))
        return true;
    return !isExpired(`${platform}:${modelId}:${keyId}:cooldown`);
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