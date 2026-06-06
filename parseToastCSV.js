/**
 * Toast POS CSV parser — browser-compatible, no dependencies.
 * Handles Employee Sales Summary and Voids & Discounts exports.
 */

// ---------------------------------------------------------------------------
// Low-level CSV parsing
// ---------------------------------------------------------------------------

function parseCSVRow(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length === 0) return [];

  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVRow(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = (values[idx] ?? '').trim();
    });
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Type coercion helpers
// ---------------------------------------------------------------------------

/**
 * Parse currency strings to float.
 * Handles: "$1,234.56"  "($1,234.56)"  "-$1,234.56"  "1234.56"  ""
 */
function parseCurrency(value) {
  if (!value || !value.trim()) return 0;
  const str = value.trim();
  const negative = (str.startsWith('(') && str.endsWith(')')) || str.startsWith('-');
  const cleaned = str.replace(/[()$,\s-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : negative ? -num : num;
}

function parseNumber(value) {
  if (!value || !value.trim()) return 0;
  const num = parseFloat(value.trim().replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

function normalizeKey(name) {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Per-file parsers
// ---------------------------------------------------------------------------

/**
 * Parse Employee Sales Summary CSV.
 * If an employee appears on multiple rows (multiple jobs), numeric fields are summed.
 * Returns Map<normalizedName, salesRecord>.
 */
function parseSalesSummary(csvText) {
  const rows = parseCSV(csvText);
  const map = new Map();

  for (const row of rows) {
    const name = (row['Employee Name'] || '').trim();
    if (!name) continue;
    const key = normalizeKey(name);

    if (map.has(key)) {
      const e = map.get(key);
      e.netSales      += parseCurrency(row['Net Sales']);
      e.grossSales    += parseCurrency(row['Gross Sales']);
      e.voidAmount    += parseCurrency(row['Voids']);
      e.voidCount     += parseNumber(row['Void Count']);
      e.discountAmount+= parseCurrency(row['Discounts']);
      e.discountCount += parseNumber(row['Discount Count']);
      e.refundAmount  += parseCurrency(row['Refunds']);
      e.refundCount   += parseNumber(row['Refund Count']);
      e.tips          += parseCurrency(row['Tips']);
      e.checks        += parseNumber(row['Checks']);
      e.hoursWorked   += parseNumber(row['Hours Worked']);
      e.shifts        += parseNumber(row['Shifts']);
      const job = (row['Job'] || '').trim();
      if (job && !e.jobs.includes(job)) e.jobs.push(job);
    } else {
      map.set(key, {
        employeeName:   name,
        jobs:           [(row['Job'] || '').trim()].filter(Boolean),
        netSales:       parseCurrency(row['Net Sales']),
        grossSales:     parseCurrency(row['Gross Sales']),
        voidAmount:     parseCurrency(row['Voids']),
        voidCount:      parseNumber(row['Void Count']),
        discountAmount: parseCurrency(row['Discounts']),
        discountCount:  parseNumber(row['Discount Count']),
        refundAmount:   parseCurrency(row['Refunds']),
        refundCount:    parseNumber(row['Refund Count']),
        tips:           parseCurrency(row['Tips']),
        checks:         parseNumber(row['Checks']),
        hoursWorked:    parseNumber(row['Hours Worked']),
        shifts:         parseNumber(row['Shifts']),
      });
    }
  }

  return map;
}

/**
 * Parse Voids & Discounts CSV.
 * Buckets each row as a void or discount record under the responsible employee.
 * Returns Map<normalizedName, voidDiscountRecord>.
 */
function parseVoidsDiscounts(csvText) {
  const rows = parseCSV(csvText);
  const map = new Map();

  for (const row of rows) {
    const name = (row['Employee'] || '').trim();
    if (!name) continue;
    const key = normalizeKey(name);

    if (!map.has(key)) {
      map.set(key, {
        employeeName:        name,
        voidDetails:         [],
        voidDetailCount:     0,
        voidDetailAmount:    0,
        discountDetails:     [],
        discountDetailCount: 0,
        discountDetailAmount:0,
      });
    }

    const entry  = map.get(key);
    const type   = (row['Void/Discount Type'] || '').trim();
    const amount = parseCurrency(row['Amount']);
    const record = {
      date:            row['Date']            || '',
      type,
      amount,
      checkNumber:     row['Check #']         || '',
      reason:          row['Reason']          || '',
      managerApproval: row['Manager Approval']|| '',
    };

    if (type.toLowerCase().includes('void')) {
      entry.voidDetails.push(record);
      entry.voidDetailCount++;
      entry.voidDetailAmount += amount;
    } else {
      entry.discountDetails.push(record);
      entry.discountDetailCount++;
      entry.discountDetailAmount += amount;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and merge Toast POS export CSVs.
 *
 * @param {string} salesCSV   - Contents of the Employee Sales Summary CSV.
 * @param {string} [voidsCSV] - Contents of the Voids & Discounts CSV (optional).
 * @returns {EmployeeRecord[]} - Sorted array of merged employee records.
 *
 * @typedef {Object} EmployeeRecord
 * @property {string}   employeeName
 * @property {string[]} jobs
 * @property {number}   netSales
 * @property {number}   grossSales
 * @property {number}   tips
 * @property {number}   checks
 * @property {number}   hoursWorked
 * @property {number}   shifts
 * @property {number}   voidAmount          - Dollar total from Sales Summary
 * @property {number}   voidCount           - Count from Sales Summary
 * @property {number}   discountAmount
 * @property {number}   discountCount
 * @property {number}   refundAmount
 * @property {number}   refundCount
 * @property {Object[]} voidDetails         - Row-level records from Voids & Discounts CSV
 * @property {number}   voidDetailCount
 * @property {number}   voidDetailAmount
 * @property {Object[]} discountDetails
 * @property {number}   discountDetailCount
 * @property {number}   discountDetailAmount
 */
export function parseToastData(salesCSV, voidsCSV) {
  const salesMap = parseSalesSummary(salesCSV);
  const voidsMap = voidsCSV ? parseVoidsDiscounts(voidsCSV) : new Map();

  const allKeys = new Set([...salesMap.keys(), ...voidsMap.keys()]);
  const employees = [];

  for (const key of allKeys) {
    const s = salesMap.get(key);
    const v = voidsMap.get(key);

    employees.push({
      employeeName:        s?.employeeName        ?? v?.employeeName ?? '',
      jobs:                s?.jobs                ?? [],
      netSales:            s?.netSales            ?? 0,
      grossSales:          s?.grossSales          ?? 0,
      tips:                s?.tips                ?? 0,
      checks:              s?.checks              ?? 0,
      hoursWorked:         s?.hoursWorked         ?? 0,
      shifts:              s?.shifts              ?? 0,
      voidAmount:          s?.voidAmount          ?? 0,
      voidCount:           s?.voidCount           ?? 0,
      discountAmount:      s?.discountAmount      ?? 0,
      discountCount:       s?.discountCount       ?? 0,
      refundAmount:        s?.refundAmount        ?? 0,
      refundCount:         s?.refundCount         ?? 0,
      voidDetails:         v?.voidDetails         ?? [],
      voidDetailCount:     v?.voidDetailCount     ?? 0,
      voidDetailAmount:    v?.voidDetailAmount    ?? 0,
      discountDetails:     v?.discountDetails     ?? [],
      discountDetailCount: v?.discountDetailCount ?? 0,
      discountDetailAmount:v?.discountDetailAmount?? 0,
    });
  }

  employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  return employees;
}
