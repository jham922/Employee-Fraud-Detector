# Fraud Detector — Toast POS Analytics

A browser-only single-page app that analyzes Toast POS employee performance exports and flags suspicious activity. No server, no build step, no dependencies beyond Chart.js (loaded via CDN).

**Live URL:** https://jham922.github.io/Employee-Fraud-Detector/

---

## What it does

Upload a `Overall_employeePerformance.csv` export from Toast Admin (Labor → Employee Performance) and the app scores every employee against six fraud flags:

| Flag | Name | What it checks |
|------|------|----------------|
| F1 | Void Rate | Void amount as % of gross sales exceeds warn/critical threshold |
| F2 | Discount Rate | Discount amount as % of gross sales exceeds warn/critical threshold |
| F3 | Peer Comparison | Net sales significantly below the role average (single-job employees only) |
| F4 | No-Sale Opens | High rate of transactions with no sale recorded |
| F5 | Refund Anomaly | Refund count and rate both exceed thresholds |
| F6 | Trend Rising | Void or discount rate jumped vs. the prior period by more than the threshold |

Results appear in four sections: summary metrics, flagged employee cards, a full sortable table, and analytics charts.

---

## How to use

### Running an analysis

1. Go to the live URL above (or open `index.html` locally in any modern browser).
2. Under **Current Period**, drag-and-drop or click to upload `Overall_employeePerformance.csv`.
3. Optionally upload a second CSV under **Prior Period** to enable trend analysis (Flag 6 + trend arrows).
4. Click **Run Analysis**.

### Getting the CSV from Toast

Toast Admin → **Labor** → **Employee Performance** → set your date range → **Export** → `Overall_employeePerformance.csv`

### Dashboard controls

- **⏱ History** — opens the run history panel. Every analysis is auto-saved to browser IndexedDB. Select any past run as the "prior period" to enable trend comparison without uploading a second file.
- **↓ Export Report** — prints a PDF of flagged employees via the browser print dialog.
- **⚙ Thresholds** — opens the settings panel to adjust all flag thresholds, set the restaurant name for the PDF header, and manage the employee exclusion list.
- **← Upload New Files** — returns to the upload screen.

---

## Settings

All settings persist in `localStorage`.

| Setting | Default | Notes |
|---------|---------|-------|
| Void warn | 8% | Flag 1 amber |
| Void critical | 15% | Flag 1 red |
| Discount warn | 10% | Flag 2 amber |
| Discount critical | 20% | Flag 2 red |
| Sales below peer | 30% | Flag 3 deviation |
| No-sale rate | 5% | Flag 4 |
| Trend rise | 5pp | Flag 6 delta threshold |
| Refund min count | 3 | Flag 5 (both conditions must be met) |
| Refund rate | 5% | Flag 5 |
| Restaurant name | — | Appears on printed PDF |
| Excluded employees | — | One name per line; excluded from all analysis |

---

## Run history

Each completed analysis is automatically saved to browser IndexedDB (`fraud-detector-db`). The history panel shows:

- File name, run date/time
- Employee count, flagged count, high-risk count
- "Use as prior" button — sets that run as the prior period for trend comparison
- Delete button — removes the run from history

History is **per browser / per device**. It does not sync across devices.

---

## File structure

```
index.html          Main app shell + all CSS
app.js              UI logic, rendering, settings, history panel
parseToastCSV.js    CSV parser — auto-detects Toast performance format vs. legacy
fraudFlags.js       Scoring engine — FLAGS 1–6
db.js               IndexedDB wrapper (saveRun, getAllRuns, deleteRun)
.nojekyll           Prevents GitHub Pages from running Jekyll
```

---

## Technical notes

- Pure ES modules (`type="module"`), no bundler or build step required.
- Chart.js 4.4.4 via CDN with SRI hash.
- BOM (`﻿`) stripping handles Windows UTF-8 CSV exports.
- Auto-detects CSV format: `EMPLOYEE_NAME` header → real Toast export; `Employee Name` → legacy test format.
- XSS prevention: all CSV-derived strings pass through `esc()` before `innerHTML` insertion.
- `[hidden] { display: none !important; }` is set explicitly to prevent flex-container overrides.
