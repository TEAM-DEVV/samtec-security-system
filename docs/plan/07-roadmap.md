# 07 · Roadmap: nine phases, each ending with a working demo

This page is the authoritative checklist for every phase. The timing assumes part-time work alongside school. Adjust dates in the weekly check-in, never silently.

## Phase 0 · Foundation (week 1)

**Goal: a repository two people cannot trip over.**

- [x] Monorepo with pnpm workspaces, strict TypeScript and Biome
- [x] CI pipeline: lint, contract check, type check, tests, build, migrations, audit
- [x] NestJS API skeleton with `/api/v1/health`, security headers, request IDs and Problem Details errors
- [x] Vite dashboard skeleton with the typed API client, mock API, System Status page and a reference Employees page
- [x] Prisma schema version 0 (companies, sites, employees, site assignments), first migration and seed data
- [x] API contract version 0: health, auth, employees and sites
- [x] Plan and beginner guides committed to `docs/`; four-lens reviewers in `.claude/`
- [x] Four-lens review of the Phase 0 pull request, with every finding fixed

**Exit demo:** `pnpm dev` starts the API and the dashboard, and the System Status page shows the database as connected. CI is green on a real pull request.

**Outside the repository.** These tasks need a person, not a pull request, and they do not block Phase 1:

- [ ] Repository owner: protect `main`, require code owner review, and turn on private vulnerability reporting and Dependabot alerts ([Git and pull requests](../guides/06-git-and-pull-requests.md#protecting-the-main-branch-repository-owner-once))
- [ ] **Order or borrow a ZKTeco device now.** It is the item with the longest lead time in the project.

## Phase 1 · Identity and workforce (weeks 2 and 3)

**Goal: sign in, see employees, model the company.**

- [x] Sign-in: JWT and refresh cookie with rotation and reuse detection, role guards on every route, two-factor setup and verification for ADMIN and HR_PAYROLL, per-email lockout
- [x] Admin-only system information endpoint (API version and environment), because the public health check no longer shares them
- [x] Append-only audit log (database-enforced), recording sign-in events; coverage grows with each write endpoint
- [x] Read endpoints: employees and sites with role scoping (supervisors see their sites, guards themselves)
- [x] Employees: create, update, terminate; employment periods for rehired guards
- [x] Posts, shift patterns and assignments (contract first): posts per site with required guard counts, company-wide shift patterns (night shifts cross midnight), and employees assignable to site + post + shift
- [x] Dashboard (Samuel): sign-in and two-factor screens, employee list and detail, site pages — the mock API already supports all of them
- [x] Dashboard (Samuel): once the sign-in screens work against the live API, remove the live-mode notice in `apps/web/src/app/router.tsx`
- **Exit demo:** create an employee, assign them to a site and shift, and see the change in the audit trail

Added to Phase 1 during the build (needed before the pilot, and by Phase 4's maker–checker and Phase 6's guard payslips):

- [x] User management (API): administrators create, change, switch off and reset sign-in accounts; owners choose their own password with a one-time link; the token guard checks the account on every request; terminating an employee switches their account off; an audited script creates the first administrator
- [x] Dashboard: the public set-password page, where a one-time link lands (`/set-password#token=…`)
- [ ] Dashboard (Samuel): Users pages for ADMIN and a change-password form — the mock API already supports them

## Phase 2 · Attendance on mocks (weeks 4 and 5)

**Goal: the whole punch-to-hours pipeline with no hardware.**

- [x] Contract and dashboard mocks for devices, ingest, work segments and the exception queue; every rule in [Attendance design](12-attendance-design.md)
- [x] `BiometricProvider` interface and a mock provider; a device simulator that replays punches with clock drift and repeated sends (`mock:devices`)
- [x] Device registry (secret shown once, stored encrypted) and `POST /ingest/punches` with HMAC signatures, idempotency and a per-device rate limit
- [x] Pairing of clock-ins and clock-outs into work segments, re-paired from scratch over 62 days, so arrival order never matters
- [x] Exception queue API (missing clock-out or clock-in, unknown or inactive employee, overlaps) and resolving it: nobody resolves their own attendance, and HR reads but never creates hours
- [x] Night shifts from 22:00 to 06:00 proven with tests (480 minutes, counted on the start date)
- [ ] Dashboard (Samuel): attendance day view, a guard's "My attendance", the exception queue with its resolution screen, and the Devices page (ADMIN). The mock API already supports them.
- **Exit demo:** replay 30 days of seeded punches and watch the attendance dashboard fill in ([The attendance demo](../guides/10-attendance-demo.md))

## Phase 3 · Real biometrics (weeks 6 and 7)

**Goal: one real device path, plus the face kiosk.**

- ZKTeco adapter: ADMS push endpoint, with `zkteco-js` pull as a fallback; enrollment sync
- Face kiosk (`apps/kiosk`) with the Human library: enroll, identify, anti-spoofing threshold, flagged PIN fallback
- Duplicate check at enrollment: a new template compared against all existing ones raises a COLLISION alert
- **Exit demo:** a real finger or face clock-in appears on the dashboard within seconds

## Phase 4 · Payroll engine (weeks 8 to 10): the crown jewel

**Goal: Ghana-correct, locked, auditable pay.**

- Close a period, calculate a draft run, copy every input into its lines
- PAYE bands and SSNIT rates from versioned tables, per [Payroll engine (Ghana)](09-payroll-engine-ghana.md), with golden tests
- Maker–checker approval, lock trigger, payslip PDFs, bank CSV export
- **Exit demo:** close a month, approve it as a second user, and open a payslip whose numbers can be checked by hand

## Phase 5 · Ghost detection (weeks 11 and 12)

**Goal: the feature that sets SAMTEC apart.**

- Rules engine and nightly sweep, per [Ghost detection engine](08-ghost-detection-engine.md)
- Alert review queue showing evidence; every resolution audited
- **Exit demo:** the three planted ghosts in the seed data are all caught live; a written false-positive discussion for the report

## Phase 6 · Dashboard and reports polish (week 13)

- Live attendance board and key figures: headcount present, absence rate, payroll cost trend
- CSV and PDF reports; guards can view their own payslips
- **Exit demo:** a full dry run of the 15-minute client walkthrough

## Phase 7 · Hardening (week 14)

- Full security review of the repository; findings fixed or accepted in writing
- Load test of punch ingestion (a burst of 1,000 punches); backup and restore drill; threat model refresh
- **Exit demo:** the security chapter of the report is drafted from the results

## Phase 8 · Deploy and present (week 15 onwards)

- Demo environment online and seeded (API on Railway or Render, dashboard on Vercel, database on Supabase)
- Deliver the [Client presentation plan](11-client-presentation-plan.md); defense slides built from this plan
- **Exit demo:** presentation delivered and a pilot proposal in the client's hands

## Weekly check-in (15 minutes, both developers)

1. Demo what moved this week.
2. Does the contract need to change?
3. What is blocking us?
4. Name next week's exit demo.
