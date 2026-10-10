/**
 * scripts/reseed.js — rebuild the database from scratch.
 *
 * Usage:  npm run seed            rebuild only if empty
 *         npm run seed -- --force wipe and regenerate the 100 students
 */

import {
  DEMO_PASSWORD,
  STAFF_ACCOUNTS,
  close,
  db,
  listDemoAccounts,
  paths,
  seed,
} from '../lib/db.js';

const force = process.argv.includes('--force') || process.argv.includes('-f');
const started = Date.now();

const result = seed({ force });
const studentCount = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

console.log('');
if (result.seeded) {
  console.log(`  \x1b[32m✓\x1b[0m Seeded ${result.students} students + ${STAFF_ACCOUNTS.length} staff`
    + `${force ? ' (forced rebuild)' : ''}`);
} else {
  console.log(`  \x1b[33m•\x1b[0m Database already populated (${result.reason}).`);
  console.log('    Run "npm run seed -- --force" to rebuild from scratch.');
}
console.log(`  users: ${userCount}   students: ${studentCount}`);
console.log(`  db:    ${paths.dbPath}`);
console.log(`  login: ${DEMO_PASSWORD}`);
for (const a of listDemoAccounts()) {
  console.log(`    ${a.role.padEnd(11)} ${a.email}`);
}
console.log(`\n  done in ${Date.now() - started}ms\n`);

close();
