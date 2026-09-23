# 16 · How a backend module is built here

Written for whoever picks up a backend phase next. It assumes you have written
frontend code and not much API code. Read
[the backend guide](../guides/04-backend-guide.md) first if NestJS is new.

Nothing here is invention: every rule below is already followed by
`apps/api/src/modules/workforce/` and `apps/api/src/modules/attendance/`.
**Copy those two modules.** When this page and the code disagree, the code
wins — and tell the other developer.

## The seven files a module has

Put them all in `apps/api/src/modules/<module>/`.

| File | What it is for |
|---|---|
| `README.md` | Written **before** the code: what this module is, which tables it owns, and the rules that must hold. Model: `attendance/README.md` |
| `<module>.module.ts` | The wiring — which controllers, which services, what it imports and exports |
| `<thing>.controller.ts` | HTTP only, and thin. One method per endpoint in the contract. No business logic |
| `<thing>.service.ts` | Where nearly all the code lives |
| `<module>.schemas.ts` | Every Zod input rule for the module, in one file |
| `<rule-name>.ts` | Pure functions: no database, no `this`, no decorators. The part you can prove on its own |
| `<rule-name>.spec.ts` | The unit test, sitting **next to** the file it tests |

End-to-end tests go somewhere else: `apps/api/test/<feature>.e2e-spec.ts`.

**The single best file to read first** is
`apps/api/src/modules/workforce/employees.controller.ts` — 81 lines, five
routes, every convention in one place.

## The five traps that cost a day each

1. **Relative imports end in `.js`**, even though the file is `.ts`:
   `import { PayrollService } from './payroll.service.js'`. The API is native
   ES modules. Get this wrong and nothing runs.
2. **Never write `import type` for a class NestJS injects.** `import type
   { PrismaService } …` compiles fine and then breaks dependency injection at
   runtime, with a confusing error. Plain `import` for anything in a
   constructor.
3. **Contract first.** The endpoint goes in `packages/contracts/openapi.yaml`
   **before** the code, then `pnpm contracts:generate`, then the controller's
   return type is imported from `@samtec/contracts` so TypeScript refuses a
   response that does not match.
4. **Calendar dates are not timestamps.** A `@db.Date` column must go through
   `toIsoDate()` in `apps/api/src/common/dates.ts`. Calling `.toISOString()`
   on one gives the wrong day for anybody in Accra.
5. **Money is an integer number of pesewas**, in an `INTEGER` column, in a
   field whose name ends in `Pesewas`. Never a decimal, never a float, not
   even for an intermediate value.

## The rules that keep the codebase one codebase

- **Validate everything at the edge.** Every body, query and route parameter
  gets a Zod schema: `@Body({ schema: createRunSchema }) body: CreateRunBody`.
  Use `z.strictObject(...)`, never `z.object(...)`, so an unexpected field is
  a clear 400 instead of being quietly ignored.
- **Sign-in is on by default.** Mark a route `@Public()` only on purpose.
  Restrict with `@Roles('ADMIN')`, and read the caller with
  `@Caller() caller: SignedInUser`.
- **`@Roles` is never the whole story.** The service still decides which
  *records* this caller may see. Pass `caller` in as the first argument and
  scope the query.
- **A record the caller may not see answers 404, never 403.** A 403 tells an
  attacker the ID exists. 403 means "your role may never do this at all".
- **Throw NestJS exceptions** — `NotFoundException`, `ConflictException`,
  `ForbiddenException`, `BadRequestException` — and let unexpected errors
  escape. `ProblemDetailsFilter` formats every one of them.
- **Record every important change** through `AuditService`, inside the same
  transaction as the change itself.
- **A module writes only to its own tables.** For anything else, call the
  other module's service. Payroll never writes `employees`; it asks the
  workforce service. A method that must run inside someone else's transaction
  takes `tx: Prisma.TransactionClient` as a parameter.
- **Multi-step writes go in one `this.prisma.$transaction(...)`** — the rows
  and the audit entry are saved together or not at all.
- **Turn database rows into contract shapes in a pure function**, in its own
  file, so a unit test can prove field by field what each role sees. Model:
  `workforce/employee-mapping.ts`.
- **Lists are cursor-paginated** with the helpers in
  `apps/api/src/common/pagination.ts`.
- **Never log** request bodies, query strings, secrets, tokens, Ghana Card
  numbers, bank details or anything biometric. Log IDs and the `traceId`.
- **Write plain-language comments.** Every file opens with a short block
  saying what it is for and pointing at its design page.
- **Formatting is not your job.** `pnpm lint:fix` does it.

## Changing the database

1. Edit `apps/api/prisma/schema.prisma`. Copy the shape of `model Employee`:
   `uuid(7)` primary key, a `companyId` with a foreign key, `@map` names in
   snake_case, `@db.Timestamptz(3)` for moments, `@db.Date` for calendar days.
2. Run `pnpm db:migrate` from the repository **root**. Never hand-create a
   migration folder.
3. **Read the generated `migration.sql`, every time.** Check it does not drop
   anything you need.
4. **Add the row-level security line by hand for every new table** — Prisma
   never writes it:
   `ALTER TABLE "payroll_runs" ENABLE ROW LEVEL SECURITY;`
5. Add, by hand and with a comment on each, the rules the database itself can
   enforce: `CHECK` constraints for values that must make sense, triggers for
   "this can never change once locked", and triggers refusing `DELETE` and
   `TRUNCATE` on anything that must never be erased. The clearest complete
   example is `apps/api/prisma/migrations/20260921112815_rosters/migration.sql`
   (67 lines).
6. After editing the SQL by hand, apply it with `pnpm db:reset` — `db:migrate`
   already applied the unedited version to your database.
7. Commit `schema.prisma` and the migration folder together.
8. **Never edit a migration that is already on `main`.** Add a new one.
9. `db:migrate`, `db:reset` and `db:seed` are for your own machine only. A
   hosted database only ever gets `pnpm db:deploy`.

Enums in `schema.prisma` mirror the enums in `openapi.yaml` word for word, so
the same value travels from the database to the dashboard unchanged.

## Testing

- Vitest, with explicit imports in every file:
  `import { describe, expect, it } from 'vitest'`. There are no globals.
- **Unit specs sit beside the code**, `<file>.spec.ts`. No database, no
  NestJS: import the pure function and assert the whole result with
  `toEqual({...})`.
- **End-to-end specs live in `apps/api/test/`**, named `<feature>.e2e-spec.ts`,
  and drive the real app over real HTTP with supertest.
  - `createTestApp()` — the default. Real app, stubbed database.
  - `createDbTestApp(databaseUrl)` — real PostgreSQL, nothing faked. Guard it
    with `describe.skipIf(!process.env.TEST_DATABASE_URL)`, the way the
    existing database specs do, so it skips when no database is configured.
- **Test the rules, not just the happy path.** Prove the things that would be
  a scandal if they broke: that the same person cannot approve their own run,
  that a locked run cannot be edited, that a guard reading somebody else's
  payslip gets 404.
- Money is tested with hand-calculated examples, **to the pesewa**.

Run everything CI runs, and do it before calling any work finished:

```bash
pnpm check
```

Run the database tests locally (keep `pnpm db:start` open in another terminal):

```bash
cd apps/api && TEST_DATABASE_URL='postgresql://samtec:samtec-local-only@localhost:54329/samtec_verify' pnpm vitest run
```

## Before you open the pull request

Run the four review lenses — `/lens-review` — and fix what they find. They are
the same four reviewers used on every backend pull request so far, and they
catch the things tests do not: a missing row-level security line, a refusal
that leaks which reason it was, a transaction that is not really atomic.

Then re-read [Who builds what next](14-work-split.md) — "Staying in sync" —
and check every shared file you touched.
