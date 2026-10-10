/**
 * lib/auth.js — sessions, refresh rotation, personal access tokens, MFA,
 * lockout and the audit trail.
 *
 * The bearer token from lib/token.js is deliberately stateless: it proves who
 * you are but cannot be withdrawn. This module is the stateful half, and it is
 * what makes logout, "sign out everywhere" and API-key revocation real.
 *
 *   access token   stateless AES-256-GCM blob, 15 min to 24 h, carries `sid`
 *   refresh token  opaque 256-bit string in an HttpOnly cookie, hashed at rest,
 *                  single-use, rotated on every refresh, grouped into a family
 *                  so that replaying a spent token kills the whole family
 *   API key        `cf_live_<40 chars>`, hashed at rest, scoped, expirable,
 *                  shown exactly once at creation
 *   MFA            RFC 6238 TOTP, 6 digits, 30 s step, ±1 step drift, plus
 *                  single-use recovery codes
 *
 * Nothing secret is ever written to disk: refresh tokens and API keys live in
 * the database as SHA-256 digests, and the raw value exists only in the
 * response that mints it.
 */

import crypto from 'node:crypto';
import { db } from './db.js';
import { bool as envBool, num as envNum, get as envGet } from './settings.js';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const REFRESH_TTL_SECONDS = () => Math.max(
  300,
  envNum('TOKEN_REFRESH_TTL_SECONDS', 1209600),
);

const API_KEY_PREFIX = () => (envGet('AUTH_API_KEY_PREFIX', 'cf_live') || 'cf_live').replace(/[^A-Za-z0-9_]/g, '');
const API_KEY_TTL_SECONDS = () => Math.max(0, envNum('AUTH_API_KEY_TTL_SECONDS', 0));
const MAX_ATTEMPTS = () => Math.max(1, envNum('AUTH_MAX_LOGIN_ATTEMPTS', 8));
const LOCKOUT_MS = () => Math.max(0, envNum('AUTH_LOCKOUT_MS', 900000));
const MFA_ISSUER = () => envGet('AUTH_MFA_ISSUER', 'CampusFlow');
const TOTP_STEP = () => Math.max(15, envNum('AUTH_MFA_TOTP_STEP', 30));
const TOTP_DIGITS = () => Math.max(6, envNum('AUTH_MFA_TOTP_DIGITS', 6));
const RETENTION_DAYS = () => Math.max(1, envNum('AUTH_AUDIT_RETENTION_DAYS', 90));

export const authConfig = {
  mfaRequired: () => envBool('AUTH_REQUIRE_MFA', false),
  oneClick: () => envBool('ALLOW_ONE_CLICK_LOGIN', true),
  csrf: () => envBool('AUTH_CSRF_ENABLED', true),
  csrfHeader: () => String(envGet('AUTH_CSRF_HEADER', 'x-csrf-token')).toLowerCase(),
  cookieName: () => envGet('TOKEN_COOKIE_NAME', 'cf_session'),
  refreshCookieName: () => envGet('TOKEN_COOKIE_REFRESH_NAME', 'cf_refresh'),
};

/* ------------------------------------------------------------------ *
 * Time helpers — SQLite wants 'YYYY-MM-DD HH:MM:SS' in UTC
 * ------------------------------------------------------------------ */

export function sqlTime(date = new Date()) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

export function fromSqlTime(value) {
  if (!value) return null;
  const iso = String(value).replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const addSeconds = (seconds, from = new Date()) =>
  new Date(from.getTime() + seconds * 1000);

/* ------------------------------------------------------------------ *
 * Prepared statements
 * ------------------------------------------------------------------ */

const A = {
  insertSession: db.prepare(`
    INSERT INTO sessions (id, user_id, user_agent, ip, expires_at, last_seen_at)
    VALUES (@id, @user_id, @user_agent, @ip, @expires_at, datetime('now'))`),

  sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),

  touchSession: db.prepare(
    "UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?",
  ),

  listSessions: db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM refresh_tokens r
             WHERE r.session_id = s.id AND r.revoked_at IS NULL AND r.used_at IS NULL) AS live_tokens
      FROM sessions s
     WHERE s.user_id = @user_id AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
     ORDER BY s.last_seen_at DESC`),

  revokeSession: db.prepare(
    "UPDATE sessions SET revoked_at = datetime('now'), revoke_reason = @reason WHERE id = @id AND revoked_at IS NULL",
  ),

  revokeSessionForUser: db.prepare(`
    UPDATE sessions SET revoked_at = datetime('now'), revoke_reason = @reason
     WHERE user_id = @user_id AND revoked_at IS NULL AND (@keep IS NULL OR id <> @keep)`),

  revokeAllForUser: db.prepare(
    'UPDATE sessions SET revoked_at = datetime(\'now\'), revoke_reason = @reason WHERE user_id = @user_id AND revoked_at IS NULL',
  ),

  /* ---- refresh tokens ---- */
  insertRefresh: db.prepare(`
    INSERT INTO refresh_tokens
      (id, family_id, parent_id, session_id, user_id, token_hash, expires_at, ip, user_agent)
    VALUES
      (@id, @family_id, @parent_id, @session_id, @user_id, @token_hash, @expires_at, @ip, @user_agent)`),

  refreshByHash: db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?'),

  spendRefresh: db.prepare(
    "UPDATE refresh_tokens SET used_at = datetime('now') WHERE id = @id AND used_at IS NULL AND revoked_at IS NULL",
  ),

  revokeRefresh: db.prepare(
    'UPDATE refresh_tokens SET revoked_at = datetime(\'now\'), revoked_for = @reason WHERE id = @id',
  ),

  revokeFamily: db.prepare(
    "UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_for = @reason WHERE family_id = @family",
  ),

  /* ---- api keys ---- */
  insertApiKey: db.prepare(`
    INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, expires_at)
    VALUES (@id, @user_id, @name, @prefix, @key_hash, @scopes, @expires_at)`),

  apiKeyByHash: db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),

  listApiKeys: db.prepare(`
    SELECT * FROM api_keys WHERE user_id = @user_id AND revoked_at IS NULL
     ORDER BY created_at DESC`),

  revokeApiKey: db.prepare(
    "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL",
  ),

  touchApiKey: db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?"),

  /* ---- lockout ---- */
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),

  bumpFailures: db.prepare(`
    UPDATE users SET failed_attempts = failed_attempts + 1,
           locked_until = CASE
             WHEN failed_attempts + 1 >= @max THEN datetime('now', @lockout)
             ELSE locked_until END
     WHERE id = @id`),

  clearFailures: db.prepare(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?",
  ),

  isLocked: db.prepare(
    "SELECT locked_until FROM users WHERE id = ? AND locked_until IS NOT NULL AND locked_until > datetime('now')",
  ),

  recordAttempt: db.prepare(
    'INSERT INTO login_attempts (identifier, ip, ok, method) VALUES (@identifier, @ip, @ok, @method)',
  ),

  /* ---- mfa ---- */
  setMfa: db.prepare(
    'UPDATE users SET mfa_secret = @secret, mfa_enabled = @enabled, mfa_recovery = @recovery WHERE id = @id',
  ),

  clearMfa: db.prepare(
    'UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, mfa_recovery = NULL WHERE id = @id',
  ),

  consumeRecovery: db.prepare(
    'UPDATE users SET mfa_recovery = @remaining WHERE id = @id',
  ),

  /* ---- audit ---- */
  insertAudit: db.prepare(`
    INSERT INTO audit_log (user_id, actor, role, action, target, outcome, ip, user_agent, detail)
    VALUES (@user_id, @actor, @role, @action, @target, @outcome, @ip, @user_agent, @detail)`),

  listAudit: db.prepare(`
    SELECT * FROM audit_log
     WHERE (@user_id IS NULL OR user_id = @user_id)
     ORDER BY at DESC, id DESC LIMIT @limit`),

  pruneAudit: db.prepare(
    "DELETE FROM audit_log WHERE at < datetime('now', @cutoff)",
  ),

  pruneSessions: db.prepare(`
    DELETE FROM sessions
     WHERE expires_at < datetime('now', '-1 day') OR revoked_at < datetime('now', '-30 days')`),
};

/* ------------------------------------------------------------------ *
 * Secrets & digests
 * ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const newId = () => crypto.randomBytes(12).toString('base64url');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/* ------------------------------------------------------------------ *
 * Audit trail
 * ------------------------------------------------------------------ */

/**
 * Append one line to the audit trail. Never throws — a logging failure must
 * not take down the request that produced it.
 */
export function audit({
  userId = null, actor = null, role = null, action, target = null,
  outcome = 'ok', ip = null, userAgent = null, detail = null,
} = {}) {
  try {
    A.insertAudit.run({
      user_id: userId,
      actor: actor ? String(actor).slice(0, 120) : null,
      role,
      action: String(action).slice(0, 60),
      target: target ? String(target).slice(0, 120) : null,
      outcome,
      ip,
      user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
      detail: detail ? JSON.stringify(detail).slice(0, 1000) : null,
    });
  } catch {
    /* audit is best-effort */
  }
}

export function listAudit({ userId = null, limit = 50 } = {}) {
  return A.listAudit.all({
    user_id: userId === null ? null : Number(userId),
    limit: Math.max(1, Math.min(200, Number(limit) || 50)),
  });
}

/** Drop audit rows and dead sessions past their retention window. */
export function prune() {
  const audit = A.pruneAudit.run({ cutoff: `-${RETENTION_DAYS()} days` }).changes;
  const sessions = A.pruneSessions.run().changes;
  return { audit, sessions };
}

/* ------------------------------------------------------------------ *
 * Lockout
 * ------------------------------------------------------------------ */

/** @returns {number} milliseconds until the account unlocks, 0 when free. */
export function lockoutRemaining(userId) {
  const row = A.isLocked.get(Number(userId));
  if (!row?.locked_until) return 0;
  const until = fromSqlTime(row.locked_until);
  if (!until) return 0;
  return Math.max(0, until.getTime() - Date.now());
}

export function registerLoginAttempt({ identifier, ip = null, ok = false, method = null }) {
  try {
    A.recordAttempt.run({
      identifier: String(identifier || 'anon').slice(0, 160),
      ip,
      ok: ok ? 1 : 0,
      method,
    });
  } catch {
    /* best effort */
  }
}

export function noteFailure(user) {
  if (!user) return { locked: false, remaining: 0 };
  A.bumpFailures.run({
    id: user.id,
    max: MAX_ATTEMPTS(),
    lockout: `+${Math.round(LOCKOUT_MS() / 1000)} seconds`,
  });
  const remaining = lockoutRemaining(user.id);
  return { locked: remaining > 0, remaining, attempts: MAX_ATTEMPTS() };
}

export function noteSuccess(user) {
  if (!user) return;
  A.clearFailures.run(user.id);
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const clientOf = (req) => ({
  ip: req?.ip || req?.socket?.remoteAddress || null,
  userAgent: (req?.get?.('user-agent') || req?.headers?.['user-agent'] || '').slice(0, 200),
});

/**
 * Open a server-side session and mint its first refresh token.
 * @returns {{sessionId: string, refreshToken: string, expiresAt: Date}}
 */
export function createSession(user, req = null) {
  const { ip, userAgent } = clientOf(req);
  const sessionId = newId();
  const expiresAt = addSeconds(REFRESH_TTL_SECONDS());

  A.insertSession.run({
    id: sessionId,
    user_id: user.id,
    user_agent: userAgent,
    ip,
    expires_at: sqlTime(expiresAt),
  });

  // The session id is the family's root, so revoking a session by id takes
  // every refresh token it ever issued down with it.
  const refreshToken = mintRefresh(user.id, sessionId, { ip, userAgent, familyId: sessionId });
  return { sessionId, refreshToken, expiresAt };
}

function mintRefresh(userId, sessionId, { ip, userAgent, familyId = null, parentId = null } = {}) {
  const raw = `cf_rt_${randomToken(32)}`;
  const id = newId();
  A.insertRefresh.run({
    id,
    family_id: familyId || sessionId,
    parent_id: parentId,
    session_id: sessionId,
    user_id: userId,
    token_hash: sha256(raw),
    expires_at: sqlTime(addSeconds(REFRESH_TTL_SECONDS())),
    ip,
    user_agent: userAgent,
  });
  return raw;
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  return A.sessionById.get(String(sessionId)) || null;
}

export function touchSession(sessionId) {
  if (sessionId) A.touchSession.run(String(sessionId));
}

/**
 * Is this session still usable? Revoked, expired or deleted all mean no —
 * which is how signing out actually kills a live access token.
 */
export function isSessionLive(sessionId) {
  const session = A.sessionById.get(String(sessionId));
  if (!session) return false;
  if (session.revoked_at) return false;
  const expires = fromSqlTime(session.expires_at);
  return Boolean(expires && expires.getTime() > Date.now());
}

/** Live sessions for a user, newest activity first. */
export function listSessions(userId, currentSessionId = null) {
  return A.listSessions.all({ user_id: Number(userId) }).map((s) => ({
    id: s.id,
    current: s.id === currentSessionId,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    expiresAt: s.expires_at,
    userAgent: s.user_agent,
    ip: s.ip,
    liveRefreshTokens: s.live_tokens,
  }));
}

/** Revoke one session. Scoped to the owner, so ids cannot be guessed across users. */
export function revokeSession(userId, sessionId, reason = 'user_revoked') {
  const owned = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .get(String(sessionId), Number(userId));
  if (!owned) return false;
  A.revokeSession.run({ id: String(sessionId), reason });
  A.revokeFamily.run({ family: String(sessionId), reason });
  return true;
}

/** Sign out everywhere except the caller's own session. */
export function revokeOtherSessions(userId, keepSessionId) {
  // Snapshot the doomed sessions *before* the UPDATE, because afterwards they
  // are all filtered out of the live list and their families would be missed.
  const doomed = A.listSessions.all({ user_id: Number(userId) })
    .filter((s) => !keepSessionId || s.id !== keepSessionId);
  const result = A.revokeSessionForUser.run({
    user_id: Number(userId),
    reason: 'bulk_revoke',
    keep: keepSessionId ? String(keepSessionId) : null,
  });
  for (const s of doomed) A.revokeFamily.run({ family: s.id, reason: 'bulk_revoke' });
  return result.changes;
}

export function revokeAllSessions(userId, reason = 'logout_all') {
  const sessions = A.listSessions.all({ user_id: Number(userId) });
  for (const s of sessions) A.revokeFamily.run({ family: s.id, reason });
  return A.revokeAllForUser.run({ user_id: Number(userId), reason }).changes;
}

/* ------------------------------------------------------------------ *
 * Refresh rotation
 * ------------------------------------------------------------------ */

/**
 * Exchange a refresh token for a new one.
 *
 * A refresh token is single use. Presenting a spent token means it leaked, so
 * the whole rotation family — every descendant of the original login — is
 * revoked immediately, which signs the attacker and the victim both out.
 *
 * @returns {{ok: true, userId: number, sessionId: string, refreshToken: string}
 *          | {ok: false, reason: string}}
 */
export function rotateRefresh(rawToken, req = null) {
  if (typeof rawToken !== 'string' || rawToken.length < 20) {
    return { ok: false, reason: 'missing' };
  }

  const row = A.refreshByHash.get(sha256(rawToken));
  if (!row) return { ok: false, reason: 'unknown' };

  if (row.used_at) {
    A.revokeFamily.run({ family: row.family_id, reason: 'reuse_detected' });
    A.revokeSession.run({ id: row.session_id, reason: 'reuse_detected' });
    return { ok: false, reason: 'reused' };
  }

  if (row.revoked_at) return { ok: false, reason: 'revoked' };

  const expires = fromSqlTime(row.expires_at);
  if (!expires || expires.getTime() <= Date.now()) {
    A.revokeRefresh.run({ id: row.id, reason: 'expired' });
    return { ok: false, reason: 'expired' };
  }

  const session = A.sessionById.get(row.session_id);
  if (!session || session.revoked_at) return { ok: false, reason: 'session_revoked' };

  const sessionExpires = fromSqlTime(session.expires_at);
  if (sessionExpires && sessionExpires.getTime() <= Date.now()) {
    return { ok: false, reason: 'session_expired' };
  }

  // Spend it. `changes === 0` means a concurrent request won the race.
  if (A.spendRefresh.run({ id: row.id }).changes === 0) {
    A.revokeFamily.run({ family: row.family_id, reason: 'race_detected' });
    return { ok: false, reason: 'reused' };
  }

  const { ip, userAgent } = clientOf(req);
  const next = mintRefresh(row.user_id, row.session_id, {
    ip: ip || row.ip,
    userAgent: userAgent || row.user_agent,
    familyId: row.family_id,
    parentId: row.id,
  });
  A.touchSession.run(row.session_id);

  return { ok: true, userId: row.user_id, sessionId: row.session_id, refreshToken: next };
}

/* ------------------------------------------------------------------ *
 * Personal access tokens (API keys)
 * ------------------------------------------------------------------ */

/** Scopes an API key may carry. `full` implies everything else. */
export const SCOPES = Object.freeze(['read', 'write', 'admin']);
export const ALL_SCOPES = Object.freeze([...SCOPES, 'full']);

/**
 * Mint a personal access token. The raw key is returned exactly once — the
 * database only ever sees its digest.
 * @returns {{id, name, prefix, key, scopes, expiresAt}}
 */
export function createApiKey(userId, { name, scopes = ['read'], ttlSeconds = null } = {}) {
  const clean = String(name || 'unnamed key').trim().slice(0, 60) || 'unnamed key';
  const wanted = (Array.isArray(scopes) ? scopes : String(scopes || '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => ALL_SCOPES.includes(s));
  const granted = wanted.length ? [...new Set(wanted)] : ['read'];

  const prefix = API_KEY_PREFIX();
  const body = randomToken(30);
  const raw = `${prefix}_${body}`;

  const ttl = ttlSeconds === null ? API_KEY_TTL_SECONDS() : Number(ttlSeconds);
  const id = newId();
  const expiresAt = ttl > 0 ? sqlTime(addSeconds(ttl)) : null;

  A.insertApiKey.run({
    id,
    user_id: Number(userId),
    name: clean,
    prefix: raw.slice(0, prefix.length + 9),
    key_hash: sha256(raw),
    scopes: granted.join(','),
    expires_at: expiresAt,
  });

  return {
    id,
    name: clean,
    prefix: raw.slice(0, prefix.length + 9),
    key: raw,
    scopes: granted,
    expiresAt,
    createdAt: sqlTime(),
  };
}

/**
 * Resolve a raw API key to its owner.
 * @returns {{ok: true, user, key} | {ok: false, reason: string}}
 */
export function verifyApiKey(raw) {
  if (typeof raw !== 'string' || !raw.includes('_')) return { ok: false, reason: 'malformed' };

  const row = A.apiKeyByHash.get(sha256(raw));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };

  const expires = fromSqlTime(row.expires_at);
  if (expires && expires.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const user = A.userById.get(row.user_id);
  if (!user) return { ok: false, reason: 'orphan' };
  if (user.status && user.status !== 'active') return { ok: false, reason: 'disabled' };

  A.touchApiKey.run(row.id);
  return {
    ok: true,
    user,
    key: {
      id: row.id,
      name: row.name,
      scopes: row.scopes ? row.scopes.split(',') : ['read'],
    },
  };
}

export function listApiKeys(userId) {
  return A.listApiKeys.all({ user_id: Number(userId) }).map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes ? k.scopes.split(',') : ['read'],
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    expiresAt: k.expires_at,
    status: k.expires_at && fromSqlTime(k.expires_at) && fromSqlTime(k.expires_at) < new Date()
      ? 'expired' : 'active',
  }));
}

export function revokeApiKey(userId, keyId) {
  return A.revokeApiKey.run({ id: String(keyId), user_id: Number(userId) }).changes > 0;
}

/* ------------------------------------------------------------------ *
 * TOTP (RFC 6238) — no dependency, ~40 lines
 * ------------------------------------------------------------------ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = B32.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code authenticator app should display at `counter`. */
export function totpAt(secretBase32, counter = Math.floor(Date.now() / 1000 / TOTP_STEP())) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % (10 ** TOTP_DIGITS())).padStart(TOTP_DIGITS(), '0');
}

/** Accept the current step plus one either side, to tolerate clock drift. */
export function verifyTotp(secretBase32, code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== TOTP_DIGITS()) return false;
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP());
  for (const drift of [0, -1, 1]) {
    const expected = totpAt(secretBase32, counter + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => randomToken(5).slice(0, 10).toLowerCase());
}

/**
 * Arm MFA for a user. The secret is not usable until `enabled` is set, so the
 * UI can show the QR/secret and wait for a confirmed code.
 */
export function enrolMfa(userId) {
  const secret = generateTotpSecret();
  const recovery = generateRecoveryCodes();
  A.setMfa.run({ id: Number(userId), secret, enabled: 0, recovery: JSON.stringify(recovery) });
  return {
    secret,
    otpauth: `otpauth://totp/${encodeURIComponent(MFA_ISSUER())}:${userId}?secret=${secret}&issuer=${encodeURIComponent(MFA_ISSUER())}&algorithm=SHA1&digits=${TOTP_DIGITS()}&period=${TOTP_STEP()}`,
    recoveryCodes: recovery,
  };
}

/** Confirm enrolment with the first real code, then switch MFA on. */
export function confirmMfa(userId, code) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!user?.mfa_secret) return { ok: false, reason: 'not_enrolled' };
  if (!verifyTotp(user.mfa_secret, code)) return { ok: false, reason: 'bad_code' };
  A.setMfa.run({
    id: Number(userId),
    secret: user.mfa_secret,
    enabled: 1,
    recovery: user.mfa_recovery,
  });
  return { ok: true };
}

export function disableMfa(userId) {
  // Named parameters must be bound by name; passing the bare id throws.
  A.clearMfa.run({ id: Number(userId) });
  return true;
}

/**
 * Second factor check. A recovery code is accepted once and then destroyed.
 * @returns {{ok: true, via: 'totp'|'recovery'} | {ok: false, reason: string}}
 */
export function verifySecondFactor(user, code) {
  if (!user) return { ok: false, reason: 'no_user' };
  const clean = String(code || '').trim();

  if (user.mfa_secret) {
    if (verifyTotp(user.mfa_secret, clean)) return { ok: true, via: 'totp' };

    const codes = user.mfa_recovery ? JSON.parse(user.mfa_recovery) : [];
    const candidate = Buffer.from(clean.toLowerCase());
    const index = codes.findIndex((c) => {
      const stored = Buffer.from(String(c));
      // timingSafeEqual throws on a length mismatch, so compare lengths first.
      return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    });
    if (index !== -1) {
      A.consumeRecovery.run({ id: user.id, remaining: JSON.stringify(codes.filter((_, i) => i !== index)) });
      return { ok: true, via: 'recovery' };
    }
  }

  return { ok: false, reason: 'invalid_code' };
}

export function mfaState(user) {
  return {
    enrolled: Boolean(user?.mfa_secret),
    enabled: Boolean(user?.mfa_enabled) || authConfig.mfaRequired(),
    requiredByPolicy: authConfig.mfaRequired(),
    method: 'totp',
    digits: TOTP_DIGITS(),
    stepSeconds: TOTP_STEP(),
  };
}

/* ------------------------------------------------------------------ *
 * Summary for the settings GUI
 * ------------------------------------------------------------------ */

export function authStats() {
  const now = sqlTime();
  return {
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?').get(now).n,
    refreshTokens: db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE used_at IS NULL AND revoked_at IS NULL').get().n,
    apiKeys: db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL').get().n,
    lockedAccounts: db.prepare("SELECT COUNT(*) AS n FROM users WHERE locked_until > datetime('now')").get().n,
    mfaEnabled: db.prepare('SELECT COUNT(*) AS n FROM users WHERE mfa_enabled = 1').get().n,
    auditRows: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
    config: {
      refreshTtlSeconds: REFRESH_TTL_SECONDS(),
      apiKeyPrefix: API_KEY_PREFIX(),
      apiKeyTtlSeconds: API_KEY_TTL_SECONDS(),
      maxAttempts: MAX_ATTEMPTS(),
      lockoutMs: LOCKOUT_MS(),
      csrfEnabled: authConfig.csrf(),
      csrfHeader: authConfig.csrfHeader(),
      oneClickLogin: authConfig.oneClick(),
      mfaRequired: authConfig.mfaRequired(),
    },
  };
}
