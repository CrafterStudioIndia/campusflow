/**
 * lib/notify.js — derives notifications from live state.
 *
 * The `notifications` table had a read path and no write path: nothing ever
 * inserted a row, so the endpoints could only ever answer `[]`. This module is
 * that missing writer, and it works by *re-deriving* the current picture rather
 * than by firing events at the moment something happens. There are no events to
 * hook in a batch-imported school, and the alerts that matter here — an unpaid
 * instalment, attendance that keeps falling, a fee total that has crossed a
 * threshold — are all states, not transitions.
 *
 * Consequences of re-deriving rather than eventing:
 *
 *   - running it twice changes nothing, which matters because the dashboard
 *     calls it on a timer and an operator can also force it by hand
 *   - a missed run self-heals on the next pass
 *   - `dedupe_key` is what keeps a warning from multiplying: the key names the
 *     *situation* ("this student is below 70% attendance"), not the moment, so
 *     the row is written once and stays unread until somebody deals with it
 *
 * Each rule decides who to tell: the student always sees their own position,
 * staff see the aggregate or the caseload that needs a human.
 */

import {
  addNotification,
  getInstallments,
  getDemoUserForRole,
  listAllStudents,
  notificationKeys,
  studentRisk,
  toStudent,
} from './db.js';
import { ROLES } from './db.js';

/* ------------------------------------------------------------------ *
 * Thresholds
 * ------------------------------------------------------------------ */

/**
 * Money, in whole currency units.
 *
 * The per-student "you owe us" alert fires on a band rather than a single
 * number so a student is warned once and not re-warned every rupee. Each band
 * is its own dedupe key, so crossing ₹20k later still produces a fresh alert.
 */
const FEE_BANDS = [10000, 25000, 40000];

/** Attendance below this is a concern; below the second value it is urgent. */
const ATTENDANCE_WARN = 80;
const ATTENDANCE_CRITICAL = 70;

/** How long a generated alert stays relevant before it is regenerated. */
const REGENERATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

const dayStamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 10);

/** The staff a teacher- or finance-facing alert should go to. */
function staffIdFor(role) {
  return getDemoUserForRole(role)?.id ?? null;
}

/**
 * Write one alert unless its key was already used.
 * @returns {boolean} true when a new notification was created
 */
function raise(seen, notification) {
  if (notification.dedupeKey && seen.has(notification.dedupeKey)) return false;
  const written = addNotification(notification);
  if (written && notification.dedupeKey) seen.add(notification.dedupeKey);
  return written;
}

/**
 * Has this dedupe key been used, and is it old enough to speak about again?
 *
 * A warning that is still true should not be re-created every pass, but one
 * that has sat unread for a week is worth nudging about — a monthly-style
 * reminder is more useful than a single notification buried in March.
 */
function shouldReissue(seen, key, existingAt) {
  if (!seen.has(key)) return true;
  if (!existingAt) return true;
  return Date.now() - new Date(`${existingAt.replace(' ', 'T')}Z`).getTime() > REGENERATE_AFTER_MS;
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/**
 * A student's own fee position. Fires on each band crossed, so the alert
 * escalates instead of silently growing.
 */
function feeAlerts(student, seen) {
  const written = [];
  const balance = student.balance;
  if (balance < FEE_BANDS[0]) return written;

  const band = FEE_BANDS.filter((b) => balance >= b).pop();
  const key = `fee:${student.id}:${band}`;
  if (!shouldReissue(seen, key)) return written;

  const overdue = getInstallments(student.id)
    .filter((i) => ['pending', 'overdue'].includes(i.status));

  if (raise(seen, {
    userId: student.user_id,
    studentId: student.id,
    kind: 'fee',
    title: `${money(balance)} outstanding`,
    body: `Your fee balance is ${money(balance)}.`
      + (overdue.length
        ? ` ${overdue.length} instalment${overdue.length === 1 ? '' : 's'} past due — next: ${overdue[0].label} on ${overdue[0].due_date}.`
        : ' No instalment is overdue yet — clearing it early avoids the late fee.')
      + ' Contact the accounts office if you need a payment plan.',
    link: `student:${student.id}`,
    dedupeKey: key,
  })) written.push(key);

  return written;
}

/** A student whose attendance has dropped below the warning line. */
function attendanceAlerts(student, seen, teacherId) {
  const written = [];
  if (student.attendance >= ATTENDANCE_WARN) return written;

  const critical = student.attendance < ATTENDANCE_CRITICAL;
  const key = `attendance:${student.id}:${critical ? 'critical' : 'warn'}`;
  const staffKey = `staff-attendance:${student.id}:${critical ? 'critical' : 'warn'}`;
  if (!shouldReissue(seen, key)) return written;

  const pct = student.attendance.toFixed(1);
  if (raise(seen, {
    userId: student.user_id,
    studentId: student.id,
    kind: 'attendance',
    title: `Attendance at ${pct}%`,
    body: critical
      ? `Your attendance is ${pct}%, below the ${ATTENDANCE_CRITICAL}% minimum. Many schools block examination entries below that line — speak to your class teacher this week.`
      : `Your attendance is ${pct}%, under the ${ATTENDANCE_WARN}% mark. It is trending toward the ${ATTENDANCE_CRITICAL}% minimum.`,
    link: `student:${student.id}`,
    dedupeKey: key,
  })) written.push(key);

  if (raise(seen, {
    userId: teacherId,
    studentId: student.id,
    kind: 'attendance',
    title: `${student.name} at ${pct}%`,
    body: critical
      ? `${student.roll_no} · Grade ${student.grade}${student.section} has attendance at ${pct}%, below the ${ATTENDANCE_CRITICAL}% minimum. Worth a guardian call.`
      : `${student.roll_no} · Grade ${student.grade}${student.section} has attendance at ${pct}%, under ${ATTENDANCE_WARN}%.`,
    link: `student:${student.id}`,
    dedupeKey: staffKey,
  })) written.push(staffKey);

  return written;
}

/** A student the accounts office should be chasing personally. */
function riskAlerts(student, seen, teacherId, accountantId) {
  const written = [];
  const risk = studentRisk(student);
  if (risk.severity !== 'critical') return written;

  const key = `risk:${student.id}`;
  if (!shouldReissue(seen, key)) return written;

  if (raise(seen, {
    userId: accountantId,
    studentId: student.id,
    kind: 'risk',
    title: `${student.name} needs escalation`,
    body: `${student.roll_no} · Grade ${student.grade}${student.section} scores ${risk.score}/100 on risk:`
      + ` ${money(student.balance)} outstanding and ${student.attendance.toFixed(1)}% attendance.`
      + ' This one usually needs a conversation rather than a reminder.',
    link: `student:${student.id}`,
    dedupeKey: key,
  })) written.push(key);

  const staffKey = `staff-risk:${student.id}`;
  if (raise(seen, {
    userId: teacherId,
    studentId: student.id,
    kind: 'risk',
    title: `${student.name} flagged at risk (${risk.score}/100)`,
    body: `Arrears and attendance are compounding for ${student.roll_no}.`
      + ' Consider a study plan alongside the finance conversation.',
    link: `student:${student.id}`,
    dedupeKey: staffKey,
  })) written.push(staffKey);

  return written;
}

/** An instalment that has gone past its due date without payment. */
function instalmentAlerts(seen, accountantId) {
  const written = [];
  const today = dayStamp();

  for (const student of listAllStudents()) {
    const late = getInstallments(student.id)
      .filter((i) => i.due_date < today && ['pending', 'overdue'].includes(i.status));
    if (!late.length) continue;

    const key = `instalment:${student.id}:${late[0].id}`;
    if (!shouldReissue(seen, key)) continue;

    if (raise(seen, {
      userId: accountantId,
      studentId: student.id,
      kind: 'instalment',
      title: `${student.name} — ${late.length} instalment${late.length === 1 ? '' : 's'} overdue`,
      body: `Oldest is "${late[0].label}", due ${late[0].due_date} (${money(late[0].amount)}).`
        + ` Roll ${student.roll_no}, Grade ${student.grade}${student.section}.`,
      link: `student:${student.id}`,
      dedupeKey: key,
    })) written.push(key);
  }

  return written;
}

/** A one-off welcome so a new account is not a blank dashboard. */
function welcome(student, seen) {
  const key = `welcome:${student.id}`;
  if (seen.has(key)) return [];

  return raise(seen, {
    userId: student.user_id,
    studentId: student.id,
    kind: 'welcome',
    title: `Welcome to CampusFlow, ${student.name.split(' ')[0]}`,
    body: `Roll ${student.roll_no} · Grade ${student.grade}${student.section}.`
      + ' Your fee position, attendance and results are all on this page.',
    link: `student:${student.id}`,
    dedupeKey: key,
  }) ? [key] : [];
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Re-derive every notification from current state.
 *
 * Safe to call as often as you like: existing dedupe keys short-circuit the
 * write, so a second pass over unchanged data creates nothing.
 *
 * @returns {{created: number, scanned: number, byKind: object, at: string}}
 */
export function generateNotifications() {
  const seen = notificationKeys();
  const students = listAllStudents().map(toStudent);
  const accountantId = staffIdFor(ROLES.ACCOUNTANT);
  const teacherId = staffIdFor(ROLES.TEACHER);

  const created = [];
  for (const student of students) {
    created.push(...feeAlerts(student, seen));
    created.push(...attendanceAlerts(student, seen, teacherId));
    created.push(...riskAlerts(student, seen, teacherId, accountantId));
    created.push(...welcome(student, seen));
  }
  created.push(...instalmentAlerts(seen, accountantId));

  const byKind = {};
  for (const key of created) {
    const kind = key.split(':')[0];
    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  return {
    created: created.length,
    scanned: students.length,
    byKind,
    at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

const REGENERATE_INTERVAL_MS = 15 * 60 * 1000;
let lastRun = null;

const lastResult = () => lastRun;

/**
 * Generate if the last pass is older than the interval.
 *
 * Called from the dashboard endpoints, which is what makes the alerts feel live
 * without a background timer holding the process awake — a school server that
 * is idle should not be polling its own database.
 */
export function refreshNotifications({ force = false, intervalMs = REGENERATE_INTERVAL_MS } = {}) {
  if (!force && lastRun && Date.now() - lastRun.at < intervalMs) return lastRun.result;

  try {
    const result = generateNotifications();
    lastRun = { at: Date.now(), result };
    return result;
  } catch {
    // A notification failure must never take a dashboard down with it.
    return { created: 0, scanned: 0, byKind: {}, at: new Date().toISOString(), error: true };
  }
}

export function notificationRunState() {
  return lastRun ? { at: new Date(lastRun.at).toISOString(), ...lastRun.result } : null;
}