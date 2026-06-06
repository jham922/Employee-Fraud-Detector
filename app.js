import { parseToastData }                  from './parseToastCSV.js';
import { scoreFraud, DEFAULT_THRESHOLDS }  from './fraudFlags.js';

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY      = 'fraud-detector-thresholds';
const RESTAURANT_KEY   = 'fraud-detector-restaurant';
const RISK_ORDER       = { high: 0, medium: 1, clean: 2 };

const SLIDER_CFG = {
  voidWarn:       { min: 1,  max: 30, step: 0.5, isPct: true,  fill: 'var(--amber)' },
  voidCrit:       { min: 5,  max: 50, step: 0.5, isPct: true,  fill: 'var(--red)'   },
  discountWarn:   { min: 1,  max: 40, step: 0.5, isPct: true,  fill: 'var(--amber)' },
  discountCrit:   { min: 5,  max: 60, step: 0.5, isPct: true,  fill: 'var(--red)'   },
  salesBelow:     { min: 10, max: 60, step: 5,   isPct: true,  fill: 'var(--amber)' },
  noSaleRate:     { min: 1,  max: 20, step: 0.5, isPct: true,  fill: 'var(--amber)' },
  trendRisePct:   { min: 1,  max: 15, step: 0.5, isPct: true,  fill: 'var(--amber)' },
  refundMinCount: { min: 1,  max: 10, step: 1,   isPct: false, fill: 'var(--blue)'  },
  refundRate:     { min: 1,  max: 20, step: 0.5, isPct: true,  fill: 'var(--amber)' },
};

// ── State ────────────────────────────────────────────────────────────────────

let rawEmployees      = [];
let employees         = [];
let salesText         = null;
let voidsText         = null;
let priorSalesText    = null;
let priorVoidsText    = null;
let salesFileName     = '';
let voidsFileName     = '';
let priorSalesFileName = '';
let priorVoidsFileName = '';
let sortCol           = 'riskLevel';
let sortDir           = 'asc';
let chartSales        = null;
let chartRates        = null;
let chartTrend        = null;
let thresholds        = loadThresholds();

// ── localStorage ─────────────────────────────────────────────────────────────

function loadThresholds() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? { ...DEFAULT_THRESHOLDS, ...JSON.parse(s) } : { ...DEFAULT_THRESHOLDS };
  } catch { return { ...DEFAULT_THRESHOLDS }; }
}

function saveThresholds() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(thresholds)); } catch { /* quota */ }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtDollars(n) {
  if (!n && n !== 0) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(ratio, decimals = 1) {
  if (ratio === null || ratio === undefined || isNaN(ratio)) return '—';
  return (ratio * 100).toFixed(decimals) + '%';
}

function rateClass(rate, warnT, critT) {
  if (rate === null || rate === undefined || isNaN(rate)) return 'cell-na';
  if (rate > critT)  return 'cell-crit';
  if (rate > warnT)  return 'cell-warn';
  return 'cell-clean';
}

function statClass(rate, warnT, critT) {
  if (rate === null || rate === undefined || isNaN(rate)) return '';
  if (rate > critT)  return 'sv-crit';
  if (rate > warnT)  return 'sv-warn';
  return 'sv-clean';
}

// All user-supplied CSV values pass through esc() before innerHTML insertion.
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Trend helpers ─────────────────────────────────────────────────────────────

/**
 * Merge current and prior employee arrays by normalised name.
 * Attaches a `.trend` object to each current employee.
 */
function computeTrends(current, prior) {
  if (!prior || prior.length === 0) {
    return current.map(e => ({ ...e, trend: null }));
  }

  const priorMap = new Map(prior.map(e => [e.employeeName.trim().toLowerCase(), e]));

  return current.map(emp => {
    const p = priorMap.get(emp.employeeName.trim().toLowerCase());
    if (!p) return { ...emp, trend: { hasPrior: false } };

    const curVR  = emp.grossSales  > 0 ? emp.voidAmount     / emp.grossSales  : null;
    const curDR  = emp.grossSales  > 0 ? emp.discountAmount / emp.grossSales  : null;
    const prevVR = p.grossSales    > 0 ? p.voidAmount       / p.grossSales    : null;
    const prevDR = p.grossSales    > 0 ? p.discountAmount   / p.grossSales    : null;

    return {
      ...emp,
      trend: {
        hasPrior:          true,
        voidRateDelta:     curVR  !== null && prevVR !== null ? curVR  - prevVR : null,
        discountRateDelta: curDR  !== null && prevDR !== null ? curDR  - prevDR : null,
        netSalesDelta:     p.netSales != null ? emp.netSales - p.netSales : null,
        prevVoidRate:      prevVR,
        prevDiscountRate:  prevDR,
        prevNetSales:      p.netSales,
      },
    };
  });
}

const NOISE_FLOOR = 0.001; // ignore deltas < 0.1pp

/**
 * Returns an HTML span with the trend arrow, or '' if no trend data.
 * delta is a ratio (e.g. 0.05 means +5pp).
 * title shows the full pp change on hover.
 */
function trendArrow(delta) {
  if (delta === null || delta === undefined) return '';
  const ppStr = (Math.abs(delta) * 100).toFixed(1) + 'pp';
  if (delta > NOISE_FLOOR)  return `<span class="trend trend-up"   title="+${ppStr} vs prior period">↑</span>`;
  if (delta < -NOISE_FLOOR) return `<span class="trend trend-down" title="−${ppStr} vs prior period">↓</span>`;
  return `<span class="trend trend-flat" title="No change vs prior period">→</span>`;
}

// ── Count-up animation ────────────────────────────────────────────────────────

function animateCount(el, target) {
  const dur = 600, t0 = performance.now();
  const tick = ts => {
    const p = Math.min((ts - t0) / dur, 1);
    el.textContent = Math.round((1 - Math.pow(1 - p, 3)) * target);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsText(file);
  });
}

// ── Upload cards ──────────────────────────────────────────────────────────────

function setupCard(cardId, inputId, onFile) {
  const card  = document.getElementById(cardId);
  const input = document.getElementById(inputId);
  card.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => { if (input.files[0]) await onFile(input.files[0]); input.value = ''; });
  card.addEventListener('dragover',  e => { e.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); });
  card.addEventListener('drop', async e => {
    e.preventDefault(); card.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) await onFile(e.dataTransfer.files[0]);
  });
}

function makeFileHandler(cardId, fnameId, setter, fileNameSetter, enableRunOnLoad = false) {
  return async function(file) {
    try {
      const text = await readFile(file);
      setter(text); fileNameSetter(file.name);
      document.getElementById(cardId).classList.add('loaded');
      document.getElementById(fnameId).textContent = file.name;
      if (enableRunOnLoad) document.getElementById('run-btn').disabled = false;
      clearErr();
    } catch { showErr('Could not read ' + file.name); }
  };
}

function showErr(msg) { document.getElementById('upload-error').textContent = msg; }
function clearErr()   { document.getElementById('upload-error').textContent = ''; }

// ── Analysis ──────────────────────────────────────────────────────────────────

function runAnalysis() {
  try {
    clearErr();
    const current = parseToastData(salesText, voidsText       ?? undefined);
    const prior   = priorSalesText
      ? parseToastData(priorSalesText, priorVoidsText ?? undefined)
      : [];

    rawEmployees = computeTrends(current, prior);
    render(scoreFraud(rawEmployees, thresholds));
  } catch (e) {
    showErr('Parse error: ' + e.message);
  }
}

// ── Re-render on threshold change ─────────────────────────────────────────────

let _raf = null;
function scheduleRerender() {
  if (_raf) cancelAnimationFrame(_raf);
  _raf = requestAnimationFrame(() => {
    _raf = null;
    if (rawEmployees.length === 0) return;
    const scored = scoreFraud(rawEmployees, thresholds);
    employees = scored;
    renderSummary(scored);
    renderAlerts(scored);
    renderTable(scored);
    renderCharts(scored);
  });
}

// ── Root render ───────────────────────────────────────────────────────────────

function render(scored) {
  employees = scored;
  document.getElementById('upload-screen').hidden = true;
  document.getElementById('dashboard').hidden = false;

  const chipS = document.getElementById('chip-sales');
  chipS.textContent = salesFileName || 'Sales CSV';
  chipS.classList.toggle('loaded', !!salesText);
  const chipV = document.getElementById('chip-voids');
  chipV.textContent = voidsFileName || 'Voids CSV';
  chipV.classList.toggle('loaded', !!voidsText);

  renderSummary(scored);
  renderAlerts(scored);
  renderTable(scored, true);
  renderCharts(scored);
}

// ── Section 1: Summary ────────────────────────────────────────────────────────

function renderSummary(scored) {
  const total   = scored.length;
  const flagged = scored.filter(e => e.riskLevel !== 'clean').length;
  const high    = scored.filter(e => e.riskLevel === 'high').length;
  const clean   = scored.filter(e => e.riskLevel === 'clean').length;

  document.getElementById('summary').innerHTML = `
    <div class="metric-card">
      <div class="metric-value" id="mc-total">0</div>
      <div class="metric-label">Total Employees</div>
    </div>
    <div class="metric-card card-amber">
      <div class="metric-value v-amber" id="mc-flagged">0</div>
      <div class="metric-label">Flagged</div>
    </div>
    <div class="metric-card card-red">
      <div class="metric-value v-red" id="mc-high">0</div>
      <div class="metric-label">High Risk</div>
    </div>
    <div class="metric-card card-green">
      <div class="metric-value v-green" id="mc-clean">0</div>
      <div class="metric-label">Clean</div>
    </div>
  `;

  animateCount(document.getElementById('mc-total'),   total);
  animateCount(document.getElementById('mc-flagged'), flagged);
  animateCount(document.getElementById('mc-high'),    high);
  animateCount(document.getElementById('mc-clean'),   clean);
}

// ── Section 2: Alert cards ────────────────────────────────────────────────────

function renderAlerts(scored) {
  const flagged = scored.filter(e => e.riskLevel !== 'clean');
  const badge   = document.getElementById('alert-badge');
  badge.textContent = String(flagged.length);
  badge.hidden = flagged.length === 0;

  const el = document.getElementById('alerts');
  if (flagged.length === 0) {
    el.innerHTML = `<div class="no-alerts">✓ No suspicious activity detected across ${scored.length} employees.</div>`;
    return;
  }

  el.innerHTML = flagged.map((emp, i) => {
    const vr = emp.grossSales > 0 ? emp.voidAmount     / emp.grossSales : null;
    const dr = emp.grossSales > 0 ? emp.discountAmount / emp.grossSales : null;
    const t  = emp.trend;

    const vrArrow = t?.hasPrior ? trendArrow(t.voidRateDelta)     : '';
    const drArrow = t?.hasPrior ? trendArrow(t.discountRateDelta) : '';

    // Prior-period tooltip on the stat value
    const vrTitle = t?.hasPrior && t.prevVoidRate     !== null ? ` title="Prior: ${fmtPct(t.prevVoidRate)}"` : '';
    const drTitle = t?.hasPrior && t.prevDiscountRate !== null ? ` title="Prior: ${fmtPct(t.prevDiscountRate)}"` : '';

    return `
      <div class="alert-card ${emp.riskLevel}" style="animation-delay:${i * 0.045}s">
        <div class="alert-header">
          <div>
            <span class="alert-name">${esc(emp.employeeName)}</span>
            <span class="alert-job">${esc(emp.jobs.join(' · ') || 'No role')}</span>
          </div>
          <span class="badge badge-${emp.riskLevel}">${emp.riskLevel.toUpperCase()}</span>
        </div>
        <div class="alert-flags">
          ${emp.flags.map(f => `
            <span class="flag-pill ${f.severity}" title="${esc(f.detail)}">
              <span class="flag-num">F${f.flag}</span>${esc(f.label)}
            </span>
          `).join('')}
        </div>
        <div class="alert-stats">
          <div>
            <span class="stat-label">Net Sales</span>
            <span class="stat-value">${fmtDollars(emp.netSales)}</span>
          </div>
          <div>
            <span class="stat-label">Void Rate</span>
            <span class="stat-value ${statClass(vr, thresholds.voidWarn, thresholds.voidCrit)}"${vrTitle}>${fmtPct(vr)}${vrArrow}</span>
          </div>
          <div>
            <span class="stat-label">Discount %</span>
            <span class="stat-value ${statClass(dr, thresholds.discountWarn, thresholds.discountCrit)}"${drTitle}>${fmtPct(dr)}${drArrow}</span>
          </div>
          <div>
            <span class="stat-label">Shifts</span>
            <span class="stat-value">${emp.shifts}</span>
          </div>
        </div>
        <div class="alert-details">
          ${emp.flags.map(f => `<div class="flag-detail ${f.severity}">▸ ${esc(f.detail)}</div>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// ── Section 3: Table ──────────────────────────────────────────────────────────

const COLS = [
  { key: 'employeeName', label: 'Employee'      },
  { key: 'jobs',         label: 'Role'          },
  { key: 'netSales',     label: 'Net Sales'     },
  { key: 'voidRate',     label: 'Void Rate'     },
  { key: 'discountRate', label: 'Discount Rate' },
  { key: 'riskLevel',    label: 'Risk'          },
];

function getSortedRows() {
  return [...employees].sort((a, b) => {
    let av, bv;
    switch (sortCol) {
      case 'employeeName':  av = a.employeeName;        bv = b.employeeName;        break;
      case 'jobs':          av = a.jobs[0] ?? '';        bv = b.jobs[0] ?? '';        break;
      case 'netSales':      av = a.netSales;             bv = b.netSales;             break;
      case 'voidRate':      av = a.grossSales > 0 ? a.voidAmount     / a.grossSales : 0;
                            bv = b.grossSales > 0 ? b.voidAmount     / b.grossSales : 0; break;
      case 'discountRate':  av = a.grossSales > 0 ? a.discountAmount / a.grossSales : 0;
                            bv = b.grossSales > 0 ? b.discountAmount / b.grossSales : 0; break;
      case 'riskLevel':     av = RISK_ORDER[a.riskLevel]; bv = RISK_ORDER[b.riskLevel]; break;
      default: return 0;
    }
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });
}

function renderTable(scored, resetSort = false) {
  if (resetSort) { sortCol = 'riskLevel'; sortDir = 'asc'; }

  const rows = getSortedRows();
  const wrap = document.getElementById('table-wrap');

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        ${COLS.map(c => `
          <th class="sortable ${sortCol === c.key ? 'th-active' : ''}" data-col="${c.key}">
            ${c.label}<span class="sort-arrow">${sortCol === c.key ? (sortDir === 'asc' ? '↑' : '↓') : '⇅'}</span>
          </th>
        `).join('')}
      </tr></thead>
      <tbody>
        ${rows.map(emp => {
          const vr = emp.grossSales > 0 ? emp.voidAmount     / emp.grossSales : null;
          const dr = emp.grossSales > 0 ? emp.discountAmount / emp.grossSales : null;
          const t  = emp.trend;

          const vrArrow = t?.hasPrior ? trendArrow(t.voidRateDelta)     : '';
          const drArrow = t?.hasPrior ? trendArrow(t.discountRateDelta) : '';
          const vrTitle = t?.hasPrior && t.prevVoidRate     !== null ? ` title="Prior: ${fmtPct(t.prevVoidRate)}"` : '';
          const drTitle = t?.hasPrior && t.prevDiscountRate !== null ? ` title="Prior: ${fmtPct(t.prevDiscountRate)}"` : '';

          return `
            <tr>
              <td class="td-name">${esc(emp.employeeName)}</td>
              <td class="td-role">${esc(emp.jobs.join(', ') || '—')}</td>
              <td class="td-num">${fmtDollars(emp.netSales)}</td>
              <td class="td-rate ${rateClass(vr, thresholds.voidWarn, thresholds.voidCrit)}"${vrTitle}>${fmtPct(vr)}${vrArrow}</td>
              <td class="td-rate ${rateClass(dr, thresholds.discountWarn, thresholds.discountCrit)}"${drTitle}>${fmtPct(dr)}${drArrow}</td>
              <td><span class="badge badge-${emp.riskLevel}">${emp.riskLevel.toUpperCase()}</span></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : (col === 'riskLevel' ? 'asc' : 'desc');
      sortCol = col;
      renderTable(employees);
    });
  });
}

// ── Section 4: Charts ─────────────────────────────────────────────────────────

const CHART_FONT_MONO = { family: "'JetBrains Mono', monospace", size: 10 };
const CHART_FONT_HEAD = { family: "'Barlow Condensed', sans-serif", size: 12, weight: '500' };
const GRID_COLOR = 'rgba(255,255,255,0.04)';
const AXIS_COLOR = '#1c2535';

const TOOLTIP_BASE = {
  backgroundColor: '#111820', borderColor: '#1c2535', borderWidth: 1,
  titleColor: '#dde3ef', bodyColor: '#7a8899', padding: 10,
  titleFont: { family: "'Barlow Condensed', sans-serif", size: 14, weight: '700' },
  bodyFont:  { family: "'JetBrains Mono', monospace", size: 11 },
};

function barColorForRate(rate, warnT, critT) {
  if (rate > critT) return 'rgba(224,82,82,0.82)';
  if (rate > warnT) return 'rgba(217,119,6,0.82)';
  return 'rgba(34,197,94,0.55)';
}

function renderCharts(scored) {
  if (chartSales) { chartSales.destroy(); chartSales = null; }
  if (chartRates) { chartRates.destroy(); chartRates = null; }
  if (chartTrend) { chartTrend.destroy(); chartTrend = null; }

  const byRisk = [...scored].sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);
  const names  = byRisk.map(e => e.employeeName);
  const n      = byRisk.length;
  const short  = names.map(name => {
    const p = name.trim().split(/\s+/);
    return p.length > 1 ? p[0][0] + '. ' + p.slice(1).join(' ') : name;
  });

  const hasTrend = byRisk.some(e => e.trend?.hasPrior);

  // ── Chart 1: Net Sales ────────────────────────────────────────────────────

  const wrap1 = document.getElementById('chart-sales-wrap');
  wrap1.style.height = Math.max(280, n * 30 + 60) + 'px';
  wrap1.innerHTML = '<canvas id="chart-sales"></canvas>';

  chartSales = new Chart(document.getElementById('chart-sales'), {
    type: 'bar',
    data: {
      labels: names,
      datasets: [{
        label: 'Net Sales',
        data: byRisk.map(e => e.netSales),
        backgroundColor: byRisk.map(e =>
          e.riskLevel === 'high'   ? 'rgba(224,82,82,0.82)'  :
          e.riskLevel === 'medium' ? 'rgba(217,119,6,0.82)'  :
                                     'rgba(74,158,255,0.72)'
        ),
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...TOOLTIP_BASE, callbacks: { label: ctx => '  ' + fmtDollars(ctx.raw) } },
      },
      scales: {
        x: {
          grid: { color: GRID_COLOR }, border: { color: AXIS_COLOR },
          ticks: { color: '#3f5068', font: CHART_FONT_MONO,
                   callback: v => v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v },
        },
        y: { grid: { display: false }, border: { color: AXIS_COLOR }, ticks: { color: '#dde3ef', font: CHART_FONT_HEAD } },
      },
    },
  });

  // ── Chart 2: Void & Discount Rates ───────────────────────────────────────

  const wrap2 = document.getElementById('chart-rates-wrap');
  wrap2.style.height = '300px';
  wrap2.innerHTML = '<canvas id="chart-rates"></canvas>';

  const vRates = byRisk.map(e => e.grossSales > 0 ? +(e.voidAmount     / e.grossSales * 100).toFixed(2) : 0);
  const dRates = byRisk.map(e => e.grossSales > 0 ? +(e.discountAmount / e.grossSales * 100).toFixed(2) : 0);

  const vWarnPct = thresholds.voidWarn     * 100;
  const vCritPct = thresholds.voidCrit     * 100;
  const dWarnPct = thresholds.discountWarn * 100;
  const dCritPct = thresholds.discountCrit * 100;

  const threshLine = (val, color, dash) => ({
    type: 'line', data: Array(n).fill(val),
    borderColor: color, borderDash: dash, borderWidth: 1,
    pointRadius: 0, fill: false, order: 0,
  });

  // If prior data is available, overlay ghost bars for comparison
  const priorVRates = hasTrend ? byRisk.map(e => {
    const pv = e.trend?.prevVoidRate;
    return pv !== null && pv !== undefined ? +(pv * 100).toFixed(2) : 0;
  }) : null;
  const priorDRates = hasTrend ? byRisk.map(e => {
    const pd = e.trend?.prevDiscountRate;
    return pd !== null && pd !== undefined ? +(pd * 100).toFixed(2) : 0;
  }) : null;

  const ratesDatasets = [
    {
      label: 'Void Rate %',
      data: vRates,
      backgroundColor: vRates.map(r => barColorForRate(r, vWarnPct, vCritPct)),
      borderRadius: 3, order: 1,
    },
    {
      label: 'Discount Rate %',
      data: dRates,
      backgroundColor: dRates.map(r => barColorForRate(r, dWarnPct, dCritPct)),
      borderRadius: 3, order: 1,
    },
  ];

  if (hasTrend) {
    ratesDatasets.push(
      {
        label: 'Void Rate % (prior)',
        data: priorVRates,
        backgroundColor: 'rgba(224,82,82,0.18)',
        borderColor: 'rgba(224,82,82,0.35)',
        borderWidth: 1,
        borderRadius: 3, order: 1,
      },
      {
        label: 'Discount Rate % (prior)',
        data: priorDRates,
        backgroundColor: 'rgba(217,119,6,0.18)',
        borderColor: 'rgba(217,119,6,0.35)',
        borderWidth: 1,
        borderRadius: 3, order: 1,
      }
    );
  }

  ratesDatasets.push(
    threshLine(vWarnPct, 'rgba(217,119,6,0.55)',  [5, 4]),
    threshLine(vCritPct, 'rgba(224,82,82,0.55)',  [5, 4]),
    threshLine(dWarnPct, 'rgba(217,119,6,0.35)',  [2, 5]),
    threshLine(dCritPct, 'rgba(224,82,82,0.35)',  [2, 5])
  );

  chartRates = new Chart(document.getElementById('chart-rates'), {
    type: 'bar',
    data: { labels: short, datasets: ratesDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#7a8899', font: CHART_FONT_MONO, boxWidth: 10, padding: 14 },
          onClick: (e, item, legend) => {
            if (item.datasetIndex < ratesDatasets.length - 4) {
              const meta = legend.chart.getDatasetMeta(item.datasetIndex);
              meta.hidden = !meta.hidden;
              legend.chart.update();
            }
          },
        },
        tooltip: {
          ...TOOLTIP_BASE,
          filter: item => !['line'].includes(item.dataset.type),
          callbacks: { label: ctx => `  ${ctx.dataset.label.replace(' %', '')}: ${ctx.raw.toFixed(1)}%` },
        },
      },
      scales: {
        x: {
          grid: { color: GRID_COLOR }, border: { color: AXIS_COLOR },
          ticks: { color: '#dde3ef', font: CHART_FONT_HEAD, maxRotation: 40 },
        },
        y: {
          grid: { color: GRID_COLOR }, border: { color: AXIS_COLOR },
          ticks: { color: '#3f5068', font: CHART_FONT_MONO, callback: v => v + '%' },
          suggestedMax: Math.max(25, vCritPct + 5, dCritPct + 5), min: 0,
        },
      },
    },
  });

  // ── Chart 3: Trend delta (only when prior data exists) ───────────────────

  const trendCard = document.getElementById('trend-chart-card');
  if (!hasTrend) {
    trendCard.hidden = true;
    return;
  }

  trendCard.hidden = false;
  const wrap3 = document.getElementById('chart-trend-wrap');
  wrap3.style.height = '260px';
  wrap3.innerHTML = '<canvas id="chart-trend"></canvas>';

  // Only employees who have prior data
  const withTrend = byRisk.filter(e => e.trend?.hasPrior);
  const tNames    = withTrend.map(e => {
    const p = e.employeeName.trim().split(/\s+/);
    return p.length > 1 ? p[0][0] + '. ' + p.slice(1).join(' ') : e.employeeName;
  });

  const vrDeltas = withTrend.map(e => e.trend.voidRateDelta !== null ? +(e.trend.voidRateDelta * 100).toFixed(2) : 0);
  const drDeltas = withTrend.map(e => e.trend.discountRateDelta !== null ? +(e.trend.discountRateDelta * 100).toFixed(2) : 0);

  const deltaColor = (d, cap) => {
    if (d > cap * 100) return 'rgba(224,82,82,0.85)';
    if (d > 0)         return 'rgba(217,119,6,0.75)';
    return               'rgba(34,197,94,0.65)';
  };

  const trendRisePct = thresholds.trendRisePct * 100;

  chartTrend = new Chart(document.getElementById('chart-trend'), {
    type: 'bar',
    data: {
      labels: tNames,
      datasets: [
        {
          label: 'Void Rate Change (pp)',
          data: vrDeltas,
          backgroundColor: vrDeltas.map(d => deltaColor(d, thresholds.trendRisePct)),
          borderRadius: 3,
        },
        {
          label: 'Discount Rate Change (pp)',
          data: drDeltas,
          backgroundColor: drDeltas.map(d => deltaColor(d, thresholds.trendRisePct)),
          borderRadius: 3,
        },
        // Trend threshold line
        {
          type: 'line', label: `Flag threshold (+${trendRisePct.toFixed(1)}pp)`,
          data: Array(withTrend.length).fill(trendRisePct),
          borderColor: 'rgba(217,119,6,0.6)', borderDash: [4, 4],
          borderWidth: 1, pointRadius: 0, fill: false, order: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#7a8899', font: CHART_FONT_MONO, boxWidth: 10, padding: 14 } },
        tooltip: {
          ...TOOLTIP_BASE,
          filter: item => item.dataset.type !== 'line',
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              const sign = v > 0 ? '+' : '';
              return `  ${ctx.dataset.label.replace(' (pp)', '')}: ${sign}${v.toFixed(1)}pp`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: GRID_COLOR }, border: { color: AXIS_COLOR },
          ticks: { color: '#dde3ef', font: CHART_FONT_HEAD, maxRotation: 40 },
        },
        y: {
          grid: { color: GRID_COLOR }, border: { color: AXIS_COLOR },
          ticks: {
            color: '#3f5068', font: CHART_FONT_MONO,
            callback: v => (v > 0 ? '+' : '') + v.toFixed(1) + 'pp',
          },
        },
      },
    },
  });
}

// ── Export report ─────────────────────────────────────────────────────────────

function getRestaurantName() {
  try { return localStorage.getItem(RESTAURANT_KEY) || ''; } catch { return ''; }
}
function saveRestaurantName(name) {
  try { localStorage.setItem(RESTAURANT_KEY, name); } catch { /* quota */ }
}

function prRateClass(rate, warnT, critT) {
  if (rate > critT) return 'pr-crit';
  if (rate > warnT) return 'pr-warn';
  return 'pr-clean';
}

function prTrendHtml(delta) {
  if (delta === null || delta === undefined) return '';
  const pp = (Math.abs(delta) * 100).toFixed(1) + 'pp';
  if (delta > NOISE_FLOOR)  return ` <span class="pr-tup">↑ +${pp}</span>`;
  if (delta < -NOISE_FLOOR) return ` <span class="pr-tdown">↓ −${pp}</span>`;
  return '';
}

function buildReportHTML() {
  const flagged  = employees.filter(e => e.riskLevel !== 'clean');
  const total    = employees.length;
  const high     = employees.filter(e => e.riskLevel === 'high').length;
  const medium   = employees.filter(e => e.riskLevel === 'medium').length;
  const clean    = employees.filter(e => e.riskLevel === 'clean').length;
  const hasPrior = employees.some(e => e.trend?.hasPrior);

  const restaurant = getRestaurantName() || 'Employee Fraud Report';
  const dateStr    = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const fileList = [
    salesFileName     && `${salesFileName} (current)`,
    voidsFileName     && `${voidsFileName} (current)`,
    priorSalesFileName && `${priorSalesFileName} (prior)`,
    priorVoidsFileName && `${priorVoidsFileName} (prior)`,
  ].filter(Boolean).join(' · ');

  const threshNote = [
    `Void: warn >${(thresholds.voidWarn * 100).toFixed(0)}% crit >${(thresholds.voidCrit * 100).toFixed(0)}%`,
    `Discount: warn >${(thresholds.discountWarn * 100).toFixed(0)}% crit >${(thresholds.discountCrit * 100).toFixed(0)}%`,
    `Refund: count >${thresholds.refundMinCount} rate >${(thresholds.refundRate * 100).toFixed(0)}%`,
    `No-sale: >${(thresholds.noSaleRate * 100).toFixed(0)}%`,
    hasPrior ? `Trend flag: >${(thresholds.trendRisePct * 100).toFixed(0)}pp` : null,
  ].filter(Boolean).join('  ·  ');

  const cardHTML = flagged.length === 0
    ? `<div class="pr-all-clean">✓ No suspicious activity detected across ${total} employees.</div>`
    : flagged.map(emp => {
        const vr = emp.grossSales > 0 ? emp.voidAmount     / emp.grossSales : null;
        const dr = emp.grossSales > 0 ? emp.discountAmount / emp.grossSales : null;
        const t  = emp.trend;

        const vrClass = vr !== null ? prRateClass(vr, thresholds.voidWarn, thresholds.voidCrit)         : '';
        const drClass = dr !== null ? prRateClass(dr, thresholds.discountWarn, thresholds.discountCrit) : '';

        const vrPriorHtml = t?.hasPrior && t.prevVoidRate     !== null
          ? `<td class="pr-prior-cell">Prior: ${fmtPct(t.prevVoidRate)}${prTrendHtml(t.voidRateDelta)}</td>` : '<td></td>';
        const drPriorHtml = t?.hasPrior && t.prevDiscountRate !== null
          ? `<td class="pr-prior-cell">Prior: ${fmtPct(t.prevDiscountRate)}${prTrendHtml(t.discountRateDelta)}</td>` : '<td></td>';

        const flagPills = emp.flags.map(f =>
          `<span class="pr-flag ${f.severity === 'critical' ? 'pr-crit' : 'pr-warn'}">F${f.flag} ${f.severity === 'critical' ? 'Critical' : 'Warning'}: ${esc(f.label)}</span>`
        ).join('');

        const details = emp.flags.map(f =>
          `<div class="pr-dl ${f.severity === 'critical' ? 'pr-crit' : 'pr-warn'}">▸ ${esc(f.detail)}</div>`
        ).join('');

        return `
          <div class="pr-card pr-${emp.riskLevel}">
            <div class="pr-card-head">
              <span class="pr-badge pr-${emp.riskLevel}">${emp.riskLevel === 'high' ? '● HIGH RISK' : '◐ MEDIUM RISK'}</span>
              <span class="pr-emp-name">${esc(emp.employeeName)}</span>
              <span class="pr-emp-role">${esc(emp.jobs.join(' · ') || 'No role')}</span>
            </div>
            <div class="pr-flags">${flagPills}</div>
            <table class="pr-stats-tbl">
              <tr>
                <th>Void Rate</th>
                <td class="${vrClass}">${fmtPct(vr)}</td>
                ${vrPriorHtml}
              </tr>
              <tr>
                <th>Discount Rate</th>
                <td class="${drClass}">${fmtPct(dr)}</td>
                ${drPriorHtml}
              </tr>
              <tr>
                <th>Net Sales</th>
                <td>${fmtDollars(emp.netSales)}</td>
                <td></td>
              </tr>
              <tr>
                <th>Shifts</th>
                <td>${emp.shifts}</td>
                <td class="pr-prior-cell">${emp.hoursWorked ? emp.hoursWorked.toFixed(1) + ' hrs' : ''}</td>
              </tr>
            </table>
            <div class="pr-details">${details}</div>
          </div>
        `;
      }).join('');

  return `
    <div class="pr-header">
      <div>
        <div class="pr-confidential">Confidential</div>
        <h1 class="pr-restaurant">${esc(restaurant)}</h1>
        <div class="pr-report-label">Fraud Detection Report — Flagged Employees</div>
      </div>
      <div class="pr-header-right">
        <div class="pr-date">${esc(dateStr)}</div>
        ${fileList ? `<div class="pr-files">${esc(fileList)}</div>` : ''}
      </div>
    </div>

    <div class="pr-summary">
      <div class="pr-sum-item"><span class="pr-sum-val">${total}</span><span class="pr-sum-lbl">Employees</span></div>
      <div class="pr-sum-item"><span class="pr-sum-val v-amber">${flagged.length}</span><span class="pr-sum-lbl">Flagged</span></div>
      <div class="pr-sum-item"><span class="pr-sum-val v-red">${high}</span><span class="pr-sum-lbl">High Risk</span></div>
      <div class="pr-sum-item"><span class="pr-sum-val v-amber">${medium}</span><span class="pr-sum-lbl">Medium Risk</span></div>
      <div class="pr-sum-item"><span class="pr-sum-val v-green">${clean}</span><span class="pr-sum-lbl">Clean</span></div>
    </div>

    <div class="pr-section-head">Flagged Employees (${flagged.length})</div>
    ${cardHTML}

    <div class="pr-footer">
      <span>Generated by Fraud Detector · Toast POS Analytics</span>
      <span>${esc(threshNote)}</span>
    </div>
  `;
}

function exportReport() {
  const root = document.getElementById('print-root');
  root.innerHTML = buildReportHTML();
  const cleanup = () => { root.innerHTML = ''; window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

// ── Settings panel ────────────────────────────────────────────────────────────

function sliderToThreshold(key, val) { return SLIDER_CFG[key].isPct ? val / 100 : val; }
function thresholdToSlider(key)      { return SLIDER_CFG[key].isPct ? thresholds[key] * 100 : thresholds[key]; }

function sliderDisplay(key, sliderVal) {
  const cfg = SLIDER_CFG[key];
  return cfg.isPct ? parseFloat(sliderVal).toFixed(cfg.step < 1 ? 1 : 0) + '%' : String(parseInt(sliderVal));
}

function updateSliderFill(slider, fill) {
  const pct = ((parseFloat(slider.value) - parseFloat(slider.min)) / (parseFloat(slider.max) - parseFloat(slider.min))) * 100;
  slider.style.setProperty('--fill-pct',   pct + '%');
  slider.style.setProperty('--track-fill', fill);
}

function syncSliderUI(key) {
  const slider  = document.getElementById('s-' + key);
  const display = document.getElementById('sv-' + key);
  if (!slider || !display) return;
  slider.value = thresholdToSlider(key);
  display.textContent = sliderDisplay(key, slider.value);
  updateSliderFill(slider, SLIDER_CFG[key].fill);
}

function initSettings() {
  for (const key of Object.keys(SLIDER_CFG)) {
    syncSliderUI(key);
    const slider  = document.getElementById('s-' + key);
    const display = document.getElementById('sv-' + key);
    if (!slider) continue;

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      display.textContent = sliderDisplay(key, val);
      updateSliderFill(slider, SLIDER_CFG[key].fill);
      thresholds[key] = sliderToThreshold(key, val);
      saveThresholds();
      scheduleRerender();
    });
  }

  // Restaurant name
  const rnInput = document.getElementById('sp-restaurant-name');
  rnInput.value = getRestaurantName();
  rnInput.addEventListener('input', () => saveRestaurantName(rnInput.value.trim()));

  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-sp').addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
  document.getElementById('btn-reset-defaults').addEventListener('click', () => {
    thresholds = { ...DEFAULT_THRESHOLDS };
    saveThresholds();
    for (const key of Object.keys(SLIDER_CFG)) syncSliderUI(key);
    scheduleRerender();
  });
}

function openSettings()  {
  document.getElementById('settings-panel').classList.add('open');
  document.getElementById('settings-backdrop').classList.add('open');
}
function closeSettings() {
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('settings-backdrop').classList.remove('open');
}

// ── Navigation ────────────────────────────────────────────────────────────────

function goBack() {
  document.getElementById('dashboard').hidden = true;
  document.getElementById('upload-screen').hidden = false;
  closeSettings();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

setupCard('upload-card-sales', 'input-sales',
  makeFileHandler('upload-card-sales', 'fname-sales',
    t => { salesText = t; },
    n => { salesFileName = n; },
    true));

setupCard('upload-card-voids', 'input-voids',
  makeFileHandler('upload-card-voids', 'fname-voids',
    t => { voidsText = t; },
    n => { voidsFileName = n; }));

// Prior period
setupCard('upload-card-prior-sales', 'input-prior-sales',
  makeFileHandler('upload-card-prior-sales', 'fname-prior-sales',
    t => { priorSalesText = t; },
    n => { priorSalesFileName = n; }));

setupCard('upload-card-prior-voids', 'input-prior-voids',
  makeFileHandler('upload-card-prior-voids', 'fname-prior-voids',
    t => { priorVoidsText = t; },
    n => { priorVoidsFileName = n; }));

document.getElementById('run-btn').addEventListener('click', runAnalysis);
document.getElementById('btn-reupload').addEventListener('click', goBack);
document.getElementById('btn-export').addEventListener('click', exportReport);
initSettings();
