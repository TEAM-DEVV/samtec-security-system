# 08 · Ghost detection engine

The original proposal defines a ghost worker as "an employee without a valid biometric record". That is a single database query, not a module. This engine is what makes the project defensible academically and valuable commercially.

**Design:** declarative rules → a sweep → alerts with evidence → a human review queue. Rules never punish anyone automatically; they surface and score.

## Rule catalogue (version 1)

| # | Rule | Signal | Severity |
|---|---|---|---|
| R1 | **Duplicate enrollment** | A new biometric template matches an existing employee above the threshold at enrollment (1:N comparison); while the review is open, both records are shown to the payroll checker | CRITICAL: blocks activation |
| R2 | **Identity collision** | Shared Ghana Card or SSNIT number (a hard database constraint), or a shared bank account, mobile money number, phone or next of kin across employees (an alert) | HIGH |
| R3 | **Paid without presence** | A draft payroll line pays more hours than biometric punches support, beyond a tolerance | CRITICAL: blocks run submission until resolved |
| R4 | **Bilocation** | One employee has overlapping work segments at two sites | HIGH |
| R5 | **Never seen** | ACTIVE for more than N days with no punches at all | HIGH: the classic ghost |
| R6 | **Terminated but active** | Punches or payroll lines after the termination date | CRITICAL |
| R7 | **PIN fallback abuse** | An employee's share of flagged clock-ins (a supervisor's co-sign, or staff number plus fingerprint) is above a threshold, counted per worker and per co-signing supervisor (avoiding biometrics) | MEDIUM |
| R8 | **Robot regularity** | Punch times with almost no variation over weeks (manufactured logs) | MEDIUM |
| R9 | **Device anomaly** | A device's punch volume spikes against its history, its clock drifts by more than 5 minutes, or it sends punches during an offline window | MEDIUM |
| R10 | **Orphan punches** | Punches whose device user reference matches nobody | MEDIUM: wrong enrollment or someone probing |
| R11 | **Conflicted decision** | A duplicate review or an exemption was decided by someone who created either record or enrolled the other face, or whose ADMIN account was created, reset or promoted by someone who handled the worker (Phase 3 two-person rules) | HIGH: shown to the payroll checker |

## How it works

- **Each rule is a pure function:** given a time window and company data, it returns alerts with evidence (the actual punch IDs, payroll line IDs and match scores). Each rule can be tested on its own.
- **When rules run:** a nightly scheduled sweep, an on-demand sweep (`POST /detection/sweep`), and inline checks at the moments that matter: R1 at enrollment, R3 when a payroll run is submitted.
- **Alert life cycle:** OPEN → UNDER_REVIEW → RESOLVED (with a reason) or CONFIRMED_FRAUD. A resolution needs a note, and every change is audited.
- **Scoring:** severity multiplied by recurrence. An employee's risk score adds up their open alerts. It makes a strong dashboard widget and a strong section of the report.

## Material this module gives the report and defense

- A precision and recall discussion on the seeded data (the three planted ghosts plus normal noise)
- A threshold tuning table for R1: false accepts against false rejects
- "Why people stay in the loop": labour law, and the ethics of false positives

Related: [Data model](04-data-model.md) · [Roadmap](07-roadmap.md)
