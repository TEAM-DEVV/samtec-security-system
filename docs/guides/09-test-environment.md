# The TEST environment

TEST is the live, online copy of SAMTEC that both developers share. Every
merge to `main` — backend or frontend — deploys to TEST automatically, so we
always have one place to see the whole system running together, show
progress, and catch problems that only appear online.

**TEST is not production.** It holds only the fictional demo company, its
demo accounts, and made-up data. Real client data never goes there.

## The addresses

| What | Address |
|---|---|
| The dashboard (open this) | https://samtec-test.vercel.app |
| The API behind it | https://samtec-test.vercel.app/api/v1/health |

The dashboard and the API share one address on purpose: the sign-in cookie is
`SameSite=Strict`, so the browser only sends it when both halves live on the
same site ([System architecture](../plan/03-system-architecture.md#hosting-one-site-for-the-dashboard-and-the-api)).
Behind the scenes, the dashboard project forwards every `/api/v1/*` request to
the API project (`apps/web/vercel.json`).

## How it is put together

| Piece | Where | Notes |
|---|---|---|
| Dashboard | Vercel project `samtec-test` (root `apps/web`) | Vite build; `VITE_API_BASE_URL=/api/v1` |
| API | Vercel project `samtec-test-api` (root `apps/api`) | Runs as a serverless function (`apps/api/api/index.ts` → `src/serverless.ts`). Same code, same security settings as local. Its `CORS_ORIGINS` must be `https://samtec-test.vercel.app`: the browser sends that as the `Origin` of every sign-in, refresh and sign-out call, and the API refuses any other. |
| Database | Supabase project `samtec-test` (ALPHA-TEAM-dev org, free tier) | **Data API is switched off**; row-level security on every table; the API is the only way in. |

Secrets (`AUTH_SECRET`, the database connection) live only in Vercel's
environment settings — never in the repository, never in chats.

## How deploys happen

1. You merge a pull request into `main` (after CI is green and review).
2. Vercel builds both projects from the new `main`.
3. The API build runs `prisma migrate deploy` first, so **database migrations
   apply themselves** — merging a migration is all it takes.
4. A minute or two later, TEST is running your change.

Nothing to click, nothing to remember. If TEST breaks, check the deploy logs
in Vercel first; the API also answers `/api/v1/health`.

## Signing in on TEST

The demo accounts are the same as local (`docs/guides/03-frontend-guide.md`):
`admin@` / `hr@` / `supervisor@samtec.example` with password `demo-password`.
Admin and HR are asked to set up an authenticator app on first sign-in — that
is the real two-factor flow, and any authenticator app works.

## Rules for TEST

1. **Fictional data only.** The seed's remote-database guard exists exactly
   for this; seeding TEST is a deliberate, documented act.
2. **Never point local tools at TEST.** `pnpm db:migrate`, `db:reset` and
   `db:seed` are for the database on your own computer.
3. **TEST secrets are not production secrets.** When the client's production
   environment is built (Phase 8), it gets its own Supabase project, its own
   `AUTH_SECRET`, and its own rules.
