# The defence pack

**Who this is for:** Samuel, to learn the whole system well enough to defend it
without help — and Francis, to check nothing is missing.

**How to use it:** read part 1 twice. It is the whole project in one page, and
almost every question at a defence is really a question about part 1. Then read
part 2 (the database), part 3 (the modules) and part 4 (the screens) once each,
and come back to them the night before. Part 5 is the questions you will
actually be asked, with the short answer to each.

Everything here describes **what is built today (2026-09-25)**. Where something
is not built yet it says so in a box marked **GAP**, with who owns it. Never
claim a gap is finished; saying plainly "that part is next, and here is the
design it will be built to" is a stronger answer than being caught.

**Contents**

1. [The system in one page](#1-the-system-in-one-page)
2. [The database, table by table](#2-the-database-table-by-table)
3. [The modules](#3-the-modules)
4. [The screens](#4-the-screens)
5. [Questions you will be asked](#5-questions-you-will-be-asked)

---

## 1. The system in one page

### The problem

A Ghanaian security company employs hundreds of guards across dozens of client
sites. Nobody in the head office can see who actually stood at a gate last
night. Two things follow:

- **Ghost workers.** A name sits on the payroll and is paid every month, but no
  such person ever works. The fraud needs only a supervisor who writes the
  attendance sheet and an accounts clerk who trusts it.
- **Buddy punching.** A real guard signs in for a friend who is not there.

Both are paid for with the same money: the client's fee. A company that cannot
prove presence cannot defend its invoice either.

### The idea

Replace the paper attendance sheet with **biometric proof at the site**, and then
make pay a *calculation from that proof* instead of a typed number.

One sentence: **SAMTEC pays people from evidence, and keeps the evidence.**

### The chain, end to end

```
   guard's face at the gate
            │  (company kiosk at the site, not the guard's phone)
            ▼
     a punch, signed by the device            ← evidence, append-only
            │
            ▼
     punches paired into a worked shift       ← what can be paid
            │
            ▼
     payroll: hours × pay terms, PAYE, SSNIT  ← the money
            │
            ▼
     a second person approves, then it locks  ← nobody pays alone
            │
            ▼
     eleven rules hunt for pay without presence   ← the last net
```

Read that chain aloud until it is yours. Every table, module and screen in this
document sits at one of those arrows.

### The four ideas that hold it together

1. **Evidence is never edited.** Punches, consents, audit lines and locked
   payroll runs are append-only — the *database itself* refuses to change them
   with a trigger, not just the code. A correction is a new row that says what it
   corrects. This is why the system can be trusted about the past.
2. **Nobody important acts alone.** Approving pay, deciding a duplicate face,
   letting someone work without biometrics, creating an administrator, switching
   on a device key: each needs a **second person**, and the database enforces
   that with a CHECK, not just the screen.
3. **A rule never punishes anybody.** Detection raises a question with the rows
   it looked at. A human answers it in writing, and the answer is audited.
4. **People are never deleted.** A leaver becomes `TERMINATED`. History has to
   survive, or there is nothing to audit.

### The parts

| Part | Folder | What it is | Who built it |
|---|---|---|---|
| API | `apps/api` | NestJS 12 on Express 5, Prisma 7, PostgreSQL 17. All rules live here. | Francis |
| Dashboard | `apps/web` | React 19 + Vite 8, Tailwind 4 with shadcn/ui. What office staff see. | Samuel |
| Contract | `packages/contracts` | `openapi.yaml`: the written agreement between the two. Types are generated from it. | Both |
| Kiosk app | `apps/kiosk` | The screen a guard faces at the site. **Not built yet.** | Samuel |
| ZKTeco gateway | `apps/gateway` | Talks to real fingerprint terminals. **Not built yet.** | Samuel |

> **GAP — the kiosk and the gateway apps.** The *API side* of both is finished
> and tested (`clock-in.controller.ts`, `gateway.controller.ts`,
> `apps/api/test/gateway.e2e-spec.ts`); what is missing is the screen a guard
> touches and the small service that talks to ZKTeco hardware. Samuel owns both.
> For the demo a phone or a laptop **is** the kiosk.

### Why a company kiosk and not the guard's phone

This was decided deliberately, and it is a likely question. Many guards have no
smartphone, and a phone-based clock-in can be done from a bed. So: **the company
owns the device, and the device lives at the site.** There is no geofence,
because there is nothing to fence — the terminal cannot move. The trade is that
we must now trust the terminal, which is why every device signs its requests with
a secret, a device key is born switched off, and a second administrator must
switch it on.

### The five roles

| Role | Sees and does |
|---|---|
| `ADMIN` | Everything, including users, devices, biometrics and approving pay. |
| `HR_PAYROLL` | People and preparing pay — but may never approve a run they prepared. |
| `SUPERVISOR` | Attendance and rosters, **only for the sites they are posted to**. |
| `GUARD` | Only their own record, attendance and payslips. |

A supervisor never sees the ghost-detection queue, because a supervisor is
himself one of the subjects rule R7 hunts.

---

## 2. The database, table by table

Thirty-five tables. They are grouped by the module that **owns** them — owning
means that module is the only code allowed to write to them. Every business table
carries a `companyId`, so a second security company can be added later without
touching a line of logic.

Two conventions worth stating at the defence:

- **Money is always an integer number of pesewas** (`amountPesewas`). Never a
  decimal, never a float, not even halfway through a sum. Floats lose money.
- **Times are stored in UTC** and shown in Africa/Accra time. A "work date" is
  the Ghana calendar date the shift *started*, which is what a night shift needs.

### 2.1 The company

| Table | What it holds |
|---|---|
| `companies` | The security company using SAMTEC. Version 1 has exactly one. |

### 2.2 identity — who is using the system (5 tables)

| Table | What it holds | The part worth knowing |
|---|---|---|
| `users` | A sign-in account: email, hashed password, role, and optionally the employee it belongs to. | Supervisors and guards must be linked to an employee; office accounts stand alone. It also carries the two administrator columns (`adminRequestedBy…`, `adminConfirmedBy…`). |
| `user_sessions` | One signed-in browser — the row behind a refresh-token cookie. | **Rotation:** every use of a refresh token kills its row and creates the next (`replacedById` points forward). If a token arrives for a row already replaced, somebody copied it, and **every** session of that user is killed. |
| `auth_challenges` | A half-finished sign-in: the password was right, a second step is owed. | Also carries the one-time password link (72 hours). Rows expire in minutes and are deleted once used. |
| `sign_in_throttles` | Counts failed passwords per email and failed 2FA codes per account, so guessing gets locked out. | Written with **one atomic SQL statement**, so twenty parallel guesses cannot each get a free try. This was a real bug, twice. |
| `audit_logs` | Who changed what, and when. | **Append-only:** a database trigger rejects every UPDATE and DELETE. History cannot be rewritten, not even by an administrator. |

### 2.3 workforce — the people and the places (6 tables)

| Table | What it holds | The part worth knowing |
|---|---|---|
| `employees` | A guard or staff member: staff number, names, phone, Ghana Card number, position, status. | **Never deleted.** Leaving sets `status = TERMINATED`. The Ghana Card number is unique in the company and cannot be changed through `PATCH`. |
| `employment_periods` | One stretch of employment, hire to termination. | A guard who leaves and returns keeps the **same** employee record — their Ghana Card identifies them — and each stay is one row. That is how rehire history survives, and it is also what stops the same person being enrolled twice. |
| `sites` | A client location: code, name, client, region, city, status. | |
| `posts` | A named position at a site ("Main Gate"), with how many guards it needs per shift. | Never deleted; set `status = INACTIVE` when the client stops paying for it. |
| `shift_patterns` | A company-wide pattern, e.g. "Night 18:00–06:00". | Times are **minutes from midnight** (0–1439). When the end is not after the start, the shift crosses midnight. Equal times are refused. |
| `site_assignments` | Which employee is posted where, to which post and pattern, for which dates. | `endsOn = null` means current. Moving a guard **ends** one row and **starts** another, so history is kept. |

### 2.4 attendance — the evidence (5 tables) and biometrics (7 tables)

**The evidence**

| Table | What it holds | The part worth knowing |
|---|---|---|
| `devices` | A terminal or kiosk, registered by an ADMIN for one site for life. | Its secret is stored **only encrypted** (AES-256-GCM) and signs every request. The rate limit and failed-signature counters live on this row. A key is born switched off, and whoever issued it may not switch it on. |
| `punch_events` | One punch exactly as a device reported it. | **The ground truth.** Append-only — a trigger refuses every change and delete, which is why the table has no `updated_at` at all. `deviceEventId` makes the same punch sent twice land once. |
| `work_segments` | One worked shift: a clock-in paired with its clock-out. | Its hours belong to `workDate`, the Ghana date it started. A database **exclusion constraint** forbids two confirmed segments of one person from overlapping — you cannot be paid twice for the same hour. |
| `attendance_exceptions` | Anything a person must look at: a missing clock-out, an unknown number, two sites at once. | `dedupeKey` is unique per company, so the same problem can never be raised twice, whoever raises it. |
| `attendance_checks` | One bookmark row per company for time-based checks. | Every clock-in before `overdueCheckedUntil` has already been checked for a missing clock-out; each heartbeat moves the bookmark. This is why there is **no cron job** for it. |

**Biometrics**

| Table | What it holds | The part worth knowing |
|---|---|---|
| `biometric_consents` | A worker's consent, or its withdrawal. | A **new row every time**, never changed (a trigger), and it records the exact text that was shown — its version and its SHA-256. That is the Data Protection Act answer. |
| `biometric_credentials` | One enrolled face (its numbers, encrypted — never a photo) or one finger a terminal reported, with its duplicate check and any review. | **Never deleted.** A wipe empties the template and keeps the row as evidence. |
| `biometric_exemptions` | A request to let somebody work without biometrics. | Asked by one ADMIN, decided by **another** — a database CHECK, not a screen rule. It only moves forward. |
| `device_passkeys` | A worker's fingerprint key on one kiosk (WebAuthn) — **only the public half**. | The finger itself never leaves the device. Revoked, never deleted. |
| `clock_in_attempts` | Every face or finger attempt at a kiosk, matched or not, with its scores. | Append-only. **The scores stay here, on the server** — they are never sent to the kiosk, so nobody can tune a mask against the number. Its ID becomes the punch's `deviceEventId`. |
| `finger_enrollment_windows` | The 30 minutes an ADMIN opens so one worker may enroll a finger on one terminal. | A finger reported outside every window is refused. **A terminal must never be able to enroll somebody by itself** — that would be a ghost factory. |
| `terminal_enrollment_reports` | Every finger a terminal claimed, accepted or refused. | Append-only, so a terminal trying to enroll people by itself is *visible* instead of silent. |

### 2.5 detection — the last net (3 tables)

| Table | What it holds | The part worth knowing |
|---|---|---|
| `detection_rules` | One row per rule: switched on or off, how serious, and its numbers. | The thresholds live in the database so they can be tuned **without a deploy** — and so the report's tuning table can be produced by moving them and re-running. |
| `detection_alerts` | A pattern worth a person's attention: who, the window it was found in, and the rows the rule cited. | Never deleted. `dedupeKey` stops the same alert appearing every night. |
| `detection_checks` | When this company's rules last ran. | |

### 2.6 payroll — the money (8 tables)

| Table | What it holds | The part worth knowing |
|---|---|---|
| `payroll_periods` | One calendar month of pay. | Moves OPEN → CLOSED and never back. |
| `tax_tables` | A frozen version of the statutory rates (SSNIT percentages, in basis points). | A rate change is a **new row, never an edit** — a trigger refuses to change one a run has used. It also records where the rate came from and when that was checked. |
| `tax_bands` | One step of the graduated PAYE table. | The last band has no width because it has no upper limit, and a CHECK insists on exactly that. |
| `employee_pay_terms` | What an employee is paid: basic, overtime rate, allowances, deductions. | Effective-dated and **never edited**: a change is a new row. A run reads the row in force on the period's last day and **copies every value into the line**. |
| `employee_payment_details` | Where the money is sent: bank, account, mobile money. | **Personal data.** Never logged, never in an error message, never on a list a supervisor can read. Its `updatedAt` is compared with the run's `approvedAt`, so a destination that moved *after* approval is shown in the bank export instead of quietly paid. |
| `payroll_runs` | One calculation of one period's pay, with who calculated, submitted, approved, rejected and paid it. | Once `LOCKED`, a trigger rejects every UPDATE and DELETE — on the run **and** on its lines. |
| `payroll_lines` | One employee's pay for one run, with **every input copied in**. | So a locked run can be re-checked years later without reading another table. Totals are the sums of the parts printed beside them and net is their difference — a CHECK proves it. |
| `payslips` | The payslip PDF, as bytes. | Made once, **inside the transaction that locks the run**, so what was sent is exactly what exists. |

> **GAP — payroll is Samuel's, and it is part-built.** The eight tables, the
> migration, the calculation and the setup endpoints (months, tax table
> versions, pay terms, payment details) are in, with hand-calculated payslips
> pinned as tests on both sides. **Calculating a run and reading it back is
> open as PR #65.** Still to come: submit, approve, reject, mark paid; the
> payslip PDF; the bank export; and the payroll screens. Every design question
> is already decided in
> [docs/plan/09-payroll-engine-ghana.md](../plan/09-payroll-engine-ghana.md) —
> twenty-six numbered decisions. If asked about a payroll detail, quote the
> decision.

### 2.7 What to say about the schema at the defence

> "Thirty-five tables in six modules. A module writes only to its own tables and
> calls another module's service for the rest, so the boundaries in the diagram
> are real boundaries in the code. Anything that is evidence — punches,
> consents, audit lines, a locked run — is append-only in the database itself,
> with a trigger, so it cannot be rewritten even by an administrator. And every
> table that enables row-level security does so in the same migration that
> creates it."

---

## 3. The modules

Six modules under `apps/api/src/modules/`. Each has its own README in its folder;
this section is the plain-language version.

**The one rule that keeps them honest:** a module writes only to its own tables.
If payroll needs employee data it calls a method on the workforce service; it
never queries the `employees` table itself. Detection reads payroll only through
`payroll-facts.service.ts`. That single rule is the architecture.

### 3.1 identity — who you are and what you may do

**Owns:** `users`, `user_sessions`, `auth_challenges`, `sign_in_throttles`,
`audit_logs`.

**Sign-in, step by step**

1. `POST /auth/login` with email and password. The password is hashed with
   **scrypt**; the stored hash is never reversible.
2. If the account has two-factor authentication, the answer is not a token but
   `TWO_FACTOR_REQUIRED` plus a short-lived **challenge token**.
3. `POST /auth/2fa/verify` with the 6-digit code from the authenticator app
   (RFC 6238 TOTP, tested against the RFC's own vectors) and the challenge token.
4. Now two things come back: a short-lived **access token** (a JWT, sent on every
   request) and a **refresh cookie** (HTTP-only, so no script can read it).
5. `POST /auth/refresh` trades the cookie for a fresh pair and **rotates** it.
   A reused cookie means a copy exists: every session of that user dies.

**The other endpoints:** `/auth/2fa/setup` and `/auth/2fa/enable` (the QR-code
flow), `/auth/logout`, `GET /auth/me`, `POST /auth/set-password` (the one-time
link) and `POST /auth/change-password`.

**User management** (`/users`, ADMIN only): create, change, deactivate,
reactivate, reset a sign-in, and `POST /users/{id}/confirm-admin`.

**Three guards run on every request, in this order:**

1. `access-token.guard.ts` — is there a valid token, and **may this account still
   be used**? (Checked on every single request, not only at sign-in, so
   deactivating somebody takes effect at once.)
2. `kiosk-scope.guard.ts` — a token minted at a kiosk may only reach kiosk routes.
3. `roles.guard.ts` — does this role have this route? (`@Roles(...)`)

A route is only open to the world if it is marked `@Public()`.

**The two-administrator rule (Phase 7).** Creating, promoting, resetting or
switching on an ADMIN account leaves it `AWAITING_CONFIRMATION` until a
*different* ADMIN confirms it. Same for a device key. This closes the "one
person, two accounts" hole — one person could otherwise be both people in every
two-person rule.

**Know this one:** the sole-administrator shortcut is deliberate. Deactivating
the *other* administrator needs nobody's approval, because otherwise a company
whose only other admin has left is locked out for ever. A Phase 7 review found
that this shortcut counted admins by `isActive`, which re-opened the hole — it
is fixed, with a test.

### 3.2 workforce — the people and the places

**Owns:** `companies`, `employees`, `sites`, `site_assignments`, `posts`,
`shift_patterns`.

**Endpoints:** `GET/POST /employees`, `GET/PATCH /employees/{id}`,
`POST /employees/{id}/terminate`, `GET /sites`, `GET /sites/{id}`,
`GET/POST /sites/{id}/posts`, `PATCH /posts/{id}`, and `GET/POST/PATCH
/shift-patterns`.

**The rules it enforces**

- Employees are never deleted; leaving sets `TERMINATED`, and that also switches
  off their sign-in account.
- One Ghana Card number, one employee — a database unique constraint.
- The Ghana Card number cannot be changed through `PATCH`. An identity
  correction needs an audited admin process, because that field is what stops the
  same person being hired twice.
- List responses leave sensitive fields out (data minimisation).
- **Supervisors only see their own sites.** A record they may not see returns
  `404`, not `403` — a `403` would confirm the record exists.
- Moving a guard ends the current assignment and starts a new one.

### 3.3 attendance — from a face at a gate to payable hours

**Owns:** `devices`, `punch_events`, `work_segments`, `attendance_exceptions`,
`attendance_checks`, plus the seven biometric tables.

This is the biggest module. Read it in four pieces.

**Piece 1 — the device registry.** `GET/POST /devices`, `GET/PATCH
/devices/{id}`, `POST /devices/{id}/rotate-secret`,
`POST /devices/{id}/finger-enrollment-windows`. ADMIN only. The secret is shown
**once** and then only stored encrypted.

**Piece 2 — signed ingest.** A device has no user account. Instead every request
carries a signature:

```
HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")
```

`device-signature.guard.ts` checks it, counts the device's rate limit, and
refuses a kind of device a route does not allow (`kindMayUse` — a face kiosk may
not report a fingerprint enrollment). `POST /ingest/punches` stores each punch
once; `POST /ingest/heartbeat` says the terminal is alive and does the
time-based housekeeping.

**Know this one:** a device reports its own clock drift. A Phase 7 review found
the drift was trusted **uncapped**, so a terminal could claim its clock ran hours
fast and buy itself future paid hours. It is now capped at five minutes, with a
test.

**Piece 3 — pairing.** `pairing.ts` holds the rules as **pure functions** — rows
in, decisions out, no database and no clock of its own, which is why they can be
tested exhaustively. The rules: an IN then an OUT, same site, at most 16 hours.
Anything else becomes an exception for a human: a missing clock-out, an unknown
device number, two sites at the same time. `pairing.service.ts` re-pairs a
person's last 62 days after new punches or after a correction.

**Piece 4 — biometrics (Phase 3).** Two sides:

*The kiosk side.* `GET /biometrics/consent-text`, `POST /kiosk/consents`,
`POST /kiosk/face-enrollments`, `POST /kiosk/passkey-options`,
`POST /kiosk/passkeys`, and the clock-in itself: `POST /kiosk/identify`,
`/kiosk/confirm`, `/kiosk/not-me`, `/kiosk/fingerprint-options`,
`/kiosk/assisted-punches`.

*The dashboard side.* `GET /employees/{id}/biometrics`, revoke, withdraw consent,
ask for and decide an exemption, and the duplicate queue
(`GET /biometric-collisions`, `POST /biometric-collisions/{id}/resolve`).

**How a face match actually works** (`face-match.ts`, `face-thresholds.ts`):

- A face becomes **1024 numbers** (the `human-faceres-1` model). No photo is
  ever stored.
- Those numbers are sealed with AES-256-GCM before they touch the database, with
  a key derived from the server's `AUTH_SECRET`. The seal is bound to the
  company, the employee and the credential, so a row cannot be moved to another
  person.
- To identify someone the server compares against every enrolled face in the
  company (**1:N**) and needs two things: a similarity of at least **0.60**, and
  a **lead of 0.05** over the runner-up. A close second means "not sure", not a
  guess.
- Three camera frames must agree with each other (0.70), and an anti-spoofing
  score must pass (0.60) — a photo held up to the camera fails.
- At enrollment a stricter check (0.50) looks for a face that is already
  somebody else's. If it finds one, this is a **possible duplicate**, and a
  second administrator decides.
- **The scores never leave the server.**

**Fingerprints, and the honest limit.** On a phone or laptop kiosk the
fingerprint is the *device's own sensor* through WebAuthn/passkeys. The device
only says "a registered finger on this device unlocked this key" — it **cannot
say whose finger it was**. So it is never used alone: it is combined with the
face (`FACE_PASSKEY`) or with a typed staff number (`STAFF_PASSKEY`), the method
is recorded on the punch, and the report states the limit. Real per-person
fingerprint identification is the ZKTeco terminal path, which is production
hardware waiting on a paying client.

**The rules a defence question will land on**

- Biometrics only move a worker between `PENDING_ENROLLMENT` and `ACTIVE`. They
  never touch a suspended or terminated record.
- One face per worker.
- **One open question at a time.** An open duplicate or a requested exemption
  blocks consent, enrollment, further requests and revoke, so two half-finished
  reviews can never disagree.
- A `SAME_PERSON` decision is **final**. The loser's face ends up `BLOCKED` and
  stays blocked.
- Withdrawing consent is ADMIN-only and *files a request*; a different ADMIN
  approves it. Meanwhile the worker is `PENDING`, and co-signed punches raise an
  `INACTIVE_EMPLOYEE` exception and are paid only after approval.
- A leaver's face is wiped after **90 days**, by a sweep that rides on the
  heartbeat.
- Every decision takes a lock on the employee row
  (`biometric_lock_worker`), so two administrators deciding at once serialise
  instead of racing.

### 3.4 detection — eleven rules that hunt a ghost

**Owns:** `detection_rules`, `detection_alerts`, `detection_checks`.

**Endpoints:** `GET /detection/alerts`, `GET /detection/alerts/{id}`,
`POST /detection/alerts/{id}/resolve`, `POST /detection/sweep`,
`GET /detection/rules`, `PATCH /detection/rules/{code}`,
`GET /detection/risk-scores`, and `GET /detection/daily-sweep` — the route the
Vercel schedule calls once a day.

The full list with every number is in
[docs/plan/08-ghost-detection-engine.md](../plan/08-ghost-detection-engine.md).
The shape to remember: the rules themselves are **pure functions** — rows in,
findings out, no database and no clock — and `detection.service.ts` does the
fetching and the writing. That split is why each rule has a test that moves its
threshold and watches the finding change, which is also how the report's tuning
table was built.

**The three worth knowing by name**

- **R3 — paid beyond presence.** Compares what a run paid against confirmed
  attendance. Its comparison lives in `src/common/paid-beyond-presence.ts` so
  payroll's submit gate can use the same code without importing detection. Known
  limits, written down: paid leave has no attendance record so it looks like
  absence, and adjustment lines are skipped.
- **R7 — the supervisor's own patterns.** This is why a supervisor never sees
  this queue.
- **R11 — ghost relationships.** Flags indirect links between the people
  deciding a two-person review, instead of blocking them, so a company with only
  two administrators never deadlocks.

**Know this one:** R7 fed a terminal's free-text `deviceEventId` into a UUID
column, so the sweep silently skipped R7 for any company whose terminal had ever
sent a PIN-fallback punch — which the shipped simulator does. Found in the Phase
7 review, fixed with a test. The lesson to say out loud: *a rule that fails
silently is worse than no rule*, so the sweep now surfaces its own failures.

> **The one thing still owed in detection:** R3's second control is a gate on
> payroll's *submit* endpoint, which is in Samuel's Phase 4 work. Until it
> lands, the nightly sweep is R3's only control.

### 3.5 payroll — Ghanaian pay, from verified attendance

**Owns:** the eight payroll tables. Nothing outside writes to them, and payroll
writes to nothing else: it asks workforce about people and attendance about
confirmed shifts.

**How a month is paid** (the design:
[docs/plan/09-payroll-engine-ghana.md](../plan/09-payroll-engine-ghana.md)):

1. An HR user opens the month (`POST /payroll/periods`).
2. A tax table version is in force, with its source recorded.
3. Each employee has effective-dated pay terms and payment details.
4. The run is **calculated**: worked minutes from confirmed segments, split into
   regular and overtime; basic pro-rated for days employed; allowances added;
   SSNIT taken; PAYE worked out through the graduated bands; net is what is
   left. Every input is **copied onto the line**.
5. It is **submitted**, then **approved by a different person**, then **marked
   paid**. Approving locks it for ever, and the payslip PDF is written in the
   same transaction.

**The rules that must hold**

- Integer pesewas only.
- Only the pro-rated basic and the overtime are rounded — once each, half-up.
  Everything else is addition and subtraction of numbers already printed, so a
  payslip always adds up by eye.
- Whoever prepared a run may never approve it.
- A locked run is immutable in the database, not just in the code. A mistake is
  corrected by an **adjustment line** that points at the line it adjusts.

> **GAP — what is built and what is not.** Built: the tables and migration, the
> calculation (with hand-calculated payslips as tests), and the setup endpoints.
> Open as PR #65: calculating a run and reading it back. Not built yet: submit,
> approve, reject, mark paid, the payslip PDF, the bank export and the screens.
> **Samuel owns all of it.**

### 3.6 reporting — summaries and exports

**Owns no tables at all.** It only reads, through the other modules' services.

Its three rules are already written: reports never write to business tables;
they apply the same role and site restrictions as the data they summarise; and
an export never contains biometric data, and contains Ghana Card numbers only for
roles that need them.

> **GAP — Phase 6 is not started.** The folder holds only its README. Planned:
> attendance and payroll-cost summaries, CSV and PDF exports, and a guard's own
> payslip. **Samuel owns it.** Francis's final visual pass over every screen is
> the last build step of the project, after this.

---

## 4. The screens

All under `apps/web/src/pages/`. Addresses live in one place,
`apps/web/src/app/routes.ts`; the sidebar is `components/layout/nav-items.ts`;
who may open what is `lib/roles.ts`, copied from the API's `@Roles(...)` so the
sidebar never offers a page the API would refuse.

**Say this about the dashboard:** the API is the real gatekeeper. The dashboard
hides what you may not use, but hiding is a courtesy — every rule is enforced
again on the server. Every screen that loads data has a **loading, an empty and
an error state**; that is a repository rule, not a nicety.

### 4.1 Signing in (open to everyone)

| Screen | File | What it does |
|---|---|---|
| Sign in | `login-page.tsx` | Email and password. Sends you on to the code screen, the setup screen, or the dashboard. |
| Two-factor code | `two-factor-verify-page.tsx` | The 6-digit code from the authenticator app, plus the challenge token from the password step. |
| Two-factor setup | `two-factor-setup-page.tsx` | The QR code, for an account that must switch 2FA on before it can be used. |
| Set your password | `set-password-page.tsx` | Where a one-time link lands. The token sits after `#` in the address, so it never reaches a server log. |
| Change password | `change-password-page.tsx` | For somebody already signed in. |

### 4.2 Everyday screens

| Screen | File | Who | What it shows |
|---|---|---|---|
| Overview | `overview-page.tsx` | everyone | Where to start: a card per area this role may open. |
| Employees | `employees-page.tsx` | ADMIN, HR, SUPERVISOR | Guards and staff, with their posting and whether they are enrolled. A supervisor sees only their sites. |
| One employee | `employee-detail-page.tsx` | as above (a guard sees their own) | The record, employment history, postings — and the **Biometrics panel** (`components/biometrics-panel.tsx`): consent, the enrolled face, fingerprint keys, revoke, withdraw, exemptions. |
| Sites | `sites-page.tsx` | ADMIN, HR, SUPERVISOR | Client locations, who is on post, which sites are active. |
| Attendance | `attendance-page.tsx` | ADMIN, HR, SUPERVISOR | Clock-ins paired into worked shifts, by day and site. |
| My attendance | `my-attendance-page.tsx` | GUARD | Your own shifts, and nobody else's. |
| Live board | `live-board-page.tsx` | ADMIN, HR, SUPERVISOR | Every clock-in as it arrives, refreshed every five seconds. **This is the screen to demo.** |
| Exceptions | `exceptions-page.tsx` | ADMIN, HR, SUPERVISOR | The queue: missing punches, unknown numbers, overlaps. HR reads; ADMIN and SUPERVISOR resolve. |
| One exception | `exception-detail-page.tsx` | as above | The evidence and the form that answers it — with a note, which is audited. |

### 4.3 Administrator screens

| Screen | File | Who | What it shows |
|---|---|---|---|
| Devices | `devices-page.tsx` | ADMIN | Every terminal and kiosk, and its health. |
| New device | `new-device-page.tsx` | ADMIN | Registers one. The secret appears **once**. |
| One device | `device-detail-page.tsx` | ADMIN | Its details, last seen, rotate its secret, open a finger-enrollment window. |
| Kiosk attempts | `kiosk-attempts-page.tsx` | ADMIN | Every face and finger attempt, matched or not. Scores stay on the server. |
| Duplicate faces | `duplicate-faces-page.tsx` | ADMIN | New faces that looked like somebody already enrolled. A **second** administrator decides: same person, or not. |
| Users | `users-page.tsx` | ADMIN | Sign-in accounts: who can open the dashboard, with which role. |
| New user | `new-user-page.tsx` | ADMIN | Creates one; the person chooses their own password from a one-time link. |
| One user | `user-detail-page.tsx` | ADMIN | Change the role, deactivate, reactivate, reset a sign-in, **confirm an administrator**. |

### 4.4 Ghost detection

| Screen | File | Who | What it shows |
|---|---|---|---|
| Ghost detection | `detection-page.tsx` | ADMIN, HR | The alert queue, the highest-risk panel, and a "Run the rules now" button. |
| One alert | `detection-alert-page.tsx` | ADMIN, HR | The rows the rule cited, and the form that answers it in writing. |
| The rules | `detection-rules-page.tsx` | ADMIN, HR | All eleven with their numbers. ADMIN tunes them; HR reads them. |

Every label on these screens comes from `apps/web/src/lib/detection.ts`, so the
words in the report match the words on the screen.

### 4.5 Housekeeping screens

| Screen | File | What it does |
|---|---|---|
| System status | `system-status-page.tsx` | Whether the dashboard can reach the API, and the API its database. |
| Not found | `not-found-page.tsx` | An address that does not exist. |
| Not allowed | `forbidden-page.tsx` | A page this role may not open — the same wording as the API's 403. |
| Something broke | `route-error-page.tsx` | Shown when a page crashes, instead of a blank screen. |

### 4.6 What is not on the dashboard yet

> **GAP — three things.**
> 1. **Payroll screens** (Phase 4, Samuel). The sidebar already carries a
>    Payroll entry marked unavailable, with the phase that brings it. The mock
>    API and the hand-calculated payslips are already in
>    `apps/web/src/mocks/handlers/payroll.ts`, so the screens have something to
>    be built against.
> 2. **Reports screens** (Phase 6, Samuel), likewise marked unavailable.
> 3. **The employee create / edit / terminate forms.** The API endpoints exist
>    and are tested; the forms do not.
>
> Also outside the dashboard: **the kiosk app** (`apps/kiosk`) and the **ZKTeco
> gateway** (`apps/gateway`), both Samuel's, both with their API side finished.

---

## 5. Questions you will be asked

Short answers. Say the answer, then stop — the follow-up is where the marks are.

**"What problem does this solve?"**
A security company cannot prove who stood at a gate last night, so it pays ghost
workers and cannot defend its invoice. SAMTEC pays people from biometric
evidence and keeps the evidence.

**"Why not just use the guard's phone?"**
Many guards have no smartphone, and a phone can clock in from a bed. The company
owns the terminal and the terminal lives at the site, so there is nothing to
geofence. The cost is that we must trust the terminal, which is why every device
signs its requests, a device key is born switched off, and a second
administrator switches it on.

**"Do you store people's fingerprints or photos?"**
No. A face becomes 1024 numbers, encrypted before they reach the database with a
key bound to the company, the employee and the credential. A fingerprint never
leaves the device at all — we hold only the public half of a WebAuthn key. No
image is ever stored.

**"Is that legal in Ghana?"**
The Data Protection Act 843 needs consent, a purpose, and the least data that
serves it. Consent is a row that records the exact text shown, its version and
its SHA-256; it is never edited, only added to. Withdrawal is a first-class
action. A leaver's face is wiped after 90 days. Lists leave sensitive fields out,
and payment details are never on a list a supervisor can read.

**"What stops a guard clocking in for a friend?"**
The face is matched 1:N against everyone enrolled, needing both a similarity of
0.60 and a clear lead of 0.05 over the runner-up, with three frames agreeing and
an anti-spoofing check that a held-up photo fails. If a fingerprint is used it is
never alone — it is tied to the face or to a typed staff number, and the method
is stamped on the punch.

**"Where did 0.60 come from? Why not 0.5 or 0.8?"**
They start as the Human library's suggested working points, and they are named
`ft-1` and stored on every attempt, so a later change can never make an old
attempt look as if it were judged by new numbers. A study measures what each one
would decide — [the threshold report](14-face-threshold-report.md). Its useful
result: on a crowd with look-alikes, removing the lead rule matches four clock-ins
in two hundred to the *wrong person*, and 0.05 turns all four into a second try;
raising `match` above 0.65 only starts refusing honest guards. The honest part of
that answer is that the study uses generated faces, so the pilot with real
volunteers is still owed before a paying client.

**"What if the face fails — a scar, bad light, a wet camera?"**
Three failed attempts allow a staff-number-plus-finger fallback, and the punch is
**flagged** as such. Beyond that an administrator can request an exemption, which
a *second* administrator must approve. Nobody is stuck outside the gate, and no
route around the biometrics is silent.

**"Can an administrator not just fix the numbers?"**
No. Punches, consents, audit lines and locked payroll runs are append-only in the
database — a trigger rejects every UPDATE and DELETE. A correction is a new row
that says what it corrects, and every one of them is audited with who and when.

**"What stops one dishonest administrator?"**
Every serious action needs a second person, checked by the database: approving
pay, deciding a duplicate face, granting an exemption, creating or promoting an
administrator, switching on a device key. Whoever prepares a payroll run can
never approve it.

**"Then what stops one person holding two administrator accounts?"**
That was a real hole, and it is closed: a new or promoted administrator stays
`AWAITING_CONFIRMATION` until a *different* administrator confirms it. One
deliberate exception remains and is documented — switching the *other*
administrator off needs nobody, or a company whose last other admin resigned is
locked out for ever.

**"How do you know the system works?"**
Tests, and reviews with teeth. Money and the biometric rules are tested to the
last pesewa and the last threshold; database rules are proved against real
PostgreSQL, including two-connection race tests. Every phase goes through four
review lenses — architect, senior developer, full-stack, security — and any
serious finding is handed to a sceptic told to refute it. The whole-system review
found twenty real findings; three were blockers; all twenty are fixed, each with
a test where a test could be written.

**"Name a bug you found and what it taught you."**
Pick one and tell it properly:
- A terminal reported its own clock drift and was believed without a cap, so it
  could buy itself future paid hours. *Never trust a number a device reports
  about itself.*
- Rule R7 put free text into a UUID column, so the sweep skipped R7 silently for
  any company whose terminal sent a PIN-fallback punch. *A control that fails
  quietly is worse than no control.*
- Two-factor checking read the lockout and then wrote it, so a burst of parallel
  guesses each got a free try. *Read-then-write is not a lock.*

**"What happens if the database is lost?"**
The hosted free plan has no backups, which the drill found, so a backup was
built: a full dump, the newest fourteen kept, with a log. It has been proved by
destroying a database and putting it back, then running the whole test suite
against the restored copy. The honest gaps are written down: a week is the most
it can lose, it runs on one laptop, and the drill has not yet been run against
the hosted database.

**"What is not finished?"**
Payroll's run workflow, the payslip PDF, the bank export and the payroll screens;
reports; the kiosk and gateway apps; and the final visual pass. Every one has a
written design and an owner. *(Update this answer on the day — check
[docs/plan/07-roadmap.md](../plan/07-roadmap.md).)*

**"What would you do differently?"**
Two honest answers. Put the five biometric thresholds in the database from the
start, as detection's rules are, so tuning never needs a deploy. And write the
race tests earlier: three of the worst bugs were two things happening at once,
and none of them showed up in an ordinary test.

---

## Where to look things up

| Question | File |
|---|---|
| Why is it built this way? | [docs/plan/03-system-architecture.md](../plan/03-system-architecture.md) |
| Every table and column | [docs/plan/04-data-model.md](../plan/04-data-model.md) and `apps/api/prisma/schema.prisma` |
| Every endpoint | `packages/contracts/openapi.yaml` |
| Attendance rules, with reasons | [docs/plan/12-attendance-design.md](../plan/12-attendance-design.md) |
| Biometric rules, with reasons | [docs/plan/13-biometrics-design.md](../plan/13-biometrics-design.md) |
| Why the face numbers are what they are | [The face-matcher threshold report](14-face-threshold-report.md) |
| Ghost-detection rules and numbers | [docs/plan/08-ghost-detection-engine.md](../plan/08-ghost-detection-engine.md) |
| Payroll decisions (all twenty-six) | [docs/plan/09-payroll-engine-ghana.md](../plan/09-payroll-engine-ghana.md) |
| Security, the threat model, review gates | [docs/plan/06-security-and-review-gates.md](../plan/06-security-and-review-gates.md) |
| The security chapter of the report | [The security chapter, drafted](12-security-chapter.md) |
| What is done and what is next | [docs/plan/07-roadmap.md](../plan/07-roadmap.md) |
| A word you do not know | [Glossary](08-glossary.md) |
