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
- [ ] Posts, shift patterns and assignments (contract first)
- [x] Dashboard (Samuel): sign-in and two-factor screens, employee list and detail, site pages — the mock API already supports all of them
- [x] Dashboard (Samuel): once the sign-in screens work against the live API, remove the live-mode notice in `apps/web/src/app/router.tsx`
- [x] Dashboard (Samuel): brand theme with light/dark mode, an Overview home page at `/`, System status moved to `/status` (Phase 6 polish pulled forward)
- **Exit demo:** create an employee, assign them to a site and shift, and see the change in the audit trail

## Phase 2 · Attendance on mocks (weeks 4 and 5)

**Goal: the whole punch-to-hours pipeline with no hardware.**

- `BiometricProvider` interface and a mock provider that simulates punches, clock drift and repeated sends
- `POST /ingest/punches` with HMAC signatures and idempotency
- Pairing of clock-ins and clock-outs into work segments
- Exception queue (missing clock-out, overlaps, unknown employee) with a resolution screen
- Night shifts from 22:00 to 06:00 proven with tests
- **Exit demo:** replay 30 days of seeded punches and watch the attendance dashboard fill in

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
