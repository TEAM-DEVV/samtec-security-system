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
- [ ] **ZKTeco device:** bought when a client pays (owner decision, Phase 3). Until then the gateway is proven against the fake terminal, and a phone is the kiosk.

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
- [x] Dashboard (Samuel): brand theme with light/dark mode, an Overview home page at `/`, System status moved to `/status` (Phase 6 polish pulled forward)
- [x] Dashboard (Samuel): executive design foundation — heading font, motion with a reduced-motion switch, boot screen, sign-in stage, shell and page styling, phone layouts (the Phase 6 visual pass pulled forward; Phase 6 keeps the final review pass)
- **Exit demo:** create an employee, assign them to a site and shift, and see the change in the audit trail

Added to Phase 1 during the build (needed before the pilot, and by Phase 4's maker–checker and Phase 6's guard payslips):

- [x] User management (API): administrators create, change, switch off and reset sign-in accounts; owners choose their own password with a one-time link; the token guard checks the account on every request; terminating an employee switches their account off; an audited script creates the first administrator
- [x] Dashboard: the public set-password page, where a one-time link lands (`/set-password#token=…`)
- [x] Dashboard (Samuel): Users pages for ADMIN (list, add with the one-time link, account page with switch off/on and reset sign-in) and a change-password form

## Phase 2 · Attendance on mocks (weeks 4 and 5)

**Goal: the whole punch-to-hours pipeline with no hardware.**

- [x] Contract and dashboard mocks for devices, ingest, work segments and the exception queue; every rule in [Attendance design](12-attendance-design.md)
- [x] `BiometricProvider` interface and a mock provider; a device simulator that replays punches with clock drift and repeated sends (`mock:devices`)
- [x] Device registry (secret shown once, stored encrypted) and `POST /ingest/punches` with HMAC signatures, idempotency and a per-device rate limit
- [x] Pairing of clock-ins and clock-outs into work segments, re-paired from scratch over 62 days, so arrival order never matters
- [x] Exception queue API (missing clock-out or clock-in, unknown or inactive employee, overlaps) and resolving it: nobody resolves their own attendance, and HR reads but never creates hours
- [x] Night shifts from 22:00 to 06:00 proven with tests (480 minutes, counted on the start date)
- [x] Dashboard (Samuel): worked shifts by day range and site, a guard's "My attendance", the exception queue with its evidence and resolution screen (dismiss, add a shift by hand, keep one, void both), and the Devices pages (register with the one-time secret, health, rename, switch off/on, new secret, ZKTeco serial and kiosk fingerprint switch)
- **Exit demo:** replay 30 days of seeded punches and watch the attendance dashboard fill in ([The attendance demo](../guides/10-attendance-demo.md))

## Phase 3 · Real biometrics (weeks 6 and 7)

**Goal: workers clock in by face and fingerprint on a company device at the site; ZKTeco terminals are ready for production.** Every rule is in [Biometrics design](13-biometrics-design.md).

- [x] Contract, mock API and design for the kiosk, biometrics and the live clock-ins board
- [x] Migration: consents, credentials, exemptions, fingerprint keys and clock-in attempts, with the rules the database enforces itself; device kinds checked on every signed route; the basis rule for the kiosk methods; `PATCH /devices` sets a serial number and switches fingerprints
- [x] Face matching on the server with Human's formula, templates encrypted and bound to their row
- [x] The kiosk door: a sign-in on a kiosk (`KIOSK_ORIGINS`) gets no refresh cookie and a token that only works on the kiosk screens; the kiosk ADMIN routes need that token **and** the kiosk's signature; the consent text, and consent with the Ghana Card check
- [x] Enrollment on the kiosk by an ADMIN: 3 face frames, the duplicate check (COLLISION decided by a second ADMIN), revoke, withdraw, exemption, and the 90-day retention sweep on the heartbeat
- [x] Clock-in: identify then confirm, a supervisor's co-sign as the fallback, the live clock-ins board and the kiosk attempt log
- [ ] **Samuel:** the kiosk app (`apps/kiosk`), on its own Vercel project: device setup, head-turn liveness, clock-in and enrollment screens. Every route it needs is merged — see [14 · Who builds what next](14-work-split.md)
- [x] Fingerprint through the device's own sensor (passkeys): registration from a sealed ticket, face then finger (`FACE_PASSKEY`), the supervisor's own finger on a co-sign, and staff number then finger (`STAFF_PASSKEY`, flagged and counted by the ghost rules)
- [ ] **Samuel:** ZKTeco gateway (`apps/gateway`) with an outbox, and a fake terminal that drives it end to end
- [x] Roster sync and finger-enrollment windows: `POST /ingest/roster`, `POST /ingest/enrollments` and `POST /devices/{id}/finger-enrollment-windows`, with a terminal that can never enroll anybody by itself
- [ ] The pull fallback, the demo guide and the threshold report
- [x] **Samuel:** dashboard — live clock-ins board (`/attendance/live`), the employee Biometrics panel, the duplicate-enrollment queue (`/biometrics/duplicates`), and kiosk attempts per device (`/devices/attempts`). Built against the mock API. (The new device fields — serial number and the kiosk fingerprint switch — shipped with the Phase 2 Devices pages.)
- **Exit demo:** a real face-plus-fingerprint clock-in on a phone acting as the site kiosk appears on the dashboard within 5 seconds, and the ZKTeco path passes end to end against the simulator

## Phase 4 · Payroll engine (weeks 8 to 10): the crown jewel

**Samuel builds this, end to end** — database, API and screens. See
[Who builds what next](14-work-split.md).

**Goal: Ghana-correct, locked, auditable pay.** Every design question that was
open is now decided in [Payroll engine (Ghana)](09-payroll-engine-ghana.md);
the house style for a backend module is in
[16 · How a backend module is built here](16-building-a-backend-module.md).

- [x] Contract and dashboard mocks for periods, runs, lines, payslips, tax tables, pay terms and payment details, with seven of the eight hand-calculated payslips pinned as tests (the eighth, the night shift crossing the period boundary, is pinned against the API engine, which reads dated segments)
- [x] The eight tables, with the rules the database enforces itself: a whole calendar month, a status that only moves forward from a draft, the maker never the checker, a run's lines frozen from the moment it is submitted, pay terms append-only, nothing ever deleted, no row ever hanging off another company's record, and every line proved to add up by a `CHECK`
- [x] The calculation as pure functions with the eight hand-calculated payslips as tests, and a second implementation written differently that has to agree with it on every field of all eight and of 5,000 generated lines; PAYE bands and SSNIT rates read from the versioned tables, never from the code
- [x] The 2026 rates seeded with their source recorded, and pay terms for every seeded employee
- [x] The setup endpoints: payroll months, the statutory rate versions, each worker's pay history and where their salary is sent — with the refusals that matter tested, including a set of tax bands that would leave the highest earners untaxed and a bank name a spreadsheet would run as a formula
- Calculate a draft run, copying every input into its lines
- Maker–checker approval endpoints, payslip PDFs, bank CSV export
- **Exit demo:** close a month, approve it as a second user, and open a payslip whose numbers can be checked by hand

## Phase 5 · Ghost detection (weeks 11 and 12)

**Francis builds this, end to end.** It merges **after** payroll, because its
rules read payroll data.

**Goal: the feature that sets SAMTEC apart.**

- [x] The engine, the alert queue and the sweep, per [Ghost detection engine](08-ghost-detection-engine.md), with rules R4, R5 and R10 built and the other eight in the catalogue, switched off and reported as skipped
- [x] **All eleven rules are built.** R3 (paid without presence) and R6 (terminated but active) read payroll through its own service; R3's comparison is a shared function in `src/common/paid-beyond-presence.ts`, so payroll can refuse a run at submission without importing detection
- [x] The daily run: a Vercel Cron entry in `apps/api/vercel.json` calls `GET /detection/daily-sweep` at 02:00. No secret to set — the twenty-hour gap per company is the guard (docs/plan/08 §7)
- [x] Alert review queue showing evidence; every resolution audited. The queue, one alert and the rules pages, with the risk panel and the sweep button, on the dashboard
- **Exit demo:** the three planted ghosts in the seed data are all caught live; a written false-positive discussion for the report

## Phase 6 · Dashboard and reports polish (week 13)

Reports, the payslip downloads and the guard's own payslip: **Samuel**. The
final visual pass: **Francis**.

- Live attendance board and key figures: headcount present, absence rate, payroll cost trend
- CSV and PDF reports; guards can view their own payslips
- **Final visual pass (Francis) — the last build step of the whole project.** The design foundation (heading font, motion, boot screen, sign-in stage, shell) is in place since Phase 1; once every feature works end to end, biometrics included, one pass checks every screen built since against it. After it, only fixes.
- **Exit demo:** a full dry run of the 15-minute client walkthrough

## Phase 7 · Hardening (week 14)

- [x] **Whole-system review:** every module, the database, every screen and the repository itself, through all four lenses, with a sceptic sent to refute each serious finding. Twenty survived. Three were blockers: switching the other administrator off re-opened the sole-administrator shortcut; a device could claim its own clock ran hours fast and have future punches paid; and rule R7 died on every sweep the moment any terminal sent an ordinary PIN fallback punch. All twenty are fixed, each with a test that fails without the fix where one could be written
- [x] **Full security review of the repository**, in the same pass: it found that every Vercel preview build was applying migrations to the one shared TEST database, before review and before merge
- [x] Creating, resetting, promoting or switching on an ADMIN account needs a second ADMIN (closes the "one person, two accounts" gap in the Phase 3 two-person rules). Rules and what is still open: [Security and review gates](06-security-and-review-gates.md), "Two administrators"
- [x] Registering a device or rotating its secret needs a second ADMIN (a device key can post punches): the key is born switched off, and whoever issued it may not switch it on — service and database CHECK alike ([Security and review gates](06-security-and-review-gates.md), "Two administrators", rules 6 to 8)
- [x] **Load test of punch ingestion**: `pnpm --filter @samtec/api load:punches` sends a burst through the real signed endpoint and measures it. A thousand punches land in about a second, every one stored exactly once, and sending the whole burst again changes nothing. Pushed to five thousand at sixteen batches at a time it sheds load politely — `503` with `Retry-After` — and still loses nothing. The same promise is pinned by a test in CI
- [x] **Backup and restore drill**, written up with its numbers in [Backup and restore](../guides/11-backup-and-restore.md). It found that the hosted database has **no backups at all** (Supabase free plan), so the drill also built the backup: 17,535 rows out, database destroyed, rebuilt empty, put back, and the whole test suite run against the restored copy. **Still owed:** nobody takes one automatically, and the full drill has not been run against the hosted database
- [x] **Threat model refresh**: [Security and review gates](06-security-and-review-gates.md) now carries a row for what Phases 5 to 7 actually built — the eleven sweep rules that hunt a ghost, losing the database, a stolen backup file, the open daily-sweep route, and the hosting dashboards themselves. The stale promise to teach R11 the administrator columns is replaced by the reason that clause was rejected, and the row says plainly that R3's second control (payroll refusing a run) waits on the Phase 4 run endpoints
- [x] **Exit demo:** the security chapter of the report is drafted from the results — [The security chapter, drafted](../guides/12-security-chapter.md). Every number in it comes from a run that happened, and every gap is named

## Phase 8 · Deploy and present (week 15 onwards)

- Demo environment online and seeded (API on Railway or Render, dashboard on Vercel, database on Supabase)
- Production settings: `NODE_ENV=production` with `ALLOW_SIMULATOR_DEVICES` left unset (simulators are then refused), and its own `AUTH_SECRET`, never shared with TEST
- **Defense pack for Samuel:** a plain-language breakdown of the whole system, from the database tables to every module, endpoint and screen, so he can learn it and defend it without help
- Deliver the [Client presentation plan](11-client-presentation-plan.md); defense slides built from this plan
- **Exit demo:** presentation delivered and a pilot proposal in the client's hands
- **Then production for the paying client:** a production environment separate from TEST (real client data only there), set up to the security plan

## Weekly check-in (15 minutes, both developers)

1. Demo what moved this week.
2. Does the contract need to change?
3. What is blocking us?
4. Name next week's exit demo.
