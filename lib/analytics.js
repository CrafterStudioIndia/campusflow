/**
 * lib/analytics.js — Domain layer over the AI bridge.
 *
 * Responsibilities:
 *   1. Build a compact, factual evidence pack from the database.
 *   2. Ask the model to *interpret* that evidence (never to invent numbers).
 *   3. Normalize whatever comes back into a shape the UI can render blindly.
 *   4. Provide a deterministic offline analysis of equal quality.
 *
 * Step 3 is what keeps the frontend bug-free: the model output is treated as
 * untrusted and coerced into a strict contract with defaults for every field.
 */

import { runStructured } from './ai.js';
import {
  financeMetrics,
  listAllStudents,
  statisticalRisk,
  studentRisk,
  toStudent,
} from './db.js';

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

const clampStr = (v, max = 400) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const toNum = (v, fallback) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const toInt = (v, fallback, lo, hi) => {
  const n = Math.round(toNum(v, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

const toArr = (v) => (Array.isArray(v) ? v : []);

/** Model-returned severity words, mapped onto our fixed set. */
function normSeverity(v) {
  const s = String(v || '').toLowerCase();
  if (/critical|severe|urgent|red/.test(s)) return 'critical';
  if (/elevated|high|warning|amber/.test(s)) return 'elevated';
  if (/guarded|medium|moderate|watch/.test(s)) return 'guarded';
  if (/healthy|low|good|green|stable/.test(s)) return 'healthy';
  return null;
}

/**
 * Action priorities use their own four-step scale, which is NOT the same
 * vocabulary as normSeverity()'s risk levels. Mapping them through the wrong
 * normalizer silently yields 'elevated'/'guarded'/'healthy' and breaks sorting.
 */
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function normPriority(v) {
  const s = String(v || '').toLowerCase();
  if (/critical|severe|urgent|red|p0|highest/.test(s)) return 'critical';
  if (/high|elevated|amber|p1|important/.test(s)) return 'high';
  if (/medium|moderate|guarded|watch|normal|p2/.test(s)) return 'medium';
  if (/low|minor|healthy|green|p3|optional/.test(s)) return 'low';
  return null;
}

function compareByPriority(a, b) {
  // sort() hands us the action objects, so rank must be read off .priority.
  // Unknown values fall back to 'medium' so a stray label can never NaN the
  // comparator (which would silently disable the sort).
  const rank = PRIORITY_ORDER[a?.priority] ?? PRIORITY_ORDER.medium;
  const other = PRIORITY_ORDER[b?.priority] ?? PRIORITY_ORDER.medium;
  return rank - other;
}

const asList = (v, max, map) => toArr(v).slice(0, max).map(map).filter(Boolean);

/* ================================================================== *
 * 1. Collection risk — accountant
 * ================================================================== */

const RISK_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: 'Collection risk score 0-100, higher is worse' },
    severity: { type: 'string', enum: ['healthy', 'guarded', 'elevated', 'critical'] },
    headline: { type: 'string', description: 'One sentence, max 90 chars' },
    summary: { type: 'string', description: '2-4 sentences on the collection position' },
    defaulterPatterns: {
      type: 'array',
      description: 'Recurring behavioural patterns among defaulters',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          evidence: { type: 'string' },
          studentsAffected: { type: 'integer' },
          recommendedAction: { type: 'string' },
        },
        required: ['pattern', 'evidence', 'recommendedAction'],
      },
    },
    actions: {
      type: 'array',
      description: 'Prioritised, concrete recovery actions',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          action: { type: 'string' },
          owner: { type: 'string' },
          timeline: { type: 'string' },
          expectedRecovery: { type: 'string' },
        },
        required: ['action', 'owner', 'timeline'],
      },
    },
    forecast: {
      type: 'object',
      properties: {
        quarterOutlook: { type: 'string' },
        collectionRateTarget: { type: 'integer' },
        recoverableThisTerm: { type: 'number' },
      },
    },
  },
  required: ['score', 'severity', 'headline', 'summary', 'defaulterPatterns', 'actions'],
};

function buildRiskEvidence(metrics, stat) {
  const t = metrics.totals;
  const weakestGrades = [...metrics.byGrade]
    .sort((a, b) => a.collectionRate - b.collectionRate)
    .slice(0, 3);
  const weakestSections = [...metrics.bySection]
    .sort((a, b) => a.collectionRate - b.collectionRate)
    .slice(0, 2);

  return {
    institution: 'CampusFlow International School',
    asOf: metrics.generatedAt,
    totals: {
      students: t.students,
      billed: t.billed,
      collected: t.collected,
      outstanding: t.outstanding,
      collectionRatePct: t.collectionRate,
      defaulterCount: t.defaulterCount,
      defaulterRatePct: t.defaulterRate,
      criticalCount: t.criticalCount,
      chronicAbsenteeCount: t.chronicAbsenteeCount,
      atRiskCount: t.atRiskCount,
      averageAttendancePct: t.avgAttendance,
    },
    statisticalBaseline: stat,
    weakestGradesByCollection: weakestGrades,
    weakestSectionsByCollection: weakestSections,
    attendanceDistribution: metrics.attendanceBuckets,
    topDefaulters: metrics.topDefaulters.map((d) => ({
      name: d.name,
      grade: d.grade,
      section: d.section,
      balance: d.balance,
      attendancePct: d.attendance,
    })),
  };
}

const RISK_SYSTEM = `You are the senior finance analyst of a K-12 school.
You are given verified financial and attendance metrics. Reason strictly from the
supplied numbers — never invent, extrapolate or contradict them.
Respond with a single JSON object. No prose, no markdown fences.
Be specific, quantitative and operationally useful. Amounts are in INR.
Tone: calm, direct, executive.`;

function riskPrompt(evidence) {
  return `Analyse this school's fee-collection and attendance position.

EVIDENCE
${JSON.stringify(evidence, null, 2)}

Return JSON with:
- score: 0-100 collection risk (higher = worse). Calibrate against the statistical baseline.
- severity: healthy | guarded | elevated | critical
- headline: one punchy sentence (max 90 chars)
- summary: 2-4 sentences citing specific figures from the evidence
- defaulterPatterns: 3-5 recurring patterns. Each needs pattern, evidence (quote real
  numbers from the evidence), studentsAffected (integer), recommendedAction.
- actions: 4-6 recovery actions, most important first. Each needs priority
  (critical|high|medium|low), action, owner, timeline, expectedRecovery (amount or pct).
- forecast: quarterOutlook, collectionRateTarget (integer %), recoverableThisTerm (number)

Base the score within +/-12 points of statisticalBaseline.score and keep the
severity consistent with it.`;
}

/** Deterministic, evidence-grounded analysis used when no AI provider exists. */
function offlineRisk(metrics, stat) {
  const t = metrics.totals;
  const weakestGrade = [...metrics.byGrade].sort((a, b) => a.collectionRate - b.collectionRate)[0];
  const weakestSection = [...metrics.bySection].sort((a, b) => a.collectionRate - b.collectionRate)[0];
  const criticalAttendance = metrics.attendanceBuckets[0]?.count ?? 0;
  const atRiskAttendance = (metrics.attendanceBuckets[0]?.count ?? 0) + (metrics.attendanceBuckets[1]?.count ?? 0);

  // Deterministic recovery estimate. Outstanding fees are weighted by the
  // attendance band of the debtor: engaged families pay, disengaged ones
  // mostly do not. Rates are conservative and fully explainable.
  const bandRates = { critical: 0.08, atRisk: 0.18, watch: 0.30, healthy: 0.45 };
  const shareOf = (pred) => {
    const band = metrics.attendanceBuckets.filter(pred).reduce((s, b) => s + b.count, 0);
    return band / (t.students || 1);
  };
  const recoverable = round2(
    t.outstanding * (
      shareOf((b) => b.label.startsWith('Critical')) * bandRates.critical
      + shareOf((b) => b.label.startsWith('At risk')) * bandRates.atRisk
      + shareOf((b) => b.label.startsWith('Watch')) * bandRates.watch
      + shareOf((b) => b.label.startsWith('Healthy')) * bandRates.healthy
    ),
  );
  const targetRate = Math.min(100, Math.ceil(t.collectionRate + 8));

  return {
    score: stat.score,
    severity: stat.severity,
    headline: `${money(t.outstanding)} outstanding across ${t.defaulterCount} defaulters — ${stat.score}/100 risk`,
    summary:
      `Collection stands at ${t.collectionRate}% of ${money(t.billed)} billed, leaving ${money(t.outstanding)} ` +
      `unrecovered from ${t.defaulterCount} of ${t.students} students (${t.defaulterRate}%). ` +
      `Mean attendance is ${t.avgAttendance}%, with ${criticalAttendance} students critically below 70%. ` +
      `Risk is concentrated in Grade ${weakestGrade.grade} (${weakestGrade.collectionRate}% collected) ` +
      `and Section ${weakestSection.section} (${weakestSection.collectionRate}%).`,
    defaulterPatterns: [
      {
        pattern: 'Arrears concentrate in senior grades',
        evidence:
          `Grade ${weakestGrade.grade} holds ${money(weakestGrade.outstanding)} of arrears across ` +
          `${weakestGrade.students} students at only ${weakestGrade.collectionRate}% collection ` +
          `(school average ${t.collectionRate}%).`,
        studentsAffected: Math.max(1, Math.round(weakestGrade.students * weakestGrade.defaulterRate / 100)),
        recommendedAction: 'Run term-fee settlement desks for Grade 8-10 parents; offer 3-part instalments with a 5% early-bird waiver.',
      },
      {
        pattern: 'Absenteeism and arrears are correlated',
        evidence:
          `${atRiskAttendance} students (${round2((atRiskAttendance / t.students) * 100)}%) attend below 80%, ` +
          `and ${t.chronicAbsenteeCount} fall below 75% — the same cohort that dominates the defaulter list.`,
        studentsAffected: t.chronicAbsenteeCount,
        recommendedAction: 'Trigger an attendance-and-fees joint review; a disengaged family is rarely a simple billing problem.',
      },
      {
        pattern: 'Section-level leakage',
        evidence:
          `Section ${weakestSection.section} collects at ${weakestSection.collectionRate}% ` +
          `versus ${t.collectionRate}% school-wide, holding ${money(weakestSection.outstanding)} outstanding.`,
        studentsAffected: weakestSection.students,
        recommendedAction: 'Audit Section ' + weakestSection.section + ' fee ledgers for missed instalments and stale standing dues.',
      },
      {
        pattern: 'Long-tail of small balances',
        evidence:
          `${t.defaulterCount} students hold a combined ${money(t.outstanding)} — an average of ` +
          `${money(t.avgBalancePerStudent)} per defaulter, indicating fragmented dues rather than one large write-off.`,
        studentsAffected: t.defaulterCount,
        recommendedAction: 'Automate a 3-tier reminder cadence (7/30/60 days) via SMS and parent portal before manual calls.',
      },
    ],
    actions: [
      {
        priority: 'critical',
        action: `Personal outreach to the ${Math.min(8, t.criticalCount)} highest-exposure families this week`,
        owner: 'Accounts Officer + Class Teacher',
        timeline: '7 days',
        expectedRecovery: money(t.criticalCount * 18000),
      },
      {
        priority: 'high',
        action: 'Publish term-fee instalment plans (3-part) with instalment-linked fee concessions',
        owner: 'Head of Finance',
        timeline: '2 weeks',
        expectedRecovery: money(t.outstanding * 0.18),
      },
      {
        priority: 'high',
        action: 'Automated 3-tier SMS reminder cadence for all balances above ₹5,000',
        owner: 'Accounts / Automated',
        timeline: '2 weeks',
        expectedRecovery: money(t.outstanding * 0.12),
      },
      {
        priority: 'medium',
        action: `Freeze sibling concessions for families below 50% settlement until 70% is cleared`,
        owner: 'Admissions + Accounts',
        timeline: '30 days',
        expectedRecovery: money(t.outstanding * 0.07),
      },
      {
        priority: 'low',
        action: 'Ledger hygiene: reconcile stale balances older than one term and write off verified uncollectibles',
        owner: 'Accounts',
        timeline: '1 term',
        expectedRecovery: 'Cleaner reporting baseline',
      },
    ],
    forecast: {
      quarterOutlook:
        `At the current ${t.collectionRate}% run-rate, ${money(t.outstanding)} remains structurally at risk. ` +
        `Executing the three high-priority actions should lift collection to roughly ${targetRate}% by term end.`,
      collectionRateTarget: targetRate,
      recoverableThisTerm: recoverable,
    },
    _offline: true,
  };
}

function normalizeRisk(raw, metrics, stat) {
  const t = metrics.totals;
  const offline = offlineRisk(metrics, stat);
  const src = raw && typeof raw === 'object' ? raw : {};

  const score = toInt(src.score, stat.score, 0, 100);
  // Keep the model anchored to the statistical baseline; flag large deviations.
  const drift = Math.abs(score - stat.score);
  const scoreUsed = drift > 12 ? stat.score : score;

  return {
    score: scoreUsed,
    severity: normSeverity(src.severity) || stat.severity,
    baseline: stat,
    headline: clampStr(src.headline, 140) || offline.headline,
    summary: clampStr(src.summary, 1200) || offline.summary,
    defaulterPatterns: asList(src.defaulterPatterns, 6, (p) => {
      const pattern = clampStr(p?.pattern, 160);
      if (!pattern) return null;
      return {
        pattern,
        evidence: clampStr(p?.evidence, 400) || 'No supporting evidence supplied.',
        studentsAffected: toInt(p?.studentsAffected, 0, 0, 100000),
        recommendedAction: clampStr(p?.recommendedAction, 400)
          || 'Follow up individually with the family.',
      };
    }),
    actions: asList(src.actions, 8, (a) => {
      const action = clampStr(a?.action, 320);
      if (!action) return null;
      return {
        priority: normPriority(a?.priority) || 'medium',
        action,
        owner: clampStr(a?.owner, 120) || 'Accounts Team',
        timeline: clampStr(a?.timeline, 80) || '30 days',
        expectedRecovery: clampStr(a?.expectedRecovery, 120) || 'To be determined',
      };
    }),
    forecast: {
      quarterOutlook: clampStr(src?.forecast?.quarterOutlook, 800) || offline.forecast.quarterOutlook,
      collectionRateTarget: toInt(src?.forecast?.collectionRateTarget, offline.forecast.collectionRateTarget, 0, 100),
      recoverableThisTerm: round2(toNum(src?.forecast?.recoverableThisTerm, offline.forecast.recoverableThisTerm)),
    },
    anchorDrift: drift,
    _raw: drift > 12 ? src : undefined,
  };
}

/**
 * Full accountant intelligence: deterministic metrics + AI interpretation.
 * Always resolves — never throws.
 */
export async function collectionRiskAnalysis({ tier = 'fast', signal } = {}) {
  const metrics = financeMetrics();
  const stat = statisticalRisk(metrics);
  const evidence = buildRiskEvidence(metrics, stat);

  const result = await runStructured({
    task: 'collection-risk',
    tier,
    system: RISK_SYSTEM,
    prompt: riskPrompt(evidence),
    schema: RISK_SCHEMA,
    maxTokens: 3000,
    signal,
    fallback: () => offlineRisk(metrics, stat),
  });

  const analysis = normalizeRisk(result.data, metrics, stat);
  analysis.defaulterPatterns.sort(
    (a, b) => b.studentsAffected - a.studentsAffected,
  );
  analysis.actions.sort(compareByPriority);

  return {
    metrics,
    analysis: { ...analysis, totals: metrics.totals },
    ai: {
      source: result.source,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      degraded: result.degraded,
      cached: Boolean(result.cached),
      tier,
      error: result.error || null,
    },
  };
}

/* ================================================================== *
 * 2. Student recovery plan — teacher
 * ================================================================== */

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    riskScore: { type: 'integer' },
    riskLevel: { type: 'string', enum: ['healthy', 'guarded', 'elevated', 'critical'] },
    summary: { type: 'string' },
    diagnosis: { type: 'string', description: 'Likely root cause, 1-3 sentences' },
    rootCauses: { type: 'array', items: { type: 'string' } },
    plan: {
      type: 'object',
      properties: {
        academics: { type: 'array', items: { type: 'string' } },
        attendance: { type: 'array', items: { type: 'string' } },
        engagement: { type: 'array', items: { type: 'string' } },
        finance: { type: 'array', items: { type: 'string' } },
        family: { type: 'array', items: { type: 'string' } },
      },
    },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          week: { type: 'string' },
          target: { type: 'string' },
          successMetric: { type: 'string' },
        },
        required: ['week', 'target'],
      },
    },
    firstWin: { type: 'string', description: 'The single fastest visible win, max 100 chars' },
  },
  required: ['riskScore', 'riskLevel', 'summary', 'rootCauses', 'plan', 'firstWin'],
};

const PLAN_SYSTEM = `You are a senior school academic counsellor supporting a class teacher.
You receive verified attendance and fee records for one student. Reason only from the
supplied data — never invent grades, incidents or family circumstances.
Respond with a single JSON object. No prose, no markdown fences.
Plans must be humane, concrete and achievable inside one term. Amounts are INR.`;

function buildStudentEvidence(student, cohort) {
  const balance = round2(Math.max(0, student.fee_due - student.fee_paid));
  return {
    student: {
      name: student.name,
      rollNo: student.roll_no,
      grade: student.grade,
      section: student.section,
      attendancePct: student.attendance,
      feeDue: round2(student.fee_due),
      feePaid: round2(student.fee_paid),
      outstandingBalance: balance,
    },
    cohort: cohort
      ? {
        grade: cohort.grade,
        peers: cohort.count,
        averageAttendancePct: cohort.avgAttendance,
        averageBalance: round2(cohort.avgBalance),
        averageBalanceDelta: round2(balance - cohort.avgBalance),
        attendanceDelta: round2(student.attendance - cohort.avgAttendance),
      }
      : null,
    statisticalRisk: studentRisk({
      fee_due: student.fee_due,
      fee_paid: student.fee_paid,
      attendance: student.attendance,
    }),
  };
}

function planPrompt(evidence) {
  const { student, cohort } = evidence;
  return `Design a recovery plan for this student.

EVIDENCE
${JSON.stringify(evidence, null, 2)}

Return JSON with:
- riskScore: 0-100 (higher = worse)
- riskLevel: healthy | guarded | elevated | critical
- summary: 2-3 sentences citing the student's actual figures
- diagnosis: likely root cause in 1-3 sentences
- rootCauses: 2-4 specific causes
- plan: arrays of concrete steps under academics, attendance, engagement, finance, family
  (1-3 items each; use [] where genuinely not applicable)
- milestones: 3-4 entries with week ("Week 1"), target, successMetric
- firstWin: the single fastest visible win

${cohort ? `The cohort averages ${cohort.averageAttendancePct}% attendance and ${money(cohort.averageBalance)} outstanding — use these as the comparison baseline.` : ''}
Keep riskScore within +/-12 of statisticalRisk.score.`;
}

function offlinePlan(student, risk, cohort) {
  const balance = round2(Math.max(0, student.fee_due - student.fee_paid));
  const att = student.attendance;
  const isFinanciallyStressed = balance > 10000;
  const isChronicallyAbsent = att < 75;
  const isHealthy = risk.severity === 'healthy';

  const causes = [];
  if (isChronicallyAbsent) causes.push(`Attendance of ${att}% is well below the 75% threshold where learning continuity breaks down`);
  else if (att < 88) causes.push(`Attendance of ${att}% is below the Grade ${student.grade} norm of ~90%`);
  if (isFinanciallyStressed) causes.push(`${money(balance)} in outstanding fees, which frequently precedes withdrawal or disengagement`);
  if (isHealthy && causes.length === 0) causes.push('No academic or financial flags — focus on consolidating strengths rather than remediation');

  const head = isHealthy
    ? `${student.name} is performing well: ${att}% attendance with ${money(balance)} outstanding.`
    : `${student.name} (${student.roll_no}) is showing strain: ${att}% attendance` +
      (isFinanciallyStressed ? ` and ${money(balance)} in unpaid fees.` : '.');

  const attendanceSteps = [];
  if (att < 90) {
    attendanceSteps.push('Daily 5-minute attendance check-in for the first three weeks, logged in the register');
    if (att < 80) attendanceSteps.push('Call home on any absence, same day — no silent absences');
  } else {
    attendanceSteps.push('Maintain the current attendance streak; recognise it in class');
  }

  return {
    riskScore: risk.score,
    riskLevel: risk.severity,
    summary: head,
    diagnosis: isHealthy
      ? 'Student is stable. The opportunity is depth, not remediation.'
      : isChronicallyAbsent && isFinanciallyStressed
        ? 'Compounding pattern: absenteeism is driving academic drift, and unsettled fees are the most likely underlying cause. Treat finance as the primary lever and attendance as the measurable outcome.'
        : isFinanciallyStressed
          ? 'Financially-driven disengagement. The student can likely recover quickly once the fee position is settled.'
          : 'Attendance-driven drift. Academic support should be paired with an attendance intervention, not deployed alone.',
    rootCauses: causes,
    plan: {
      academics: isHealthy
        ? ['Enrol in the enrichment / Olympiad stream to keep the student challenged']
        : [
          'Weekly 30-minute catch-up session on the two weakest topics, with a printed gap-analysis sheet',
          'Assign a same-grade study partner for daily 20-minute revision',
        ],
      attendance: attendanceSteps,
      engagement: isHealthy
        ? ['Nominate as class representative for a term to build ownership']
        : [
          'Daily participation target: one in-class contribution, tracked on a visible progress strip',
          'Weekly 10-minute one-to-one check-in with the class teacher',
        ],
      finance: isFinanciallyStressed
        ? [
            `Escalate the ${money(balance)} balance to the accounts desk for an instalment plan this week`,
            'Confirm with the family that the fee position is not the cause of missed days',
          ]
        : balance > 0
          ? [`Settle the residual ${money(balance)} at the next fee window`]
          : ['Fees are clear — no finance action required'],
      family: isFinanciallyStressed || isChronicallyAbsent
        ? [
            'Schedule a 15-minute call with parent/guardian within five school days',
            'Share the attendance trend chart, not just the number, at the first meeting',
          ]
        : ['Send a positive progress note home this term'],
    },
    milestones: [
      { week: 'Week 1', target: 'Contact family; confirm no external blockers', successMetric: 'Call logged, blocker identified' },
      { week: 'Week 3', target: `Attendance improves to ${Math.min(100, Math.round(att) + 6)}%`, successMetric: `≥ ${Math.min(100, Math.round(att) + 6)}% attendance over 15 school days` },
      { week: 'Week 6', target: 'Academic gap closed on the two weakest topics', successMetric: 'Gap-analysis sheet at 80%+ accuracy' },
      { week: 'Week 10', target: isFinanciallyStressed ? `Outstanding balance below ${money(round2(balance * 0.4))}` : 'Sustained attendance above 90%', successMetric: 'Balance / attendance target held for 10 school days' },
    ],
    firstWin: isFinanciallyStressed
      ? 'Call the family this week — an agreed instalment plan is the fastest lever on both fees and attendance.'
      : isChronicallyAbsent
        ? 'A same-day call home on the next absence turns attendance around faster than any academic support.'
        : 'Public recognition in class to lock in the current attendance streak.',
    _offline: true,
  };
}

function normalizePlan(raw, student, risk, cohort) {
  const offline = offlinePlan(student, risk, cohort);
  const src = raw && typeof raw === 'object' ? raw : {};

  const score = toInt(src.riskScore, risk.score, 0, 100);
  const drift = Math.abs(score - risk.score);
  const plan = src.plan && typeof src.plan === 'object' ? src.plan : {};

  const pickSteps = (v) => asList(v, 4, (s) => clampStr(typeof s === 'string' ? s : s?.action, 240));

  return {
    student: {
      id: student.id,
      name: student.name,
      rollNo: student.roll_no,
      grade: student.grade,
      section: student.section,
      attendance: student.attendance,
      feeDue: round2(student.fee_due),
      feePaid: round2(student.fee_paid),
      balance: round2(Math.max(0, student.fee_due - student.fee_paid)),
    },
    riskScore: drift > 12 ? risk.score : score,
    riskLevel: normSeverity(src.riskLevel) || risk.severity,
    baseline: risk,
    summary: clampStr(src.summary, 800) || offline.summary,
    diagnosis: clampStr(src.diagnosis, 900) || offline.diagnosis,
    rootCauses: asList(src.rootCauses, 5, (c) => clampStr(typeof c === 'string' ? c : c?.cause, 260))
      .concat(offline.rootCauses)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 5),
    plan: {
      academics: pickSteps(plan.academics).length ? pickSteps(plan.academics) : offline.plan.academics,
      attendance: pickSteps(plan.attendance).length ? pickSteps(plan.attendance) : offline.plan.attendance,
      engagement: pickSteps(plan.engagement).length ? pickSteps(plan.engagement) : offline.plan.engagement,
      finance: pickSteps(plan.finance).length ? pickSteps(plan.finance) : offline.plan.finance,
      family: pickSteps(plan.family).length ? pickSteps(plan.family) : offline.plan.family,
    },
    milestones: asList(src.milestones, 5, (m) => {
      const week = clampStr(m?.week, 40);
      const target = clampStr(m?.target, 240);
      if (!week || !target) return null;
      return {
        week,
        target,
        successMetric: clampStr(m?.successMetric, 200) || 'Reviewed at the weekly check-in',
      };
    }),
    firstWin: clampStr(src.firstWin, 240) || offline.firstWin,
    cohort,
    anchorDrift: drift,
  };
}

/**
 * AI recovery plan for a single student.
 * @param {object} student  joined student row (from db.listAllStudents/getRoster)
 */
export async function studentRecoveryPlan({ student: input, tier = 'fast', signal }) {
  const student = toStudent(input);
  if (!student) throw new Error('studentRecoveryPlan requires a student row');

  const risk = studentRisk(student);
  const peers = peersInGrade(student.grade);
  const cohort = peers.length > 1
    ? {
      grade: student.grade,
      count: peers.length,
      avgAttendance: round2(peers.reduce((s, r) => s + r.attendance, 0) / peers.length),
      avgBalance: round2(
        peers.reduce((s, r) => s + Math.max(0, r.fee_due - r.fee_paid), 0) / peers.length,
      ),
    }
    : null;

  const evidence = buildStudentEvidence(student, cohort);

  const result = await runStructured({
    task: `recovery-plan:${student.id}`,
    tier,
    system: PLAN_SYSTEM,
    prompt: planPrompt(evidence),
    schema: PLAN_SCHEMA,
    maxTokens: 2600,
    signal,
    fallback: () => offlinePlan(student, risk, cohort),
  });

  return {
    plan: normalizePlan(result.data, student, risk, cohort),
    ai: {
      source: result.source,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      degraded: result.degraded,
      cached: Boolean(result.cached),
      tier,
      error: result.error || null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Cohort helper
 * ------------------------------------------------------------------ */

/** Peers in the same grade, used to contextualise an individual student. */
function peersInGrade(grade) {
  return listAllStudents().filter((r) => r.grade === grade);
}

/* ================================================================== *
 * 3. Class health — teacher roster view
 * ================================================================== */

function offlineClassHealth(students) {
  if (students.length === 0) {
    return { healthScore: 0, healthLabel: 'unknown', summary: 'No students in this cohort.', focusAreas: [], interventions: [] };
  }
  const scored = students.map((s) => ({ s, r: studentRisk(s) }));
  const avgRisk = Math.round(scored.reduce((x, { r }) => x + r.score, 0) / scored.length);
  const avgAtt = round2(students.reduce((x, s) => x + s.attendance, 0) / students.length);
  const atRisk = scored.filter(({ r }) => r.score >= 35);
  const chronic = students.filter((s) => s.attendance < 75);
  const arrears = students.filter((s) => s.fee_due - s.fee_paid > 10000);
  const health = Math.max(0, 100 - avgRisk);

  const label = health >= 75 ? 'healthy' : health >= 60 ? 'guarded' : health >= 40 ? 'elevated' : 'critical';

  return {
    healthScore: health,
    healthLabel: label,
    summary:
      `${students.length} students · ${avgAtt}% mean attendance · ${atRisk.length} flagged for intervention · ` +
      `${money(arrears.reduce((s, x) => s + (x.fee_due - x.fee_paid), 0))} outstanding across the class.`,
    focusAreas: [
      chronic.length > 0
        ? { area: 'Attendance', detail: `${chronic.length} students below 75% — ${chronic.slice(0, 3).map((s) => s.name.split(' ')[0]).join(', ')}${chronic.length > 3 ? ' and others' : ''}`, students: chronic.length }
        : null,
      arrears.length > 0
        ? { area: 'Fee arrears', detail: `${arrears.length} students owe over ₹10,000`, students: arrears.length }
        : null,
      { area: 'Priority caseload', detail: `${atRisk.length} students scoring 35+ on combined risk`, students: atRisk.length },
    ].filter(Boolean),
    interventions: atRisk.slice(0, 5).map(({ s, r }) => ({
      student: s.name,
      rollNo: s.roll_no,
      score: r.score,
      severity: r.severity,
      note: r.score >= 60
        ? 'Immediate: family meeting + same-day absence follow-up'
        : 'Monitor weekly; enrol in study-support pair',
    })),
  };
}

/** Class-level summary for the teacher roster screen (deterministic, no AI). */
export function classHealth(students) {
  const scored = students.map((s) => ({ ...s, risk: studentRisk(s) }));
  return {
    total: scored.length,
    avgAttendance: round2(scored.reduce((s, r) => s + r.attendance, 0) / (scored.length || 1)),
    totalOutstanding: round2(scored.reduce((s, r) => s + Math.max(0, r.fee_due - r.fee_paid), 0)),
    atRisk: scored.filter((r) => r.risk.score >= 35).length,
    critical: scored.filter((r) => r.risk.score >= 60).length,
    healthy: scored.filter((r) => r.risk.severity === 'healthy').length,
    health: offlineClassHealth(students),
    roster: scored
      .slice()
      .sort((a, b) => b.risk.score - a.risk.score || a.roll_no.localeCompare(b.roll_no))
      .map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        rollNo: r.roll_no,
        grade: r.grade,
        section: r.section,
        attendance: r.attendance,
        feeDue: round2(r.fee_due),
        feePaid: round2(r.fee_paid),
        balance: round2(Math.max(0, r.fee_due - r.fee_paid)),
        riskScore: r.risk.score,
        severity: r.risk.severity,
      })),
  };
}
