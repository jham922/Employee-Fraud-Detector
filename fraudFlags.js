/**
 * Fraud flagging engine for Toast POS employee data.
 * Input:  unified employee array from parseToastData()
 * Output: same array, each record augmented with { flags, riskLevel }, sorted high → medium → clean
 */

// ---------------------------------------------------------------------------
// Default thresholds (exported so the UI can read and persist them)
// ---------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS = {
  voidWarn:       0.08,   // FLAG 1 warning  — void amount / gross sales
  voidCrit:       0.15,   // FLAG 1 critical
  discountWarn:   0.10,   // FLAG 2 warning  — discount amount / gross sales
  discountCrit:   0.20,   // FLAG 2 critical
  salesBelow:     0.30,   // FLAG 3          — deviation below role avg net sales/shift
  noSaleRate:     0.05,   // FLAG 4          — no-sale opens / total checks
  refundMinCount: 3,      // FLAG 5 guard    — minimum refund count before rate is checked
  refundRate:     0.05,   // FLAG 5          — refund amount / net sales
  trendRisePct:   0.03,   // FLAG 6          — pp rise in void or discount rate vs prior period
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(ratio) { return (ratio * 100).toFixed(1) + '%'; }
function fmt(dollars) { return '$' + Math.abs(dollars).toFixed(2); }

function countNoSaleRecords(emp) {
  return [...emp.voidDetails, ...emp.discountDetails].filter(r => /no.?sale/i.test(r.type)).length;
}

/**
 * Build per-role avg net-sales/shift stats for FLAG 3.
 * Only single-job employees are included so combined-role stats don't skew averages.
 */
function buildRoleStats(employees) {
  const groups = new Map();

  for (const emp of employees) {
    if (emp.jobs.length !== 1 || emp.shifts <= 0) continue;
    const job = emp.jobs[0];
    if (!groups.has(job)) groups.set(job, { total: 0, count: 0 });
    const g = groups.get(job);
    g.total += emp.netSales / emp.shifts;
    g.count++;
  }

  const stats = new Map();
  for (const [job, { total, count }] of groups) {
    stats.set(job, { avgNetSalesPerShift: count > 0 ? total / count : 0, count });
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Flag evaluators — each accepts (emp, thresholds, [roleStats])
// ---------------------------------------------------------------------------

function flag1_voidRate(emp, t) {
  if (emp.grossSales <= 0) return null;
  const rate = emp.voidAmount / emp.grossSales;
  if (rate > t.voidCrit) return {
    flag: 1, label: 'High void rate', severity: 'critical', rate,
    detail: `Voids are ${pct(rate)} of gross sales (${fmt(emp.voidAmount)} / ${fmt(emp.grossSales)})`,
  };
  if (rate > t.voidWarn) return {
    flag: 1, label: 'High void rate', severity: 'warning', rate,
    detail: `Voids are ${pct(rate)} of gross sales (${fmt(emp.voidAmount)} / ${fmt(emp.grossSales)})`,
  };
  return null;
}

function flag2_discountRate(emp, t) {
  if (emp.grossSales <= 0) return null;
  const rate = emp.discountAmount / emp.grossSales;
  if (rate > t.discountCrit) return {
    flag: 2, label: 'High discount rate', severity: 'critical', rate,
    detail: `Discounts are ${pct(rate)} of gross sales (${fmt(emp.discountAmount)} / ${fmt(emp.grossSales)})`,
  };
  if (rate > t.discountWarn) return {
    flag: 2, label: 'High discount rate', severity: 'warning', rate,
    detail: `Discounts are ${pct(rate)} of gross sales (${fmt(emp.discountAmount)} / ${fmt(emp.grossSales)})`,
  };
  return null;
}

function flag3_salesBelowPeers(emp, roleStats, t) {
  if (emp.jobs.length !== 1 || emp.shifts <= 0) return null;
  const stats = roleStats.get(emp.jobs[0]);
  if (!stats || stats.count < 2 || stats.avgNetSalesPerShift <= 0) return null;

  const empPerShift = emp.netSales / emp.shifts;
  const deviation = (stats.avgNetSalesPerShift - empPerShift) / stats.avgNetSalesPerShift;

  if (deviation > t.salesBelow) return {
    flag: 3, label: 'Sales below peers', severity: 'warning', deviation,
    detail: `${fmt(empPerShift)}/shift vs peer avg ${fmt(stats.avgNetSalesPerShift)}/shift for ${emp.jobs[0]} (${pct(deviation)} below)`,
  };
  return null;
}

function flag4_noSaleRate(emp, t) {
  if (emp.checks <= 0) return null;
  const noSaleCount = countNoSaleRecords(emp);
  if (noSaleCount === 0) return null;
  const rate = noSaleCount / emp.checks;
  if (rate > t.noSaleRate) return {
    flag: 4, label: 'High no-sale open rate', severity: 'warning', rate,
    detail: `${noSaleCount} no-sale opens on ${emp.checks} transactions (${pct(rate)})`,
  };
  return null;
}

function flag5_refundAnomaly(emp, t) {
  if (emp.refundCount <= t.refundMinCount || emp.netSales <= 0) return null;
  const rate = Math.abs(emp.refundAmount) / emp.netSales;
  if (rate > t.refundRate) return {
    flag: 5, label: 'Refund anomaly', severity: 'warning', rate,
    detail: `${emp.refundCount} refunds totalling ${fmt(emp.refundAmount)} (${pct(rate)} of net sales)`,
  };
  return null;
}

// Returns an array (0-2 items) so both void-trend and discount-trend can fire independently.
function flag6_trendRising(emp, t) {
  if (!emp.trend?.hasPrior) return [];
  const results = [];
  const { voidRateDelta, discountRateDelta, prevVoidRate, prevDiscountRate } = emp.trend;

  if (voidRateDelta !== null && voidRateDelta > t.trendRisePct) {
    results.push({
      flag: 6, label: 'Void rate rising', severity: 'warning', delta: voidRateDelta,
      detail: `Void rate up ${pct(voidRateDelta)} vs prior period (was ${prevVoidRate !== null ? pct(prevVoidRate) : '—'})`,
    });
  }
  if (discountRateDelta !== null && discountRateDelta > t.trendRisePct) {
    results.push({
      flag: 6, label: 'Discount rate rising', severity: 'warning', delta: discountRateDelta,
      detail: `Discount rate up ${pct(discountRateDelta)} vs prior period (was ${prevDiscountRate !== null ? pct(prevDiscountRate) : '—'})`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const RISK_ORDER = { high: 0, medium: 1, clean: 2 };

/**
 * Score each employee for fraud indicators and return the array sorted by risk.
 *
 * @param {import('./parseToastCSV.js').EmployeeRecord[]} employees
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @returns {ScoredEmployee[]}
 */
export function scoreFraud(employees, thresholds = DEFAULT_THRESHOLDS) {
  const t         = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const roleStats = buildRoleStats(employees);

  const scored = employees.map(emp => {
    const flags = [
      flag1_voidRate(emp, t),
      flag2_discountRate(emp, t),
      flag3_salesBelowPeers(emp, roleStats, t),
      flag4_noSaleRate(emp, t),
      flag5_refundAnomaly(emp, t),
      ...flag6_trendRising(emp, t),
    ].filter(Boolean);

    const hasCritical = flags.some(f => f.severity === 'critical');
    const riskLevel   = hasCritical ? 'high' : flags.length > 0 ? 'medium' : 'clean';

    return { ...emp, flags, riskLevel };
  });

  scored.sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);
  return scored;
}
