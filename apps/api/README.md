# @samtec/api

The SAMTEC API: a NestJS 12 application using Prisma 7 and PostgreSQL 17.

- **Guide:** [Backend guide](../../docs/guides/04-backend-guide.md)
- **The contract it implements:** [packages/contracts/openapi.yaml](../../packages/contracts/openapi.yaml)
- **Feature modules:** [src/modules/README.md](src/modules/README.md)

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `pnpm db:start` | Starts the local PostgreSQL server. Keep that terminal open. |
| `pnpm db:migrate` | Creates and applies a migration after you edit `prisma/schema.prisma` |
| `pnpm db:seed` | Loads the fictional demo company (safe to run again) |
| `pnpm db:reset` | Deletes all local data, reapplies every migration and reseeds |
| `pnpm db:studio` | Opens Prisma Studio to browse the database in a web page |
| `pnpm dev:api` | Starts the API on http://localhost:3000/api/v1 and restarts it when files change |
| `pnpm --filter @samtec/api test` | Runs the API's unit and end-to-end tests |

## Configuration

Copy `.env.example` to `.env` in this folder. The API checks every value when it starts and refuses to run if a value is missing or wrong. `.env` is ignored by git; never commit real passwords.
