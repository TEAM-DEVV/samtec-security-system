# SAMTEC Security System

Biometric attendance and payroll that stops ghost workers in Ghanaian security companies. Final year project (Samuel) and a client product. Francis builds the API (`apps/api`); Samuel builds the dashboard (`apps/web`), the kiosk app (`apps/kiosk`) and the ZKTeco gateway (`apps/gateway`). Who picks up what next is in [docs/plan/14-work-split.md](docs/plan/14-work-split.md).

Both developers are learning. Explain changes in plain language, and prefer simple, conventional code over clever code.

## Repository map

- `apps/api`: NestJS 12 (ES modules) on Express 5, Prisma 7 with PostgreSQL 17. Feature code goes in `src/modules/<module>/` (read that folder's README first).
- `apps/web`: React 19, Vite 8, Tailwind CSS 4 with shadcn/ui, React Router 8, TanStack Query through `$api` in `src/lib/api.ts`, MSW mocks in `src/mocks/`.
- `packages/contracts`: `openapi.yaml`, the API contract, and the generated types package `@samtec/contracts`. Never edit `src/generated/`.
- `docs/plan`: architecture and decisions. `docs/guides`: beginner guides.

## Commands (run from the repository root)

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| API and dashboard against the real API | `pnpm dev` |
| Dashboard with mock data only | `pnpm dev:web` |
| API only | `pnpm dev:api` |
| Start the local database (keep the terminal open) | `pnpm db:start` |
| Create a migration after editing `schema.prisma` (local database only) | `pnpm db:migrate` |
| Apply migrations to a shared or hosted database | `pnpm db:deploy` |
| Load fictional demo data (local database only) | `pnpm db:seed` |
| Rebuild the local database (asks to confirm) | `pnpm db:reset` |
| Everything CI runs | `pnpm check` |
| Fix formatting and import order | `pnpm lint:fix` |
| Regenerate contract types | `pnpm contracts:generate` |
| Tests for one app | `pnpm --filter @samtec/api test` or `pnpm --filter @samtec/web test` |

## Rules

1. **Contract first.** Change `packages/contracts/openapi.yaml`, run `pnpm contracts:generate`, then write code. When a response shape changes, update the MSW handlers in `apps/web/src/mocks/handlers/` in the same change.
2. Import contract types with `import type { ... } from '@samtec/contracts'`.
3. **Money is integer pesewas** (`amountPesewas`). Store timestamps in UTC; display them in Africa/Accra time with `apps/web/src/lib/format.ts`.
4. **Module boundaries.** A module writes only to its own tables. It calls other modules' services instead of touching their tables.
5. **API inputs.** Validate every body, query and route parameter with a Zod schema (`@Body({ schema })`). Throw Nest HTTP exceptions; `ProblemDetailsFilter` formats every error.
6. **API imports.** Relative imports end in `.js` (ES modules). Never use `import type` for a class that Nest injects, because that breaks dependency injection.
7. **Dashboard data.** Fetch only through `$api` or `fetchClient`. Every screen that loads data has loading, empty and error states.
8. **Data safety.** Never hard-delete people, punches or payroll records. Never store biometric images. Never log request bodies, query strings, secrets, tokens, Ghana Card numbers or biometric data; log IDs and the `traceId`. Seed and mock data must be fictional.
9. **Migrations.** Read every generated `migration.sql`. A migration that creates a table also enables row-level security on it (`docs/plan/04-data-model.md`). Calendar-date columns (`@db.Date`) reach the contract through `toIsoDate` in `apps/api/src/common/dates.ts`.
10. **Secrets.** Never read `.env` files; use `.env.example` for reference.
11. **Dependencies.** No new dependency without a line in `docs/plan/02-stack-decisions.md`. Never loosen the security settings in `pnpm-workspace.yaml`.
12. **Tests.** Vitest with explicit imports (`import { describe, expect, it } from 'vitest'`). Payroll and money logic is tested to the pesewa. API end-to-end tests start the app with `createTestApp()` from `apps/api/test/create-test-app.ts`.
13. **Done means green.** Run `pnpm check` before calling any work finished.

## Reviews

Four review lenses live in `.claude/agents/`: architect, senior developer, full-stack and security analyst. `/lens-review` runs all four in parallel; `/lens-review phase` adds the phase exit gate. Use them before every pull request.

## Git

Branch from `main` with a prefix (`feat/`, `fix/`, `contract/`, `docs/`, `chore/`). Use Conventional Commits. Changes reach `main` only through pull requests. See `docs/guides/06-git-and-pull-requests.md`.

**Every merge to `main` deploys automatically to the shared TEST environment** (https://samtec-test.vercel.app, fictional data only) — see `docs/guides/09-test-environment.md`. Migrations apply themselves during the deploy.

## Working in parallel (two developers, two Claude sessions)

**Read [docs/plan/14-work-split.md](docs/plan/14-work-split.md) at the start of every session.** It says who owns what right now, and its "Staying in sync" half lists every shared file and how to resolve it. It wins over anything said in a pull request or a chat.

**If you have nothing in flight, this is what to pick up.** Samuel: Job A in [docs/plan/14-work-split.md](docs/plan/14-work-split.md) — Phase 4, the payroll engine, tracked in the open issue of the same name. Francis: the three Phase 3 gateway endpoints, then Phase 5. Neither of you waits for the other.

**Francis and Samuel now own whole phases each, backend included.** Samuel: Phase 4 payroll end to end, Phase 6 reports, the kiosk app and the gateway. Francis: the last three Phase 3 gateway endpoints, Phase 5 ghost detection end to end, Phase 7 hardening. Payroll must reach `main` before detection does, because detection reads payroll data.

Francis's and Samuel's sessions never message each other; they stay in sync through GitHub. Every session follows these steps without being asked:

1. **At the start of every session:** `git fetch --all --prune`, then `gh pr list` **and `gh issue list`**. An open issue titled with a phase is that phase handed over: read it, and if you have nothing else in flight, start it without waiting to be asked. If the other developer opened a pull request **into one of your branches** (usually a `fix/…` branch that resolves a conflict for you), review it and merge it first, with a normal merge (not squash).
2. **Before merging any pull request:** update the branch from `main` (`git merge origin/main`). If files conflict, **keep both sides**: never delete the other developer's code to make a conflict go away. Then run `pnpm check` and wait for CI to be green.
3. **Expect overlaps in the shared files**, and check each one by eye after every merge — a clean `git merge` is not proof they survived: `packages/contracts/openapi.yaml` (append only inside your own `# --- … ---` banner), `apps/api/prisma/schema.prisma` (the conflict lands inside `model Company` and `model Employee` — keep **both** back-relation lists), `apps/api/src/app.module.ts` (one lost line breaks every end-to-end test at once), `apps/api/src/modules/payroll/payroll.module.ts` (Phase 5 created it for the read seam; Samuel's controller and service join it — keep both), `apps/api/prisma/seed.ts`, `apps/api/test/db-fixture.ts` (keep both deletes, above the employee and site deletes), `apps/web/src/app/routes.ts`, `apps/web/src/app/router.tsx` (keep `path: '*'` last), `apps/web/src/components/layout/nav-items.ts` (the Payroll and Ghost detection entries already exist — **edit yours in place**, never add a second), `apps/web/src/lib/roles.ts`, `apps/web/src/mocks/**`, `apps/web/src/test/setup.ts`, `docs/plan/07-roadmap.md`, `docs/plan/04-data-model.md` and this file. The fix is always to keep every change.
   - **Never hand-merge two generated files.** For `packages/contracts/src/generated/api.d.ts`: resolve `openapi.yaml` first, take either side, then `pnpm contracts:generate`. For `pnpm-lock.yaml`: take `main`'s copy, then `pnpm install`.
   - **Migrations never conflict in git, and that means nothing.** Whoever merges second regenerates their migration on top of `main` — delete the unmerged local folder, `pnpm db:reset`, `pnpm db:migrate` again — so its timestamp is later. Never edit, rename or renumber a migration already on `main`. Every new table, enum, index and trigger function carries its module's prefix, so two migrations can never name the same object.
4. **Merge as soon as a pull request is green,** and keep stacks short (two branches at most), so conflicts stay small.
5. **Say what the other side must do in the pull request description,** not in chat. For example, a backend pull request that changes the contract lists the new endpoints and mock handlers for the dashboard.
6. **A dashboard feature that needs data the API does not have yet** (including features beyond the plan): add it to `openapi.yaml` and the mock handlers first (rule 1 above), and list it under a heading **"For the API (Francis)"** in the pull request description, so the backend gets built to match. Francis's session looks for that heading in open pull requests at the start of every session.

## Current phase

Each line below is owned by one area. **Edit only the line for the work you just did**, so two sessions never rewrite the same block.

- **Phase 0–1 (identity and workforce) — done.** Sign-in, two-factor, the audit log, employees, employment periods, sites, posts, shift patterns, user management. Screens: the Users pages, the change-password form and the public `/set-password` page. One-time links are `<dashboard>/set-password#token=<token>`; the token sits after `#` so it never reaches a server log. Still open on the dashboard: the employee create/edit/terminate forms.
- **Phase 2 (attendance) — done.** Devices, signed ingest, pairing into work segments, the exception queue and resolving it, and a device simulator ([docs/guides/10-attendance-demo.md](docs/guides/10-attendance-demo.md)). Screens: `attendance-page.tsx`, `my-attendance-page.tsx`, `exceptions-page.tsx`, `exception-detail-page.tsx`, `devices-page.tsx`, `new-device-page.tsx`, `device-detail-page.tsx`. Every rule: [docs/plan/12-attendance-design.md](docs/plan/12-attendance-design.md).
- **Phase 3 (biometrics) — the kiosk API is complete**, from [docs/plan/13-biometrics-design.md](docs/plan/13-biometrics-design.md): consent, enrollment, the duplicate-enrollment queue, identify/confirm/"Not me", a supervisor's co-sign, and fingerprints on the kiosk's own sensor (`FACE_PASSKEY`, plus the staff-number fallback `STAFF_PASSKEY`). Screens are built: the live clock-ins board (`live-board-page.tsx`), the employee Biometrics panel (`components/biometrics-panel.tsx`), the duplicate queue (`duplicate-faces-page.tsx`) and kiosk attempts (`kiosk-attempts-page.tsx`). **Left:** the kiosk app (`apps/kiosk`) and the gateway (`apps/gateway`), both Samuel's; and three gateway endpoints (`POST /ingest/roster`, `POST /ingest/enrollments`, `POST /devices/{id}/finger-enrollment-windows`), Francis's.
- **Phase 4 (payroll) — Samuel owns it, end to end. The contract and the mock API are in**, with the hand-calculated payslips pinned as tests (`apps/web/src/mocks/handlers/payroll.ts`, `data/payroll.ts`). **The eight tables, the migration and the calculation are in too**, with the hand-calculated payslips as tests on both sides and the rules the database enforces proved against a real PostgreSQL (`apps/api/test/payroll-rules.e2e-spec.ts`). **The setup endpoints are in** (payroll months, tax table versions, pay terms and payment details). **Left:** the run endpoints, the payslip PDF and the screens. Every design question is decided in [docs/plan/09-payroll-engine-ghana.md](docs/plan/09-payroll-engine-ghana.md) — decisions 22 to 26 were added during the build after the four-lens reviews, and 25 corrects 22; the house style is in [docs/plan/16-building-a-backend-module.md](docs/plan/16-building-a-backend-module.md).
- **Phase 5 (ghost detection) — Francis owns it, end to end. All eleven rules are built**, with the sweep, the alert queue, resolving an alert and risk scores ([docs/plan/08-ghost-detection-engine.md](docs/plan/08-ghost-detection-engine.md)). R3 and R6 read payroll through `apps/api/src/modules/payroll/payroll-facts.service.ts`. **Screens are built:** the queue with the highest-risk panel and the "Run the rules now" button (`detection-page.tsx`), one alert with its evidence and decision form (`detection-alert-page.tsx`), and the rules with their numbers (`detection-rules-page.tsx`); every label is in `apps/web/src/lib/detection.ts`. The daily run is a Vercel Cron entry in `apps/api/vercel.json` (`GET /detection/daily-sweep`, public by design). **Phase 5 is complete.**
- **Phase 7 (hardening) — Francis owns it. Started.** The daily detection run is a Vercel Cron entry (no secret to set). **Two administrators:** creating, promoting, resetting or switching on an ADMIN account holds it as `AWAITING_CONFIRMATION` until a different ADMIN calls `POST /users/{id}/confirm-admin` — rules in [docs/plan/06-security-and-review-gates.md](docs/plan/06-security-and-review-gates.md), "Two administrators". A device key is born switched off too, and whoever issued it may not switch it on. **Left:** the load test and backup drill, and the whole-system review.
- **Phases 6–8.** Reports and the guard's own payslip: Samuel. The final visual pass, hardening and the defence pack: Francis. Both present.
- **Outside the repository:** the owner still has to set the repository protection settings and create the `apps/kiosk` Vercel project; the ZKTeco device waits for a paying client. See `docs/plan/07-roadmap.md`.

Phase 1 API rules: every route requires sign-in unless marked `@Public()`; restrict roles with `@Roles(...)` and read the caller with `@Caller()` (`src/common/auth.decorators.ts`). Record every important change through `AuditService`. The database-backed tests in `apps/api/test/db.e2e-spec.ts` run when `TEST_DATABASE_URL` points at a migrated database (CI's database job does this; locally point it at the running local database).
