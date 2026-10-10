/**
 * lib/schema.js — the CampusFlow database schema, and the migration runner.
 *
 * Kept apart from lib/db.js so the DDL reads as one artefact: every table the
 * app relies on is declared once, here, and `migrate()` brings an older
 * campus.db forward to match — add a column, get the new table, keep the data.
 *
 * Migrations are additive and idempotent:
 *   - CREATE TABLE / CREATE INDEX IF NOT EXISTS
 *   - ALTER TABLE ADD COLUMN, but only when PRAGMA table_info says it is absent
 * so booting twice is a no-op and booting against last month's file just works.
 *
 * The runner takes the better-sqlite3 handle as an argument rather than
 * importing lib/db.js, which keeps the dependency one-way: db.js -> schema.js.
 */

/* ------------------------------------------------------------------ *
 * Table definitions
 * ------------------------------------------------------------------ */

export const TABLES = Object.freeze({
  /* ---- identity ------------------------------------------------- */
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL UNIQUE,
      password   TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      role       TEXT    NOT NULL CHECK (role IN ('ACCOUNTANT','TEACHER','STUDENT')),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,

  students: `
    CREATE TABLE IF NOT EXISTS students (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      roll_no     TEXT    NOT NULL UNIQUE,
      grade       INTEGER NOT NULL,
      section     TEXT    NOT NULL DEFAULT 'A',
      fee_due     REAL    NOT NULL DEFAULT 0,
      fee_paid    REAL    NOT NULL DEFAULT 0,
      attendance  REAL    NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      CHECK (fee_due  >= 0),
      CHECK (fee_paid >= 0),
      CHECK (attendance BETWEEN 0 AND 100)
    )`,

  /* ---- sessions, tokens, keys ----------------------------------- */
  sessions: `
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT    PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_agent    TEXT,
      ip            TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT    NOT NULL,
      revoked_at    TEXT,
      revoke_reason TEXT
    )`,

  refresh_tokens: `
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          TEXT    PRIMARY KEY,
      family_id   TEXT    NOT NULL,
      parent_id   TEXT    REFERENCES refresh_tokens(id) ON DELETE SET NULL,
      session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT    NOT NULL UNIQUE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT    NOT NULL,
      used_at     TEXT,
      revoked_at  TEXT,
      revoked_for TEXT,
      ip          TEXT,
      user_agent  TEXT
    )`,

  api_keys: `
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT    PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      prefix       TEXT    NOT NULL,
      key_hash     TEXT    NOT NULL UNIQUE,
      scopes       TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      expires_at   TEXT,
      revoked_at   TEXT
    )`,

  login_attempts: `
    CREATE TABLE IF NOT EXISTS login_attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT    NOT NULL,
      ip         TEXT,
      at         TEXT    NOT NULL DEFAULT (datetime('now')),
      ok         INTEGER NOT NULL DEFAULT 0,
      method     TEXT
    )`,

  audit_log: `
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT    NOT NULL DEFAULT (datetime('now')),
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor       TEXT,
      role        TEXT,
      action      TEXT    NOT NULL,
      target      TEXT,
      outcome     TEXT    NOT NULL DEFAULT 'ok',
      ip          TEXT,
      user_agent  TEXT,
      detail      TEXT
    )`,

  /* ---- academic -------------------------------------------------- */
  academic_terms: `
    CREATE TABLE IF NOT EXISTS academic_terms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT    NOT NULL UNIQUE,
      name       TEXT    NOT NULL,
      start_date TEXT    NOT NULL,
      end_date   TEXT    NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0
    )`,

  subjects: `
    CREATE TABLE IF NOT EXISTS subjects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT    NOT NULL UNIQUE,
      name       TEXT    NOT NULL,
      grade_from INTEGER NOT NULL,
      grade_to   INTEGER NOT NULL,
      credits    INTEGER NOT NULL DEFAULT 4
    )`,

  course_results: `
    CREATE TABLE IF NOT EXISTS course_results (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      term_id      INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
      score        REAL    NOT NULL,
      max_score    REAL    NOT NULL DEFAULT 100,
      letter       TEXT,
      verified     INTEGER NOT NULL DEFAULT 0,
      graded_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (student_id, subject_id, term_id),
      CHECK (score >= 0)
    )`,

  attendance_records: `
    CREATE TABLE IF NOT EXISTS attendance_records (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      term_id    INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
      day        TEXT    NOT NULL,
      status     TEXT    NOT NULL CHECK (status IN ('present','absent','late','excused')),
      UNIQUE (student_id, term_id, day)
    )`,

  /* ---- finance --------------------------------------------------- */
  invoices: `
    CREATE TABLE IF NOT EXISTS invoices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no   TEXT    NOT NULL UNIQUE,
      student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      term_id      INTEGER REFERENCES academic_terms(id) ON DELETE SET NULL,
      category     TEXT    NOT NULL DEFAULT 'tuition',
      amount_billed REAL   NOT NULL,
      amount_paid   REAL   NOT NULL DEFAULT 0,
      discount      REAL   NOT NULL DEFAULT 0,
      status        TEXT   NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','partial','settled','overdue','void')),
      issued_at     TEXT   NOT NULL DEFAULT (datetime('now')),
      due_date      TEXT   NOT NULL,
      settled_at    TEXT,
      notes         TEXT
    )`,

  payments: `
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_no  TEXT    NOT NULL UNIQUE,
      invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      amount      REAL    NOT NULL,
      method      TEXT    NOT NULL DEFAULT 'upi'
                  CHECK (method IN ('cash','upi','card','netbanking','cheque','scholarship')),
      reference   TEXT,
      paid_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      CHECK (amount > 0)
    )`,

  fee_installments: `
    CREATE TABLE IF NOT EXISTS fee_installments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      label      TEXT    NOT NULL,
      amount     REAL    NOT NULL,
      due_date   TEXT    NOT NULL,
      paid_at    TEXT,
      status     TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','overdue','waived'))
    )`,

  notifications: `
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL DEFAULT 'info',
      title      TEXT    NOT NULL,
      body       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      read_at    TEXT
    )`,

  /* ---- saved views (per-user dashboard state) ------------------- */
  saved_views: `
    CREATE TABLE IF NOT EXISTS saved_views (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      scope      TEXT    NOT NULL DEFAULT '',
      payload    TEXT    NOT NULL DEFAULT '{}',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, name)
    )`,
});

/* ------------------------------------------------------------------ *
 * Indexes
 * ------------------------------------------------------------------ */

export const INDEXES = Object.freeze([
  'CREATE INDEX IF NOT EXISTS idx_users_role         ON users(role)',
  'CREATE INDEX IF NOT EXISTS idx_students_grade      ON students(grade)',
  'CREATE INDEX IF NOT EXISTS idx_students_user       ON students(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires    ON sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_refresh_session     ON refresh_tokens(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_refresh_family      ON refresh_tokens(family_id)',
  'CREATE INDEX IF NOT EXISTS idx_refresh_user        ON refresh_tokens(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_api_keys_user       ON api_keys(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_audit_at            ON audit_log(at)',
  'CREATE INDEX IF NOT EXISTS idx_audit_action        ON audit_log(action)',
  'CREATE INDEX IF NOT EXISTS idx_results_student     ON course_results(student_id)',
  'CREATE INDEX IF NOT EXISTS idx_results_term        ON course_results(term_id)',
  'CREATE INDEX IF NOT EXISTS idx_attendance_student  ON attendance_records(student_id, day)',
  'CREATE INDEX IF NOT EXISTS idx_invoices_student     ON invoices(student_id)',
  'CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status)',
  'CREATE INDEX IF NOT EXISTS idx_payments_student    ON payments(student_id)',
  'CREATE INDEX IF NOT EXISTS idx_installments_stud   ON fee_installments(student_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user  ON notifications(user_id, read_at)',
  // Partial, because legacy rows have no key and must not collide.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key)'
    + ' WHERE dedupe_key IS NOT NULL',
]);

/* ------------------------------------------------------------------ *
 * Column additions for databases created by an earlier version
 * ------------------------------------------------------------------ */

/** table -> columns added after 1.0, with their SQL fragment. */
export const ADDED_COLUMNS = Object.freeze({
  users: [
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['title', "TEXT NOT NULL DEFAULT ''"],
    ['phone', "TEXT NOT NULL DEFAULT ''"],
    ['avatar', "TEXT NOT NULL DEFAULT ''"],
    ['mfa_secret', 'TEXT'],
    ['mfa_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['mfa_recovery', 'TEXT'],
    ['failed_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['password_changed_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ],
  students: [
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['category', "TEXT NOT NULL DEFAULT 'general'"],
    ['dob', 'TEXT'],
    ['admission_date', 'TEXT'],
    ['guardian_name', "TEXT NOT NULL DEFAULT ''"],
    ['guardian_phone', "TEXT NOT NULL DEFAULT ''"],
    ['blood_group', "TEXT NOT NULL DEFAULT ''"],
    ['previous_school', "TEXT NOT NULL DEFAULT ''"],
    ['notes', "TEXT NOT NULL DEFAULT ''"],
    ['updated_at', 'TEXT'],
  ],
  // Notifications are regenerated from live state, so they need a stable key
  // to be idempotent and a target for the UI to link to.
  notifications: [
    ['dedupe_key', 'TEXT'],
    ['link', 'TEXT'],
  ],
});

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

const isoNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Column names currently present on a table. */
export function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name));
}

/**
 * Bring the database up to the current schema.
 * @param {import('better-sqlite3').Database} db
 * @returns {{created: string[], added: string[], indexes: number, at: string}}
 */
export function migrate(db) {
  const created = [];
  for (const [name, ddl] of Object.entries(TABLES)) {
    const existed = columnsOf(db, name).size > 0;
    db.exec(ddl);
    if (!existed) created.push(name);
  }

  const added = [];
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const present = columnsOf(db, table);
    for (const [name, fragment] of columns) {
      if (present.has(name)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${fragment}`);
        added.push(`${table}.${name}`);
      } catch {
        // A column that cannot be added (already there under a different type)
        // is not fatal — the rest of the migration still applies.
      }
    }
  }

  let indexes = 0;
  for (const statement of INDEXES) {
    try {
      db.exec(statement);
      indexes += 1;
    } catch {
      /* index already exists under a different definition */
    }
  }

  // A single current term, so the academic tables always have a home.
  if (columnsOf(db, 'academic_terms').size > 0) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM academic_terms').get().n;
    if (n === 0) {
      db.exec(`
        INSERT INTO academic_terms (code, name, start_date, end_date, is_current) VALUES
          ('2026-T1', 'Term 1 · Apr–Sep 2026', '2026-04-01', '2026-09-30', 1),
          ('2026-T2', 'Term 2 · Oct 2026–Mar 2027', '2026-10-01', '2027-03-31', 0)
      `);
    }
  }

  return { created, added, indexes, at: isoNow() };
}

/**
 * Row counts for every user-facing table, for the settings GUI and for
 * `npm run seed -- --stats`.
 * @param {import('better-sqlite3').Database} db
 */
export function tableStats(db) {
  return Object.keys(TABLES).map((name) => {
    let rows = 0;
    let columns = 0;
    try {
      rows = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
      columns = db.prepare(`PRAGMA table_info(${name})`).all().length;
    } catch {
      rows = 0;
    }
    return { table: name, rows, columns };
  });
}
