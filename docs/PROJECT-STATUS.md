# Project status — Employee-Fraud-Detector

_Maintained jointly. Last updated 2026-09-16 by the Hermes assistant._
_Read `docs/CHANGES.md` for the running log; append a line there after any session._

## 6. Employee Fraud Detector — *complete, live, untouched since June*

**What it is:** browser-only Toast analytics. Upload an employee-performance export and it scores everyone against six flags: void rate, discount rate, peer comparison, no-sale opens, refund anomaly, rising trend.

**Where:** `jham922.github.io/Employee-Fraud-Detector` · public repo · GitHub Pages, no server, no build step, no dependencies

**Done:** complete and deployed, including a run history in IndexedDB.

**Next**
1. Feed it from the automated Toast pull instead of manual CSV uploads.
2. Tune the thresholds against your real data so the flags mean something at your volume.
3. **This is your strongest shrink-and-fraud story for the memo** — pair it with the variance work and it stops being "I built a tool" and becomes "I built loss detection."

**Blocking:** thresholds untuned; last touched 9 June.

---

---

Source: full cross-project survey kept on the Hermes host (`~/business-reports/project-status-2026-09-16.md`).
