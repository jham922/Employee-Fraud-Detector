# CLAUDE.md — Fraud Detector

Browser-only SPA. No build step, no bundler, no npm. Pure ES modules loaded directly by the browser.

## Stack

- `index.html` — app shell, all CSS (inline `<style>`), Google Fonts + Chart.js CDN
- `app.js` — all UI logic as ES module
- `parseToastCSV.js` — CSV parser, exported as `parseToastData(salesCSV, voidsCSV?)`
- `fraudFlags.js` — scoring engine, exported as `scoreFraud(employees, thresholds)` and `DEFAULT_THRESHOLDS`
- `db.js` — IndexedDB wrapper, exports `saveRun()`, `getAllRuns()`, `deleteRun()`

## Deployment

GitHub Pages from `main` branch root. Live at `https://jham922.github.io/Employee-Fraud-Detector/`.

Push to `main` → Pages rebuilds in ~1 min. The `.nojekyll` file is required — without it, GitHub Pages Jekyll processing breaks ES module imports.

## CSV format

The real Toast export is `Overall_employeePerformance.csv`. Key columns:

```
EMPLOYEE_NAME, EMPLOYEE_GUID, NET_SALES, GROSS_SALES, VOID_AMOUNT,
VOIDED_ITEM_QUANTITY, DISCOUNT_AMOUNT, ORDER_COUNT, TOTAL_LABOR_HOURS
```

The parser auto-detects format by the first header field: `EMPLOYEE_NAME` → real Toast format; `Employee Name` → legacy test format. Both formats go through the same scoring engine.

Windows CSV exports include a UTF-8 BOM (`﻿`). Strip it from both the raw text and each header field individually — both stripping sites are needed.

## Persistent state

| Store | Key | Contents |
|-------|-----|----------|
| `localStorage` | `fraud-detector-thresholds` | JSON threshold object |
| `localStorage` | `fraud-detector-restaurant` | Restaurant name string |
| `localStorage` | `fraud-detector-exclusions` | Newline-separated exclusion list |
| `IndexedDB` | `fraud-detector-db` / `runs` store | Historical run objects |

## Key implementation details

**`[hidden]` CSS fix** — `.upload-screen { display: flex }` (author CSS) overrides the browser's user-agent `[hidden] { display: none }`. The fix is `[hidden] { display: none !important; }` at the top of the `<style>` block. Do not remove this.

**XSS prevention** — all CSV-derived strings must pass through `esc()` before being inserted via `innerHTML`. Never bypass this.

**Exclusion list** — `getExclusions()` returns a `Set` of lowercased names. Applied via `filterExcluded()` immediately after parsing, before trend computation or scoring.

**Trend computation** — `computeTrends(current, prior)` merges by normalized name. Prior source priority: `priorHistoryRun?.employees` (IndexedDB selection) > uploaded prior CSV > none.

**`currentEmployees`** — stores the parsed, pre-trend current period array. Used by history "Use as prior" to re-run trends without re-parsing the CSV.

**Chart.js** — uses mixed chart types (bar + line) for threshold reference lines. Destroy existing chart instances before re-creating. CDN SRI hash must match the version exactly — do not change the version without updating the hash.

**History panel** — slides in from the left (settings panel slides from the right). Both use the same backdrop z-index pattern. `renderHistoryPanel()` is called on open, not on boot.

## Employees excluded from all analysis

Jennifer Hamilton and Daniel Sletten are in the default exclusion list placeholder text. Users manage this list in the Settings panel (Thresholds → Report → Exclude employees). The list is stored in `localStorage`, not hardcoded.

## Flags

| Flag | Key threshold fields |
|------|----------------------|
| F1 Void Rate | `voidWarn`, `voidCrit` |
| F2 Discount Rate | `discountWarn`, `discountCrit` |
| F3 Peer Comparison | `salesBelow` — only fires for employees with exactly one job |
| F4 No-Sale Opens | `noSaleRate` |
| F5 Refund Anomaly | `refundMinCount` AND `refundRate` (both must exceed) |
| F6 Trend Rising | `trendRisePct` — requires prior period data |

Risk level: any critical flag → `high`; any warning flag, no critical → `medium`; no flags → `clean`.
