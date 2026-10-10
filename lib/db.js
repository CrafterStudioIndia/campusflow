/**
 * lib/db.js — SQLite persistence layer for CampusFlow.
 *
 * Uses better-sqlite3 in synchronous mode: every query here is a prepared
 * statement executed inline, which is the fastest correct pattern for SQLite
 * and keeps the request handlers free of async plumbing.
 *
 * The dataset is seeded deterministically (fixed PRNG seed) so that every
 * judge, every machine and every restart sees identical numbers. Re-running
 * the seeder on a populated database is a no-op unless `force` is set.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './token.js';
import { migrate, tableStats } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.CAMPUS_DB_PATH || path.join(ROOT, 'campus.db');

export const ROLES = Object.freeze({
  ACCOUNTANT: 'ACCOUNTANT',
  TEACHER: 'TEACHER',
  STUDENT: 'STUDENT',
});

export const DEMO_PASSWORD = 'campus123';

export const STAFF_ACCOUNTS = Object.freeze([
  {
    email: 'accounts@campusflow.edu',
    name: 'Meera Raghunathan',
    role: ROLES.ACCOUNTANT,
  },
  {
    email: 'teacher@campusflow.edu',
    name: 'Aditya Sharma',
    role: ROLES.TEACHER,
  },
]);

/* ------------------------------------------------------------------ *
 * Deterministic PRNG
 * ------------------------------------------------------------------ */

/** mulberry32 — small, fast, and stable across Node versions. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const round2 = (n) => Math.round(n * 100) / 100;

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Vihaan', 'Diya', 'Arjun', 'Isha', 'Kabir', 'Meera',
  'Rohan', 'Saanvi', 'Aditya', 'Nisha', 'Karan', 'Priya', 'Rahul', 'Tara',
  'Devansh', 'Ira', 'Yash', 'Neha', 'Siddharth', 'Kavya', 'Manav', 'Riya',
  'Aisha', 'Varun', 'Sneha', 'Nikhil', 'Pooja', 'Aman', 'Sanjana', 'Harsh',
  'Anjali', 'Vivek', 'Swara', 'Gaurav', 'Lakshmi', 'Naveen', 'Trisha', 'Omkar',
  'Deepika', 'Farhan', 'Ritika', 'Siddharth', 'Zoya', 'Manoj', 'Aparna', 'Rudra',
  'Simran', 'Karthik', 'Nandini', 'Imran', 'Shreya', 'Bharat', 'Aditi', 'Pranav',
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Kapoor', 'Banerjee',
  'Chatterjee', 'Deshmukh', 'Kulkarni', 'Menon', 'Rao', 'Joshi', 'Malhotra',
  'Bhattacharya', 'Chauhan', 'Ghosh', 'Pillai', 'Sinha', 'Thakur', 'Vyas',
];

const SECTIONS = ['A', 'B', 'C', 'D'];

/* ------------------------------------------------------------------ *
 * Connection + schema
 * ------------------------------------------------------------------ */

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** What the last boot had to add to bring this file up to date. */
export const migration = migrate(db);

/* ------------------------------------------------------------------ *
 * Prepared statements
 * ------------------------------------------------------------------ */

const S = {
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countStudents: db.prepare('SELECT COUNT(*) AS n FROM students'),
  insertUser: db.prepare(
    `INSERT INTO users (email, password, name, role) VALUES (@email, @password, @name, @role)`,
  ),
  insertStudent: db.prepare(
    `INSERT INTO students (user_id, roll_no, grade, section, fee_due, fee_paid, attendance,
                           category, admission_date, dob, guardian_name, guardian_phone,
                           blood_group, previous_school)
     VALUES (@user_id, @roll_no, @grade, @section, @fee_due, @fee_paid, @attendance,
             @category, @admission_date, @dob, @guardian_name, @guardian_phone,
             @blood_group, @previous_school)`,
  ),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  firstUserByRole: db.prepare(
    `SELECT * FROM users WHERE role = ? ORDER BY id ASC LIMIT 1`,
  ),
  studentByUserId: db.prepare(
    `SELECT s.*, u.name, u.email, u.role
       FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ?`,
  ),
  allStudents: db.prepare(`
    SELECT s.id, s.user_id, s.roll_no, s.grade, s.section,
           s.fee_due, s.fee_paid, s.attendance,
           u.name, u.email,
           (s.fee_due - s.fee_paid) AS balance
      FROM students s JOIN users u ON u.id = s.user_id
     ORDER BY s.grade ASC, s.roll_no ASC
  `),
  rosterByGrade: db.prepare(`
    SELECT s.id, s.user_id, s.roll_no, s.grade, s.section,
           s.fee_due, s.fee_paid, s.attendance, u.name, u.email,
           (s.fee_due - s.fee_paid) AS balance
      FROM students s JOIN users u ON u.id = s.user_id
     WHERE s.grade = @grade
     ORDER BY s.roll_no ASC
  `),
  distinctGrades: db.prepare(
    'SELECT DISTINCT grade FROM students ORDER BY grade ASC',
  ),

  /* ---- academic -------------------------------------------------- */
  allTerms: db.prepare('SELECT * FROM academic_terms ORDER BY start_date DESC'),
  currentTerm: db.prepare('SELECT * FROM academic_terms WHERE is_current = 1 LIMIT 1'),
  allSubjects: db.prepare('SELECT * FROM subjects ORDER BY code'),
  resultsForStudent: db.prepare(`
    SELECT r.*, s.name AS subject, s.code AS subject_code
      FROM course_results r JOIN subjects s ON s.id = r.subject_id
     WHERE r.student_id = @student_id
     ORDER BY r.term_id DESC, s.name ASC`),
  resultsForGrade: db.prepare(`
    SELECT s.name AS subject, COUNT(*) AS students, ROUND(AVG(r.score), 2) AS average,
           MIN(r.score) AS lowest, MAX(r.score) AS highest
      FROM course_results r
      JOIN subjects s ON s.id = r.subject_id
      JOIN students st ON st.id = r.student_id
     WHERE st.grade = @grade
     GROUP BY s.id ORDER BY s.name`),
  attendanceForStudent: db.prepare(`
    SELECT a.day, a.status FROM attendance_records a
     WHERE a.student_id = @student_id
     ORDER BY a.day DESC LIMIT @limit`),
  attendanceBreakdown: db.prepare(`
    SELECT a.status, COUNT(*) AS n FROM attendance_records a
      JOIN students st ON st.id = a.student_id
     WHERE st.grade = @grade GROUP BY a.status`),
  /** One row per student in scope, left-joined to whatever was filed for @day. */
  attendanceSheet: db.prepare(`
    SELECT st.id, st.roll_no, st.grade, st.section, st.attendance, u.name,
           a.status, a.day
      FROM students st
      JOIN users u ON u.id = st.user_id
      LEFT JOIN attendance_records a
        ON a.student_id = st.id AND a.day = @day AND a.term_id = @term_id
     WHERE (@grade = 0 OR st.grade = @grade)
     ORDER BY st.grade ASC, st.roll_no ASC`),
  attendanceTallies: db.prepare(`
    SELECT a.status, COUNT(*) AS n FROM attendance_records a
      JOIN students st ON st.id = a.student_id
     WHERE a.day = @day AND a.term_id = @term_id
       AND (@grade = 0 OR st.grade = @grade)
     GROUP BY a.status`),
  attendanceRecentDays: db.prepare(`
    SELECT DISTINCT a.day FROM attendance_records a
      JOIN students st ON st.id = a.student_id
     WHERE (@grade = 0 OR st.grade = @grade)
     ORDER BY a.day DESC LIMIT @limit`),
  upsertAttendance: db.prepare(`
    INSERT INTO attendance_records (student_id, term_id, day, status)
    VALUES (@student_id, @term_id, @day, @status)
    ON CONFLICT (student_id, term_id, day) DO UPDATE SET status = excluded.status`),
  clearAttendance: db.prepare(
    'DELETE FROM attendance_records WHERE student_id = @student_id AND term_id = @term_id AND day = @day'),
  attendanceTotals: db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN status = 'late'    THEN 1 ELSE 0 END) AS late,
      SUM(CASE WHEN status = 'absent'  THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) AS excused
    FROM attendance_records WHERE student_id = @student_id`),
  writeAttendancePct: db.prepare('UPDATE students SET attendance = @attendance WHERE id = @id'),

  /* ---- finance --------------------------------------------------- */
  invoicesForStudent: db.prepare(`
    SELECT * FROM invoices WHERE student_id = @student_id
     ORDER BY issued_at DESC, id DESC`),
  paymentsForStudent: db.prepare(`
    SELECT p.*, i.invoice_no FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
     WHERE p.student_id = @student_id
     ORDER BY p.paid_at DESC, p.id DESC`),
  ledgerPage: db.prepare(`
    SELECT p.id, p.receipt_no, p.amount, p.method, p.paid_at, p.reference,
           i.invoice_no, i.category,
           st.id AS student_id, st.roll_no, u.name AS student_name, st.grade
      FROM payments p
      JOIN invoices i  ON i.id = p.invoice_id
      JOIN students st ON st.id = p.student_id
      JOIN users u     ON u.id = st.user_id
     WHERE (@method = '' OR p.method = @method)
       AND (@from = ''   OR p.paid_at >= @from)
       AND (@to = ''     OR p.paid_at <= @to)
     ORDER BY p.paid_at DESC, p.id DESC
     LIMIT @limit OFFSET @offset`),
  ledgerCount: db.prepare(`
    SELECT COUNT(*) AS n FROM payments p
      JOIN invoices i  ON i.id = p.invoice_id
     WHERE (@method = '' OR p.method = @method)
       AND (@from = ''   OR p.paid_at >= @from)
       AND (@to = ''     OR p.paid_at <= @to)`),
  collectionByMethod: db.prepare(
    'SELECT method, COUNT(*) AS payments, ROUND(SUM(amount), 2) AS total FROM payments GROUP BY method',
  ),
  invoiceAging: db.prepare(`
    SELECT
      SUM(CASE WHEN julianday('now') - julianday(due_date) <= 0  THEN amount_billed - amount_paid ELSE 0 END) AS current_due,
      SUM(CASE WHEN julianday('now') - julianday(due_date) BETWEEN 1  AND 30 THEN amount_billed - amount_paid ELSE 0 END) AS d1_30,
      SUM(CASE WHEN julianday('now') - julianday(due_date) BETWEEN 31 AND 60 THEN amount_billed - amount_paid ELSE 0 END) AS d31_60,
      SUM(CASE WHEN julianday('now') - julianday(due_date) BETWEEN 61 AND 90 THEN amount_billed - amount_paid ELSE 0 END) AS d61_90,
      SUM(CASE WHEN julianday('now') - julianday(due_date) > 90 THEN amount_billed - amount_paid ELSE 0 END) AS over_90
    FROM invoices WHERE status <> 'void'`),
  installmentsForStudent: db.prepare(
    'SELECT * FROM fee_installments WHERE student_id = @student_id ORDER BY due_date ASC',
  ),
  overdueInstallments: db.prepare(`
    SELECT fi.*, u.name AS student_name, st.roll_no, st.grade
      FROM fee_installments fi
      JOIN students st ON st.id = fi.student_id
      JOIN users u     ON u.id = st.user_id
     WHERE fi.status IN ('pending','overdue') AND fi.due_date < date('now')
     ORDER BY fi.due_date ASC LIMIT @limit`),

  /* ---- notifications & saved views ------------------------------- */
  notificationsForUser: db.prepare(`
    SELECT * FROM notifications
     WHERE user_id = @user_id OR student_id = @student_id
     ORDER BY created_at DESC LIMIT @limit`),
  markNotificationRead: db.prepare(
    "UPDATE notifications SET read_at = datetime('now') WHERE id = @id AND read_at IS NULL",
  ),
  markAllNotificationsRead: db.prepare(`
    UPDATE notifications SET read_at = datetime('now')
     WHERE read_at IS NULL AND (user_id = @user_id OR student_id = @student_id)`),
  unreadCount: db.prepare(`
    SELECT COUNT(*) AS n FROM notifications
     WHERE read_at IS NULL AND (user_id = @user_id OR student_id = @student_id)`),
  insertNotification: db.prepare(`
    INSERT OR IGNORE INTO notifications
      (user_id, student_id, kind, title, body, link, dedupe_key, created_at)
    VALUES
      (@user_id, @student_id, @kind, @title, @body, @link, @dedupe_key, @created_at)`),
  existingNotificationKeys: db.prepare(
    'SELECT dedupe_key FROM notifications WHERE dedupe_key IS NOT NULL',
  ),
  notificationsByKind: db.prepare(`
    SELECT kind, COUNT(*) AS n FROM notifications GROUP BY kind ORDER BY n DESC`),
  listViews: db.prepare(
    'SELECT id, name, scope, created_at FROM saved_views WHERE user_id = @user_id ORDER BY name',
  ),
  insertView: db.prepare(`
    INSERT INTO saved_views (user_id, name, scope, payload) VALUES (@user_id, @name, @scope, @payload)
    ON CONFLICT (user_id, name) DO UPDATE SET scope = excluded.scope, payload = excluded.payload
  `),
  viewByName: db.prepare('SELECT * FROM saved_views WHERE user_id = @user_id AND name = @name'),
  deleteView: db.prepare('DELETE FROM saved_views WHERE id = @id AND user_id = @user_id'),
  getView: db.prepare(
    'SELECT * FROM saved_views WHERE id = @id AND user_id = @user_id',
  ),
};

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

/**
 * Build a plausible fee/attendance profile for a student.
 * Correlates the two: chronic absenteeism tends to accompany arrears.
 *
 * `fee_due` is the billed total for the year; `fee_paid` is what has landed.
 * The outstanding balance is therefore `fee_due - fee_paid`.
 */
function makeProfile(rng) {
  const billed = Math.round(between(rng, 18000, 62000) / 500) * 500;
  const roll = rng();

  // Payment behaviour buckets
  let paidRatio;
  if (roll < 0.52) paidRatio = 1;                 // fully settled
  else if (roll < 0.74) paidRatio = between(rng, 0.55, 0.9);
  else if (roll < 0.9) paidRatio = between(rng, 0.15, 0.5);
  else paidRatio = between(rng, 0, 0.12);        // chronic defaulter

  const fee_paid = round2(billed * paidRatio);
  const fee_due = round2(billed);

  // Attendance skews with arrears.
  const attendanceRoll = rng() - (paidRatio < 0.5 ? 0.12 : 0);
  let attendance;
  if (attendanceRoll < 0.06) attendance = round2(between(rng, 52, 68));
  else if (attendanceRoll < 0.2) attendance = round2(between(rng, 68, 79));
  else if (attendanceRoll < 0.72) attendance = round2(between(rng, 79, 91));
  else attendance = round2(between(rng, 91, 99.4));

  return { fee_due, fee_paid, attendance };
}

/**
 * Seed the database. Idempotent: does nothing if users already exist,
 * unless `force` is true (in which case the data is rebuilt from scratch).
 */
export function seed({ force = false, studentCount = 100 } = {}) {
  if (!force && S.countUsers.get().n > 0) {
    return { seeded: false, reason: 'already_populated' };
  }

  const run = db.transaction(() => {
    if (force) {
      db.exec('DELETE FROM students; DELETE FROM users;');
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','students')");
    }

    const rng = mulberry32(0x43414d50); // "CAMP"

    // Staff
    const staffHashes = new Map();
    for (const staff of STAFF_ACCOUNTS) {
      const hash = hashPassword(DEMO_PASSWORD);
      staffHashes.set(staff.email, hash);
      S.insertUser.run({ ...staff, password: hash });
    }

    // Students — grade weights sum to 100.
    const gradeWeights = [
      [6, 10], [7, 14], [8, 14], [9, 16], [10, 16], [11, 15], [12, 15],
    ];
    const grades = gradeWeights.flatMap(([g, w]) => Array(w).fill(g)).slice(0, studentCount);

    // Shuffle deterministically so roll numbers are not grouped by grade.
    for (let i = grades.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [grades[i], grades[j]] = [grades[j], grades[i]];
    }

    const usedRoll = new Set();
    const usedEmail = new Set();
    let counter = 0;
    const profiles = [];

    for (const grade of grades) {
      counter += 1;

      // Stable, unique, human-readable roll number: CF-<year>-<seq>
      let rollNo;
      do {
        rollNo = `CF-2026-${String(counter).padStart(4, '0')}`;
      } while (usedRoll.has(rollNo));
      usedRoll.add(rollNo);

      const first = pick(rng, FIRST_NAMES);
      const last = pick(rng, LAST_NAMES);
      const name = `${first} ${last}`;

      let email;
      let n = 1;
      do {
        const slug = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
        email = n === 1 ? `${slug}@campusflow.edu` : `${slug}${n}@campusflow.edu`;
        n += 1;
      } while (usedEmail.has(email));
      usedEmail.add(email);

      const info = S.insertUser.run({
        email,
        name,
        role: ROLES.STUDENT,
        password: hashPassword(DEMO_PASSWORD),
      });

      const profile = makeProfile(rng);
      const admissionYear = 2026 - grade;
      const row = S.insertStudent.run({
        user_id: info.lastInsertRowid,
        roll_no: rollNo,
        grade,
        section: SECTIONS[counter % SECTIONS.length],
        category: pick(rng, FEE_CATEGORIES),
        admission_date: `${admissionYear}-0${1 + Math.floor(rng() * 8)}-1${Math.floor(rng() * 9)}`,
        dob: `${admissionYear - 5}-0${1 + Math.floor(rng() * 8)}-1${Math.floor(rng() * 9)}`,
        guardian_name: `${pick(rng, FIRST_NAMES)} ${last}`,
        guardian_phone: `+91 9${Math.floor(between(rng, 100000000, 999999999))}`,
        blood_group: pick(rng, BLOOD_GROUPS),
        previous_school: `${last} High School, ${pick(rng, CITIES)}`,
        ...profile,
      });

      profiles.push({
        id: Number(row.lastInsertRowid),
        grade,
        attendance: profile.attendance,
        fee_due: profile.fee_due,
        fee_paid: profile.fee_paid,
      });
    }

    seedAcademic(rng, profiles);
    seedFinance(rng, profiles);
  });

  run();

  return {
    seeded: true,
    users: S.countUsers.get().n,
    students: S.countStudents.get().n,
    tables: tableStats(db).filter((t) => t.rows > 0).length,
  };
}

/* ------------------------------------------------------------------ *
 * Academic seeding — subjects, results, day-by-day attendance
 * ------------------------------------------------------------------ */

const SUBJECTS = [
  ['ENG', 'English', 6, 8],
  ['MAT', 'Mathematics', 6, 8],
  ['SCI', 'Science', 6, 8],
  ['HIN', 'Hindi', 6, 8],
  ['SOC', 'Social Studies', 6, 8],
  ['ENG', 'English', 9, 12],
  ['MAT', 'Mathematics', 9, 12],
  ['PHY', 'Physics', 11, 12],
  ['CHE', 'Chemistry', 11, 12],
  ['BIO', 'Biology', 11, 12],
  ['ECO', 'Economics', 11, 12],
  ['CS', 'Computer Science', 9, 12],
];

const FEE_CATEGORIES = ['general', 'general', 'general', 'ews', 'staff_ward', 'scholarship'];
const BLOOD_GROUPS = ['A+', 'B+', 'O+', 'AB+', 'A-', 'O-'];
const CITIES = ['Bengaluru', 'Pune', 'Delhi', 'Kochi', 'Jaipur', 'Chennai', 'Hyderabad'];

/** The last N weekday-only school days, ending today, oldest first. */
function schoolDays(count) {
  const days = [];
  const cursor = new Date();
  while (days.length < count) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return days.reverse();
}

function letterFor(pct) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B+';
  if (pct >= 60) return 'B';
  if (pct >= 45) return 'C';
  if (pct >= 33) return 'D';
  return 'F';
}

function seedAcademic(rng, profiles) {
  const insertSubject = db.prepare(`
    INSERT OR IGNORE INTO subjects (code, name, grade_from, grade_to, credits) VALUES (?, ?, ?, ?, ?)`);
  for (const [code, name, from, to] of SUBJECTS) {
    insertSubject.run(code, name, from, to, to >= 11 ? 6 : 4);
  }
  const subjects = S.allSubjects.all();
  const term = S.currentTerm.get();
  if (!term) return;

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO course_results (student_id, subject_id, term_id, score, max_score, letter, graded_at)
    VALUES (@student_id, @subject_id, @term_id, @score, 100, @letter, @graded_at)`);
  const insertAttendance = db.prepare(`
    INSERT OR IGNORE INTO attendance_records (student_id, term_id, day, status)
    VALUES (@student_id, @term_id, @day, @status)`);

  const days = schoolDays(30);
  const gradedAt = `${term.end_date} 17:00:00`;

  for (const student of profiles) {
    // Ability: derived from attendance, so results and behaviour agree.
    const ability = 0.55 * (student.attendance / 100) + 0.45 * between(rng, 0.25, 0.95);
    const eligible = subjects.filter((s) => student.grade >= s.grade_from && student.grade <= s.grade_to);

    for (const subject of eligible) {
      const noise = between(rng, -0.16, 0.16);
      const pct = Math.max(0.12, Math.min(1, ability + noise));
      insertResult.run({
        student_id: student.id,
        subject_id: subject.id,
        term_id: term.id,
        score: Math.round(pct * 100),
        letter: letterFor(pct * 100),
        graded_at: gradedAt,
      });
    }

    // Attendance log: the headline percentage is reproduced day by day.
    const targetPresent = student.attendance / 100;
    for (const day of days) {
      const roll = rng();
      let status;
      if (roll < targetPresent) status = 'present';
      else if (roll < targetPresent + 0.02) status = 'late';
      else if (roll < targetPresent + 0.04) status = 'excused';
      else status = 'absent';
      insertAttendance.run({ student_id: student.id, term_id: term.id, day, status });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Finance seeding — invoices, payments, instalment plans
 * ------------------------------------------------------------------ */

const CATEGORIES = ['tuition', 'tuition', 'lab', 'transport', 'library', 'sports', 'exam'];
const METHODS = ['upi', 'upi', 'upi', 'card', 'netbanking', 'cash', 'cheque'];

function seedFinance(rng, profiles) {
  const term = S.currentTerm.get();
  if (!term) return;

  const accountant = db.prepare("SELECT id FROM users WHERE role = 'ACCOUNTANT' ORDER BY id LIMIT 1").get();

  const insertInvoice = db.prepare(`
    INSERT OR IGNORE INTO invoices
      (invoice_no, student_id, term_id, category, amount_billed, amount_paid, discount, status, issued_at, due_date, settled_at, notes)
    VALUES
      (@invoice_no, @student_id, @term_id, @category, @amount_billed, @amount_paid, @discount, @status, @issued_at, @due_date, @settled_at, @notes)`);
  const insertPayment = db.prepare(`
    INSERT OR IGNORE INTO payments
      (receipt_no, invoice_id, student_id, amount, method, reference, paid_at, recorded_by)
    VALUES
      (@receipt_no, @invoice_id, @student_id, @amount, @method, @reference, @paid_at, @recorded_by)`);
  const insertInstallment = db.prepare(`
    INSERT OR IGNORE INTO fee_installments (student_id, label, amount, due_date, paid_at, status)
    VALUES (@student_id, @label, @amount, @due_date, @paid_at, @status)`);

  let invoiceSeq = 0;
  let receiptSeq = 0;

  for (const student of profiles) {
    const balance = Math.max(0, round2(student.fee_due - student.fee_paid));
    const discount = student.category === 'scholarship' || student.category === 'staff_ward'
      ? round2(student.fee_due * 0.25)
      : 0;
    const settled = balance <= 0.5;

    invoiceSeq += 1;
    const invoiceNo = `INV-2026-${String(invoiceSeq).padStart(5, '0')}`;
    const dueDate = settled ? `${term.start_date}` : addDays(term.start_date, 45 + Math.floor(rng() * 120));

    const invoice = insertInvoice.run({
      invoice_no: invoiceNo,
      student_id: student.id,
      term_id: term.id,
      category: 'tuition',
      amount_billed: student.fee_due,
      amount_paid: student.fee_paid,
      discount,
      status: settled ? 'settled' : (student.fee_paid > 0 ? 'partial' : 'open'),
      issued_at: `${term.start_date} 09:00:00`,
      due_date: dueDate,
      settled_at: settled ? `${term.start_date} 14:30:00` : null,
      notes: null,
    });

    // Split what was collected into 1–3 realistic receipts.
    let remaining = student.fee_paid;
    const parts = remaining > 0 ? (remaining > 20000 ? 3 : remaining > 8000 ? 2 : 1) : 0;
    for (let part = 0; part < parts; part += 1) {
      const amount = part === parts - 1
        ? round2(remaining)
        : round2((student.fee_paid / parts) * between(rng, 0.7, 1));
      if (amount <= 0) continue;
      remaining = round2(remaining - amount);
      receiptSeq += 1;
      insertPayment.run({
        receipt_no: `RCP-2026-${String(receiptSeq).padStart(5, '0')}`,
        invoice_id: invoice.lastInsertRowid,
        student_id: student.id,
        amount,
        method: pick(rng, METHODS),
        reference: `${pick(rng, ['UPI', 'NEFT', 'CHQ', 'POS'])}-${Math.floor(between(rng, 100000, 999999))}`,
        paid_at: `${addDays(term.start_date, Math.floor(between(rng, 0, 90)))} 1${Math.floor(rng() * 9)}:00:00`,
        recorded_by: accountant?.id ?? null,
      });
    }

    // A three-part instalment plan, the first slice always cleared.
    const slice = round2(student.fee_due / 3);
    const labels = ['Term 1 · Apr', 'Term 2 · Aug', 'Term 3 · Dec'];
    const today = new Date().toISOString().slice(0, 10);
    labels.forEach((label, i) => {
      const due = addDays(term.start_date, 30 + i * 120);
      // A settled account has cleared the whole plan, not just the first
      // slice. Leaving its later instalments 'pending' made the collections
      // alerts chase students who owe nothing at all.
      const paid = settled || (i === 0 && student.fee_paid > 0);
      insertInstallment.run({
        student_id: student.id,
        label,
        amount: slice,
        due_date: due,
        paid_at: paid ? `${addDays(term.start_date, 12 + i * 30)} 10:00:00` : null,
        status: paid ? 'paid' : (due < today ? 'overdue' : 'pending'),
      });
    });
  }

  // A handful of side invoices (transport, lab, exam) so the ledger is not
  // tuition-only and category filtering in the UI has something to show.
  const sideCategories = ['lab', 'transport', 'library', 'sports', 'exam'];
  for (const student of profiles.filter(() => rng() < 0.45)) {
    invoiceSeq += 1;
    const amount = Math.round(between(rng, 1500, 9000) / 100) * 100;
    const paid = rng() < 0.6 ? amount : 0;
    insertInvoice.run({
      invoice_no: `INV-2026-${String(invoiceSeq).padStart(5, '0')}`,
      student_id: student.id,
      term_id: term.id,
      category: pick(rng, sideCategories),
      amount_billed: amount,
      amount_paid: paid,
      discount: 0,
      status: paid >= amount ? 'settled' : (paid > 0 ? 'partial' : 'open'),
      issued_at: `${term.start_date} 10:00:00`,
      due_date: addDays(term.start_date, 60),
      settled_at: paid >= amount ? `${term.start_date} 16:00:00` : null,
      notes: 'Ancillary charge',
    });
  }
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Queries used by the API layer
 * ------------------------------------------------------------------ */

const byBalanceDesc = (a, b) => b.balance - a.balance;

export function getUserByEmail(email) {
  return S.userByEmail.get(String(email || '').trim().toLowerCase()) || null;
}

export function getUserById(id) {
  return S.userById.get(id) || null;
}

/** First account holding a role — powers the 1-click demo login. */
export function getDemoUserForRole(role) {
  const wanted = String(role || '').trim().toUpperCase();
  if (!Object.values(ROLES).includes(wanted)) return null;
  return S.firstUserByRole.get(wanted) || null;
}

export function getStudentByUserId(userId) {
  return S.studentByUserId.get(userId) || null;
}

export function listAllStudents() {
  return S.allStudents.all();
}

export function getRoster(grade) {
  const g = Number.parseInt(grade, 10);
  if (!Number.isFinite(g)) return listAllStudents();
  return S.rosterByGrade.all({ grade: g });
}

export function listGrades() {
  return S.distinctGrades.all().map((r) => r.grade);
}

/** Build the login dropdown for the UI, with live counts. */
export function listDemoAccounts() {
  const staff = STAFF_ACCOUNTS.map((s) => ({
    role: s.role,
    email: s.email,
    name: s.name,
  }));
  const first = S.firstUserByRole.get(ROLES.STUDENT);
  if (first) {
    const stu = S.studentByUserId.get(first.id);
    staff.push({
      role: ROLES.STUDENT,
      email: first.email,
      name: first.name,
      rollNo: stu?.roll_no ?? null,
      grade: stu?.grade ?? null,
    });
  }
  return staff;
}

/* ------------------------------------------------------------------ *
 * Finance metrics
 * ------------------------------------------------------------------ */

/**
 * Deterministic, explainable finance metrics.
 * This is the ground truth the AI layer reasons over — the model is asked to
 * interpret these numbers, never to invent them.
 */
export function financeMetrics() {
  const students = listAllStudents();
  const total = students.length;

  const billed = students.reduce((s, r) => s + r.fee_due, 0);
  const collected = students.reduce((s, r) => s + r.fee_paid, 0);
  const outstanding = Math.max(0, billed - collected);

  const defaulters = students.filter((r) => r.balance > 0);
  const critical = defaulters.filter((r) => r.balance >= 25000 || r.attendance < 70);
  const chronic = students.filter((r) => r.attendance < 75);

  const atRisk = students.filter(
    (r) => r.balance > 10000 || r.attendance < 75 || (r.balance > 0 && r.attendance < 85),
  );

  const topDefaulters = [...defaulters].sort(byBalanceDesc).slice(0, 8);

  const byGrade = listGrades().map((grade) => {
    const rows = students.filter((r) => r.grade === grade);
    const gBilled = rows.reduce((s, r) => s + r.fee_due, 0);
    const gCollected = rows.reduce((s, r) => s + r.fee_paid, 0);
    const gOutstanding = Math.max(0, gBilled - gCollected);
    const gDefaulters = rows.filter((r) => r.balance > 0);
    return {
      grade,
      students: rows.length,
      billed: round2(gBilled),
      collected: round2(gCollected),
      outstanding: round2(gOutstanding),
      collectionRate: gBilled > 0 ? round2((gCollected / gBilled) * 100) : 100,
      defaulterRate: rows.length ? round2((gDefaulters.length / rows.length) * 100) : 0,
      avgAttendance: round2(
        rows.reduce((s, r) => s + r.attendance, 0) / (rows.length || 1),
      ),
    };
  });

  const attendanceBuckets = [
    { label: 'Critical (<70%)', min: 0, max: 70 },
    { label: 'At risk (70–80%)', min: 70, max: 80 },
    { label: 'Watch (80–90%)', min: 80, max: 90 },
    { label: 'Healthy (90%+)', min: 90, max: 101 },
  ].map((b) => ({
    label: b.label,
    count: students.filter((r) => r.attendance >= b.min && r.attendance < b.max).length,
  }));

  const bySection = SECTIONS.map((section) => {
    const rows = students.filter((r) => r.section === section);
    const sBilled = rows.reduce((s, r) => s + r.fee_due, 0);
    const sCollected = rows.reduce((s, r) => s + r.fee_paid, 0);
    return {
      section,
      students: rows.length,
      outstanding: round2(Math.max(0, sBilled - sCollected)),
      collectionRate: sBilled > 0 ? round2((sCollected / sBilled) * 100) : 100,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      students: total,
      billed: round2(billed),
      collected: round2(collected),
      outstanding: round2(outstanding),
      collectionRate: billed > 0 ? round2((collected / billed) * 100) : 100,
      avgBalancePerStudent: round2(outstanding / (total || 1)),
      defaulterCount: defaulters.length,
      defaulterRate: total ? round2((defaulters.length / total) * 100) : 0,
      criticalCount: critical.length,
      chronicAbsenteeCount: chronic.length,
      atRiskCount: atRisk.length,
      avgAttendance: round2(
        students.reduce((s, r) => s + r.attendance, 0) / (total || 1),
      ),
    },
    topDefaulters: topDefaulters.map((r) => ({
      id: r.id,
      name: r.name,
      rollNo: r.roll_no,
      grade: r.grade,
      section: r.section,
      balance: round2(r.balance),
      feeDue: round2(r.fee_due),
      feePaid: round2(r.fee_paid),
      attendance: r.attendance,
    })),
    byGrade,
    bySection,
    attendanceBuckets,
  };
}

/**
 * Baseline statistical risk score, computed without any AI.
 * Used as the always-available fallback and as a sanity anchor for the model.
 * Weighted blend of arrears severity, arrears incidence and absenteeism.
 */
export function statisticalRisk(metrics = financeMetrics()) {
  const t = metrics.totals;
  const collection = t.collectionRate / 100; // 0..1, higher is better
  const attendance = t.avgAttendance / 100;
  const defaulter = t.defaulterRate / 100;

  // Penalties: 0 (healthy) .. 1 (severe)
  const collectionPenalty = Math.min(1, Math.max(0, 1 - collection) / 0.4);
  const attendancePenalty = Math.min(1, Math.max(0, 0.9 - attendance) / 0.35);
  const defaulterPenalty = Math.min(1, defaulter / 0.6);

  const score = Math.round(
    100 * (0.45 * collectionPenalty + 0.3 * attendancePenalty + 0.25 * defaulterPenalty),
  );

  const severity = score >= 60 ? 'critical' : score >= 35 ? 'elevated' : score >= 15 ? 'guarded' : 'healthy';

  return {
    score: Math.max(0, Math.min(100, score)),
    severity,
    components: {
      collectionPenalty: round2(collectionPenalty * 100),
      attendancePenalty: round2(attendancePenalty * 100),
      defaulterPenalty: round2(defaulterPenalty * 100),
    },
  };
}

/**
 * Coerce any student row (DB snake_case, or API camelCase) into one canonical
 * shape. Every downstream risk/AI calculation goes through this, so a field
 * rename can never silently produce NaN.
 */
export function toStudent(row) {
  if (!row) return null;
  const feeDue = Number(row.fee_due ?? row.feeDue ?? 0) || 0;
  const feePaid = Number(row.fee_paid ?? row.feePaid ?? 0) || 0;
  const attendance = Number(row.attendance ?? 0) || 0;
  const rollNo = row.roll_no ?? row.rollNo ?? null;
  return {
    id: row.id,
    user_id: row.user_id ?? row.userId ?? null,
    roll_no: rollNo,
    rollNo,
    grade: Number(row.grade ?? 0) || 0,
    section: row.section ?? 'A',
    name: row.name ?? 'Unknown',
    email: row.email ?? null,
    fee_due: round2(feeDue),
    fee_paid: round2(feePaid),
    attendance: round2(Math.max(0, Math.min(100, attendance))),
    balance: round2(Math.max(0, feeDue - feePaid)),
  };
}

/** Per-student risk used by the teacher view. */
export function studentRisk(input) {
  const student = toStudent(input);
  if (!student) return { score: 0, severity: 'healthy' };

  const duesPenalty = Math.min(1, student.balance / 40000);
  const attendancePenalty = Math.min(1, Math.max(0, 80 - student.attendance) / 40);
  const score = Math.round(100 * (0.5 * duesPenalty + 0.5 * attendancePenalty));
  return {
    score: Math.max(0, Math.min(100, score)),
    severity:
      score >= 60 ? 'critical' : score >= 35 ? 'elevated' : score >= 15 ? 'guarded' : 'healthy',
  };
}

/* ------------------------------------------------------------------ *
 * Academic records
 * ------------------------------------------------------------------ */

export function listTerms() {
  return S.allTerms.all();
}

export function currentTerm() {
  return S.currentTerm.get() || null;
}

export function listSubjects(grade) {
  const all = S.allSubjects.all();
  if (grade === undefined || grade === null) return all;
  const g = Number(grade);
  return all.filter((s) => g >= s.grade_from && g <= s.grade_to);
}

export function getResults(studentId) {
  return S.resultsForStudent.all({ student_id: Number(studentId) });
}

export function getGradeAverages(grade) {
  return S.resultsForGrade.all({ grade: Number(grade) });
}

export function getAttendanceHistory(studentId, limit = 30) {
  return S.attendanceForStudent.all({ student_id: Number(studentId), limit: Number(limit) });
}

export function getAttendanceBreakdown(grade) {
  const rows = S.attendanceBreakdown.all({ grade: Number(grade) });
  const total = rows.reduce((s, r) => s + r.n, 0);
  return rows.map((r) => ({
    status: r.status,
    count: r.n,
    share: total ? round2((r.n / total) * 100) : 0,
  }));
}

/* ---- roll call ---------------------------------------------------- */

/** The four states a register accepts, in the order the UI cycles them. */
export const ATTENDANCE_STATUSES = Object.freeze(['present', 'late', 'absent', 'excused']);

/** Today in the local timezone, as YYYY-MM-DD — the shape `day` columns use. */
export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const isISODay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

const clampPct = (n) => Math.max(0, Math.min(100, round2(Number(n) || 0)));

/**
 * Recompute a student's headline percentage from the register.
 *
 * `students.attendance` is denormalised so the roster and the risk engine stay
 * cheap. Excused days are dropped from the denominator (a medical leave should
 * not drag the number down) and late counts as half a day.
 */
export function recomputeAttendance(studentId) {
  const t = S.attendanceTotals.get({ student_id: Number(studentId) }) || {};
  const present = Number(t.present) || 0;
  const late = Number(t.late) || 0;
  const absent = Number(t.absent) || 0;
  const counted = present + late + absent;
  const pct = counted ? round2(((present + late * 0.5) / counted) * 100) : 0;
  S.writeAttendancePct.run({ id: Number(studentId), attendance: clampPct(pct) });
  return clampPct(pct);
}

/**
 * The register for one day.
 *
 * `grade: null` means the whole school. Unmarked students come back with a null
 * status so the sheet can show who still needs a decision.
 */
export function attendanceSheet({ grade = null, day = today() } = {}) {
  const term = currentTerm();
  if (!term) return { day, term: null, students: [], tallies: emptyTallies(), recentDays: [] };

  const g = grade === null || grade === undefined || grade === '' ? 0 : Number(grade);
  const students = S.attendanceSheet.all({ grade: g, day, term_id: term.id }).map((r) => ({
    id: r.id,
    name: r.name,
    rollNo: r.roll_no,
    grade: r.grade,
    section: r.section,
    attendance: r.attendance,
    status: r.status || null,
  }));

  const tallies = emptyTallies();
  for (const row of S.attendanceTallies.all({ grade: g, day, term_id: term.id })) {
    tallies[row.status] = row.n;
  }

  return {
    day,
    term,
    grade: g || null,
    students,
    tallies,
    recentDays: S.attendanceRecentDays.all({ grade: g, limit: 30 }).map((r) => r.day),
  };
}

function emptyTallies() {
  return { present: 0, late: 0, absent: 0, excused: 0 };
}

/**
 * File the register. `entries` is `[{ studentId, status }]`, where a falsy
 * status clears the row (back to unmarked). The whole batch is one transaction
 * and every touched student has their headline percentage refreshed in the
 * same call, so a marked register is immediately visible on the roster.
 */
export function markAttendance({ day = today(), entries = [] } = {}) {
  if (!isISODay(day)) throw new Error('day must look like YYYY-MM-DD');
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('Provide at least one attendance entry.');
  }

  const term = currentTerm();
  if (!term) throw new Error('No current term — the register cannot be filed.');

  const roster = new Set(S.attendanceSheet.all({ grade: 0, day, term_id: term.id }).map((r) => r.id));
  const clean = [];
  for (const e of entries) {
    const id = Number(e && e.studentId);
    if (!Number.isFinite(id) || !roster.has(id)) continue;
    const status = e.status ? String(e.status).toLowerCase() : null;
    if (status && !ATTENDANCE_STATUSES.includes(status)) continue;
    clean.push({ studentId: id, status });
  }
  if (!clean.length) throw new Error('Nothing valid to save — no known student or status.');

  const write = db.transaction((rows) => {
    for (const row of rows) {
      if (row.status) {
        S.upsertAttendance.run({ student_id: row.studentId, term_id: term.id, day, status: row.status });
      } else {
        S.clearAttendance.run({ student_id: row.studentId, term_id: term.id, day });
      }
    }
  });

  write(clean);
  for (const row of new Set(clean.map((r) => r.studentId))) recomputeAttendance(row);

  return { ok: true, day, termId: term.id, written: clean.length, marked: clean.filter((r) => r.status).length };
}

/* ------------------------------------------------------------------ *
 * Finance records
 * ------------------------------------------------------------------ */

export function getInvoices(studentId) {
  return S.invoicesForStudent.all({ student_id: Number(studentId) });
}

export function getPayments(studentId) {
  return S.paymentsForStudent.all({ student_id: Number(studentId) });
}

export function getInstallments(studentId) {
  return S.installmentsForStudent.all({ student_id: Number(studentId) });
}

export function getOverdueInstallments(limit = 20) {
  return S.overdueInstallments.all({ limit: Number(limit) });
}

/** Receipts across the whole school, newest first, with paging and filters. */
export function ledger({ method = '', from = '', to = '', limit = 50, offset = 0 } = {}) {
  const args = {
    method: String(method || '').toLowerCase(),
    from: String(from || ''),
    to: String(to || ''),
    limit: Math.max(1, Math.min(200, Number(limit) || 50)),
    offset: Math.max(0, Number(offset) || 0),
  };
  const rows = S.ledgerPage.all(args);
  const total = S.ledgerCount.get(args).n;
  return {
    rows,
    total,
    limit: args.limit,
    offset: args.offset,
    pages: Math.max(1, Math.ceil(total / args.limit)),
    byMethod: S.collectionByMethod.all(),
    aging: S.invoiceAging.get(),
  };
}

/* ------------------------------------------------------------------ *
 * Notifications + saved views
 * ------------------------------------------------------------------ */

export function getNotifications({ userId = null, studentId = null, limit = 20 } = {}) {
  return S.notificationsForUser.all({
    user_id: userId ? Number(userId) : -1,
    student_id: studentId ? Number(studentId) : -1,
    limit: Math.max(1, Math.min(100, Number(limit) || 20)),
  });
}

export function markNotificationRead(id, userId) {
  return S.markNotificationRead.run({ id: Number(id) }).changes > 0;
}

/**
 * Clear the caller's whole inbox.
 *
 * Scoped exactly like {@link unreadNotifications} — matching on `user_id` alone
 * would leave every alert addressed to a student record unread, so the badge
 * would refuse to clear no matter how many times "Clear all" was pressed.
 */
export function markAllNotificationsRead(userId, studentId = null) {
  return S.markAllNotificationsRead.run({
    user_id: userId ? Number(userId) : -1,
    student_id: studentId ? Number(studentId) : -1,
  }).changes;
}

/** Unread badge count for the header. */
export function unreadNotifications({ userId = null, studentId = null } = {}) {
  return S.unreadCount.get({
    user_id: userId ? Number(userId) : -1,
    student_id: studentId ? Number(studentId) : -1,
  }).n;
}

/**
 * Add a notification, or do nothing if that dedupe key has been used before.
 *
 * The unique index on `dedupe_key` is what makes regeneration safe: the
 * generator re-derives every alert from live state on each pass, so without it
 * a user would collect a fresh copy of the same warning every fifteen minutes.
 *
 * @returns {boolean} true when a new row was written
 */
export function addNotification({
  userId = null, studentId = null, kind = 'info', title, body = '', link = null,
  dedupeKey = null, createdAt = null,
}) {
  const clean = String(title || '').trim();
  if (!clean) return false;

  const result = S.insertNotification.run({
    user_id: userId ? Number(userId) : null,
    student_id: studentId ? Number(studentId) : null,
    kind: String(kind || 'info').slice(0, 30),
    title: clean.slice(0, 200),
    body: String(body || '').slice(0, 1000),
    link: link ? String(link).slice(0, 120) : null,
    dedupe_key: dedupeKey ? String(dedupeKey).slice(0, 200) : null,
    created_at: createdAt || new Date().toISOString().replace('T', ' ').slice(0, 19),
  });

  return result.changes > 0;
}

/** Every dedupe key already in use, so the generator can skip cheaply. */
export function notificationKeys() {
  return new Set(S.existingNotificationKeys.all().map((r) => r.dedupe_key));
}

/** How many notifications exist per kind, for the audit/settings views. */
export function notificationMix() {
  return S.notificationsByKind.all();
}

export function listViews(userId) {
  return S.listViews.all({ user_id: Number(userId) });
}

export function saveView(userId, { name, scope = '', payload = {} }) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return null;
  S.insertView.run({
    user_id: Number(userId),
    name: clean,
    scope: String(scope || '').slice(0, 60),
    payload: JSON.stringify(payload ?? {}).slice(0, 4000),
  });
  return S.viewByName.get({ user_id: Number(userId), name: clean });
}

export function removeView(userId, id) {
  return S.deleteView.run({ id: Number(id), user_id: Number(userId) }).changes > 0;
}

export function getView(userId, id) {
  return S.getView.get({ id: Number(id), user_id: Number(userId) });
}

/* ------------------------------------------------------------------ *
 * Introspection (settings GUI, /api/health)
 * ------------------------------------------------------------------ */

export function databaseStats() {
  const tables = tableStats(db);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(DB_PATH).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    path: DB_PATH,
    sizeBytes,
    tables,
    totals: {
      tables: tables.length,
      rows: tables.reduce((s, t) => s + t.rows, 0),
      users: S.countUsers.get().n,
      students: S.countStudents.get().n,
    },
  };
}

export function close() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

export const paths = { dbPath: DB_PATH, root: ROOT };
