/**
 * lib/log.js — leveled logging and the optional access log.
 *
 * Two settings control this and nothing else:
 *
 *   LOG_LEVEL    debug | info | warn | error | silent — the floor for every
 *                message. Read live, so changing it in the control room takes
 *                effect on the next line without a restart.
 *   LOG_REQUESTS true | false — one line per API request, written when the
 *                response finishes so the status code and duration are known.
 *
 * Values are read on every call rather than captured at import, because the
 * settings GUI writes straight into `process.env` for non-restart keys. The
 * cost is a couple of map lookups per line, which is noise next to a console
 * write.
 *
 * Request logging also keeps a small in-process tally, so `/api/system` can
 * report traffic without anyone having to tail a file.
 */

import { bool, get } from './settings.js';

/* ------------------------------------------------------------------ *
 * Levels
 * ------------------------------------------------------------------ */

const LEVELS = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });

const DEFAULT_LEVEL = 'info';

/** The current floor, resolved from LOG_LEVEL on every call. */
function threshold() {
  const raw = String(get('LOG_LEVEL', DEFAULT_LEVEL) || DEFAULT_LEVEL).trim().toLowerCase();
  return LEVELS[raw] ?? LEVELS[DEFAULT_LEVEL];
}

/** Is `level` at or above the configured floor? */
export function enabled(level) {
  return (LEVELS[level] ?? LEVELS.info) <= threshold();
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function debug(...args) {
  if (enabled('debug')) console.log(`[${stamp()}] debug`, ...args);
}

export function info(...args) {
  if (enabled('info')) console.log(`[${stamp()}] info `, ...args);
}

export function warn(...args) {
  if (enabled('warn')) console.warn(`[${stamp()}] warn `, ...args);
}

export function error(...args) {
  if (enabled('error')) console.error(`[${stamp()}] error`, ...args);
}

/* ------------------------------------------------------------------ *
 * Request tally
 * ------------------------------------------------------------------ */

const tally = {
  total: 0,
  inFlight: 0,
  byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  slowest: { method: null, path: null, ms: 0, at: null },
};

const CLASS_OF = (status) => `${Math.floor(status / 100)}xx`;

/** Snapshot for the system endpoint. Never includes paths or query strings. */
export function requestStats() {
  return {
    ...tally,
    byClass: { ...tally.byClass },
    slowest: { ...tally.slowest },
    logging: bool('LOG_REQUESTS', false),
    level: String(get('LOG_LEVEL', DEFAULT_LEVEL) || DEFAULT_LEVEL).toLowerCase(),
  };
}

/* ------------------------------------------------------------------ *
 * Access log
 * ------------------------------------------------------------------ */

/** Paths that would flood the log without telling anyone anything useful. */
const QUIET_PATHS = /^\/api\/health$/;

/**
 * Access-log middleware. Also counts every API request, whether or not logging
 * is switched on, so the tally is always populated.
 *
 * Registered early in the stack but deliberately after nothing that can reject:
 * it needs to see the final status code, including the 404 and error paths.
 */
export function requestLogger(req, res, next) {
  const isApi = req.path.startsWith('/api/');
  if (isApi) {
    tally.total += 1;
    tally.inFlight += 1;
  }

  let startedAt = 0;
  if (isApi && bool('LOG_REQUESTS', false) && !QUIET_PATHS.test(req.path)) {
    startedAt = process.hrtime.bigint();
  }

  res.on('finish', () => {
    if (!isApi) return;
    tally.inFlight = Math.max(0, tally.inFlight - 1);

    const cls = CLASS_OF(res.statusCode);
    if (cls in tally.byClass) tally.byClass[cls] += 1;

    if (!startedAt) return;

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // `originalUrl` keeps the query string, which carries the filter the caller
    // asked for and is the thing worth reading in an access log.
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`;

    if (ms > tally.slowest.ms) {
      tally.slowest = { method: req.method, path: req.path, ms: Math.round(ms), at: new Date().toISOString() };
    }

    if (res.statusCode >= 500) error(line);
    else if (res.statusCode >= 400) warn(line);
    else info(line);
  });

  next();
}

/** Reset the tally. Used by the test harness between runs. */
export function resetRequestStats() {
  tally.total = 0;
  tally.inFlight = 0;
  tally.byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  tally.slowest = { method: null, path: null, ms: 0, at: null };
}