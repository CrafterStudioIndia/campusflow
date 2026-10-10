#!/usr/bin/env node
/**
 * Parse every JavaScript file the browser and the server actually run.
 *
 * `node --check` is only ever as good as the list of files it is handed, and a
 * hand-maintained list is how a template-literal typo in public/settings.js
 * reaches production: the API suites pass because they never load that file.
 * The inline <script> block in public/index.html is the other blind spot — it
 * is not a file on disk, so nothing checks it either.
 *
 * So: walk the tree, check every .js, then extract the inline scripts from the
 * HTML and check those too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP = new Set(['node_modules', '.git', 'data', 'coverage', '.cache']);
const problems = [];
let checked = 0;

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function check(label, source) {
  const tmp = path.join('/tmp', `cf-check-${process.pid}-${checked}.js`);
  fs.writeFileSync(tmp, source);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = String(err.stderr || err.message)
      .split('\n')
      .filter((l) => l.trim() && !l.includes('/tmp/cf-check-'))
      .slice(0, 4)
      .join('\n');
    problems.push(`${path.relative(root, label) || label}\n${detail.replace(new RegExp(tmp, 'g'), '')}`);
  } finally {
    fs.unlinkSync(tmp);
  }
  checked += 1;
}

for (const file of jsFiles(root)) check(file, fs.readFileSync(file, 'utf8'));

// Inline scripts in the served HTML are part of the app but have no filename.
for (const page of ['index.html', 'settings.html']) {
  const full = path.join(root, 'public', page);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  inline.forEach((m, i) => check(`public/${page}#script[${i}]`, m[1]));
  if (!inline.length) problems.push(`public/${page}: expected at least one inline script, found none`);
}

console.log(`\n\x1b[1mParse check\x1b[0m`);
console.log(`───────────────────────────────────────────────────────────`);
if (problems.length) {
  for (const p of problems) console.log(`\x1b[31m✗\x1b[0m ${p}`);
  console.log(`\x1b[31m✗ ${problems.length} file(s) failed to parse\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m✓ ${checked} scripts parse\x1b[0m`);
console.log('───────────────────────────────────────────────────────────\n');