/**
 * lib/settings.js — the single source of truth for configuration.
 *
 * Every knob the app understands is declared once in SCHEMA below. That
 * declaration drives three things at once, so they can never drift apart:
 *
 *   1. reading the effective value (process env > .env file > declared default)
 *   2. validating and writing values back to the .env file
 *   3. the settings GUI in public/settings.js, which renders straight from here
 *
 * The .env file is written structurally: one `KEY=value` per line, blank line
 * between sections, no comments — a clean, diff-friendly, machine-editable
 * file. Keys the schema does not know about are preserved verbatim in their
 * original position at the end of the file, so hand-added variables survive a
 * save from the GUI.
 *
 * Secrets (type 'secret') are never sent to the browser in the clear: the API
 * returns a mask plus a `configured` flag, and a write only replaces the value
 * when a non-empty value is supplied.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envFile, readEnvFile, root } from './env.js';

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * item.type:
 *   string | secret | int | float | bool | enum
 *
 * `restart: true` marks values that are read at import time, so a change only
 * takes effect after the process is restarted — the GUI badges those.
 */
export const SCHEMA = Object.freeze([
  {
    id: 'server',
    title: 'Server',
    blurb: 'Where the API listens and how it is served.',
    items: [
      { key: 'PORT', label: 'Port', type: 'int', def: 3000, min: 1, max: 65535, restart: true },
      { key: 'HOST', label: 'Bind address', type: 'string', def: '0.0.0.0', restart: true },
      { key: 'NODE_ENV', label: 'Environment', type: 'enum', def: 'development',
        options: ['development', 'production', 'test'] },
      { key: 'TRUST_PROXY', label: 'Trust X-Forwarded-*', type: 'bool', def: false },
      { key: 'CORS_ORIGIN', label: 'Allowed CORS origin', type: 'string', def: '',
        hint: 'Blank = same-origin only.' },
    ],
  },
  {
    id: 'providers',
    title: 'AI providers',
    blurb: 'Two keys. Gemini is primary for gemini-* models, Zen backs it up and '
      + 'supplies everything else. Model lists are discovered from each key.',
    items: [
      { key: 'GEMINI_API_KEY', label: 'Gemini API key', type: 'secret', def: '',
        hint: 'Primary. aistudio.google.com/apikey — serves every gemini-* model it lists.' },
      { key: 'OPENCODE_ZEN_API_KEY', label: 'OpenCode Zen API key', type: 'secret', def: '',
        hint: 'Backup. https://opencode.ai/auth — serves 80+ models; used when Gemini is '
          + 'missing, out of quota, or for non-Gemini models.' },
      { key: 'AI_PROVIDER_ORDER', label: 'Provider priority', type: 'enum', def: 'auto',
        options: ['auto', 'gemini-first', 'zen-first', 'gemini-only', 'zen-only'],
        hint: 'Which key to try first, and whether the other may take over when one is '
          + 'throttled or missing. Applies immediately — no restart.' },
      { key: 'OPENCODE_ZEN_URL', label: 'Zen gateway URL', type: 'string',
        def: 'https://opencode.ai/zen/v1', restart: true,
        hint: 'Point at a proxy or a self-hosted gateway here.' },
    ],
  },
  {
    id: 'routing',
    title: 'Model routing',
    blurb: 'Models are discovered per key and ranked into fast and deep chains — '
      + 'nothing to type here.',
    items: [
      { key: 'AI_TIER', label: 'Default tier', type: 'enum', def: 'fast',
        options: ['fast', 'deep'], restart: true },
      { key: 'AI_MODEL_CHAIN', label: 'Pin a model chain', type: 'string', def: '',
        restart: true,
        hint: 'Blank = use the discovered ranking. Otherwise provider:model entries, e.g. '
          + 'gemini:gemini-3.8-flash,zen:kimi-k3.' },
      { key: 'AI_TIMEOUT_MS', label: 'Request timeout (ms)', type: 'int', def: 25000,
        min: 1000, max: 120000, restart: true },
      { key: 'AI_CACHE_TTL_MS', label: 'Cache TTL (ms)', type: 'int', def: 300000,
        min: 0, max: 3600000, restart: true },
      { key: 'AI_DISCOVERY_TTL_MS', label: 'Catalogue refresh (ms)', type: 'int', def: 900000,
        min: 60000, max: 86400000, restart: true,
        hint: 'How often the provider model lists are re-read.' },
      { key: 'AI_RATE_LIMIT_COOLDOWN_MS', label: 'Rate-limit cooldown (ms)', type: 'int',
        def: 60000, min: 1000, max: 3600000, restart: true,
        hint: 'How long a 429-throttled key is parked before the other provider is tried.' },
    ],
  },
  {
    id: 'tokens',
    title: 'Tokens & sessions',
    blurb: 'Signing key, access-token lifetime and refresh rotation.',
    items: [
      { key: 'TOKEN_SECRET', label: 'Token signing secret', type: 'secret', def: '', restart: true,
        hint: 'Blanks fall back to .token-secret. Changing it signs everyone out.' },
      { key: 'TOKEN_TTL_SECONDS', label: 'Access token TTL (s)', type: 'int', def: 28800,
        min: 60, max: 86400, restart: true },
      { key: 'TOKEN_ISSUER', label: 'Token issuer', type: 'string', def: 'campusflow', restart: true },
      { key: 'TOKEN_AUDIENCE', label: 'Token audience', type: 'string', def: 'campusflow-web',
        restart: true },
      { key: 'TOKEN_REFRESH_TTL_SECONDS', label: 'Refresh token TTL (s)', type: 'int',
        def: 1209600, min: 300, max: 31536000 },
    ],
  },
  {
    id: 'cookies',
    title: 'Cookies',
    blurb: 'HttpOnly cookie transport so the browser never touches the raw token.',
    items: [
      { key: 'TOKEN_COOKIE_NAME', label: 'Session cookie', type: 'string', def: 'cf_session' },
      { key: 'TOKEN_COOKIE_REFRESH_NAME', label: 'Refresh cookie', type: 'string', def: 'cf_refresh' },
      { key: 'TOKEN_COOKIE_SECURE', label: 'Secure flag', type: 'bool', def: false,
        hint: 'Turn on whenever the app is served over HTTPS.' },
      { key: 'TOKEN_COOKIE_SAMESITE', label: 'SameSite', type: 'enum', def: 'lax',
        options: ['strict', 'lax', 'none'] },
      { key: 'TOKEN_COOKIE_DOMAIN', label: 'Cookie domain', type: 'string', def: '',
        hint: 'Blank = host-only.' },
      { key: 'TOKEN_COOKIE_PATH', label: 'Cookie path', type: 'string', def: '/' },
    ],
  },
  {
    id: 'auth',
    title: 'Authentication policy',
    blurb: 'Lockout, MFA, personal access tokens and CSRF.',
    items: [
      { key: 'AUTH_MAX_LOGIN_ATTEMPTS', label: 'Failed tries before lockout', type: 'int',
        def: 8, min: 1, max: 100 },
      { key: 'AUTH_LOCKOUT_MS', label: 'Lockout duration (ms)', type: 'int', def: 900000,
        min: 0, max: 86400000 },
      { key: 'AUTH_THROTTLE_WINDOW_MS', label: 'Throttle window (ms)', type: 'int', def: 60000,
        min: 1000, max: 3600000, restart: true },
      { key: 'AUTH_THROTTLE_MAX', label: 'Logins per window', type: 'int', def: 40,
        min: 1, max: 1000, restart: true },
      { key: 'AUTH_REQUIRE_MFA', label: 'Require MFA for everyone', type: 'bool', def: false },
      { key: 'AUTH_MFA_ISSUER', label: 'MFA issuer label', type: 'string', def: 'CampusFlow' },
      { key: 'AUTH_MFA_TOTP_STEP', label: 'TOTP step (s)', type: 'int', def: 30, min: 15, max: 120 },
      { key: 'AUTH_MFA_TOTP_DIGITS', label: 'TOTP digits', type: 'int', def: 6, min: 6, max: 8 },
      { key: 'AUTH_API_KEY_PREFIX', label: 'API key prefix', type: 'string', def: 'cf_live' },
      { key: 'AUTH_API_KEY_TTL_SECONDS', label: 'API key TTL (s, 0 = never)', type: 'int',
        def: 0, min: 0, max: 31536000 },
      { key: 'AUTH_CSRF_ENABLED', label: 'CSRF double-submit', type: 'bool', def: true },
      { key: 'AUTH_CSRF_HEADER', label: 'CSRF header name', type: 'string', def: 'x-csrf-token' },
      { key: 'AUTH_AUDIT_RETENTION_DAYS', label: 'Audit retention (days)', type: 'int', def: 90,
        min: 1, max: 3650 },
      { key: 'ALLOW_ONE_CLICK_LOGIN', label: 'One-click demo login', type: 'bool', def: true,
        hint: 'Off = email + password only. The switcher in the UI then dies.' },
    ],
  },
  {
    id: 'data',
    title: 'Data & observability',
    blurb: 'Where state lives and how much noise the server prints.',
    items: [
      { key: 'CAMPUS_DB_PATH', label: 'SQLite path', type: 'string', def: '',
        hint: 'Blank = ./campus.db. Only change before the first boot.' },
      { key: 'CAMPUS_ENV_FILE', label: 'Env file path', type: 'string', def: '', restart: true,
        hint: 'Blank = ./.env' },
      { key: 'LOG_LEVEL', label: 'Log level', type: 'enum', def: 'info',
        options: ['debug', 'info', 'warn', 'error', 'silent'] },
      { key: 'LOG_REQUESTS', label: 'Log every request', type: 'bool', def: false },
      { key: 'RATE_LIMIT_WINDOW_MS', label: 'Global rate window (ms)', type: 'int', def: 60000,
        min: 1000, max: 3600000 },
      { key: 'RATE_LIMIT_MAX', label: 'Global requests per window', type: 'int', def: 600,
        min: 10, max: 100000 },
    ],
  },
]);

/** Flat index: KEY -> { item, section }. */
const INDEX = new Map();
for (const section of SCHEMA) {
  for (const item of section.items) INDEX.set(item.key, { item, section });
}

export const KEYS = Object.freeze([...INDEX.keys()]);

/* ------------------------------------------------------------------ *
 * Coercion
 * ------------------------------------------------------------------ */

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off', 'disabled']);

export function toBool(value, def = false) {
  if (value === undefined || value === null) return def;
  const s = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return def;
}

export function toNumber(value, def = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : def;
}

/**
 * Validate + normalise one incoming value against its schema item.
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function coerce(item, raw) {
  if (raw === null || raw === undefined) return { ok: false, error: 'value is required' };

  switch (item.type) {
    case 'int':
    case 'float': {
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n)) return { ok: false, error: 'must be a number' };
      if (item.type === 'int' && !Number.isInteger(n)) {
        return { ok: false, error: 'must be a whole number' };
      }
      if (item.min !== undefined && n < item.min) {
        return { ok: false, error: `must be at least ${item.min}` };
      }
      if (item.max !== undefined && n > item.max) {
        return { ok: false, error: `must be at most ${item.max}` };
      }
      return { ok: true, value: String(n) };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw ? 'true' : 'false' };
      const s = String(raw).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return { ok: true, value: 'true' };
      if (FALSE_WORDS.has(s)) return { ok: true, value: 'false' };
      return { ok: false, error: 'must be true or false' };
    }
    case 'enum': {
      const s = String(raw).trim();
      if (!item.options.includes(s)) {
        return { ok: false, error: `must be one of: ${item.options.join(', ')}` };
      }
      return { ok: true, value: s };
    }
    default: {
      const s = String(raw).trim();
      if (s.includes('\n')) return { ok: false, error: 'must be a single line' };
      if (item.maxLength && s.length > item.maxLength) {
        return { ok: false, error: `must be ${item.maxLength} characters or fewer` };
      }
      return { ok: true, value: s };
    }
  }
}

/** Read an env value the way the running process sees it (post-defaults). */
export function get(key, def) {
  const entry = INDEX.get(key);
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;
  if (def !== undefined) return def;
  return entry ? entry.item.def : undefined;
}

export function num(key, fallback = 0) {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(key, fallback = false) {
  return toBool(process.env[key], fallback);
}

export function list(key, fallback = []) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
}

/* ------------------------------------------------------------------ *
 * Reading the file
 * ------------------------------------------------------------------ */

/**
 * Keys present in the .env file, in file order.
 * @returns {{order: string[], values: Record<string,string>, exists: boolean, path: string}}
 */
export function readFile() {
  const order = [];
  const values = {};
  let exists = true;
  try {
    const parsed = readEnvFile(envFile);
    for (const [k, v] of Object.entries(parsed)) {
      if (!values[k]) order.push(k);
      values[k] = v;
    }
  } catch {
    exists = false;
  }
  return { order, values, exists, path: envFile };
}

/** Show only the tail of a secret — enough to recognise, useless to an attacker. */
export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${'*'.repeat(Math.min(16, s.length - 4))}${s.slice(-4)}`;
}

/**
 * Full settings view for the GUI: every declared key with its effective value,
 * where that value came from, and whether a restart is needed to apply it.
 * Secret values are masked; the raw value never leaves the process.
 */
export function readAll() {
  const file = readFile();

  const sections = SCHEMA.map((section) => ({
    id: section.id,
    title: section.title,
    blurb: section.blurb,
    items: section.items.map((item) => {
      const inProcess = Object.prototype.hasOwnProperty.call(process.env, item.key)
        && process.env[item.key] !== undefined;
      const inFile = Object.prototype.hasOwnProperty.call(file.values, item.key);
      const effective = inProcess
        ? process.env[item.key]
        : (inFile ? file.values[item.key] : item.def);

      const source = inProcess && inFile && process.env[item.key] !== file.values[item.key]
        ? 'process'
        : (inFile ? 'file' : (inProcess ? 'process' : 'default'));

      const changed = Object.prototype.hasOwnProperty.call(file.values, item.key)
        && file.values[item.key] !== String(effective);

      const base = {
        key: item.key,
        label: item.label,
        type: item.type,
        hint: item.hint || null,
        restart: Boolean(item.restart),
        options: item.options || null,
        min: item.min ?? null,
        max: item.max ?? null,
        default: item.def,
        source,
        overridden: source === 'process',
        inFile,
        drift: changed,
        // What the file on disk holds. For a restart-flagged key this differs
        // from `value` until the process is restarted, so a control room has to
        // be able to tell "you never set it" from "you set it and it is
        // waiting for a restart" — otherwise a saved change looks like a no-op.
        fileValue: inFile ? file.values[item.key] : null,
      };

      if (item.type === 'secret') {
        const configured = Boolean(effective);
        return {
          ...base,
          // Never expose the file's own text for a secret — the whole point of
          // `fileValue` is to let a control room show what is saved on disk, and
          // for a credential that would hand the secret to the browser.
          fileValue: null,
          value: '',
          masked: mask(effective),
          configured,
          display: configured ? mask(effective) : '(not set)',
        };
      }

      return { ...base, value: effective ?? '', configured: true };
    }),
  }));

  const unknown = file.order.filter((k) => !INDEX.has(k));

  return {
    file: { path: file.path, exists: file.exists, keys: file.order.length, bytes: fileSize() },
    sections,
    unknown,
    restartRequired: sections.some((s) => s.items.some((i) => i.drift && i.restart)),
  };
}

function fileSize() {
  try {
    return fs.statSync(envFile).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Writing the file
 * ------------------------------------------------------------------ */

const needsQuotes = (v) => v === '' || /[\s#"'\\]/.test(v);
const render = (k, v) => `${k}=${needsQuotes(v) ? `"${v.replace(/"/g, '\\"')}"` : v}`;

/**
 * Render the whole file from the schema, then append any keys the schema does
 * not know about (preserved verbatim from the previous file).
 * @returns {string}
 */
export function renderFile(values, extraOrder = []) {
  const blocks = [];

  for (const section of SCHEMA) {
    const lines = section.items
      .map((item) => render(item.key, values[item.key] ?? String(item.def)))
      .join('\n');
    blocks.push(lines);
  }

  const known = new Set(INDEX.keys());
  const extras = extraOrder.filter((k) => !known.has(k));
  if (extras.length) {
    blocks.push(extras.map((k) => render(k, values[k] ?? '')).join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Validate and persist a batch of updates.
 *
 * An update is `{ key, value, clear? }`:
 *   - `clear: true`  writes an empty value (for secrets: un-configure)
 *   - omitted `value` on a secret means "leave unchanged" (the GUI never sees
 *     the real value, so it cannot echo it back)
 *
 * Non-restart values are applied to `process.env` immediately. Restart-class
 * values are written to the file only, and the response tells the caller which
 * ones are waiting for a restart.
 *
 * @returns {{ok: boolean, error?: string, applied: string[], pendingRestart: string[], file: object}}
 */
export function writeAll(updates, { file = envFile } = {}) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, error: 'no updates supplied', applied: [], pendingRestart: [] };
  }

  const current = readFile();
  const next = { ...current.values };
  const applied = [];
  const pendingRestart = [];
  const errors = [];

  for (const update of updates) {
    const entry = INDEX.get(String(update?.key ?? ''));
    if (!entry) {
      errors.push(`${update?.key}: unknown setting`);
      continue;
    }
    const { item } = entry;

    if (item.type === 'secret' && update.value === undefined && !update.clear) {
      continue; // untouched
    }

    let value = update.clear ? '' : String(update.value ?? '');

    if (item.type === 'secret' && !value) {
      next[item.key] = '';
    } else {
      const result = coerce(item, value);
      if (!result.ok) {
        errors.push(`${item.key}: ${result.error}`);
        continue;
      }
      value = result.value;
    }

    next[item.key] = value;
    applied.push(item.key);

    if (item.restart) {
      pendingRestart.push(item.key);
    } else {
      applyToProcess(item.key, value);
    }
  }

  if (errors.length) {
    return { ok: false, error: errors.join('; '), applied, pendingRestart };
  }

  const body = renderFile(next, current.order);
  fs.writeFileSync(file, body, { mode: 0o600 });

  return {
    ok: true,
    applied,
    pendingRestart,
    restartRequired: pendingRestart.length > 0,
    file: { path: file, bytes: Buffer.byteLength(body) },
  };
}

function applyToProcess(key, value) {
  if (value === '') delete process.env[key];
  else process.env[key] = value;
}

/**
 * Mint a fresh 384-bit token secret, write it to the .env file and swap it in
 * for this process so the change is live immediately. Existing sessions and
 * refresh tokens are invalidated by definition — that is the point of rotating.
 */
export function rotateTokenSecret() {
  const secret = crypto.randomBytes(48).toString('base64url');
  const result = writeAll([{ key: 'TOKEN_SECRET', value: secret }]);
  return { ...result, rotated: result.ok, secret };
}

/** Absolute path of the env file being managed. */
export const envPath = path.resolve(root, envFile);
