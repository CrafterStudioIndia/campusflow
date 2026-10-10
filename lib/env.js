/**
 * lib/env.js — minimal .env loader. No dependency, no build step.
 *
 * Imported first by server.js so that every module sees the environment at
 * load time (lib/token.js derives its key at import).
 *
 * Rules:
 *   - real environment variables always win over the file
 *   - `#` starts a comment; blank lines ignored
 *   - optional `export ` prefix is tolerated
 *   - values may be quoted; \n inside double quotes becomes a newline
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function parse(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    if (!key) continue;

    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    out[key] = value;
  }
  return out;
}

export const envFile = process.env.CAMPUS_ENV_FILE || path.join(ROOT, '.env');

/** Parse an env file body into `{ KEY: value }`. Exported for lib/settings.js. */
export function readEnvFile(file = envFile) {
  return parse(fs.readFileSync(file, 'utf8'));
}

/** Absolute project root, so lib/settings.js can resolve the same .env. */
export const root = ROOT;

let loadedFrom = null;
try {
  const parsed = parse(fs.readFileSync(envFile, 'utf8'));
  let applied = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  if (applied > 0) loadedFrom = envFile;
} catch {
  // No .env is fine — the app runs on ambient environment variables alone.
}

export { loadedFrom };
