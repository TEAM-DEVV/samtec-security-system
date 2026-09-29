# Contributing to SAMTEC

## The short version

1. Read [How the system works](docs/guides/01-how-the-system-works.md), then set up your computer with the [setup guide](docs/guides/02-setup-on-windows.md).
2. Create a branch from `main` named `feat/…`, `fix/…`, `contract/…`, `docs/…` or `chore/…`.
3. Any API change starts in `packages/contracts/openapi.yaml`. See [Changing the API contract](docs/guides/05-api-contract-workflow.md).
4. Write commit messages as Conventional Commits, for example `feat(web): add employee detail page`.
5. Run `pnpm check` before you push.
6. Open a pull request and complete the four-lens checklist in the template.
7. Wait for green CI and your teammate's approval, then use **Squash and merge**.

Full details: [Git and pull requests](docs/guides/06-git-and-pull-requests.md). Security rules: [SECURITY.md](SECURITY.md).

## Project rules

These apply to every change. The reviewer checklist in the pull request template
asks about most of them.

1. **Contract first.** Change `packages/contracts/openapi.yaml`, run `pnpm contracts:generate`, then write code. When a response shape changes, update the mock handlers in `apps/web/src/mocks/handlers/` in the same change.
2. Import contract types with `import type { ... } from '@samtec/contracts'`.
3. **Money is integer pesewas** (`amountPesewas`). Store timestamps in UTC; display them in Africa/Accra time with `apps/web/src/lib/format.ts`.
4. **Module boundaries.** A module writes only to its own tables. It calls other modules' services instead of touching their tables.
5. **API inputs.** Validate every body, query and route parameter with a Zod schema (`@Body({ schema })`). Throw Nest HTTP exceptions; `ProblemDetailsFilter` formats every error.
6. **API imports.** Relative imports end in `.js` (ES modules). Never use `import type` for a class that Nest injects, because that breaks dependency injection.
7. **Dashboard data.** Fetch only through `$api` or `fetchClient`. Every screen that loads data has loading, empty and error states.
8. **Data safety.** Never hard-delete people, punches or payroll records. Never store biometric images. Never log request bodies, query strings, secrets, tokens, Ghana Card numbers or biometric data; log IDs and the `traceId`. Seed and mock data must be fictional.
9. **Migrations.** Read every generated `migration.sql`. A migration that creates a table also enables row-level security on it (`docs/plan/04-data-model.md`). Calendar-date columns (`@db.Date`) reach the contract through `toIsoDate` in `apps/api/src/common/dates.ts`.
10. **Secrets.** Never commit or share `.env` files; `.env.example` is the reference.
11. **Dependencies.** No new dependency without a line in `docs/plan/02-stack-decisions.md`. Never loosen the security settings in `pnpm-workspace.yaml`.
12. **Tests.** Vitest with explicit imports (`import { describe, expect, it } from 'vitest'`). Payroll and money logic is tested to the pesewa. API end-to-end tests start the app with `createTestApp()` from `apps/api/test/create-test-app.ts`.
13. **Done means green.** Run `pnpm check` before calling any work finished.

## Definition of done

A change is done when all of these are true:

- [ ] It matches the API contract and belongs to the current roadmap phase.
- [ ] Tests cover it. Money logic is tested to the pesewa.
- [ ] New screens have loading, empty and error states.
- [ ] The documents in `docs/` still describe what the code does.
- [ ] `pnpm check` passes and CI is green.
- [ ] The four-lens checklist is complete, and every blocker is fixed.
