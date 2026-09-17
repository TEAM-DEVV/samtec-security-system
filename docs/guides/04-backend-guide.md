# Backend guide

For Francis, who builds the API. Samuel should read "How the API is organised" and "The life of a request" too, because examiners will ask about the whole system.

## How the API is organised

```
apps/api/
├── prisma/
│   ├── schema.prisma          every database table
│   ├── migrations/            SQL files that build the database, in order
│   └── seed.ts                fictional demo data (pnpm db:seed)
├── scripts/
│   └── dev-database.ts        the local PostgreSQL server (pnpm db:start)
├── src/
│   ├── main.ts                starts the API
│   ├── app.module.ts          wires all modules together
│   ├── app.setup.ts           security settings shared by main.ts and tests
│   ├── config/                environment variables, checked at startup
│   ├── database/              PrismaService, the database client
│   ├── common/                request IDs, the error format (Problem Details) and date helpers
│   ├── health/                GET /api/v1/health, the reference example
│   ├── modules/               business features, one folder per module
│   └── generated/prisma/      the generated Prisma client (never edit, never committed)
├── test/                      end-to-end tests, and create-test-app.ts that starts the app for them
└── .env.example               copy to .env
```

## NestJS in five ideas

1. **Module:** a box that groups related code. `HealthModule` holds the health controller and service.
2. **Controller:** handles HTTP. It defines routes (`@Get()`), reads inputs, sets status codes, and calls a service. Keep controllers thin.
3. **Service:** holds the business rules and the database access. Most of your code lives here, and most of your tests test it.
4. **Dependency injection:** a class lists what it needs in its constructor, and Nest supplies it. `HealthService` asks for `PrismaService`. Tests can supply fakes instead.
5. **Pipes, filters and middleware:** code that runs around every request. Our validation pipe checks input, our filter formats errors, our middleware adds request IDs and security headers.

## The life of a request

What happens when someone calls `GET /api/v1/health`:

1. `requestIdMiddleware` gives the request an ID and adds the `X-Request-ID` header.
2. Helmet adds secure headers; CORS checks the calling website; a JSON body of up to 100 kB is read (a bigger one gets `413`).
3. Nest finds the route `HealthController.getHealth()`.
4. The validation pipe checks any Zod schemas on the route (none here).
5. The controller calls `HealthService.check()`.
6. The service asks `PrismaService.isReachable()`, which runs `SELECT 1` and gives up after 3 seconds. The answer is reused for 5 seconds, because anyone can call this endpoint.
7. The controller returns the report with status 200, or 503 if the database is down.
8. If anything throws, `ProblemDetailsFilter` sends a Problem Details error with the request ID as `traceId`.

Read those files in that order: `common/request-id.middleware.ts`, `app.setup.ts`, `health/health.controller.ts`, `health/health.service.ts`, `database/prisma.service.ts`, `common/problem-details.filter.ts`.

## How sign-in works (Phase 1)

The identity module (`src/modules/identity/`) implements the contract's
`/auth/*` endpoints. The short version:

1. **Passwords** are never stored — only scrypt hashes (`password.ts`). Five
   wrong passwords for one email lock it for 15 minutes.
2. **Signing in** returns a 15-minute **access token** (a signed JWT), and
   sets a 7-day **refresh token cookie** that JavaScript cannot read. The
   dashboard sends the access token as `Authorization: Bearer <token>`.
3. **Refresh tokens rotate**: every `POST /auth/refresh` replaces the cookie.
   If an old one ever comes back, someone copied it, and every session of
   that user is revoked.
4. **ADMIN and HR_PAYROLL accounts need a 6-digit code** from an
   authenticator app. The codes are standard TOTP (`totp.ts`, tested against
   the official RFC vectors), and the secrets are stored encrypted.
5. **Every route requires sign-in by default.** Two global guards run before
   every request. You never add sign-in to an endpoint — you would have to
   *remove* it, by marking a route `@Public()`, and that stands out in review.

The pieces you use when adding endpoints (`src/common/auth.decorators.ts`):

| Decorator | What it does |
|---|---|
| `@Public()` | Opens a route to everyone. Only `/health` and the sign-in endpoints themselves. |
| `@Roles('ADMIN', 'HR_PAYROLL')` | Only these roles may call the route (others get 403). |
| `@Caller() caller: SignedInUser` | Hands your method who is calling: `userId`, `role`, `companyId`, `employeeId`. |

`@Roles` is never the whole story: the service must still check *which
records* this caller may see. Look at `modules/workforce/employees.service.ts`
for the pattern — supervisors are scoped to their sites, guards to
themselves, and hidden records answer 404, never 403.

Every important change is recorded through `AuditService`
(`modules/identity/audit.service.ts`). The audit table is append-only: a
database trigger rejects updates and deletes, so history cannot be rewritten.

## Running the API on your computer

You need two terminals. Full setup steps are in [Set up your computer](02-setup-on-windows.md).

**Terminal 1**, the database. Leave it open:

```bash
pnpm db:start
```

**Terminal 2**, the first time only:

```bash
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm db:seed
```

Then start the API. It restarts automatically when you save a file:

```bash
pnpm dev:api
```

Check it in a browser: http://localhost:3000/api/v1/health should show `"database": "up"`.

## Two rules about imports

1. **Relative imports end in `.js`**, even though the file is `.ts`:

   ```ts
   import { HealthService } from './health.service.js';
   ```

   The API uses modern ES modules, where an import names the file that will exist after compiling.

2. **Never use `import type` for a class that Nest injects.**

   ```ts
   import { PrismaService } from '../database/prisma.service.js';      // correct
   import type { PrismaService } from '../database/prisma.service.js'; // breaks dependency injection
   ```

   Nest reads constructor types while the program runs, and `import type` deletes them. Contract types are different: always import those with `import type`.

## Adding an endpoint, step by step

Example: `GET /api/v1/sites/{siteId}` in the `workforce` module (Phase 1). The contract already describes it (`getSite` in `openapi.yaml`). If an endpoint is not in the contract yet, add it first: [Changing the API contract](05-api-contract-workflow.md).

### 1. A Zod schema for the input

```ts
// apps/api/src/modules/workforce/sites.schemas.ts
import { z } from 'zod';

/** The {siteId} part of the address must be a UUID. */
export const siteIdSchema = z.uuid();
```

### 2. The service: business rules and database access

```ts
// apps/api/src/modules/workforce/sites.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Site } from '@samtec/contracts';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async getSite(siteId: string): Promise<Site> {
    // Phase 1: also filter by the signed-in user's company and, for supervisors, their sites.
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('No site exists with this ID.');
    }

    const activeGuardCount = await this.prisma.siteAssignment.count({
      where: { siteId, endsOn: null, employee: { status: 'ACTIVE' } },
    });

    // Turn the database row into exactly the shape the contract promises.
    return {
      id: site.id,
      code: site.code,
      name: site.name,
      clientName: site.clientName,
      region: site.region,
      city: site.city,
      status: site.status,
      activeGuardCount,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    };
  }
}
```

The return type `Site` comes from the contract. If you forget a field or use the wrong type, TypeScript stops you.

**Calendar dates.** Timestamps become text with `toISOString()`, as above. A calendar-date column (`@db.Date`, such as an employee's `hireDate`) must use `toIsoDate(employee.hireDate)` from `src/common/dates.ts`, which gives `2026-09-15` as the contract expects.

### 3. The controller: HTTP only

```ts
// apps/api/src/modules/workforce/sites.controller.ts
import { Controller, Get, Param } from '@nestjs/common';
import type { Site } from '@samtec/contracts';
import { siteIdSchema } from './sites.schemas.js';
import { SitesService } from './sites.service.js';

@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get(':siteId')
  getSite(@Param('siteId', { schema: siteIdSchema }) siteId: string): Promise<Site> {
    return this.sites.getSite(siteId);
  }
}
```

If `siteId` is not a UUID, the validation pipe answers `400` with a Problem Details body before your code runs.

### 4. The module, registered in AppModule

```ts
// apps/api/src/modules/workforce/workforce.module.ts
import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller.js';
import { SitesService } from './sites.service.js';

@Module({
  controllers: [SitesController],
  providers: [SitesService],
})
export class WorkforceModule {}
```

Then add `WorkforceModule` to the `imports` list in `src/app.module.ts`.

### 5. Tests

A unit test for the service, with a fake database:

```ts
// apps/api/src/modules/workforce/sites.service.spec.ts
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { SitesService } from './sites.service.js';

describe('SitesService', () => {
  it('reports an unknown site as not found', async () => {
    const prisma = { site: { findUnique: async () => null } } as unknown as PrismaService;

    await expect(
      new SitesService(prisma).getSite('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c99'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Add an end-to-end test in `test/` for the route itself. `createTestApp()` from `test/create-test-app.ts` starts the real app with a fake database. `test/health.e2e-spec.ts` is the simplest example, and `test/http-safety.e2e-spec.ts` shows how to check validation errors.

### 6. Check and open a pull request

```bash
pnpm check
```

Then follow [Git and pull requests](06-git-and-pull-requests.md).

## Changing the database

1. Edit `apps/api/prisma/schema.prisma`.
2. Create and apply a migration, giving it a short name when asked. The same command also regenerates the Prisma client:

   ```bash
   pnpm db:migrate
   ```

3. **Read the generated `migration.sql`.** Make sure it does not delete data you need.
4. **If the migration creates a table,** add row-level security for it at the end of `migration.sql`, then run `pnpm db:reset` to apply the edited file (see [Data model](../plan/04-data-model.md#row-level-security-on-every-table)):

   ```sql
   ALTER TABLE "new_table" ENABLE ROW LEVEL SECURITY;
   ```

5. Commit `schema.prisma` and the new migration folder together.

Rules:

- Never edit a migration that is already on `main`. Create a new one instead.
- `pnpm db:migrate` and `pnpm db:reset` are for your **own computer** only. For a shared or hosted database, use `pnpm db:deploy`, which only applies migrations and never deletes anything.
- `pnpm db:reset` deletes everything in your local database, reapplies all migrations and reseeds. It asks you to confirm first. It is handy when your local data is a mess, or when a migration changed before merging.
- `pnpm db:seed` refuses a database that is not on your computer, unless you run it with `ALLOW_REMOTE_SEED=yes` on purpose.
- Money columns are integers (pesewas). Timestamps use `@db.Timestamptz(3)`. People and money records are never deleted; add a status instead.

## Adding a configuration setting

1. Add the variable and its rule to `envSchema` in `src/config/env.ts`.
2. Expose it on `AppConfig` in `src/config/app-config.ts`.
3. Add it with a safe example value and a comment to `apps/api/.env.example`.
4. Add it to the `env:` section of the `database` job in `.github/workflows/ci.yml` if CI needs it.

## Errors

- Throw Nest's HTTP exceptions for expected problems: `NotFoundException`, `ConflictException`, `ForbiddenException`, `BadRequestException`.
- Never catch an error just to hide it. Let unexpected errors reach the filter, which logs them and sends a safe, generic 500 response.
- Records a user may not see return **404**, not 403, so nobody can discover which IDs exist.
- A `ConflictException` (409) gets the type `urn:samtec:problem:conflict`, as the contract promises.

**What the logs contain.** The filter writes one warning line for a client error (4xx): method, path, status and `traceId`. For a server error (5xx) it adds the error's type, code and stack. It never logs request bodies, query strings or error messages, because they can contain names or Ghana Card numbers. Follow the same rule in your own log lines: log IDs and the `traceId`, never personal data. A test in `problem-details.filter.spec.ts` checks this.

## Security checklist for every endpoint

- [ ] It is in the contract.
- [ ] Every input has a strict Zod schema; unknown fields are rejected.
- [ ] The route is not `@Public()` unless it truly is, and `@Roles` matches the contract.
- [ ] The service checks that this user may access this specific record.
- [ ] Lists are paginated with a maximum page size.
- [ ] Responses include only the fields the role needs.
- [ ] Nothing sensitive is logged: passwords, tokens, Ghana Card numbers, biometric data.

## Testing

| Command | What runs |
|---|---|
| `pnpm --filter @samtec/api test` | All API unit and end-to-end tests |
| `pnpm --filter @samtec/api test:watch` | Re-runs tests as you save |
| `pnpm test` | Tests for every package |

- **Unit tests** (`src/**/*.spec.ts`) test one class with fake dependencies. They are fast and need no database.
- **End-to-end tests** (`test/*.e2e-spec.ts`) start the real app with the real security settings and send HTTP requests to it.
- **Real-database tests** (`test/db.e2e-spec.ts`) run the sign-in flows and the access rules against actual PostgreSQL. They only run when `TEST_DATABASE_URL` points at a migrated database — CI's database job sets it, and locally (with `pnpm db:start` running):

  ```bash
  TEST_DATABASE_URL=postgresql://samtec:samtec-local-only@localhost:54329/samtec_dev pnpm --filter @samtec/api test
  ```

- Payroll logic, when it arrives, is tested with hand-calculated examples, correct to the pesewa.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `Invalid environment configuration` | `apps/api/.env` is missing or has a wrong value. Compare it with `.env.example`. |
| `Can't reach database server` or `Database is not reachable` | The database is not running. Start it with `pnpm db:start` in another terminal. |
| `Nest can't resolve dependencies of ...` | A provider is missing from a module's `providers`, the module is not imported, or a class was imported with `import type`. |
| `Module '"../generated/prisma/client.js"' has no exported member` | The Prisma client is out of date. Run `pnpm --filter @samtec/api db:generate`. |
| `EADDRINUSE: address already in use :::3000` | Another API is already running. Close that terminal, or change `PORT` in `.env`. |
| `pnpm db:migrate` says a migration was modified or is missing | Your local database was built from an older version of the migrations. Run `pnpm db:reset` and confirm. It rebuilds your local database and reloads the demo data. |
| `Refusing to seed the database at "..."` | `DATABASE_URL` points at a database that is not on your computer. Seeding a hosted database needs `ALLOW_REMOTE_SEED=yes`. |
| `Each CORS origin must be a bare address` | `CORS_ORIGINS` has a path or a trailing slash. Use exactly `http://localhost:5173`. |

Related: [System architecture](../plan/03-system-architecture.md) · [Data model](../plan/04-data-model.md) · [Changing the API contract](05-api-contract-workflow.md)
