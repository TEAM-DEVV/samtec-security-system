# 08 · Ghost detection engine

**Phase 5. Francis builds this, end to end.** It merges **after** payroll,
because three of its rules read payroll data.

The original proposal defines a ghost worker as "an employee without a valid
biometric record". That is a single database query, not a module. This engine
is what makes the project defensible academically and valuable commercially.

**Design:** declarative rules → a sweep → alerts with evidence → a human
review queue. Rules never punish anyone automatically; they surface and score.

> **The decisions section below settles what this page used to leave open.**
> A review found sixteen places a builder would have had to guess — every
> threshold, the shape of evidence, who may look, and one real architectural
> problem (R3 would have made payroll and detection import each other). They
> are settled below, with the limits of version 1 written down on purpose.

## Rule catalogue (version 1)

| # | Rule | Signal | Severity |
|---|---|---|---|
| R1 | **Duplicate enrollment** | A new biometric template matches an existing employee above the threshold at enrollment (1:N comparison); while the review is open, both records are shown to the payroll checker | CRITICAL: blocks activation |
| R2 | **Identity collision** | A shared phone number, bank account or mobile money number across employees (the Ghana Card number is already a hard database constraint). Version 1 checks the phone; the other two join it when payroll stores them | HIGH |
| R3 | **Paid without presence** | A payroll line pays more hours than the recorded shifts support, beyond a tolerance | CRITICAL: blocks run submission until resolved |
| R4 | **Bilocation** | One employee repeatedly has overlapping work segments at two sites | HIGH |
| R5 | **Never seen** | ACTIVE for more than N days with no punches at all | HIGH: the classic ghost |
| R6 | **Terminated but active** | Punches or payroll lines after the termination date | CRITICAL |
| R7 | **PIN fallback abuse** | An employee's share of flagged clock-ins (a supervisor's co-sign, or staff number plus fingerprint) is above a threshold, counted per worker and per co-signing supervisor (avoiding biometrics) | MEDIUM |
| R8 | **Robot regularity** | Punch times with almost no variation over weeks (manufactured logs) | MEDIUM |
| R9 | **Device anomaly** | A device's punch volume spikes against its history, or its clock drifts by more than 5 minutes | MEDIUM |
| R10 | **Orphan punches** | Punches whose device user reference matches nobody, repeatedly | MEDIUM: wrong enrollment or someone probing |
| R11 | **Conflicted decision** | A duplicate review or an exemption was decided by somebody who should not have decided it | HIGH: shown to the payroll checker |

## How it works

- **Each rule is a pure function:** given a window and the rows it needs, it
  returns alerts with evidence. Each rule is tested on its own, with no
  database.
- **When rules run:** a sweep riding the heartbeat (below), an on-demand
  sweep (`POST /detection/sweep`), and one inline check — R1 at enrollment,
  which Phase 3 already does.
- **Alert life cycle:** `OPEN` → `UNDER_REVIEW` → `RESOLVED` or
  `CONFIRMED_FRAUD`. A resolution needs a note, and every change is audited.
- **Scoring:** severity × recurrence, added up per employee.

---

# The decisions

## 1. The architecture problem, and the answer

R3 says detection blocks a payroll run's submission. Written naively that
makes **payroll import detection** (to ask) and **detection import payroll**
(to read the lines) — a circle this codebase has no precedent for and does
not want.

The answer splits the two things that were tangled together:

- **The rule is a pure function in one shared file**, depending on nothing:
  `paidBeyondPresence(paidMinutes, presentMinutes, toleranceMinutes)`.
- **Payroll enforces it at submission**, using its own data. A line already
  carries `punchedMinutes` (decision 8 of
  [Payroll engine (Ghana)](09-payroll-engine-ghana.md)), so payroll needs
  nothing from detection to refuse a run.
- **Detection raises the alert** on its sweep, using the same shared function,
  so the queue and the report see it too.

So imports point one way only: **detection → payroll, attendance, workforce,
and nothing imports detection.** Payroll never learns detection exists.

This also means **Samuel's Phase 4 does not change**: he records
`punchedMinutes` and lets submission through, and Phase 5 adds the refusal
inside payroll's own submit, with no new module dependency.

## 2. Every threshold, named

They live in a `detection_rules` row per rule, so they can be tuned without a
deploy. These are the seeded starting values, and the report's tuning table
is built by moving them.

| Rule | Threshold |
|---|---|
| R2 | Any phone, bank account or mobile money number shared by 2+ employees |
| R3 | Paid minutes exceed present minutes by more than **60 minutes** in a period |
| R4 | **3 or more** `OVERLAP` exceptions for one worker in **30 days** |
| R5 | `ACTIVE`, hired more than **14 days** ago, **zero** punches ever |
| R7 | More than **40%** of a worker's clock-ins flagged over **30 days**, with at least **5** clock-ins; or a supervisor co-signing more than **20** times in 30 days |
| R8 | Standard deviation of the clock-in minute-of-day under **3 minutes** across at least **10** working days |
| R9 | A device's daily punch count above **3×** its own 30-day median, or a clock drift over **5 minutes** |
| R10 | **5 or more** orphan punches on one device in **7 days** |

R1, R6 and R11 need no threshold: they are facts, not gradients.

**R3's tolerance tunes the sweep only.** Payroll's own gate at submission
(§1) uses the fixed default of sixty minutes, because payroll may not read
detection's table. So the gate is a floor: the sweep can be made stricter
than it, never looser in what gets refused.

## 3. What counts as "present" for R3

Every `CONFIRMED` work segment counts, whatever its basis. Excluding
`MANUAL` segments would make R3 fire on every honest correction an ADMIN made
through the exception queue.

But the evidence **records the split** — how many of those minutes were
`MANUAL` (a person typed them) and how many were `PIN_FALLBACK` (a co-sign or
a staff number) — so a checker looking at a flagged line sees immediately
whether the hours rest on a face or on somebody's word.

Two things R3 knowingly does not handle yet, so nobody mistakes an alert from
them for a bug:

- **Paid leave has no record in this system.** A guard on approved leave is
  paid their basic (decision 4 of [Payroll engine (Ghana)](09-payroll-engine-ghana.md))
  and has no shifts, so to R3 the month looks like absence. Until leave
  exists as a thing the system knows about, the checker resolves that alert
  with a note saying so — which is the audit trail a leave record would have
  been anyway.
- **An adjustment line is not judged.** It corrects an earlier period's
  money (decision 20 there); its minutes are not a claim about the period it
  sits in, so R3 leaves lines with `adjusts_line_id` alone. What to compare
  them with is settled when Phase 4 builds adjustments.

## 3b. Somebody who has left

Two different questions, so two different answers, and they are written down
here so the rules stay consistent as more are built:

- **A rule about what already happened keeps a leaver.** R1, R4, R5, R7, R8,
  R9 and R10 look at enrollments, shifts and punches that are already on the
  record. Somebody leaving does not unmake them, the money has already gone
  out, and an unresolved duplicate enrollment is exactly how a ghost carries
  on after the person it was built from has gone.
- **A rule about who people are now leaves them out.** R2 asks whether two
  workers share a detail only one person should have. A leaver's old phone
  number turning up on a current worker's record is a question for HR, not a
  fraud alert, so R2 looks only at people who have not left.

## 4. Detection does not repeat the exception queue

R4 and R10 describe things Phase 2 already raises per event, as `OVERLAP` and
`UNKNOWN_EMPLOYEE` exceptions with their own queue. Detection must not shadow
them.

The line: **an exception is one event, for an operator to clear; an alert is
a pattern about a person or a device, for an investigator.** So R4 and R10
count *existing exceptions* over a window and fire only on repetition (the
thresholds above). One overlap is a bad night. Three in a month is a
question.

## 5. The shape of an alert

One table, `detection_alerts`:

- `ruleCode` (R1…R11), `severity`, `status`, `dedupeKey` (unique),
  `openedAt`, `windowFrom`/`windowTo`;
- the **subject**: nullable `employeeId`, `deviceId`, `siteId` foreign keys,
  so an alert about a person joins to that person;
- `evidence` (JSON): the IDs and numbers the rule cited — punch IDs, segment
  IDs, payroll line IDs, match scores, counts. Each rule documents its own
  shape, and a unit test pins it;
- the resolution: `resolvedByUserId`, `resolvedAt`, `resolutionNote`.

**`dedupeKey` is what makes a sweep repeatable.** It is built from the rule,
the subject and the window (`R5:<employeeId>` , `R4:<employeeId>:<month>`),
and a unique index means running the sweep twice changes nothing and never
reopens what a person resolved. This is exactly the trick
`attendance_exceptions` already uses.

`detection_rules` holds one row per rule: `code`, `enabled`, `severity`,
`thresholds` (JSON) and who last changed it. Only an ADMIN may change one,
and every change is audited.

## 6. Who may look

Alerts are suspicions about named people, so the audience is narrow:

- **ADMIN and HR_PAYROLL** see and resolve them, company-wide.
- **SUPERVISOR sees none** — a supervisor is a subject of R7, so showing them
  the queue would show them their own file.
- **GUARD sees none.**

## 7. When the sweep runs

**On demand, by an ADMIN**: `POST /detection/sweep`. That is what the exit
demo uses, and pressing it twice is safe.

It does **not** ride the heartbeat, although the retention sweep does. The
heartbeat lives in the attendance module, so calling detection from it would
make attendance import detection while detection imports attendance — the
circle section 1 exists to avoid. The daily run therefore comes from outside
the application: a Vercel Cron job calling the same endpoint. That needs an
environment secret the owner sets, so it is an owner task in the roadmap
rather than something hidden in the code. Until it is set the sweep is a
button, and `detection_checks` records when it last ran.

A sweep never fails a heartbeat, and a rule that throws is logged by code and
skipped — one broken rule must not stop the other ten.

## 8. Scoring

An employee's risk score is computed on read, never stored, so it can never
go stale:

```
score = Σ over open alerts (severity weight × min(recurrence, 5))
severity weight: CRITICAL 10, HIGH 5, MEDIUM 2
recurrence = times that rule fired for that worker in 90 days
```

## 9. What version 1 leaves out

- **R2 has no next-of-kin clause**: the field does not exist. Phone, bank
  account and mobile money do (the last two arrive with payroll).
- **R11 has no ADMIN-provenance clause.** "Decided by somebody whose ADMIN
  account was created or reset by the person who handled the worker" cannot
  be reconstructed: the audit log records which fields changed, never who was
  promoted by whom. Phase 7's two-ADMIN account rules record it properly, and
  R11 gains the clause then. Version 1 covers the part the data supports:
  decided by somebody who created either record or enrolled the other face.
- **R9 has no offline-window clause**: nothing declares a device's offline
  windows yet. It can also ask about a device's first genuinely busy day: a
  site that opens quietly while people are enrolled, then runs at full
  strength, reads as a spike against its own short history. It needs a week
  of history before it says anything, and it is MEDIUM and never acts by
  itself, so the cost is a question somebody answers once.
- **R8 measures the device's own clock, not the server's.** It has to: a
  gateway sends punches in batches, so the moment the server received one
  says more about the batch than about when somebody arrived — and a whole
  batch would look identical, which is the very pattern the rule hunts.
  Punches from a device whose clock the server already doubted
  (`clock_suspect`) are left out, so a faulty terminal cannot make a worker
  look manufactured. Somebody who controls a terminal **and** varies the
  times they invent will not be caught by this rule; that is what the other
  ten are for.
- **No automatic action, ever.** A rule surfaces and scores. A person decides.

## 10. Seed data owed

The exit demo needs three planted anomalies in `prisma/seed.ts`, all
fictional: a worker on the payroll with no punches (R5), one person enrolled
twice under two names (R1), and a guard clocked in at two sites at once (R4).
They are the labelled ground truth the report's precision and recall
discussion is written from, so they land with the engine, not after it.

## Material this module gives the report and defense

- A precision and recall discussion on the seeded data (the three planted
  ghosts plus normal noise)
- A threshold tuning table for R1: false accepts against false rejects
- "Why people stay in the loop": labour law, and the ethics of false positives

Related: [Data model](04-data-model.md) · [Roadmap](07-roadmap.md) ·
[Payroll engine (Ghana)](09-payroll-engine-ghana.md) ·
[How a backend module is built here](16-building-a-backend-module.md)
