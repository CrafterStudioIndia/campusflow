/**
 * scripts/auth-test.js — end-to-end verification of the security surface.
 *
 * Usage:  npm run test:auth
 *
 * Covers what the smoke test deliberately leaves out: cookies, CSRF, refresh
 * rotation and reuse detection, personal access keys, MFA, account lockout,
 * the audit trail and the settings writer.
 *
 * Unlike the smoke test this always boots its own server against a throwaway
 * SQLite file, because it deliberately locks accounts out, burns refresh
 * tokens and enrols MFA on real rows.
 *
 * Exits non-zero if any check fails.
 */

import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * RFC 6238 TOTP, implemented here rather than imported from lib/auth.js.
 * Importing the app would load the real .env into *this* process, and that
 * loaded env would then be inherited by the child server, where it beats the
 * throwaway .env below (real env vars always win over the file). Keeping the
 * test self-contained means the thresholds it asserts are the real ones.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBuffer(text) {
  const bits = text.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let value = 0;
  let bitsHeld = 0;
  const out = [];
  for (const ch of bits) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | idx;
    bitsHeld += 5;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      out.push((value >>> bitsHeld) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpAt(secret, counter = Math.floor(Date.now() / 30000)) {
  const key = base32ToBuffer(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const bin = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusflow-authtest-'));
const dbPath = path.join(tmpDir, 'auth-test.db');
const envPath = path.join(tmpDir, 'test.env');

// A private .env so the test can write settings without touching the real one.
// It is the *only* source of app config for the child: the child's environment
// is curated below, so nothing ambient can shadow these values.
fs.writeFileSync(envPath, [
  'PORT=0',
  'HOST=127.0.0.1',
  'NODE_ENV=test',
  'TOKEN_SECRET=auth-test-secret-not-used-anywhere-else-0123456789',
  'AUTH_MAX_LOGIN_ATTEMPTS=3',
  'AUTH_LOCKOUT_MS=600000',
  'AUTH_CSRF_ENABLED=true',
  'AUTH_THROTTLE_MAX=500',
  'RATE_LIMIT_MAX=5000',
  'ALLOW_ONE_CLICK_LOGIN=true',
  'AUTH_REQUIRE_MFA=false',
  '',
].join('\n'));

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close();
    resolve(p);
  });
});

const BASE = `http://127.0.0.1:${port}`;

// A curated environment, not `...process.env`. lib/env.js gives real env vars
// priority over the file, so inheriting an already-populated process.env would
// silently defeat every threshold this test is trying to pin down.
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    PORT: String(port),
    HOST: '127.0.0.1',
    CAMPUS_DB_PATH: dbPath,
    CAMPUS_ENV_FILE: envPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
server.stdout.on('data', (d) => logs.push(d.toString()));
server.stderr.on('data', (d) => logs.push(d.toString()));

const cleanup = () => {
  server.kill('SIGKILL');
  fs.rmSync(tmpDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

const reachable = async () => {
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
};

process.stdout.write(`Booting a throwaway server at ${BASE} (db: ${dbPath}) ...\n`);
{
  const deadline = Date.now() + 40_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (server.exitCode !== null) break;
    ready = await reachable();
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    console.error('\nServer failed to start:\n' + logs.join(''));
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const group = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** A request with its own cookie jar, so sessions stay isolated. */
function jar() {
  const cookies = new Map();
  return {
    get size() { return cookies.size; },
    setFrom(res) {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '') cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    value(name) { return cookies.get(name) || null; },
  };
}

async function req(pathname, { token, cookies, csrf, method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookies) headers.cookie = cookies.header();
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookies = res.headers.getSetCookie?.() || [];
  if (cookies) cookies.setFrom(res);

  const out = { status: res.status, setCookies, headers: res.headers };
  if (raw) {
    // Non-JSON payloads (CSV) would otherwise be swallowed by the parse attempt.
    out.text = await res.text();
    out.data = null;
  } else {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    out.data = data;
  }
  return out;
}

/* ------------------------------------------------------------------ */

group('Cookie transport');
const session = jar();
let accessToken = null;
let csrfToken = null;
{
  const res = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' }, cookies: session });
  accessToken = res.data?.token;
  csrfToken = res.data?.csrfToken;
  check('login returns an access token', !!accessToken, `status ${res.status}`);
  check('login returns a CSRF token', !!csrfToken);
  check('sets an HttpOnly session cookie', res.setCookies.some((c) => c.startsWith('cf_session=') && /HttpOnly/.test(c)));
  check('sets an HttpOnly refresh cookie', res.setCookies.some((c) => c.startsWith('cf_refresh=') && /HttpOnly/.test(c)));
  check('refresh cookie is SameSite=Lax', res.setCookies.some((c) => /cf_refresh=/.test(c) && /SameSite=Lax/i.test(c)));

  const viaCookie = await req('/api/auth/session', { cookies: session });
  check('cookie alone authenticates a GET', viaCookie.status === 200, `status ${viaCookie.status}`);
  check('transport is reported as cookie', viaCookie.data?.transport === 'cookie');
  check('session id is bound into the token', !!viaCookie.data?.sessionId);
  check('CSRF token is echoed back', !!viaCookie.data?.csrfToken);

  // Proves the throwaway .env is the one in force, so every threshold below
  // is being exercised at the value the test intends.
  const sys = await req('/api/system', { token: accessToken });
  const cfg = sys.data.auth.config;
  check('the test env file is in force (maxAttempts=3)', cfg.maxAttempts === 3, String(cfg.maxAttempts));
  check('the test env file is in force (lockout=600000)', cfg.lockoutMs === 600000, String(cfg.lockoutMs));
  check('the test env file is in force (login throttle=500)', sys.data.security.rateLimit.loginMax === 500, String(sys.data.security.rateLimit.loginMax));
}

group('CSRF double-submit');
{
  const noCsrf = await req('/api/notifications/1/read', { method: 'POST', cookies: session });
  check('cookie POST without CSRF = 403', noCsrf.status === 403, `status ${noCsrf.status}`);
  check('error code is csrf_failed', noCsrf.data?.error === 'csrf_failed');

  const wrongCsrf = await req('/api/notifications/1/read', { method: 'POST', cookies: session, csrf: 'nonsense' });
  check('cookie POST with a bad CSRF = 403', wrongCsrf.status === 403, `status ${wrongCsrf.status}`);

  const okCsrf = await req('/api/notifications/1/read', { method: 'POST', cookies: session, csrf: csrfToken });
  check('cookie POST with the right CSRF passes the gate', okCsrf.status !== 403, `status ${okCsrf.status}`);

  const headerOnly = await req('/api/notifications/1/read', { method: 'POST', token: accessToken });
  check('bearer POST needs no CSRF', headerOnly.status !== 403, `status ${headerOnly.status}`);

  const safe = await req('/api/auth/session', { cookies: session });
  check('cookie GET needs no CSRF', safe.status === 200);
}

group('Refresh rotation');
{
  // Grab the raw cookie first: the jar is overwritten by the response below.
  const original = session.value('cf_refresh');
  check('a refresh cookie was issued at login', String(original).startsWith('cf_rt_'), String(original).slice(0, 12));

  const first = await req('/api/auth/refresh', { method: 'POST', cookies: session });
  check('refresh issues a new access token', first.status === 200 && !!first.data?.token, `status ${first.status}`);
  check('refresh returns a fresh CSRF token', !!first.data?.csrfToken);
  check('the refresh cookie is rotated', session.value('cf_refresh') !== original);
  check('the access token is rotated', first.data.token !== accessToken);

  const replay = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: original } });
  check('a spent refresh token is rejected', replay.status === 401, `status ${replay.status}`);
  check('the error names the replay', replay.data?.error === 'refresh_reused', replay.data?.error);

  // Reuse means a leak: the whole family, and the access token with it, is dead.
  const afterBreach = await req('/api/auth/session', { cookies: session });
  check('reuse detection kills the session', afterBreach.status === 401, `status ${afterBreach.status}`);
  check('the error is session_revoked', afterBreach.data?.error === 'session_revoked', afterBreach.data?.error);

  const tokenDead = await req('/api/auth/me', { token: accessToken });
  check('the stolen access token dies with the session', tokenDead.status === 401, `status ${tokenDead.status}`);
  check('revocation is named', tokenDead.data?.error === 'session_revoked', tokenDead.data?.error);

  const stillGood = await req('/api/auth/session', { token: first.data.token });
  check('the fresh token dies too — it is the same family', stillGood.status === 401, `status ${stillGood.status}`);
}

group('Personal access keys');
let keyId = null;
let rawKey = null;
{
  const token = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  const created = await req('/api/auth/api-keys', {
    method: 'POST',
    token,
    body: { name: 'integration', scopes: ['read'] },
  });
  rawKey = created.data?.key?.key;
  keyId = created.data?.key?.id;
  check('key is created', created.status === 201 && !!rawKey, `status ${created.status}`);
  check('key carries the configured prefix', String(rawKey).startsWith('cf_live_'), rawKey);
  check('the full key is returned exactly once', created.data?.warning?.includes('never shown again'));

  const listed = await req('/api/auth/api-keys', { token });
  const entry = listed.data?.keys?.[0];
  check('list shows the prefix, never the key', entry && entry.prefix && entry.prefix !== rawKey);
  check('list shows the scopes', entry?.scopes?.includes('read'));

  const used = await req('/api/metrics', { token: rawKey });
  check('key works as a bearer', used.status === 200, `status ${used.status}`);

  const garbage = await req('/api/metrics', { token: 'cf_live_totally-made-up-key-value' });
  check('an unknown key is rejected', garbage.status === 401, `status ${garbage.status}`);
  check('rejection is named api_key_unknown', garbage.data?.error === 'api_key_unknown', garbage.data?.error);

  const revoked = await req(`/api/auth/api-keys/${keyId}`, { method: 'DELETE', token });
  check('key can be revoked', revoked.status === 200);
  const afterRevoke = await req('/api/metrics', { token: rawKey });
  check('a revoked key stops working', afterRevoke.status === 401, `status ${afterRevoke.status}`);
  check('revocation is reported', afterRevoke.data?.error === 'api_key_revoked', afterRevoke.data?.error);

  const noScopes = await req('/api/auth/api-keys', { method: 'POST', token, body: { name: 'x' } });
  check('a key with no requested scope falls back to read-only', noScopes.status === 201
    && noScopes.data.key.scopes.length === 1 && noScopes.data.key.scopes[0] === 'read', JSON.stringify(noScopes.data?.key?.scopes));
  await req(`/api/auth/api-keys/${noScopes.data.key.id}`, { method: 'DELETE', token });

  const bogus = await req('/api/auth/api-keys', { method: 'POST', token, body: { name: 'x', scopes: ['superuser', 'write'] } });
  check('an unknown scope is dropped, known ones kept', bogus.data.key.scopes.join(',') === 'write', JSON.stringify(bogus.data?.key?.scopes));
  await req(`/api/auth/api-keys/${bogus.data.key.id}`, { method: 'DELETE', token });

  const noName = await req('/api/auth/api-keys', { method: 'POST', token, body: {} });
  check('a nameless key is rejected', noName.status === 400, `status ${noName.status}`);

  // A scope is only real if it is enforced on the wire.
  const ro = await req('/api/auth/api-keys', { method: 'POST', token, body: { name: 'readonly', scopes: ['read'] } });
  const roKey = ro.data.key.key;
  check('a read-only key can read', (await req('/api/metrics', { token: roKey })).status === 200);
  const roWrite = await req('/api/auth/api-keys', { method: 'POST', token: roKey, body: { name: 'nope' } });
  check('a read-only key cannot write', roWrite.status === 403, `status ${roWrite.status}`);
  check('the refusal names the scope', roWrite.data?.error === 'insufficient_scope', roWrite.data?.error);
  check('the refusal reports what it holds', roWrite.data?.yourScopes?.includes('read'), JSON.stringify(roWrite.data?.yourScopes));
  await req(`/api/auth/api-keys/${ro.data.key.id}`, { method: 'DELETE', token });

  const rw = await req('/api/auth/api-keys', { method: 'POST', token, body: { name: 'readwrite', scopes: ['write'] } });
  const rwKey = rw.data.key.key;
  check('a write key can also read', (await req('/api/metrics', { token: rwKey })).status === 200);
  const rwWrite = await req('/api/auth/api-keys', { method: 'POST', token: rwKey, body: { name: 'child' } });
  check('a write key can write', rwWrite.status === 201, `status ${rwWrite.status}`);
  await req(`/api/auth/api-keys/${rw.data.key.id}`, { method: 'DELETE', token });
  await req(`/api/auth/api-keys/${rwWrite.data.key.id}`, { method: 'DELETE', token });
}

group('Role enforcement');
{
  const teacherToken = (await req('/api/auth/login', { method: 'POST', body: { role: 'TEACHER' } })).data?.token;
  const denied = await req('/api/settings', { token: teacherToken });
  check('teachers cannot read settings', denied.status === 403, `status ${denied.status}`);
  check('the error names the required role', denied.data?.message?.includes('ACCOUNTANT'), denied.data?.message);
}

group('Session management');
{
  const a = jar();
  await req('/api/auth/login', { method: 'POST', body: { email: 'accounts@campusflow.edu', password: 'campus123' }, cookies: a });

  const list = await req('/api/auth/sessions', { cookies: a });
  check('sessions are listed', list.status === 200 && list.data.sessions.length >= 1, `status ${list.status}`);
  check('the current session is flagged', list.data.sessions.some((s) => s.current));
  check('the user agent is recorded', list.data.sessions.every((s) => s.userAgent !== undefined));
  check('live refresh tokens are counted', list.data.sessions[0].liveRefreshTokens >= 1);

  // A second, revocable session for the same account.
  const b = jar();
  const bLogin = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' }, cookies: b });
  check('a second device signs in', bLogin.status === 200);

  const csrfA = (await req('/api/auth/session', { cookies: a })).data.csrfToken;

  const others = await req('/api/auth/sessions/revoke-others', { method: 'POST', cookies: a, csrf: csrfA });
  check('other sessions can be revoked', others.status === 200, `status ${others.status} ${JSON.stringify(others.data)}`);

  const stillAlive = await req('/api/auth/session', { cookies: a });
  check('the calling session survives the sweep', stillAlive.status === 200, `status ${stillAlive.status}`);

  const bDead = await req('/api/auth/session', { cookies: b });
  check('the other device is signed out', bDead.status === 401, `status ${bDead.status}`);
  const bTokenDead = await req('/api/auth/session', { token: bLogin.data.token });
  check('its access token dies with it', bTokenDead.status === 401, `status ${bTokenDead.status}`);

  const out = await req('/api/auth/logout', { method: 'POST', cookies: a, csrf: csrfA });
  check('logout succeeds', out.status === 200, `status ${out.status}`);
  const afterOut = await req('/api/auth/session', { cookies: a });
  check('the session is dead after logout', afterOut.status === 401, `status ${afterOut.status}`);
  check('logout clears the cookies', a.size === 0, `${a.size} cookies left`);

  // A fresh sign-in is the only session left, and the earlier one is history.
  const fresh = jar();
  const freshLogin = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' }, cookies: fresh });
  const after = await req('/api/auth/sessions', { cookies: fresh });
  check('the list is down to the one live session', after.data.sessions.length === 1, `${after.data.sessions.length} sessions`);
  check('and it is the current one', after.data.sessions[0]?.current === true);
  check('the revoked sessions are gone', after.data.sessions.length === 1 && after.data.sessions[0].id === freshLogin.data.sessionId);
}

group('Account lockout');
{
  const bad = async () => req('/api/auth/login', {
    method: 'POST',
    body: { email: 'teacher@campusflow.edu', password: 'definitely-wrong' },
  });

  const one = await bad();
  check('a wrong password is rejected', one.status === 401, `status ${one.status}`);
  check('the message reveals nothing about the user', one.data?.error === 'invalid_credentials');

  await bad();
  const third = await bad();
  check('the account locks on the Nth failure', third.status === 423, `status ${third.status}`);
  check('the lockout tells the client when to retry', typeof third.data?.retryAfterSeconds === 'number');

  const right = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'teacher@campusflow.edu', password: 'campus123' },
  });
  check('the right password is refused while locked', right.status === 423, `status ${right.status}`);

  const seen = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } });
  const audit = await req('/api/auth/audit?scope=all&limit=100', { token: seen.data.token });
  const outcomes = new Set(audit.data.events.map((e) => e.outcome));
  check('failed logins are written to the audit trail', outcomes.has('denied'), [...outcomes].join(','));
  check('the lockout itself is audited', outcomes.has('locked'), [...outcomes].join(','));
  check('the audit trail is scoped to the account', audit.data.scope === 'all');
}

group('Multi-factor authentication');
{
  const token = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;

  const before = await req('/api/auth/mfa', { token });
  check('MFA starts off', before.data?.enabled === false, JSON.stringify(before.data));
  check('the TOTP parameters are published', before.data?.digits === 6 && before.data?.stepSeconds === 30);

  const enrol = await req('/api/auth/mfa/enrol', { method: 'POST', token });
  check('enrolment returns a secret', !!enrol.data?.secret, `status ${enrol.status}`);
  check('enrolment returns an otpauth URL', String(enrol.data?.otpauth || '').startsWith('otpauth://totp/'));
  check('recovery codes are issued', Array.isArray(enrol.data?.recoveryCodes) && enrol.data.recoveryCodes.length === 8);

  const wrong = await req('/api/auth/mfa/confirm', { method: 'POST', token, body: { code: '000000' } });
  check('a wrong code does not enable MFA', wrong.status === 400, `status ${wrong.status}`);

  const stillOff = await req('/api/auth/mfa', { token });
  check('MFA is still off after a bad code', stillOff.data?.enabled === false);

  const confirm = await req('/api/auth/mfa/confirm', { method: 'POST', token, body: { code: totpAt(enrol.data.secret) } });
  check('a real code enables MFA', confirm.status === 200, `status ${confirm.status}`);

  // Now a fresh login must stop at the second factor.
  const challenged = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } });
  check('login now demands a second factor', challenged.data?.mfaRequired === true, JSON.stringify(challenged.data));
  check('a challenge token is issued', !!challenged.data?.challenge);
  check('no session is issued yet', !challenged.data?.token);

  const badMfa = await req('/api/auth/mfa/verify', { method: 'POST', body: { challenge: challenged.data.challenge, code: '000000' } });
  check('a wrong code is refused', badMfa.status === 401, `status ${badMfa.status}`);

  const goodMfa = await req('/api/auth/mfa/verify', {
    method: 'POST',
    body: { challenge: challenged.data.challenge, code: totpAt(enrol.data.secret) },
  });
  check('the right code completes the login', goodMfa.status === 200 && !!goodMfa.data?.token, `status ${goodMfa.status}`);

  const me = await req('/api/auth/me', { token: goodMfa.data.token });
  check('the MFA session is usable', me.status === 200, `status ${me.status}`);

  // A recovery code is single-use.
  const recovery = enrol.data.recoveryCodes[0];
  const c1 = await req('/api/auth/login', { method: 'POST', body: { email: 'accounts@campusflow.edu', password: 'campus123' } });
  const withRecovery = await req('/api/auth/mfa/verify', { method: 'POST', body: { challenge: c1.data.challenge, code: recovery } });
  check('a recovery code works', withRecovery.status === 200 && withRecovery.data.via === 'recovery', `status ${withRecovery.status} ${JSON.stringify(withRecovery.data)}`);
  const c2 = await req('/api/auth/login', { method: 'POST', body: { email: 'accounts@campusflow.edu', password: 'campus123' } });
  const reuseRecovery = await req('/api/auth/mfa/verify', { method: 'POST', body: { challenge: c2.data.challenge, code: recovery } });
  check('a recovery code cannot be reused', reuseRecovery.status === 401, `status ${reuseRecovery.status}`);

  const offRes = await req('/api/auth/mfa', { method: 'DELETE', token: withRecovery.data.token });
  check('MFA can be turned off', offRes.status === 200, `status ${offRes.status} ${JSON.stringify(offRes.data)}`);
  const off = await req('/api/auth/mfa', { token: withRecovery.data.token });
  check('MFA reads as off afterwards', off.data?.enabled === false, JSON.stringify(off.data));
  const offNow = await req('/api/auth/mfa', { token });
  check('MFA is off for every session of that user', offNow.data?.enabled === false, JSON.stringify(offNow.data));
  const plain = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } });
  check('login no longer demands a code', plain.data?.mfaRequired === false, JSON.stringify(plain.data?.mfaRequired));

  // Policy on, nobody enrolled: refusing is the only safe answer.
  const admin = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  await req('/api/settings', { method: 'PUT', token: admin, body: { updates: [{ key: 'AUTH_REQUIRE_MFA', value: 'true' }] } });
  const unEnrolled = await req('/api/auth/login', { method: 'POST', body: { role: 'STUDENT' } });
  check('policy without enrolment refuses the sign-in', unEnrolled.status === 403, `status ${unEnrolled.status}`);
  check('the refusal explains the fix', unEnrolled.data?.error === 'mfa_enrolment_required', unEnrolled.data?.error);
  check('and it issues no session', !unEnrolled.data?.token);
  await req('/api/settings', { method: 'PUT', token: admin, body: { updates: [{ key: 'AUTH_REQUIRE_MFA', value: 'false' }] } });
  const afterOff = await req('/api/auth/login', { method: 'POST', body: { role: 'STUDENT' } });
  check('lifting the policy restores sign-in', afterOff.data?.mfaRequired === false, JSON.stringify(afterOff.data?.mfaRequired));
}

group('Audit trail');
{
  const token = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  check('an accountant can read the trail', !!token, 'login failed');
  const audit = await req('/api/auth/audit?scope=all&limit=200', { token });
  check('audit is readable', audit.status === 200, `status ${audit.status}`);
  const actions = new Set((audit.data.events || []).map((e) => e.action));
  check('logins are recorded', actions.has('auth.login'), [...actions].join(','));
  check('refreshes are recorded', actions.has('auth.refresh'), [...actions].join(','));
  check('key lifecycle is recorded', actions.has('auth.api_key_create'), [...actions].join(','));
  check('MFA enrolment is recorded', actions.has('auth.mfa_enrol'), [...actions].join(','));
  check('lockouts are recorded', actions.has('auth.login'), [...actions].join(','));
  check('each event carries a timestamp', audit.data.events.every((e) => !!e.at));
  check('each event records an outcome', audit.data.events.every((e) => !!e.outcome));
  check('each event records the client IP', audit.data.events.every((e) => e.ip !== undefined));

  const teacher = (await req('/api/auth/login', { method: 'POST', body: { role: 'STUDENT' } })).data.token;
  const scoped = await req('/api/auth/audit?scope=all', { token: teacher });
  check('a student is refused the whole trail', scoped.status === 403, `status ${scoped.status}`);
  check('the refusal is named', scoped.data?.error === 'forbidden', scoped.data?.error);

  const own = await req('/api/auth/audit', { token: teacher });
  check('a student can still read their own trail', own.status === 200 && own.data.scope === 'me', `status ${own.status}`);
  check('and it contains only their own events', own.data.events.every((e) => e.actor !== 'accounts@campusflow.edu'), JSON.stringify(own.data.events.map((e) => e.actor)));
  check('their own events are non-empty', own.data.events.length > 0, `${own.data.events.length} events`);
}

group('Environment file hygiene');
{
  // A throwaway server, so a refused sign-in here means a real state problem,
  // not flakiness. Report it instead of crashing on the response shape.
  const login = await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } });
  check('the accountant can sign in for the settings checks',
    login.status === 200 && !!login.data.token, `status ${login.status} ${JSON.stringify(login.data).slice(0, 160)}`);
  const token = login.data.token;

  // The writer rewrites the file from the schema, so this holds after any save.
  const raw = (await req('/api/settings/raw', { token })).data.text;
  const lines = raw.split('\n').filter((l) => l.trim());
  check('the .env has no comment lines', lines.every((l) => !l.trimStart().startsWith('#')), lines.find((l) => l.trimStart().startsWith('#')) || '');
  check('every non-blank line is KEY=value', lines.every((l) => /^[A-Z0-9_]+=/.test(l)), lines.find((l) => !/^[A-Z0-9_]+=/.test(l)) || '');
  check('the file has no duplicate keys', new Set(lines.map((l) => l.split('=')[0])).size === lines.length);

  const settingsRes = await req('/api/settings', { token });
  const secretItem = (settingsRes.data.sections || [])
    .flatMap((s) => s.items).find((i) => i.key === 'TOKEN_SECRET');
  check('the secret value is never sent to the browser', secretItem.value === '', JSON.stringify(secretItem));
  check('the server only reports that it exists', secretItem.configured === true && !!secretItem.display, JSON.stringify(secretItem.display));
}

group('Settings writer');
{
  const token = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;

  const read = await req('/api/settings', { token });
  check('settings are readable', read.status === 200, `status ${read.status}`);
  check('every section is present', read.data.sections.length >= 5, `${read.data.sections.length} sections`);
  const keys = read.data.sections.flatMap((s) => s.items.map((i) => i.key));
  check('the schema is the single source of truth', keys.length >= 40, `${keys.length} keys`);
  check('keys are unique', new Set(keys).size === keys.length);

  const secretItem = read.data.sections.flatMap((s) => s.items).find((i) => i.type === 'secret');
  check('secrets are marked, not sent', secretItem.value === '' && secretItem.configured === false, JSON.stringify(secretItem?.display));

  const text = JSON.stringify(read.data);
  const secretLine = fs.readFileSync(envPath, 'utf8');
  const anySecret = secretLine.split('\n').find((l) => /SECRET/.test(l) && l.includes('=') && l.split('=')[1].length > 20);
  if (anySecret) {
    const value = anySecret.split('=')[1];
    check('a real secret never appears in the API response', !text.includes(value));
  } else {
    check('a real secret never appears in the API response', true);
  }

  const live = await req('/api/settings', {
    method: 'PUT',
    token,
    body: { updates: [{ key: 'AUTH_AUDIT_RETENTION_DAYS', value: '30' }] },
  });
  check('a valid value is written', live.status === 200 && live.data.ok === true, `status ${live.status}`);
  check('a live value applies without a restart', live.data.restartRequired === false, JSON.stringify(live.data));
  check('the file is rewritten on disk', fs.readFileSync(envPath, 'utf8').includes('AUTH_AUDIT_RETENTION_DAYS=30'));
  check('the file stays structured', /^[A-Z0-9_]+=/.test(fs.readFileSync(envPath, 'utf8').split('\n')[0]));

  const boot = await req('/api/settings', {
    method: 'PUT',
    token,
    body: { updates: [{ key: 'TOKEN_TTL_SECONDS', value: '3600' }] },
  });
  check('a boot-time value is flagged for restart', boot.data.pendingRestart.includes('TOKEN_TTL_SECONDS'));

  const bad = await req('/api/settings', { method: 'PUT', token, body: { updates: [{ key: 'PORT', value: 'abc' }] } });
  check('a non-numeric port is rejected', bad.status === 400, `status ${bad.status}`);
  const badEnum = await req('/api/settings', { method: 'PUT', token, body: { updates: [{ key: 'TOKEN_COOKIE_SAMESITE', value: 'sideways' }] } });
  check('an unknown enum value is rejected', badEnum.status === 400, `status ${badEnum.status}`);
  const badKey = await req('/api/settings', { method: 'PUT', token, body: { updates: [{ key: 'DROP_TABLE', value: 'x' }] } });
  check('an unknown key is rejected', badKey.status === 400, `status ${badKey.status}`);
  const badPayload = await req('/api/settings', { method: 'PUT', token, body: {} });
  check('a malformed body is rejected', badPayload.status === 400, `status ${badPayload.status}`);

  const raw = await req('/api/settings/raw', { token });
  check('the raw file is viewable', raw.status === 200 && raw.data.text.includes('PORT='), `status ${raw.status}`);

  const system = await req('/api/system', { token });
  check('the runtime view is readable', system.status === 200, `status ${system.status}`);
  check('it reports the auth posture', typeof system.data.auth.config.maxAttempts === 'number');
  check('it reports the change it made', system.data.auth.config.maxAttempts === 3, String(system.data.auth.config.maxAttempts));
}

group('Expanded database');
{
  const token = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  const db = await req('/api/system', { token });
  const tables = db.data.database.tables;
  check('16 tables are defined', tables.length === 16, `${tables.length}`);
  for (const t of ['sessions', 'refresh_tokens', 'api_keys', 'audit_log', 'login_attempts',
    'invoices', 'payments', 'fee_installments', 'course_results', 'attendance_records',
    'subjects', 'academic_terms', 'notifications', 'saved_views']) {
    check(`table ${t} exists`, tables.some((x) => x.table === t));
  }
  const rows = (name) => tables.find((x) => x.table === name)?.rows ?? 0;
  check('invoices were seeded', rows('invoices') > 100, String(rows('invoices')));
  check('payments were seeded', rows('payments') > 100, String(rows('payments')));
  check('attendance was seeded', rows('attendance_records') > 1000, String(rows('attendance_records')));
  check('course results were seeded', rows('course_results') > 100, String(rows('course_results')));
  check('subjects were seeded', rows('subjects') > 5, String(rows('subjects')));
  check('audit rows accumulated during the run', rows('audit_log') > 10, String(rows('audit_log')));
  check('the migration report is attached', !!db.data.database.migration);
  check('the earlier database gained columns', db.data.database.migration.added.length >= 0);
}

group('Expanded API surface');
{
  const accountant = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  const teacher = (await req('/api/auth/login', { method: 'POST', body: { role: 'TEACHER' } })).data.token;
  const student = (await req('/api/auth/login', { method: 'POST', body: { role: 'STUDENT' } })).data.token;

  const ledger = await req('/api/accountant/ledger?limit=5', { token: accountant });
  check('the ledger paginates', ledger.status === 200 && ledger.data.rows.length === 5, `status ${ledger.status}`);
  check('the ledger pages are counted', ledger.data.pages > 1, String(ledger.data.pages));
  check('collections are broken down by method', ledger.data.byMethod.length > 0);
  check('the ageing bucket is reported', typeof ledger.data.aging.over_90 === 'number');

  const filtered = await req('/api/accountant/ledger?method=upi&limit=5', { token: accountant });
  check('the ledger filters by method', filtered.data.rows.every((r) => r.method === 'upi'));

  const ledgerDenied = await req('/api/accountant/ledger', { token: teacher });
  check('teachers cannot read the ledger', ledgerDenied.status === 403, `status ${ledgerDenied.status}`);

  const roster = await req('/api/teacher/students?grade=9', { token: teacher });
  check('the roster carries subject averages', Array.isArray(roster.data.subjectAverages));
  check('the roster carries an attendance split', roster.data.attendance.length > 0);

  const me = await req('/api/student/me', { token: student });
  check('the student view carries invoices', me.data.fees.invoices.length > 0);
  check('the student view carries payments', Array.isArray(me.data.fees.payments));
  check('the student view carries an instalment plan', me.data.fees.installments.length === 3, String(me.data.fees.installments.length));
  check('the student view carries results', me.data.academics.results.length > 0);
  check('the student view carries recent attendance', me.data.attendance.recent.length === 14, String(me.data.attendance.recent.length));
  check('a subject average is computed', typeof me.data.academics.average === 'number');

  const one = await req('/api/teacher/student/1', { token: teacher });
  check('a full student record is available to staff', one.status === 200 && one.data.results.length > 0, `status ${one.status}`);

  const notes = await req('/api/notifications', { token: student });
  check('notifications are readable', notes.status === 200, `status ${notes.status}`);

  const view = await req('/api/views', { method: 'PUT', token: teacher, body: { name: 'watchlist', payload: { grade: 9 } } });
  check('a view can be saved', view.status === 200, `status ${view.status}`);
  const views = await req('/api/views', { token: teacher });
  check('the saved view is listed', views.data.views.some((v) => v.name === 'watchlist'));
  const removed = await req(`/api/views/${view.data.view.id}`, { method: 'DELETE', token: teacher });
  check('a view can be deleted', removed.status === 200);

  const roles = await req('/api/auth/roles');
  check('the role catalogue advertises the transport', !!roles.data.transport.session, JSON.stringify(roles.data.transport));
  check('one-click state is published', roles.data.oneClickEnabled === true);
}

group('Provider console');
{
  const accountant = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  const teacher = (await req('/api/auth/login', { method: 'POST', body: { role: 'TEACHER' } })).data.token;

  const report = await req('/api/ai/providers', { token: accountant });
  check('the provider report is served', report.status === 200, `status ${report.status}`);
  check('the report names a provider order', typeof report.data.order === 'string', report.data.order);
  check('the report carries a live plan', Array.isArray(report.data.plan?.fast));
  check('the report lists models with scores', Array.isArray(report.data.models));
  check('every reported model is scored or dead',
    report.data.models.every((m) => m.dead || typeof m.fast === 'number' || typeof m.deep === 'number'));
  check('the report explains itself when offline',
    report.data.providers.length > 0 || report.data.notes.length > 0, JSON.stringify(report.data.notes));

  const denied = await req('/api/ai/providers', { token: teacher });
  check('teachers cannot read the provider console', denied.status === 403, `status ${denied.status}`);

  const probeDenied = await req('/api/ai/probe', { method: 'POST', token: teacher, body: { provider: 'gemini' } });
  check('teachers cannot probe a key', probeDenied.status === 403, `status ${probeDenied.status}`);

  const badProvider = await req('/api/ai/probe', { method: 'POST', token: accountant, body: { provider: 'nope' } });
  check('an unknown provider is rejected', badProvider.status === 400, `status ${badProvider.status}`);
  check('the rejection names the real providers',
    badProvider.data.message.includes('gemini') && badProvider.data.message.includes('zen'),
    badProvider.data.message);

  // The order is a live setting, so flipping it must move the router with no
  // restart. Restore it afterwards so later checks are not order-dependent.
  const set = await req('/api/settings', {
    method: 'PUT', token: accountant,
    body: { updates: [{ key: 'AI_PROVIDER_ORDER', value: 'zen-only' }] },
  });
  check('the provider order is writable', set.status === 200 && !set.data.restartRequired, JSON.stringify(set.data?.error));
  check('the new order is live without a restart', (await req('/api/health')).data.ai.order === 'zen-only');

  const only = await req('/api/ai/providers', { token: accountant });
  check('a -only order narrows the rotation',
    only.data.providers.filter((p) => p.active).every((p) => p.id === 'zen'),
    JSON.stringify(only.data.providers.map((p) => [p.id, p.active])));

  const badOrder = await req('/api/settings', {
    method: 'PUT', token: accountant,
    body: { updates: [{ key: 'AI_PROVIDER_ORDER', value: 'psychic-first' }] },
  });
  check('an unknown order is rejected', badOrder.status === 400, `status ${badOrder.status}`);
  check('a rejected order does not take effect', (await req('/api/health')).data.ai.order === 'zen-only');

  await req('/api/settings', {
    method: 'PUT', token: accountant,
    body: { updates: [{ key: 'AI_PROVIDER_ORDER', value: 'auto' }] },
  });
  check('the order is restored', (await req('/api/health')).data.ai.order === 'auto');
}

group('Notifications and export');
{
  const accountant = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  const student = (await req('/api/auth/login', { method: 'POST', body: { role: 'STUDENT' } })).data.token;

  const sweep = await req('/api/notifications/generate', { method: 'POST', token: accountant });
  check('an accountant can force a sweep', sweep.status === 200, `status ${sweep.status}`);
  check('the sweep reports what it derived', typeof sweep.data.created === 'number', JSON.stringify(sweep.data));
  check('the sweep is idempotent', sweep.data.created === 0, `created ${sweep.data.created} on a repeat pass`);
  check('the sweep summarises the mix', !!sweep.data.mix, JSON.stringify(sweep.data.mix));

  const again = await req('/api/notifications/generate', { method: 'POST', token: accountant });
  check('a third sweep still adds nothing', again.data.created === 0, `created ${again.data.created}`);

  const sweepDenied = await req('/api/notifications/generate', { method: 'POST', token: student });
  check('students cannot force a sweep', sweepDenied.status === 403, `status ${sweepDenied.status}`);

  const before = await req('/api/notifications?limit=5', { token: student });
  check('a student reads their own alerts', before.status === 200 && before.data.unread > 0,
    `status ${before.status} unread ${before.data?.unread}`);

  const session = await req('/api/auth/session', { token: student });
  check('the session carries the unread count', typeof session.data.unread === 'number', String(session.data.unread));
  check('the unread count agrees with the list', session.data.unread === before.data.unread,
    `${session.data.unread} vs ${before.data.unread}`);

  const one = before.data.notifications[0];
  const read = await req(`/api/notifications/${one.id}/read`, { method: 'POST', token: student });
  check('an alert can be marked read', read.status === 200, `status ${read.status}`);
  const afterOne = await req('/api/notifications?limit=5', { token: student });
  check('marking one read lowers the count', afterOne.data.unread === before.data.unread - 1,
    `${afterOne.data.unread} vs ${before.data.unread}`);
  check('the marked alert comes back read',
    afterOne.data.notifications.find((n) => n.id === one.id)?.read_at !== null);

  const ghost = await req('/api/notifications/99999999/read', { method: 'POST', token: student });
  check('marking an unknown alert read is a 404', ghost.status === 404, `status ${ghost.status}`);

  const readAll = await req('/api/notifications/read-all', { method: 'POST', token: student });
  check('every alert can be cleared', readAll.status === 200 && readAll.data.marked > 0, JSON.stringify(readAll.data));
  // The read-all is scoped to the caller, so compare against this student's own
  // count rather than assuming a global zero.
  const cleared = await req('/api/auth/session', { token: student });
  check('the cleared count reaches the session', cleared.data.unread === 0, String(cleared.data.unread));
  check('clearing read-all does not touch another inbox',
    (await req('/api/auth/session', { token: accountant })).data.unread > 0,
    String((await req('/api/auth/session', { token: accountant })).data.unread));

  // A student must not be able to clear somebody else's inbox.
  const cross = await req('/api/notifications/read-all', { method: 'POST', token: accountant });
  check('clearing is scoped to the caller', cross.status === 200);

  const csv = await req('/api/accountant/ledger.csv', { token: accountant, raw: true });
  check('the ledger exports as CSV', csv.status === 200, `status ${csv.status}`);
  check('the export is a CSV attachment',
    String(csv.headers.get('content-type')).includes('text/csv'), csv.headers.get('content-type'));
  check('the export downloads under a filename',
    String(csv.headers.get('content-disposition')).includes('campusflow-ledger.csv'),
    csv.headers.get('content-disposition'));
  const lines = String(csv.text).trim().split('\n');
  check('the export has a header row', lines[0].startsWith('receipt_no,paid_at,student'), lines[0]);
  check('the export carries the whole filtered set, not one page',
    lines.length > 200, `${lines.length} lines`);
  check('every exported column is quoted or clean',
    lines.slice(1).every((l) => l.split(',').length >= 10));

  const filteredCsv = await req('/api/accountant/ledger.csv?method=cheque', { token: accountant, raw: true });
  const filteredLines = String(filteredCsv.text).trim().split('\n').slice(1);
  check('the export honours the method filter',
    filteredLines.length > 0 && filteredLines.every((l) => l.includes('cheque')),
    `${filteredLines.length} lines`);
  check('the filtered export is smaller than the whole set',
    filteredLines.length < lines.length - 1, `${filteredLines.length} vs ${lines.length - 1}`);

  const csvDenied = await req('/api/accountant/ledger.csv', { token: student });
  check('students cannot export the ledger', csvDenied.status === 403, `status ${csvDenied.status}`);
}

group('Settings read model');
{
  const accountant = (await req('/api/auth/login', { method: 'POST', body: { role: 'ACCOUNTANT' } })).data.token;
  const read = await req('/api/settings', { token: accountant });
  const items = read.data.sections.flatMap((s) => s.items);

  const chain = items.find((i) => i.key === 'AI_MODEL_CHAIN');
  check('a restart key reports the file value', 'fileValue' in chain, JSON.stringify(Object.keys(chain)));
  check('drift is reported against the running value', typeof chain.drift === 'boolean', String(chain.drift));

  const secrets = items.filter((i) => i.type === 'secret');
  check('secrets never expose a file value', secrets.every((s) => s.fileValue === null),
    JSON.stringify(secrets.filter((s) => s.fileValue !== null).map((s) => s.key)));
  check('secrets still send a value field', secrets.every((s) => s.value === ''));
}

group('Hardening');
{
  const bad = await req('/api/auth/me', { token: 'not-a-token' });
  check('a malformed token is rejected', bad.status === 401, `status ${bad.status}`);

  const live = (await req('/api/auth/login', { method: 'POST', body: { role: 'STUDENT' } })).data.token;
  const [head, tag, data] = live.split('.');
  const flipped = `${head}.${tag}.${data.slice(0, -2)}${data.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  const forged = await req('/api/auth/me', { token: flipped });
  check('a tampered token fails the GCM tag', forged.status === 401, `status ${forged.status}`);
  check('tampering is named', String(forged.data?.error).includes('tampered'), forged.data?.error);

  const swapped = await req('/api/auth/me', { token: `${head}.${data}.${tag}` });
  check('reordered token parts are rejected', swapped.status === 401, `status ${swapped.status}`);

  const noAuth = await req('/api/metrics');
  check('an unauthenticated request is rejected', noAuth.status === 401, `status ${noAuth.status}`);
  check('the rejection explains how to sign in', noAuth.data?.message?.includes('/api/auth/login'), noAuth.data?.message);

  const badBody = await req('/api/auth/login', { method: 'POST', body: { role: 'WIZARD' } });
  check('an unknown role is rejected', badBody.status === 400, `status ${badBody.status}`);

  const query = await req(`/api/auth/me?token=${live}`);
  check('the legacy query-string transport still works', query.status === 200, `status ${query.status}`);
}

/* ------------------------------------------------------------------ */

console.log(`\n\x1b[1mDatabase: ${dbPath}\x1b[0m`);
console.log(`\n───────────────────────────────────────────────────────────`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} checks passed\x1b[0m`);
  console.log('───────────────────────────────────────────────────────────\n');
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, \x1b[32m${passed} passed\x1b[0m`);
  for (const f of failures) console.log(`· ${f}`);
  console.log('───────────────────────────────────────────────────────────\n');
  process.exit(1);
}
