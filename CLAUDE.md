# SAMTEC Security System

Biometric attendance and payroll that stops ghost workers in Ghanaian security companies. Final year project (Samuel) and a client product. Francis builds the API (`apps/api`); Samuel builds the dashboard (`apps/web`).

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

Francis's and Samuel's sessions never message each other; they stay in sync through GitHub. Every session follows these steps without being asked:

1. **At the start of every session:** `git fetch --all --prune`, then `gh pr list`. If the other developer opened a pull request **into one of your branches** (usually a `fix/…` branch that resolves a conflict for you), review it and merge it first, with a normal merge (not squash).
2. **Before merging any pull request:** update the branch from `main` (`git merge origin/main`). If files conflict, **keep both sides**: never delete the other developer's code to make a conflict go away. Then run `pnpm check` and wait for CI to be green.
3. **Expect overlaps in the shared files:** `apps/web/src/mocks/**`, `apps/web/src/test/setup.ts`, `packages/contracts/openapi.yaml` and `docs/plan/07-roadmap.md`. Both sides edit them; the fix is always to keep every change.
4. **Merge as soon as a pull request is green,** and keep stacks short (two branches at most), so conflicts stay small.
5. **Say what the other side must do in the pull request description,** not in chat. For example, a backend pull request that changes the contract lists the new endpoints and mock handlers for the dashboard.
6. **A dashboard feature that needs data the API does not have yet** (including features beyond the plan): add it to `openapi.yaml` and the mock handlers first (rule 1 above), and list it under a heading **"For the API (Francis)"** in the pull request description, so the backend gets built to match. Francis's session looks for that heading in open pull requests at the start of every session.

## Current phase

Phase 0 is merged. **The Phase 1 backend is complete**: sign-in, two-factor, the audit log, employees (read, create, update, terminate), employment periods, sites, posts, shift patterns and user management are built. Samuel's screens complete the frontend side. His next dashboard tasks are the Users pages (ADMIN only) and a change-password form (`POST /auth/change-password`; on success clear the session and go to `/login`). The public `/set-password` page is built (`apps/web/src/pages/set-password-page.tsx`): it reads the one-time token from the link's `#token=` part, removes it from the address bar and calls `POST /auth/set-password`. The Users pages should build their one-time links as `<dashboard>/set-password#token=<token>`. The contract's `Users` operations describe them, and the mock API already supports them. **The Phase 2 (attendance) backend is complete:** devices, signed ingest, pairing into work segments, the exception queue and resolving it, and a device simulator for the exit demo ([docs/guides/10-attendance-demo.md](docs/guides/10-attendance-demo.md)). The dashboard's Attendance day view, a guard's "My attendance", the exception queue with its resolution screen and the Devices page (ADMIN) can be built against the mock API or the real one; [docs/plan/12-attendance-design.md](docs/plan/12-attendance-design.md) explains every rule. Two owner tasks outside the repository remain (repository protection settings and ordering a ZKTeco device). See `docs/plan/07-roadmap.md`.

Phase 1 API rules: every route requires sign-in unless marked `@Public()`; restrict roles with `@Roles(...)` and read the caller with `@Caller()` (`src/common/auth.decorators.ts`). Record every important change through `AuditService`. The database-backed tests in `apps/api/test/db.e2e-spec.ts` run when `TEST_DATABASE_URL` points at a migrated database (CI's database job does this; locally point it at the running local database).
