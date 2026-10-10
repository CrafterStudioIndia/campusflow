/**
 * scripts/smoke-test.js — end-to-end verification of the CampusFlow API.
 *
 * Usage:  npm run test:api
 *         BASE=http://host:port npm run test:api   (test an already-running server)
 *
 * If nothing is listening on BASE, the script starts its own server on an
 * ephemeral port and shuts it down afterwards, so it is always self-contained.
 *
 * Exits non-zero if any check fails.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let BASE = process.env.BASE || 'http://localhost:3000';
let server = null;

const reachable = async (url) => {
  try {
    await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
};

if (process.env.BASE || await reachable(BASE)) {
  console.log(`Testing the server already running at ${BASE}`);
} else {
  // Pick a free port so a running dev server is never disturbed.
  const { createServer } = await import('node:net');
  const probe = createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
  });
  probe.close();

  BASE = `http://127.0.0.1:${port}`;
  process.stdout.write(`Starting a temporary server at ${BASE} ...\n`);

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    if (await reachable(BASE)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    console.error('\nServer failed to start:\n' + logs.join(''));
    server.kill('SIGKILL');
    process.exit(1);
  }
  process.on('exit', () => server?.kill('SIGTERM'));
}

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

async function req(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data };
}

/* ------------------------------------------------------------------ */

group('Health & metadata');
{
  const { status, data } = await req('/api/health');
  check('GET /api/health returns 200', status === 200, `got ${status}`);
  check('service is campusflow', data?.service === 'campusflow');
  check('100 students seeded', data?.students === 100, `got ${data?.students}`);
  check('ai provider reported', typeof data?.ai?.provider === 'string');
  check('ai provider is a known value',
    ['zen', 'gemini', 'offline'].includes(data?.ai?.provider), data?.ai?.provider);
  if (data?.ai?.provider === 'offline') {
    check('offline mode has no transports', data?.ai?.transports === null);
  } else {
    check('live mode exposes a route for every model',
      (data?.ai?.models || []).every((m) => !!data?.ai?.transports?.routing?.[m]));
    check('live mode reports its endpoint', /^https?:\/\//.test(data?.ai?.endpoint || ''), data?.ai?.endpoint);
  }
}

group('1-click role login');
const tokens = {};
for (const role of ['ACCOUNTANT', 'TEACHER', 'STUDENT']) {
  const { status, data } = await req('/api/auth/login', { method: 'POST', body: { role } });
  check(`login as ${role}`, status === 200 && !!data?.token, `status ${status}`);
  check('  token is iv.tag.ciphertext',
    typeof data?.token === 'string' && data.token.split('.').length === 3);
  check('  token is URL-safe',
    typeof data?.token === 'string'
      && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token));
  check('  role claim matches', data?.user?.role === role);
  tokens[role] = data?.token;
}

group('Credential login');
{
  const ok = await req('/api/auth/login', {
    method: 'POST', body: { email: 'accounts@campusflow.edu', password: 'campus123' },
  });
  check('valid email + password', ok.status === 200 && !!ok.data?.token);

  const bad = await req('/api/auth/login', {
    method: 'POST', body: { email: 'accounts@campusflow.edu', password: 'wrong' },
  });
  check('wrong password rejected', bad.status === 401);

  const ghost = await req('/api/auth/login', {
    method: 'POST', body: { email: 'nobody@campusflow.edu', password: 'campus123' },
  });
  check('unknown email rejected', ghost.status === 401);

  const badRole = await req('/api/auth/login', { method: 'POST', body: { role: 'PRINCIPAL' } });
  check('unknown role rejected', badRole.status === 400);

  const empty = await req('/api/auth/login', { method: 'POST', body: {} });
  check('empty body rejected', empty.status === 400);
}

group('Token integrity');
{
  const parts = tokens.ACCOUNTANT.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

  const cases = [
    ['tampered ciphertext', flip(parts[2], 5)],
    ['tampered IV', flip(parts[0], 3) + '.' + parts[1] + '.' + parts[2]],
    ['tampered auth tag', parts[0] + '.' + flip(parts[1], 3) + '.' + parts[2]],
    ['auth tag swapped between tokens',
      parts[0] + '.' + tokens.TEACHER.split('.')[1] + '.' + parts[2]],
    ['malformed token', 'not.a.token'],
    ['two-segment token', parts[0] + '.' + parts[1]],
  ];
  for (const [name, bad] of cases) {
    const r = await req('/api/auth/me', { token: bad });
    check(`${name} rejected`, r.status === 401, `got ${r.status}`);
  }

  const missing = await req('/api/accountant/overview');
  check('no token rejected', missing.status === 401);

  const valid = await req('/api/auth/me', { token: tokens.ACCOUNTANT });
  check('valid token accepted', valid.status === 200);
  check('token carries exp claim', typeof valid.data?.expiresAt === 'number');
}

group('Role guards');
{
  const cases = [
    ['TEACHER', '/api/accountant/overview', 403],
    ['STUDENT', '/api/accountant/overview', 403],
    ['STUDENT', '/api/teacher/students', 403],
    ['ACCOUNTANT', '/api/teacher/students', 403],
    ['ACCOUNTANT', '/api/student/me', 403],
    ['TEACHER', '/api/student/me', 403],
  ];
  for (const [role, path, expected] of cases) {
    const r = await req(path, { token: tokens[role] });
    check(`${role} -> ${path} = ${expected}`, r.status === expected, `got ${r.status}`);
  }
}

group('GET /api/accountant/overview');
{
  const { status, data } = await req('/api/accountant/overview', { token: tokens.ACCOUNTANT });
  check('returns 200', status === 200);

  const t = data?.metrics?.totals;
  check('has totals', !!t);
  check('100 students counted', t?.students === 100, `got ${t?.students}`);
  check('collected <= billed', t.collected <= t.billed, `${t?.collected} > ${t?.billed}`);
  check('collectionRate in 0..100', t.collectionRate >= 0 && t.collectionRate <= 100);
  check('outstanding = billed - collected',
    Math.abs(t.outstanding - (t.billed - t.collected)) < 1,
    `${t?.outstanding} vs ${(t?.billed - t?.collected)?.toFixed(2)}`);
  check('risk score in 0..100', data?.risk?.score >= 0 && data?.risk?.score <= 100);
  check('severity is a known value',
    ['healthy', 'guarded', 'elevated', 'critical'].includes(data?.risk?.severity));
  check('has defaulter patterns', (data?.risk?.defaulterPatterns?.length || 0) > 0);
  check('has action plan', (data?.risk?.actions?.length || 0) > 0);
  check('has forecast', typeof data?.risk?.forecast?.quarterOutlook === 'string');
  check('ai provenance present', typeof data?.ai?.source === 'string');
  check('byGrade has 7 rows', data?.metrics?.byGrade?.length === 7);
  check('attendance buckets sum to 100',
    data?.metrics?.attendanceBuckets?.reduce((a, b) => a + b.count, 0) === 100);
  check('every pattern has evidence + action',
    data.risk.defaulterPatterns.every((p) => p.evidence && p.recommendedAction));
  check('every action has owner + timeline',
    data.risk.actions.every((a) => a.owner && a.timeline));
  check('actions sorted by priority',
    (() => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return data.risk.actions.every((a, i, arr) => i === 0 || order[arr[i - 1].priority] <= order[a.priority]);
    })());

  const deep = await req('/api/accountant/overview?tier=deep', { token: tokens.ACCOUNTANT });
  check('deep tier accepted', deep.status === 200 && deep.data?.tier === 'deep');
}

group('GET /api/teacher/students');
let sampleStudentId = null;
{
  const { status, data } = await req('/api/teacher/students', { token: tokens.TEACHER });
  check('all-grades roster returns 200', status === 200);
  check('roster has 100 students', data?.roster?.length === 100, `got ${data?.roster?.length}`);
  check('summary present', typeof data?.summary?.total === 'number');
  check('class health scored', typeof data?.health?.healthScore === 'number');
  check('roster sorted by risk desc',
    data.roster.every((r, i, a) => i === 0 || a[i - 1].riskScore >= r.riskScore));
  check('risk scores in 0..100', data.roster.every((r) => r.riskScore >= 0 && r.riskScore <= 100));
  check('no NaN risk scores', data.roster.every((r) => Number.isFinite(r.riskScore)));
  check('balances non-negative', data.roster.every((r) => r.balance >= 0));

  const g = await req('/api/teacher/students?grade=9', { token: tokens.TEACHER });
  check('grade filter returns 200', g.status === 200);
  check('grade 9 roster non-empty', g.data?.roster?.length > 0);
  check('only grade 9 returned', g.data.roster.every((r) => r.grade === 9));

  const all = await req('/api/teacher/students?grade=', { token: tokens.TEACHER });
  check('empty grade = all students', all.data?.roster?.length === 100);

  const bad = await req('/api/teacher/students?grade=abc', { token: tokens.TEACHER });
  check('non-numeric grade rejected', bad.status === 400);

  sampleStudentId = g.data.roster[0].id;
}

group('GET /api/teacher/diagnose');
{
  const { status, data } = await req(`/api/teacher/diagnose?studentId=${sampleStudentId}`, { token: tokens.TEACHER });
  check('returns 200', status === 200);

  const p = data?.plan;
  check('plan returned', !!p);
  check('risk score numeric', Number.isFinite(p?.riskScore), `got ${p?.riskScore}`);
  check('risk level valid', ['healthy', 'guarded', 'elevated', 'critical'].includes(p?.riskLevel));
  check('student echoed', p?.student?.id === sampleStudentId);
  check('has summary', typeof p?.summary === 'string' && p.summary.length > 0);
  check('has diagnosis', typeof p?.diagnosis === 'string' && p.diagnosis.length > 0);
  check('has firstWin', typeof p?.firstWin === 'string' && p.firstWin.length > 0);
  check('has root causes', (p?.rootCauses?.length || 0) > 0);
  check('has milestones', (p?.milestones?.length || 0) > 0);
  check('plan.academics is an array', Array.isArray(p?.plan?.academics));
  check('plan.attendance is an array', Array.isArray(p?.plan?.attendance));
  check('plan.finance is an array', Array.isArray(p?.plan?.finance));
  check('plan.family is an array', Array.isArray(p?.plan?.family));
  check('cohort context attached', p?.cohort?.count > 1);
  check('no NaN/Infinity/undefined in payload',
    !/NaN|Infinity|undefined/.test(JSON.stringify(p)));

  const byRoll = await req('/api/teacher/diagnose?rollNo=' + p.student.rollNo, { token: tokens.TEACHER });
  check('lookup by rollNo works', byRoll.status === 200 && byRoll.data.plan.student.id === p.student.id);

  const missing = await req('/api/teacher/diagnose', { token: tokens.TEACHER });
  check('missing identifier = 400', missing.status === 400);

  const notFound = await req('/api/teacher/diagnose?studentId=999999', { token: tokens.TEACHER });
  check('unknown student = 404', notFound.status === 404);

  const byBadRoll = await req('/api/teacher/diagnose?rollNo=NOPE-1', { token: tokens.TEACHER });
  check('unknown rollNo = 404', byBadRoll.status === 404);
}

group('GET /api/student/me');
{
  const { status, data } = await req('/api/student/me', { token: tokens.STUDENT });
  check('returns 200', status === 200);

  const f = data?.fees;
  check('has profile', !!data?.profile?.name);
  check('has rollNo', !!data?.profile?.rollNo);
  check('billed = paid + outstanding',
    Math.abs(f.totalBilled - (f.totalPaid + f.outstanding)) < 1,
    `${f?.totalBilled} vs ${f?.totalPaid + f?.outstanding}`);
  check('outstanding non-negative', f.outstanding >= 0);
  check('settlement percent in 0..100', f.settlementPercent >= 0 && f.settlementPercent <= 100);
  check('breakdown has 3 rows', f.breakdown?.length === 3);
  check('breakdown amounts numeric', f.breakdown.every((b) => Number.isFinite(b.amount)));
  check('status is valid', ['clear', 'due', 'overdue', 'overdue_high'].includes(f.status));
  check('attendance band present', !!data?.attendance?.band);
  check('guidance text present', typeof data?.guidance === 'string' && data.guidance.length > 0);
}

group('Static UI & routing');
{
  const notFound = await req('/api/definitely-not-here');
  check('unknown API route = 404 JSON', notFound.status === 404 && !!notFound.data?.error);

  const spa = await fetch(BASE + '/');
  const html = await spa.text();
  check('GET / serves HTML', spa.status === 200 && html.includes('<!DOCTYPE html>'));
  check('page has role switcher', html.includes('id="switcher"'));
  // Every script and stylesheet must be served by this server: no CDN, so the
  // app still works on a plane. Same-origin <script src> is fine.
  const externalRefs = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
    ...html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi),
  ]
    .map((m) => m[1])
    .filter((href) => !href.startsWith('/') && !href.startsWith('./'));
  check('no third-party script or style URLs', externalRefs.length === 0);
  check('page has no external stylesheets', !/<link[^>]+stylesheet/i.test(html));
  check('control room script is same-origin', html.includes('src="/settings.js"'));

  const deepLink = await fetch(BASE + '/some/spa/route');
  check('SPA fallback works for deep links', deepLink.status === 200);
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(58));
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} checks passed\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, \x1b[32m${passed} passed\x1b[0m`);
  for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
}
console.log('─'.repeat(58) + '\n');

process.exit(failed === 0 ? 0 : 1);
