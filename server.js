/**
 * server.js — CampusFlow HTTP API.
 *
 * Express 5, ESM, port 3000.
 * Auth is layered: an AES-256-GCM access token (lib/token.js) proves identity,
 * lib/auth.js keeps the stateful half — sessions, refresh rotation, API keys,
 * MFA, lockout and the audit trail. Credentials arrive as a bearer header, an
 * HttpOnly cookie, or a personal access key.
 * Every /api route is JSON; everything else is the static SPA.
 */

import './lib/env.js'; // must be first: other modules read env at import time

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEMO_PASSWORD,
  STAFF_ACCOUNTS,
  currentTerm,
  databaseStats,
  financeMetrics,
  getAttendanceBreakdown,
  getAttendanceHistory,
  attendanceSheet,
  markAttendance,
  today,
  getDemoUserForRole,
  getGradeAverages,
  getInstallments,
  getInvoices,
  getOverdueInstallments,
  getPayments,
  getResults,
  getRoster,
  getStudentByUserId,
  getUserByEmail,
  getUserById,
  ledger,
  listAllStudents,
  listDemoAccounts,
  listGrades,
  listSubjects,
  listTerms,
  listViews,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  migration,
  notificationMix,
  removeView,
  saveView,
  seed,
  statisticalRisk,
  studentRisk,
  toStudent,
  unreadNotifications,
  paths,
} from './lib/db.js';

import { notificationRunState, refreshNotifications } from './lib/notify.js';

import {
  clearAuthCookies,
  csrfFor,
  hashPassword,
  readRefreshCookie,
  registerApiKeyResolver,
  registerSessionValidator,
  requireRole,
  setAuthCookies,
  sign,
  transportNames,
  verify,
  verifyPassword,
} from './lib/token.js';

import * as auth from './lib/auth.js';
import { aiStatus, catalogueSnapshot, discoverModels, probeKeys, providerReport, PROVIDERS } from './lib/ai.js';
import {
  enabled as logEnabled,
  error as logError,
  info as logInfo,
  requestLogger,
  requestStats,
} from './lib/log.js';
import * as settings from './lib/settings.js';
import {
  classHealth,
  collectionRiskAnalysis,
  studentRecoveryPlan,
} from './lib/analytics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Personal access keys and session liveness are resolved here rather than
// inside lib/token.js, which keeps the module graph acyclic:
// token -> auth -> db -> token would not load.
registerApiKeyResolver(auth.verifyApiKey);
registerSessionValidator(auth.isSessionLive);

/* ------------------------------------------------------------------ *
 * Boot: ensure the database is populated before accepting traffic
 * ------------------------------------------------------------------ */

const seedResult = seed();
const bootedAt = new Date();
auth.prune();
setInterval(() => auth.prune(), 15 * 60_000).unref();

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', settings.bool('TRUST_PROXY', false) ? 1 : false);
app.use(express.json({ limit: '64kb' }));

// Access log + traffic tally. Counted before anything else so even a rejected
// request shows up in the tally; printed only when LOG_REQUESTS is on.
app.use(requestLogger);

// Minimal hardening without pulling in another dependency.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'");
  next();
});

// Optional cross-origin access for a separately hosted dashboard.
const CORS_ORIGIN = String(settings.get('CORS_ORIGIN', '') || '').trim();
if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers',
      `Content-Type, Authorization, ${settings.get('AUTH_CSRF_HEADER', 'x-csrf-token')}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
}

/** Wrap an async handler so rejections always reach the error middleware. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * An AbortSignal that fires when the client hangs up.
 *
 * Express 5 does not put a `signal` on the request — that is a fetch/undici
 * thing — so passing `req.signal` to the AI layer always handed it `undefined`
 * and the whole cancellation path went unused. `res` 'close' is the reliable
 * edge: it fires for both outcomes, and `writableEnded` tells the two apart.
 * Without this, a user who switches tab mid-analysis keeps the provider call
 * running to completion and pays for an answer nobody will read.
 */
function abortOnDisconnect(req, res) {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

/** Has the client already hung up? Writing to a dead socket is just noise. */
const gone = (res) => res.destroyed || res.writableEnded;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const tierOf = (req) => (String(req.query.tier || '').toLowerCase() === 'deep' ? 'deep' : 'fast');

/* ------------------------------------------------------------------ *
 * Global rate limit — a cheap fixed window, per IP
 * ------------------------------------------------------------------ */

const hits = new Map();
const RATE_WINDOW = Math.max(1, settings.num('RATE_LIMIT_WINDOW_MS', 60000));
const RATE_MAX = Math.max(10, settings.num('RATE_LIMIT_MAX', 600));

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [key, entry] of hits) if (entry.start < cutoff) hits.delete(key);
}, RATE_WINDOW).unref();

app.use((req, res, next) => {
  if (req.path === '/api/health' || !req.path.startsWith('/api/')) return next();
  const key = req.ip || 'anon';
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    hits.set(key, { start: now, count: 1 });
    return next();
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((entry.start + RATE_WINDOW - now) / 1000)));
    return res.status(429).json({ error: 'rate_limited', message: 'Slow down.' });
  }
  return next();
});

/**
 * A real scrypt hash of an unguessable value. Verified against when the
 * supplied email does not exist, so login latency is identical either way.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/**
 * Build the session payload and hand back a fresh encrypted token.
 * The browser gets it twice: in the body for the in-page client, and in an
 * HttpOnly cookie so a page reload can resume without a token in JS.
 */
function issueSession(user, req, res) {
  const { sessionId, refreshToken, expiresAt } = auth.createSession(user, req);
  const token = sign({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sid: sessionId,
    amr: user.mfa_enabled ? ['pwd', 'otp'] : ['pwd'],
  });

  const ttl = sign.ttlSeconds();
  setAuthCookies(res, { token, refreshToken, maxAgeSeconds: ttl });

  return {
    sessionId,
    token,
    // Convenience for the demo: the Authorization header is the real path.
    authorization: `Bearer ${token}`,
    csrfToken: csrfFor(verify(token)),
    expiresIn: ttl,
    refreshExpiresAt: expiresAt,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
}

/**
 * POST /api/auth/login
 * 1-click : { "role": "ACCOUNTANT" | "TEACHER" | "STUDENT" }
 * Full    : { "email": "...", "password": "..." }
 *
 * When the account needs a second factor the response is 200 with
 * `mfaRequired: true` and a short-lived `challenge` instead of a session.
 */
function handleLogin(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // --- 1-click role login (demo path) ---
  if (body.role !== undefined) {
    if (!auth.authConfig.oneClick()) {
      return res.status(403).json({
        error: 'one_click_disabled',
        message: 'One-click demo login is disabled. Sign in with email and password.',
      });
    }
    const user = getDemoUserForRole(body.role);
    if (!user) {
      return res.status(400).json({
        error: 'bad_role',
        message: 'role must be one of ACCOUNTANT, TEACHER, STUDENT.',
      });
    }
    return completeLogin(res, user, req, 'one-click');
  }

  // --- credential login ---
  const { email, password } = body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Provide { "role" } for a 1-click login, or { "email", "password" }.',
    });
  }

  const identifier = email.trim().toLowerCase();
  const user = getUserByEmail(identifier);

  if (user) {
    const locked = auth.lockoutRemaining(user.id);
    if (locked > 0) {
      auth.registerLoginAttempt({ identifier, ip: req.ip, ok: false, method: 'credentials' });
      auth.audit({ userId: user.id, actor: identifier, action: 'auth.login', outcome: 'locked', ip: req.ip, userAgent: req.get('user-agent') });
      return res.status(423).json({
        error: 'account_locked',
        message: `Too many failed attempts. Try again in ${Math.ceil(locked / 1000)}s.`,
        retryAfterSeconds: Math.ceil(locked / 1000),
      });
    }
  }

  // A missing user still runs a scrypt verification so that response timing
  // does not reveal whether the address exists.
  const ok = verifyPassword(
    String(password),
    user ? user.password : DUMMY_HASH,
  ) && Boolean(user);

  if (!ok) {
    const failure = user ? auth.noteFailure(user) : { locked: false, remaining: 0 };
    auth.registerLoginAttempt({ identifier, ip: req.ip, ok: false, method: 'credentials' });
    auth.audit({ userId: user?.id ?? null, actor: identifier, action: 'auth.login', outcome: 'denied', ip: req.ip, userAgent: req.get('user-agent') });
    if (failure.locked) {
      return res.status(423).json({
        error: 'account_locked',
        message: 'Too many failed attempts. The account is now locked.',
        retryAfterSeconds: Math.ceil(failure.remaining / 1000),
      });
    }
    return res.status(401).json({
      error: 'invalid_credentials',
      message: 'Email or password is incorrect.',
    });
  }

  if (user.status && user.status !== 'active') {
    return res.status(403).json({ error: 'account_disabled', message: 'This account is disabled.' });
  }

  return completeLogin(res, user, req, 'credentials');
}

/** Shared tail of every successful first factor: audit, MFA gate, session. */
function completeLogin(res, user, req, method) {
  auth.registerLoginAttempt({ identifier: user.email, ip: req.ip, ok: true, method });
  auth.noteSuccess(user);

  const mfa = auth.mfaState(user);
  if (mfa.enabled) {
    // Required by policy but never enrolled is a deployment mistake, not a
    // licence to skip the second factor. Refuse and say what to do about it.
    if (!mfa.enrolled) {
      return res.status(403).json({
        error: 'mfa_enrolment_required',
        message: 'This account must have a second factor. Open the control room and enrol one before signing in.',
        mfaRequired: true,
        enrolled: false,
      });
    }
    const challenge = sign({ sub: user.id, email: user.email, amr: ['pwd'], mfa: true }, { ttlSeconds: 300 });
    auth.audit({ userId: user.id, actor: user.email, role: user.role, action: 'auth.mfa_challenge', ip: req.ip, userAgent: req.get('user-agent') });
    return res.json({
      ok: true,
      method,
      mfaRequired: true,
      challenge,
      expiresIn: 300,
    });
  }

  auth.audit({ userId: user.id, actor: user.email, role: user.role, action: 'auth.login', target: method, ip: req.ip, userAgent: req.get('user-agent') });
  const session = issueSession(user, req, res);
  return res.json({ ok: true, method, mfaRequired: false, ...session });
}

// Small in-memory throttle for the login endpoint, on top of the global limit.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = Math.max(1, settings.num('AUTH_THROTTLE_WINDOW_MS', 60000));
const LOGIN_MAX = Math.max(1, settings.num('AUTH_THROTTLE_MAX', 40));

function throttleLogin(req, res, next) {
  const key = req.ip || 'anon';
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { start: now, count: 1 });
    return next();
  }
  if (entry.count >= LOGIN_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many sign-in attempts. Try again in a minute.',
    });
  }
  entry.count += 1;
  return next();
}

// Periodically drop stale buckets so the map cannot grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [key, entry] of loginAttempts) {
    if (entry.start < cutoff) loginAttempts.delete(key);
  }
}, LOGIN_WINDOW_MS).unref();

app.post('/api/auth/login', throttleLogin, handleLogin);

app.get('/api/auth/roles', (req, res) => {
  res.json({
    password: DEMO_PASSWORD,
    oneClickEnabled: auth.authConfig.oneClick(),
    transport: transportNames(),
    accounts: listDemoAccounts(),
    note: 'Send { "role": "ACCOUNTANT" } to /api/auth/login for a one-click session.',
  });
});

/** Session echo — proves the token decrypts server-side. */
app.get('/api/auth/me', requireRole(), (req, res) => {
  const user = getUserById(req.user.sub);
  res.json({
    user: user
      ? { id: user.id, email: user.email, name: user.name, role: user.role }
      : { id: req.user.sub, email: req.user.email, name: req.user.name, role: req.user.role },
    issuedAt: req.user.iat,
    expiresAt: req.user.exp,
    expiresInSeconds: req.user.exp - Math.floor(Date.now() / 1000),
  });
});

/* ------------------------------------------------------------------ *
 * Session, refresh, cookies
 * ------------------------------------------------------------------ */

/**
 * GET /api/auth/session
 * Everything the client needs to bootstrap itself from a cookie: the current
 * claims, a CSRF token to echo on unsafe verbs, and the security posture.
 */
app.get('/api/auth/session', requireRole(), (req, res) => {
  const user = getUserById(req.user.sub);
  if (user) auth.touchSession(req.user.sid);

  // The header bell reads its badge from here, so a page load does not need a
  // second round trip just to know whether anything is unread.
  const studentRow = req.role === 'STUDENT' && user ? getStudentByUserId(user.id) : null;

  res.json({
    ok: true,
    authenticated: true,
    user: user
      ? { id: user.id, email: user.email, name: user.name, role: user.role }
      : { id: req.user.sub, email: req.user.email, name: req.user.name, role: req.user.role },
    via: req.user.via || 'session_token',
    transport: req.tokenTransport,
    sessionId: req.user.sid || null,
    csrfToken: csrfFor(req.user),
    mfa: auth.mfaState(user),
    unread: user ? unreadNotifications({ userId: user.id, studentId: studentRow?.id ?? null }) : 0,
    issuedAt: req.user.iat,
    expiresAt: req.user.exp,
    expiresInSeconds: req.user.exp - Math.floor(Date.now() / 1000),
    cookies: transportNames(),
  });
});

/**
 * POST /api/auth/refresh
 * Reads the HttpOnly refresh cookie, rotates it, and issues a new access token.
 * A spent cookie is treated as a leak: the whole token family is revoked.
 */
app.post('/api/auth/refresh', (req, res) => {
  const raw = readRefreshCookie(req) || req.body?.refreshToken || null;
  const result = auth.rotateRefresh(raw, req);

  if (!result.ok) {
    if (['reused', 'revoked', 'session_revoked'].includes(result.reason)) clearAuthCookies(res);
    auth.audit({
      userId: null,
      action: 'auth.refresh',
      outcome: result.reason,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.status(401).json({
      error: `refresh_${result.reason}`,
      message: result.reason === 'reused'
        ? 'This refresh token was already used, so the session was terminated.'
        : 'No valid refresh token. Please sign in again.',
    });
  }

  const user = getUserById(result.userId);
  if (!user) return res.status(401).json({ error: 'refresh_orphan', message: 'Account no longer exists.' });

  const token = sign({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sid: result.sessionId,
    amr: user.mfa_enabled ? ['pwd', 'otp'] : ['pwd'],
  });

  setAuthCookies(res, { token, refreshToken: result.refreshToken });
  auth.touchSession(result.sessionId);
  auth.audit({
    userId: user.id, actor: user.email, role: user.role, action: 'auth.refresh',
    target: result.sessionId, ip: req.ip, userAgent: req.get('user-agent'),
  });

  return res.json({
    ok: true,
    token,
    authorization: `Bearer ${token}`,
    csrfToken: csrfFor(verify(token)),
    sessionId: result.sessionId,
    expiresIn: sign.ttlSeconds(),
  });
});

/** POST /api/auth/logout — revoke this session and expire both cookies. */
app.post('/api/auth/logout', requireRole(), (req, res) => {
  const sid = req.user.sid;
  if (sid) auth.revokeSession(req.user.sub, sid, 'logout');
  clearAuthCookies(res);
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.logout', target: sid || null, ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ok: true });
});

/** POST /api/auth/logout-all — kill every session, including this one. */
app.post('/api/auth/logout-all', requireRole(), (req, res) => {
  const count = auth.revokeAllSessions(req.user.sub, 'logout_all');
  clearAuthCookies(res);
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.logout_all', target: String(count), ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ok: true, revoked: count });
});

/* ------------------------------------------------------------------ *
 * Multi-device session management
 * ------------------------------------------------------------------ */

app.get('/api/auth/sessions', requireRole(), (req, res) => {
  res.json({ ok: true, sessions: auth.listSessions(req.user.sub, req.user.sid) });
});

app.delete('/api/auth/sessions/:id', requireRole(), (req, res) => {
  const id = String(req.params.id);
  if (id === req.user.sid) {
    auth.revokeSession(req.user.sub, id, 'self_revoke');
    clearAuthCookies(res);
    return res.json({ ok: true, revoked: 1, self: true });
  }
  const changed = auth.revokeSession(req.user.sub, id, 'remote_revoke');
  if (!changed) {
    return res.status(404).json({ error: 'not_found', message: 'No such live session.' });
  }
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.session_revoke', target: id, ip: req.ip, userAgent: req.get('user-agent'),
  });
  return res.json({ ok: true, revoked: 1 });
});

app.post('/api/auth/sessions/revoke-others', requireRole(), (req, res) => {
  const count = auth.revokeOtherSessions(req.user.sub, req.user.sid);
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.sessions_revoke_others', target: String(count), ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ok: true, revoked: count });
});

/* ------------------------------------------------------------------ *
 * Personal access tokens
 * ------------------------------------------------------------------ */

app.get('/api/auth/api-keys', requireRole(), (req, res) => {
  res.json({
    ok: true,
    prefix: settings.get('AUTH_API_KEY_PREFIX', 'cf_live'),
    scopes: auth.ALL_SCOPES,
    keys: auth.listApiKeys(req.user.sub),
  });
});

/** POST /api/auth/api-keys — the raw key is in this response and nowhere else. */
app.post('/api/auth/api-keys', requireRole(), (req, res) => {
  const { name, scopes, ttlSeconds } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'A key needs a name.' });
  }
  const key = auth.createApiKey(req.user.sub, { name, scopes, ttlSeconds });
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.api_key_create', target: key.prefix, ip: req.ip, userAgent: req.get('user-agent'),
    detail: { scopes: key.scopes },
  });
  return res.status(201).json({
    ok: true,
    key,
    warning: 'Copy this now — the full key is never shown again.',
  });
});

app.delete('/api/auth/api-keys/:id', requireRole(), (req, res) => {
  const ok = auth.revokeApiKey(req.user.sub, String(req.params.id));
  if (!ok) {
    return res.status(404).json({ error: 'not_found', message: 'No such key, or it was already revoked.' });
  }
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.api_key_revoke', target: String(req.params.id), ip: req.ip, userAgent: req.get('user-agent'),
  });
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Multi-factor authentication
 * ------------------------------------------------------------------ */

app.get('/api/auth/mfa', requireRole(), (req, res) => {
  const user = getUserById(req.user.sub);
  res.json({ ok: true, ...auth.mfaState(user), issuer: settings.get('AUTH_MFA_ISSUER', 'CampusFlow') });
});

/** POST /api/auth/mfa/enrol — returns the secret, held disabled until confirmed. */
app.post('/api/auth/mfa/enrol', requireRole(), (req, res) => {
  const enrolment = auth.enrolMfa(req.user.sub);
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.mfa_enrol', ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({
    ok: true,
    ...enrolment,
    note: 'Add this to your authenticator, then confirm with a code to switch MFA on.',
  });
});

/** POST /api/auth/mfa/confirm — first real code activates the secret. */
app.post('/api/auth/mfa/confirm', requireRole(), (req, res) => {
  const result = auth.confirmMfa(req.user.sub, req.body?.code);
  if (!result.ok) {
    return res.status(400).json({
      error: `mfa_${result.reason}`,
      message: result.reason === 'bad_code' ? 'That code did not match. Check your clock and try again.' : 'No pending enrolment.',
    });
  }
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.mfa_enabled', ip: req.ip, userAgent: req.get('user-agent'),
  });
  return res.json({ ok: true, enabled: true });
});

app.delete('/api/auth/mfa', requireRole(), (req, res) => {
  auth.disableMfa(req.user.sub);
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'auth.mfa_disabled', ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ok: true, enabled: false });
});

/**
 * POST /api/auth/mfa/verify — finishes a login that stopped at the second factor.
 * The `challenge` came from /api/auth/login and expires in 5 minutes.
 */
app.post('/api/auth/mfa/verify', throttleLogin, (req, res) => {
  const challenge = String(req.body?.challenge || '');
  const code = String(req.body?.code || '');

  let claims;
  try {
    claims = verify(challenge);
  } catch {
    return res.status(401).json({ error: 'bad_challenge', message: 'The sign-in attempt expired. Start again.' });
  }
  if (!claims.mfa) {
    return res.status(400).json({ error: 'bad_challenge', message: 'That challenge is not an MFA challenge.' });
  }

  const user = getUserById(claims.sub);
  if (!user) return res.status(401).json({ error: 'no_user', message: 'Account no longer exists.' });

  const result = auth.verifySecondFactor(user, code);
  if (!result.ok) {
    auth.audit({ userId: user.id, actor: user.email, action: 'auth.mfa_verify', outcome: 'denied', ip: req.ip, userAgent: req.get('user-agent') });
    return res.status(401).json({ error: 'invalid_code', message: 'That code is not valid.' });
  }

  auth.audit({
    userId: user.id, actor: user.email, role: user.role, action: 'auth.mfa_verify',
    target: result.via, ip: req.ip, userAgent: req.get('user-agent'),
  });
  auth.noteSuccess(user);
  return res.json({ ok: true, method: 'mfa', via: result.via, ...issueSession(user, req, res) });
});

/** GET /api/auth/audit — the security trail for the signed-in user. */
app.get('/api/auth/audit', requireRole(), (req, res) => {
  const limit = Math.min(200, Number.parseInt(req.query.limit, 10) || 50);
  const wantsAll = String(req.query.scope || 'me') === 'all';
  // Say no rather than quietly narrowing: a client that asked for the whole
  // trail must not be handed a filtered one under the same label.
  if (wantsAll && req.role !== 'ACCOUNTANT') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Only an accountant can read the full security trail. Use scope=me for your own events.',
    });
  }
  const events = auth.listAudit({ userId: wantsAll ? null : req.user.sub, limit });
  return res.json({ ok: true, scope: wantsAll ? 'all' : 'me', events });
});

/* ------------------------------------------------------------------ *
 * Accountant
 * ------------------------------------------------------------------ */

/**
 * GET /api/accountant/overview
 * Deterministic finance metrics + AI collection-risk score and defaulter patterns.
 */
app.get('/api/accountant/overview', requireRole('ACCOUNTANT'), route(async (req, res) => {
  const tier = tierOf(req);
  refreshNotifications();
  const result = await collectionRiskAnalysis({ tier, signal: abortOnDisconnect(req, res) });
  if (gone(res)) return;

  res.json({
    ok: true,
    role: 'ACCOUNTANT',
    tier,
    metrics: result.metrics,
    risk: result.analysis,
    ai: result.ai,
  });
}));

/**
 * GET /api/accountant/ledger?method=upi&from=&to=&limit=&offset=
 * Every receipt across the school, with the ageing summary and per-method mix.
 */
app.get('/api/accountant/ledger', requireRole('ACCOUNTANT'), (req, res) => {
  res.json({
    ok: true,
    ...ledger({
      method: req.query.method,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
      offset: req.query.offset,
    }),
    overdueInstallments: getOverdueInstallments(10),
  });
});

/**
 * GET /api/accountant/ledger.csv?method=&from=&to=
 * The same receipts as CSV, for the finance team who live in a spreadsheet.
 *
 * The whole filtered result is walked rather than the first page: an export that
 * silently stopped at 50 rows would be worse than no export at all. `ledger()`
 * caps a page at 200, so that is the step size. The query is ordered and
 * index-backed, and a school's receipts are thousands of rows, not millions —
 * `EXPORT_MAX_ROWS` is the backstop if that assumption is ever wrong.
 */
const EXPORT_MAX_ROWS = 100000;
const EXPORT_PAGE = 200;

app.get('/api/accountant/ledger.csv', requireRole('ACCOUNTANT'), (req, res) => {
  const filter = { method: req.query.method, from: req.query.from, to: req.query.to };

  const rows = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const chunk = ledger({ ...filter, limit: EXPORT_PAGE, offset });
    total = chunk.total;
    rows.push(...chunk.rows);
    if (rows.length >= total || chunk.rows.length < EXPORT_PAGE) break;
    if (rows.length >= EXPORT_MAX_ROWS) break;
    offset += EXPORT_PAGE;
  }

  const header = ['receipt_no', 'paid_at', 'student', 'roll_no', 'grade', 'invoice_no',
    'category', 'amount', 'method', 'reference'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Quote anything that would break the row, and neutralise the spreadsheet
    // formula-injection vector on a leading = + - @.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.receipt_no, r.paid_at, r.student_name, r.roll_no, r.grade,
      r.invoice_no, r.category, r.amount, r.method, r.reference,
    ].map(cell).join(','));
  }

  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'ledger.export', target: `rows:${rows.length}`,
    outcome: 'ok', ip: req.ip, userAgent: req.get('user-agent'),
    detail: { filter, rows: rows.length, total },
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="campusflow-ledger.csv"');
  res.send(`${lines.join('\n')}\n`);
});

/* ------------------------------------------------------------------ *
 * Teacher
 * ------------------------------------------------------------------ */

/**
 * GET /api/teacher/students?grade=9
 * Class roster with per-student risk. Omit grade for the whole school.
 */
app.get('/api/teacher/students', requireRole('TEACHER'), (req, res) => {
  const gradeParam = req.query.grade;
  const grade = gradeParam === undefined || gradeParam === '' ? null : Number.parseInt(gradeParam, 10);

  if (gradeParam !== undefined && gradeParam !== '' && !Number.isFinite(grade)) {
    return res.status(400).json({ error: 'bad_request', message: 'grade must be a number.' });
  }

  const rows = grade === null ? listAllStudents() : getRoster(grade);
  const students = rows.map(toStudent);
  const health = classHealth(students);

  refreshNotifications();

  res.json({
    ok: true,
    role: 'TEACHER',
    scope: grade === null ? 'school' : `grade-${grade}`,
    grades: listGrades(),
    selectedGrade: grade,
    subjects: listSubjects(grade),
    term: currentTerm(),
    summary: {
      total: health.total,
      avgAttendance: health.avgAttendance,
      totalOutstanding: health.totalOutstanding,
      atRisk: health.atRisk,
      critical: health.critical,
      healthy: health.healthy,
    },
    health: health.health,
    roster: health.roster,
    subjectAverages: grade === null ? [] : getGradeAverages(grade),
    attendance: grade === null ? [] : getAttendanceBreakdown(grade),
  });
});

/**
 * GET /api/teacher/diagnose?studentId=12   (or ?rollNo=CF-2026-0007)
 * AI-driven recovery plan for one student.
 */
app.get('/api/teacher/diagnose', requireRole('TEACHER'), route(async (req, res) => {
  const { studentId, rollNo } = req.query;

  if (studentId === undefined && rollNo === undefined) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Provide ?studentId=<id> or ?rollNo=<roll number>.',
    });
  }

  let student;
  if (studentId !== undefined) {
    const id = Number.parseInt(studentId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'bad_request', message: 'studentId must be a number.' });
    }
    student = listAllStudents().find((s) => s.id === id) || null;
  } else {
    const wanted = String(rollNo).trim().toUpperCase();
    student = listAllStudents().find((s) => s.roll_no.toUpperCase() === wanted) || null;
  }

  if (!student) {
    return res.status(404).json({ error: 'not_found', message: 'No student with that id or roll number.' });
  }

  const tier = tierOf(req);
  const result = await studentRecoveryPlan({ student, tier, signal: abortOnDisconnect(req, res) });
  if (gone(res)) return;

  res.json({
    ok: true,
    role: 'TEACHER',
    tier,
    ...result,
  });
}));

/** GET /api/teacher/student/:id — the full academic + finance record. */
app.get('/api/teacher/student/:id', requireRole('TEACHER'), (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const row = Number.isFinite(id) ? listAllStudents().find((s) => s.id === id) : null;
  if (!row) return res.status(404).json({ error: 'not_found', message: 'No such student.' });

  const student = toStudent(row);
  res.json({
    ok: true,
    student,
    risk: studentRisk(student),
    results: getResults(student.id),
    attendance: getAttendanceHistory(student.id, 30),
    invoices: getInvoices(student.id),
    payments: getPayments(student.id),
    installments: getInstallments(student.id),
    terms: listTerms(),
  });
});

/**
 * GET /api/teacher/attendance?grade=9&day=2026-10-02
 *
 * The roll-call sheet: one row per student in scope with whatever was already
 * filed for that day, plus live tallies and the last days that have data. Omit
 * `grade` for the whole school; omit `day` for today.
 */
app.get('/api/teacher/attendance', requireRole('TEACHER'), (req, res) => {
  const gradeParam = req.query.grade;
  const grade = gradeParam === undefined || gradeParam === '' ? null : Number.parseInt(gradeParam, 10);
  if (gradeParam !== undefined && gradeParam !== '' && !Number.isFinite(grade)) {
    return res.status(400).json({ error: 'bad_request', message: 'grade must be a number.' });
  }

  const day = req.query.day ? String(req.query.day) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'bad_request', message: 'day must look like YYYY-MM-DD.' });
  }

  res.json({ ok: true, role: 'TEACHER', today: today(), ...attendanceSheet({ grade, day }) });
});

/**
 * POST /api/teacher/attendance — file the register.
 *
 * Body: `{ day, entries: [{ studentId, status }] }` where `status` is one of
 * present / absent / late / excused, or null to clear a row back to unmarked.
 * Unknown students, invalid statuses and out-of-scope ids are dropped rather
 * than failing the batch, because the sheet is a bulk edit and a single stale
 * row should not lose the other twenty marks.
 */
app.post('/api/teacher/attendance', requireRole('TEACHER'), (req, res) => {
  const body = req.body || {};
  try {
    const result = markAttendance({ day: body.day || today(), entries: body.entries });
    auth.audit({
      userId: req.user.sub, actor: req.user.email, role: req.role,
      action: 'attendance.mark', target: `${result.day}:${result.written}`,
      outcome: 'ok', ip: req.ip, userAgent: req.get('user-agent'),
    });
    refreshNotifications();
    res.json({ ...result, sheet: attendanceSheet({ grade: body.grade ?? null, day: result.day }) });
  } catch (err) {
    auth.audit({
      userId: req.user.sub, actor: req.user.email, role: req.role,
      action: 'attendance.mark', target: 'invalid', outcome: 'failed',
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    res.status(400).json({ error: 'bad_request', message: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Student
 * ------------------------------------------------------------------ */

/** GET /api/student/me — everything the signed-in student can see. */
app.get('/api/student/me', requireRole('STUDENT'), (req, res) => {
  const row = getStudentByUserId(req.user.sub);

  if (!row) {
    return res.status(404).json({
      error: 'no_profile',
      message: 'This account is not linked to a student record.',
    });
  }

  // Throttled inside the generator, so a student polling their dashboard still
  // gets a freshly derived instalment or fee-band warning.
  refreshNotifications();

  const student = toStudent(row);
  const billed = round2(student.fee_due);
  const paid = round2(student.fee_paid);
  const balance = round2(Math.max(0, billed - paid));
  const risk = studentRisk(student);

  const status = balance <= 0
    ? 'clear'
    : balance > 25000 ? 'overdue_high' : balance > 10000 ? 'overdue' : 'due';

  const results = getResults(student.id);
  const average = results.length
    ? round2(results.reduce((s, r) => s + r.score, 0) / results.length)
    : null;

  // Grade-level average per subject, so a student can see whether they are
  // above or below the room rather than staring at a bare score.
  const classAverages = {};
  for (const row of getGradeAverages(student.grade)) classAverages[row.subject] = row.average;

  res.json({
    ok: true,
    role: 'STUDENT',
    profile: {
      id: student.id,
      name: student.name,
      email: student.email,
      rollNo: student.roll_no,
      grade: student.grade,
      section: student.section,
      guardian: row.guardian_name || null,
    },
    attendance: {
      percentage: student.attendance,
      band: student.attendance >= 90 ? 'healthy'
        : student.attendance >= 80 ? 'watch'
          : student.attendance >= 75 ? 'at_risk' : 'critical',
      recent: getAttendanceHistory(student.id, 14),
    },
    academics: {
      term: currentTerm(),
      subjects: listSubjects(student.grade),
      average,
      results: results.map((r) => ({
        subject: r.subject,
        subjectCode: r.subject_code,
        score: r.score,
        maxScore: r.max_score,
        letter: r.letter,
        termId: r.term_id,
        classAverage: classAverages[r.subject] ?? null,
      })),
    },
    fees: {
      totalBilled: billed,
      totalPaid: paid,
      outstanding: balance,
      settlementPercent: billed > 0 ? round2((paid / billed) * 100) : 100,
      status,
      // Component view of the dues: billed splits into settled + outstanding.
      breakdown: [
        { label: 'Total billed', amount: billed, kind: 'billed' },
        { label: 'Paid to date', amount: paid, kind: 'paid' },
        { label: 'Outstanding dues', amount: balance, kind: 'due' },
      ],
      invoices: getInvoices(student.id),
      payments: getPayments(student.id),
      installments: getInstallments(student.id),
    },
    risk,
    notifications: getNotifications({ studentId: student.id, limit: 10 }),
    guidance: balance <= 0
      ? 'Your account is fully settled. Nothing further is required.'
      : `${balance > 25000 ? 'This balance is flagged for follow-up by the accounts office. ' : ''}` +
        `Please contact accounts@campusflow.edu to set up an instalment plan for the outstanding ` +
        `₹${balance.toLocaleString('en-IN')}.`,
  });
});

/* ------------------------------------------------------------------ *
 * Notifications + saved views
 * ------------------------------------------------------------------ */

app.get('/api/notifications', requireRole(), (req, res) => {
  const studentRow = req.role === 'STUDENT' ? getStudentByUserId(req.user.sub) : null;
  const studentId = studentRow?.id ?? null;

  // Cheap and throttled inside the generator, so the alerts stay current
  // without this endpoint becoming a database scan on every poll.
  refreshNotifications();

  res.json({
    ok: true,
    notifications: getNotifications({
      userId: req.user.sub,
      studentId,
      limit: req.query.limit,
    }),
    unread: unreadNotifications({ userId: req.user.sub, studentId }),
    generated: notificationRunState(),
  });
});

app.post('/api/notifications/:id/read', requireRole(), (req, res) => {
  const ok = markNotificationRead(req.params.id, req.user.sub);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});

/** Mark everything read — what the bell's "clear all" does. */
app.post('/api/notifications/read-all', requireRole(), (req, res) => {
  const studentRow = req.role === 'STUDENT' ? getStudentByUserId(req.user.sub) : null;
  const changed = markAllNotificationsRead(req.user.sub, studentRow?.id ?? null);
  res.json({ ok: true, marked: changed });
});

/**
 * POST /api/notifications/generate — force a re-derivation of every alert.
 *
 * The dashboard already refreshes on a timer; this is the manual escape hatch
 * for "I just fixed a payment, tell the student now" without waiting.
 */
app.post('/api/notifications/generate', requireRole('ACCOUNTANT'), (req, res) => {
  const result = refreshNotifications({ force: true });
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'notifications.generate', target: `created:${result.created}`,
    outcome: result.error ? 'failed' : 'ok',
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ok: !result.error, ...result, mix: notificationMix() });
});

app.get('/api/views', requireRole(), (req, res) => {
  res.json({ ok: true, views: listViews(req.user.sub) });
});

app.put('/api/views', requireRole(), (req, res) => {
  const view = saveView(req.user.sub, req.body || {});
  if (!view) {
    return res.status(400).json({ error: 'bad_request', message: 'A view needs a name.' });
  }
  return res.json({ ok: true, view });
});

app.delete('/api/views/:id', requireRole(), (req, res) => {
  const ok = removeView(req.user.sub, req.params.id);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});

/* ------------------------------------------------------------------ *
 * Meta / system
 * ------------------------------------------------------------------ */

app.get('/api/health', route(async (req, res) => {
  const ai = aiStatus();
  res.json({
    ok: true,
    service: 'campusflow',
    version: '1.0.0',
    uptimeSeconds: Math.round(process.uptime()),
    bootedAt: bootedAt.toISOString(),
    students: listAllStudents().length,
    ai: {
      ...ai,
      // Last-read model catalogues, so a misconfigured model id is obvious
      // immediately. Cached, because the browser hits /api/health constantly.
      catalogue: catalogueSnapshot(),
    },
    database: paths.dbPath,
  });
}));

/**
 * GET /api/system — the settings GUI's bootstrap: what the process is running
 * right now, as opposed to what the .env file says it should be running.
 */
app.get('/api/system', requireRole(), (req, res) => {
  res.json({
    ok: true,
    runtime: {
      node: process.version,
      platform: process.platform,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      bootedAt: bootedAt.toISOString(),
      envFile: settings.envPath,
      logLevel: settings.get('LOG_LEVEL', 'info'),
    },
    auth: auth.authStats(),
    security: {
      token: {
        algorithm: 'aes-256-gcm',
        ttlSeconds: Number.parseInt(process.env.TOKEN_TTL_SECONDS || '28800', 10),
        refreshTtlSeconds: settings.num('TOKEN_REFRESH_TTL_SECONDS', 1209600),
        issuer: settings.get('TOKEN_ISSUER', 'campusflow'),
        audience: settings.get('TOKEN_AUDIENCE', 'campusflow-web'),
        cookies: transportNames(),
        cookieSecure: settings.bool('TOKEN_COOKIE_SECURE', false),
        cookieSameSite: settings.get('TOKEN_COOKIE_SAMESITE', 'lax'),
      },
      csrf: {
        enabled: auth.authConfig.csrf(),
        header: auth.authConfig.csrfHeader(),
        doubleSubmit: true,
      },
      password: { algorithm: 'scrypt', N: 16384, r: 8, p: 1 },
      rateLimit: { windowMs: RATE_WINDOW, max: RATE_MAX, loginMax: LOGIN_MAX },
      cors: CORS_ORIGIN || 'same-origin only',
      trustProxy: settings.bool('TRUST_PROXY', false),
    },
    database: { ...databaseStats(), migration },
    requests: requestStats(),
    ai: aiStatus(),
  });
});

/** GET /api/settings — the full schema, secrets masked, for the settings GUI. */
app.get('/api/settings', requireRole('ACCOUNTANT'), (req, res) => {
  res.json({ ok: true, ...settings.readAll() });
});

/**
 * GET /api/ai/providers — the provider console's data source.
 *
 * Unlike /api/system's `ai` block this is built for the control room: it lists
 * every configured key (including one the current order has switched off), the
 * catalogues as last discovered, the ranked chains with their scores, and the
 * live routing plan. Cheap: no network call, no model invocation.
 */
app.get('/api/ai/providers', requireRole('ACCOUNTANT'), route(async (req, res) => {
  // `?refresh=1` re-reads the catalogues first, so an operator who has just
  // pasted a new key sees what that key serves instead of the seed list.
  if (req.query.refresh === '1' || req.query.refresh === 'true') {
    await discoverModels({ force: true }).catch(() => {});
  }
  res.json(providerReport());
}));

/**
 * POST /api/ai/probe — "which model does this key actually give me?"
 *
 * Re-reads both provider catalogues, then sends one real request to the top of
 * each chain so the answer is measured rather than assumed. Costs a few
 * fractions of a cent per key; that is the price of not guessing.
 */
app.post('/api/ai/probe', requireRole('ACCOUNTANT'), route(async (req, res) => {
  const verify = req.body?.verify !== false;
  const tier = req.body?.tier === 'deep' ? 'deep' : 'fast';
  const limit = Math.min(Number.parseInt(req.body?.limit || '6', 10) || 6, 20);
  // Narrowing to one provider is what the per-card button means; without the
  // filter every press would spend calls on the other key as well.
  const asked = typeof req.body?.provider === 'string' ? req.body.provider.trim().toLowerCase() : null;
  const provider = asked && PROVIDERS.includes(asked) ? asked : null;
  if (asked && !provider) {
    return res.status(400).json({
      error: 'unknown_provider',
      message: `"${asked}" is not a provider. Use one of: ${PROVIDERS.join(', ')}.`,
    });
  }
  const result = await probeKeys({ tier, verify, limit, provider });

  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'ai.probe', target: provider || 'all',
    outcome: result.probes.some((p) => p.ok) ? 'ok' : 'failed',
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ...result, tier, verified: verify, provider });
}));

/** PUT /api/settings — validate, write the .env file, apply what is live. */
app.put('/api/settings', requireRole('ACCOUNTANT'), (req, res) => {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
  if (!updates) {
    return res.status(400).json({ error: 'bad_request', message: 'Send { "updates": [{ key, value }] }.' });
  }

  const result = settings.writeAll(updates);
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'settings.write', target: result.applied.join(',').slice(0, 120) || null,
    outcome: result.ok ? 'ok' : 'rejected', ip: req.ip, userAgent: req.get('user-agent'),
    detail: { applied: result.applied, pendingRestart: result.pendingRestart },
  });

  if (!result.ok) {
    return res.status(400).json({ error: 'invalid_setting', message: result.error });
  }

  return res.json({
    ok: true,
    applied: result.applied,
    pendingRestart: result.pendingRestart,
    restartRequired: Boolean(result.restartRequired),
    file: result.file,
    message: result.restartRequired
      ? 'Saved. Some values are only read at boot — restart the server to apply them.'
      : 'Saved and applied to the running process.',
  });
});

/** POST /api/settings/rotate-secret — mint a new TOKEN_SECRET immediately. */
app.post('/api/settings/rotate-secret', requireRole('ACCOUNTANT'), (req, res) => {
  const result = settings.rotateTokenSecret();
  auth.audit({
    userId: req.user.sub, actor: req.user.email, role: req.role,
    action: 'settings.rotate_token_secret', outcome: result.ok ? 'ok' : 'failed',
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  if (!result.ok) {
    return res.status(500).json({ error: 'rotate_failed', message: result.error || 'Could not write the env file.' });
  }
  auth.revokeAllSessions(req.user.sub, 'secret_rotated');
  return res.json({
    ok: true,
    restartRequired: true,
    message: 'New signing secret written. Every existing session and token is now invalid — restart to load it.',
  });
});

/** GET /api/settings/raw — the literal .env text, for copy/paste. */
app.get('/api/settings/raw', requireRole('ACCOUNTANT'), (req, res) => {
  const file = settings.readFile();
  const body = settings.renderFile(file.values, file.order);
  res.json({
    ok: true,
    path: file.path,
    exists: file.exists,
    keys: file.order.length,
    text: body,
  });
});

/** Raw metrics, for judges who want the numbers without the AI layer. */
app.get('/api/metrics', requireRole('ACCOUNTANT'), (req, res) => {
  const metrics = financeMetrics();
  res.json({ ok: true, metrics, statisticalRisk: statisticalRisk(metrics) });
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

// SPA fallback — Express 5 rejects bare '*' paths, so use middleware.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logError(err?.message || err, err?.stack ? `\n${err.stack}` : '');
  if (res.headersSent) return;
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: err?.code || 'internal_error',
    message: status === 500 ? 'Internal server error.' : err.message,
  });
});

/* ------------------------------------------------------------------ *
 * Listen
 * ------------------------------------------------------------------ */

const server = app.listen(PORT, HOST, () => {
  if (!logEnabled('info')) return;

  const ai = aiStatus();
  const accounts = listDemoAccounts();
  const staffLine = STAFF_ACCOUNTS.map((s) => `${s.role.toLowerCase()}: ${s.email}`).join('  ');
  const idle = ai.configuredProviders.filter((p) => !ai.providers.includes(p));

  console.log('');
  console.log('  CampusFlow — Automated School Finance & Academic Intelligence');
  console.log('  ────────────────────────────────────────────────────────────');
  console.log(`  URL        http://localhost:${PORT}`);
  console.log(`  Database   ${paths.dbPath}  (${databaseStats().totals.rows} rows, ${databaseStats().totals.tables} tables)`);
  if (migration.created.length || migration.added.length) {
    console.log(`  Migrate    +${migration.created.length} tables, +${migration.added.length} columns, ${migration.indexes} indexes`);
  }
  console.log(`  Env        ${settings.envPath}`);
  console.log(`  Seed       ${seedResult.seeded
    ? `created ${seedResult.students} students + ${STAFF_ACCOUNTS.length} staff`
    : `existing (${seedResult.reason})`}`);
  console.log(`  AI         ${ai.provider === 'offline'
    ? 'OFFLINE — set GEMINI_API_KEY and/or OPENCODE_ZEN_API_KEY to enable live models'
    : `${ai.providers.map((p) => p.toUpperCase()).join(' + ')} · ${ai.endpoint}`}`);
  if (idle.length) {
    console.log(`  Order      ${ai.order} — ${idle.map((p) => p.toUpperCase()).join(', ')} configured but not used`);
  }
  if (ai.provider === 'offline') {
    console.log('  Models     (none configured)');
  } else {
    const line = (tier, list) => `  ${tier.padEnd(6)}  ${list
      .map((c) => (ai.providers.length > 1 ? `${c.model} [${c.provider}]` : c.model))
      .join(' → ') || '(none)'}`;
    console.log(line('fast', ai.plan.fast.slice(0, 6)));
    console.log(line('deep', ai.plan.deep.slice(0, 4)));
    console.log('  Keys       POST /api/ai/probe re-reads both catalogues and tests the top model of each');
  }
  console.log(`  Sessions   cookie=${transportNames().session} refresh=${transportNames().refresh} csrf=${auth.authConfig.csrf() ? 'on' : 'off'}`);
  console.log(`  Accounts   ${staffLine}`);
  console.log(`  Password   ${DEMO_PASSWORD} (all accounts) · 1-click: POST /api/auth/login {"role":"TEACHER"}`);
  console.log(`  Demo users ${accounts.map((a) => `${a.role}→${a.email}`).join('  ')}`);
  console.log(`  Settings   ${settings.envPath} · GUI: click the ⚙ in the header (ACCOUNTANT only)`);
  console.log('  ────────────────────────────────────────────────────────────');
  console.log('');
});

function shutdown(signal) {
  logInfo(`${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
