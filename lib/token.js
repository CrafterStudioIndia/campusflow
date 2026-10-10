/**
 * lib/token.js — Hardened authenticated tokens, zero external libraries.
 *
 * Password storage : scrypt (N=16384, r=8, p=1) with a per-user random salt.
 *                    Cost parameters are stored alongside each hash so they can
 *                    be raised later without invalidating existing accounts.
 * Session tokens   : AES-256-GCM over a compact JSON payload.
 *                    Wire format is URL-safe:  <iv>.<authTag>.<ciphertext>
 *                    Every field is base64url, so the token is safe in headers,
 *                    query strings and cookies without further encoding.
 *
 * The GCM auth tag is verified on decrypt, so any bit-flip in the ciphertext,
 * the IV or the payload fails closed with an authentication error.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool as envBool, get as envGet } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const TAG_BYTES = 16; // 128-bit authentication tag
const KEY_BYTES = 32; // 256-bit key

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Default token lifetime. Overridable with TOKEN_TTL_SECONDS. */
const DEFAULT_TTL_SECONDS = Math.max(
  60,
  Number.parseInt(process.env.TOKEN_TTL_SECONDS || '28800', 10) || 28800,
);

/**
 * Resolve the 256-bit encryption key.
 * Prefers TOKEN_SECRET; otherwise generates one once and persists it to
 * .token-secret (0600) so that sessions survive a restart in development.
 */
function loadKey() {
  const fromEnv = process.env.TOKEN_SECRET;
  let secret;

  if (fromEnv && fromEnv.trim().length >= 16) {
    secret = fromEnv.trim();
  } else {
    const secretFile = path.join(ROOT, '.token-secret');
    try {
      secret = fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
      secret = crypto.randomBytes(48).toString('base64url');
      try {
        fs.writeFileSync(secretFile, secret, { mode: 0o600 });
        console.warn(
          '[token] TOKEN_SECRET not set — generated a key at .token-secret. ' +
            'Set TOKEN_SECRET in production.',
        );
      } catch {
        console.warn(
          '[token] TOKEN_SECRET not set and .token-secret is not writable — ' +
            'using an ephemeral key; tokens will not survive a restart.',
        );
      }
    }
  }

  // Stretch the secret into a uniform 32-byte key.
  return crypto.scryptSync(secret, 'campusflow.token.key.v1', KEY_BYTES);
}

const KEY = loadKey();

/** Thrown for every authentication failure. Never leaks the reason to clients. */
export class TokenError extends Error {
  constructor(message, code = 'invalid_token') {
    super(message);
    this.name = 'TokenError';
    this.code = code;
    this.status = code === 'token_expired' ? 401 : 401;
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(str, 'base64url');

/* ------------------------------------------------------------------ *
 * Password hashing
 * ------------------------------------------------------------------ */

/**
 * Hash a plaintext password.
 * @returns {string} `scrypt$N$r$p$salt$hash` (all binary parts base64url)
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    b64(salt),
    b64(derived),
  ].join('$');
}

/**
 * Verify a plaintext password against a stored hash.
 * Uses a constant-time comparison and never throws on malformed input.
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = unb64(parts[4]);
    expected = unb64(parts[5]);
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ *
 * AES-256-GCM session tokens
 * ------------------------------------------------------------------ */

/**
 * Encrypt a payload into a URL-safe authenticated token.
 * @param {object} payload  claims to embed (e.g. { sub, email, role, name })
 * @param {{ttlSeconds?: number}} [options]
 * @returns {string} `<iv>.<authTag>.<ciphertext>` base64url
 */
export function sign(payload, options = {}) {
  const ttl = options.ttlSeconds === undefined
    ? DEFAULT_TTL_SECONDS
    : Math.max(1, Math.floor(options.ttlSeconds));
  const now = Math.floor(Date.now() / 1000);

  const claims = {
    ...payload,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomBytes(9).toString('base64url'),
  };

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from('campusflow.v1', 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(claims), 'utf8'),
    cipher.final(),
  ]);

  return `${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ciphertext)}`;
}

/**
 * Decrypt and authenticate a token.
 * @throws {TokenError} on malformed, tampered, or expired tokens.
 * @returns {object} the verified claims
 */
export function verify(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TokenError('Token missing', 'token_missing');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new TokenError('Token malformed', 'token_malformed');
  }

  const [ivPart, tagPart, dataPart] = parts;
  let iv;
  let tag;
  let ciphertext;
  try {
    iv = unb64(ivPart);
    tag = unb64(tagPart);
    ciphertext = unb64(dataPart);
  } catch {
    throw new TokenError('Token malformed', 'token_malformed');
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TokenError('Token malformed', 'token_malformed');
  }

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from('campusflow.v1', 'utf8'));
    decipher.setAuthTag(tag);
    // setAuthTag + final() performs the authentication check; a tampered
    // token throws here before we ever look at the plaintext.
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new TokenError('Token signature invalid', 'token_tampered');
  }

  let claims;
  try {
    claims = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new TokenError('Token payload unreadable', 'token_malformed');
  }

  if (typeof claims?.exp !== 'number') {
    throw new TokenError('Token has no expiry', 'token_malformed');
  }
  if (Math.floor(Date.now() / 1000) >= claims.exp) {
    throw new TokenError('Token expired', 'token_expired');
  }

  return claims;
}

/** Inspect a token without throwing. Handy for debugging. */
export function decode(token) {
  try {
    return { ok: true, claims: verify(token) };
  } catch (err) {
    return { ok: false, code: err.code || 'invalid_token' };
  }
}

/* ------------------------------------------------------------------ *
 * Express middleware
 * ------------------------------------------------------------------ */

const CSRF_AAD = 'campusflow.csrf.v1';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const cookieName = () => envGet('TOKEN_COOKIE_NAME', 'cf_session');
const refreshCookieName = () => envGet('TOKEN_COOKIE_REFRESH_NAME', 'cf_refresh');
const cookieSecure = () => envBool('TOKEN_COOKIE_SECURE', false);
const cookieSameSite = () => envGet('TOKEN_COOKIE_SAMESITE', 'lax');
const cookieDomain = () => envGet('TOKEN_COOKIE_DOMAIN', '');
const cookiePath = () => envGet('TOKEN_COOKIE_PATH', '/') || '/';

/** Minimal cookie reader — avoids pulling in cookie-parser for four lines. */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The CSRF secret for a session: HMAC over the access token's unique id.
 * Stateless, so it needs no storage, and it rotates whenever the token does.
 */
export function csrfFor(claims) {
  if (!claims?.jti) return null;
  return crypto
    .createHmac('sha256', KEY)
    .update(`${CSRF_AAD}.${claims.jti}`)
    .digest('base64url');
}

function csrfMatches(req, claims) {
  const header = envGet('AUTH_CSRF_HEADER', 'x-csrf-token').toLowerCase();
  const supplied = req.get(header)
    || req.get('x-csrf-token')
    || req.get('x-xsrf-token');
  const expected = csrfFor(claims);
  if (!supplied || !expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Late-bound API key resolver. lib/auth.js registers one at boot; keeping the
 * hook here means token.js never has to import it, and the import graph stays
 * a straight line (token -> auth would otherwise cycle through db).
 * @param {(raw: string) => {ok: boolean, user?: object, key?: object, reason?: string}} fn
 */
let apiKeyResolver = null;
export function registerApiKeyResolver(fn) {
  apiKeyResolver = typeof fn === 'function' ? fn : null;
}

/**
 * Late-bound session validator, same reasoning. Without it an access token
 * stays usable until it expires, which would make "sign out everywhere"
 * cosmetic. With it, revoking the session kills the token on the next request.
 * @param {(sessionId: string) => boolean} fn
 */
let sessionValidator = null;
export function registerSessionValidator(fn) {
  sessionValidator = typeof fn === 'function' ? fn : null;
}

/** The API-key prefix currently in force, used to spot key-shaped bearers. */
const apiKeyPrefix = () => envGet('AUTH_API_KEY_PREFIX', 'cf_live');

/**
 * Locate a credential on the request and say how it arrived.
 * @returns {{token: string|null, transport: 'header'|'cookie'|'query'}}
 */
function extractToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return { token: header.slice(7).trim(), transport: 'header' };
  }
  const fromCookie = readCookie(req, cookieName());
  if (fromCookie) return { token: fromCookie, transport: 'cookie' };
  if (typeof req.query?.token === 'string' && req.query.token) {
    return { token: req.query.token, transport: 'query' };
  }
  return { token: null, transport: 'header' };
}

/**
 * Gate that authenticates the request and enforces an optional role allowlist.
 * @param {...string} roles  e.g. requireRole('ACCOUNTANT')
 * On success: req.user = claims and req.role = claims.role
 *
 * Three credential types are accepted:
 *   - an access token in the Authorization header (scripts, integrations)
 *   - an access token in the HttpOnly session cookie (the browser)
 *   - a personal access key in the Authorization header (`cf_live_…`)
 *
 * Cookie-borne credentials must also pass a CSRF double-submit check on any
 * state-changing request, since a cookie is sent automatically by the browser.
 */
export function requireRole(...roles) {
  const allowed = roles.flat().map((r) => String(r).toUpperCase());
  const prefix = `${apiKeyPrefix()}_`;

  return function gate(req, res, next) {
    const { token, transport } = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Missing bearer token. Use POST /api/auth/login first.',
      });
    }

    // Personal access key — no expiry claim, no CSRF (not ambient).
    if (token.startsWith(prefix) && apiKeyResolver) {
      const result = apiKeyResolver(token);
      if (!result.ok) {
        return res.status(401).json({
          error: `api_key_${result.reason}`,
          message: 'That API key is not valid, has expired, or was revoked.',
        });
      }
      req.user = {
        sub: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        via: 'api_key',
        key: result.key,
      };
      req.role = String(result.user.role).toUpperCase();
      req.tokenTransport = 'header';
      if (allowed.length > 0 && !allowed.includes(req.role)) {
        return res.status(403).json({
          error: 'forbidden',
          message: `This endpoint requires role: ${allowed.join(' or ')}.`,
          yourRole: req.role,
        });
      }

      // A key is only as useful as the scope it was minted with. Scopes nest:
      // `write` implies `read`, `admin` implies both, and `full` means all.
      const scopes = Array.isArray(result.key?.scopes) ? result.key.scopes : [];
      const rank = { read: 1, write: 2, admin: 3, full: 3 };
      const held = Math.max(0, ...scopes.map((s) => rank[s] || 0));
      const needed = SAFE_METHODS.has(req.method) ? 1 : 2;
      if (held < needed) {
        const verb = SAFE_METHODS.has(req.method) ? 'read' : 'write';
        return res.status(403).json({
          error: 'insufficient_scope',
          message: `This key is scoped to ${scopes.join(', ') || 'nothing'} and cannot ${verb}.`,
          required: verb,
          yourScopes: scopes,
        });
      }
      return next();
    }

    let claims;
    try {
      claims = verify(token);
    } catch (err) {
      return res.status(401).json({
        error: err.code || 'invalid_token',
        message:
          err.code === 'token_expired'
            ? 'Session expired. Please sign in again.'
            : 'Invalid or tampered session token.',
      });
    }

    // Cookie transport + a state-changing verb == cross-site request risk.
    if (
      transport === 'cookie'
      && !SAFE_METHODS.has(req.method)
      && envBool('AUTH_CSRF_ENABLED', true)
      && !csrfMatches(req, claims)
    ) {
      return res.status(403).json({
        error: 'csrf_failed',
        message: 'Missing or invalid CSRF token for a cookie-authenticated request.',
      });
    }

    // A token minted for a session that has since been revoked is dead, even
    // though its signature is still perfectly valid. This is what makes
    // logout and "revoke this device" take effect immediately.
    if (claims.sid && sessionValidator && !sessionValidator(claims.sid)) {
      return res.status(401).json({
        error: 'session_revoked',
        message: 'This session has been signed out. Please sign in again.',
      });
    }

    if (allowed.length > 0 && !allowed.includes(String(claims.role).toUpperCase())) {
      return res.status(403).json({
        error: 'forbidden',
        message: `This endpoint requires role: ${allowed.join(' or ')}.`,
        yourRole: claims.role,
      });
    }

    req.user = claims;
    req.role = String(claims.role).toUpperCase();
    req.tokenTransport = transport;
    return next();
  };
}

/* ------------------------------------------------------------------ *
 * Cookie transport
 * ------------------------------------------------------------------ */

function serializeCookie(name, value, { maxAge, expires } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=' + String(cookieSameSite()).toLowerCase(),
  ];
  if (cookieSecure()) parts.push('Secure');
  if (cookieDomain()) parts.push(`Domain=${cookieDomain()}`);
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  return parts.join('; ');
}

/**
 * Hand the browser an HttpOnly session cookie plus the refresh cookie.
 * The access token also comes back in the JSON body, so header-based clients
 * (curl, the smoke tests) keep working unchanged.
 */
export function setAuthCookies(res, { token, refreshToken, maxAgeSeconds, refreshMaxAgeSeconds }) {
  const cookies = [
    serializeCookie(cookieName(), token, { maxAge: maxAgeSeconds }),
  ];
  if (refreshToken) {
    cookies.push(serializeCookie(refreshCookieName(), refreshToken, {
      maxAge: refreshMaxAgeSeconds,
    }));
  }
  res.append('Set-Cookie', cookies);
}

/** Expire both cookies — the logout half of the session story. */
export function clearAuthCookies(res) {
  res.append('Set-Cookie', [
    serializeCookie(cookieName(), '', { maxAge: 0, expires: 0 }),
    serializeCookie(refreshCookieName(), '', { maxAge: 0, expires: 0 }),
  ]);
}

export function readRefreshCookie(req) {
  return readCookie(req, refreshCookieName());
}

export function transportNames() {
  return { session: cookieName(), refresh: refreshCookieName() };
}


export const config = {
  algo: ALGO,
  ttlSeconds: DEFAULT_TTL_SECONDS,
  scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
  cookie: transportNames(),
  csrf: envBool('AUTH_CSRF_ENABLED', true),
};

/** Access-token lifetime, re-read each call so the GUI can change it live. */
export const signTtl = () => {
  const t = Number.parseInt(process.env.TOKEN_TTL_SECONDS || '', 10);
  return Number.isFinite(t) && t >= 60 ? t : DEFAULT_TTL_SECONDS;
};
sign.ttlSeconds = signTtl;
