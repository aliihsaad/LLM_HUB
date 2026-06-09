import crypto from 'crypto';
import { getDb } from '../db/index.js';
const PIN_ENABLED_KEY = 'admin_pin_enabled';
const PIN_HASH_KEY = 'admin_pin_hash';
const SESSION_SECRET_KEY = 'admin_session_secret';
const SESSION_COOKIE_NAME = 'llmhub_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 128;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const loginFailures = new Map();
function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
}
function setSetting(key, value) {
    getDb().prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
function deleteSetting(key) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}
function getSessionSecret() {
    const existing = getSetting(SESSION_SECRET_KEY);
    if (existing)
        return existing;
    const secret = crypto.randomBytes(32).toString('hex');
    setSetting(SESSION_SECRET_KEY, secret);
    return secret;
}
function rotateSessionSecret() {
    setSetting(SESSION_SECRET_KEY, crypto.randomBytes(32).toString('hex'));
}
function timingSafeStringEqual(provided, expected) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
    return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}
function timingSafeBufferEqual(provided, expected) {
    const compareA = provided.length === expected.length ? provided : Buffer.alloc(expected.length);
    return crypto.timingSafeEqual(compareA, expected) && provided.length === expected.length;
}
export function validateAdminPin(pin) {
    if (typeof pin !== 'string')
        return 'PIN must be a string';
    const trimmed = pin.trim();
    if (trimmed.length < MIN_PIN_LENGTH)
        return `PIN must be at least ${MIN_PIN_LENGTH} characters`;
    if (trimmed.length > MAX_PIN_LENGTH)
        return `PIN must be ${MAX_PIN_LENGTH} characters or fewer`;
    return null;
}
function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pin, salt, 32, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
    });
    return [
        'scrypt',
        '1',
        String(SCRYPT_N),
        String(SCRYPT_R),
        String(SCRYPT_P),
        salt.toString('hex'),
        hash.toString('hex'),
    ].join('$');
}
function verifyPin(pin, encodedHash) {
    const parts = encodedHash.split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1')
        return false;
    const [, , nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p))
        return false;
    try {
        const salt = Buffer.from(saltHex, 'hex');
        const expected = Buffer.from(hashHex, 'hex');
        const actual = crypto.scryptSync(pin, salt, expected.length, {
            N: n,
            r,
            p,
            maxmem: SCRYPT_MAXMEM,
        });
        return timingSafeBufferEqual(actual, expected);
    }
    catch {
        return false;
    }
}
export function isDashboardPinEnabled() {
    return getSetting(PIN_ENABLED_KEY) === '1' && Boolean(getSetting(PIN_HASH_KEY));
}
export function setDashboardPin(pin) {
    const validationError = validateAdminPin(pin);
    if (validationError) {
        const error = new Error(validationError);
        error.status = 400;
        throw error;
    }
    setSetting(PIN_HASH_KEY, hashPin(pin));
    setSetting(PIN_ENABLED_KEY, '1');
    rotateSessionSecret();
}
export function disableDashboardPin() {
    setSetting(PIN_ENABLED_KEY, '0');
    deleteSetting(PIN_HASH_KEY);
    rotateSessionSecret();
}
export function verifyDashboardPin(pin) {
    const encodedHash = getSetting(PIN_HASH_KEY);
    if (!isDashboardPinEnabled() || !encodedHash)
        return false;
    return verifyPin(pin, encodedHash);
}
function signSessionPayload(payload) {
    return crypto
        .createHmac('sha256', getSessionSecret())
        .update(payload)
        .digest('hex');
}
function parseCookies(req) {
    const cookies = new Map();
    const header = req.headers.cookie;
    if (!header)
        return cookies;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1)
            continue;
        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (name)
            cookies.set(name, decodeURIComponent(value));
    }
    return cookies;
}
function shouldUseSecureCookie(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const firstForwardedProto = Array.isArray(forwardedProto)
        ? forwardedProto[0]
        : forwardedProto?.split(',')[0]?.trim();
    return req.secure || firstForwardedProto === 'https';
}
export function setAdminSessionCookie(req, res) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${expiresAt}.${nonce}`;
    const signature = signSessionPayload(payload);
    res.cookie(SESSION_COOKIE_NAME, `${payload}.${signature}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: shouldUseSecureCookie(req),
        expires: new Date(expiresAt),
        path: '/',
    });
}
export function clearAdminSessionCookie(req, res) {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: shouldUseSecureCookie(req),
        path: '/',
    });
}
export function hasValidAdminSession(req) {
    if (!isDashboardPinEnabled())
        return false;
    const value = parseCookies(req).get(SESSION_COOKIE_NAME);
    if (!value)
        return false;
    const parts = value.split('.');
    if (parts.length !== 3)
        return false;
    const [expiresAtRaw, nonce, signature] = parts;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        return false;
    const expected = signSessionPayload(`${expiresAtRaw}.${nonce}`);
    return timingSafeStringEqual(signature, expected);
}
export function getDashboardAuthStatus(req) {
    const pinEnabled = isDashboardPinEnabled();
    return {
        pinEnabled,
        authenticated: pinEnabled ? hasValidAdminSession(req) : false,
    };
}
function getLoginFailureKey(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}
export function getLoginLockSeconds(req) {
    const key = getLoginFailureKey(req);
    const entry = loginFailures.get(key);
    if (!entry)
        return 0;
    if (entry.lockedUntil <= Date.now()) {
        if (Date.now() - entry.firstFailedAt > LOGIN_WINDOW_MS)
            loginFailures.delete(key);
        return 0;
    }
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
}
export function recordFailedLogin(req) {
    const key = getLoginFailureKey(req);
    const now = Date.now();
    const existing = loginFailures.get(key);
    const entry = existing && now - existing.firstFailedAt <= LOGIN_WINDOW_MS
        ? existing
        : { count: 0, firstFailedAt: now, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_LOGIN_FAILURES) {
        entry.lockedUntil = now + LOGIN_LOCK_MS;
    }
    loginFailures.set(key, entry);
}
export function clearLoginFailures(req) {
    loginFailures.delete(getLoginFailureKey(req));
}
//# sourceMappingURL=admin-auth.js.map