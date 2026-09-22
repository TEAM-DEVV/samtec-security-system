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

The API project sets `ALLOW_SIMULATOR_DEVICES=yes`, so the attendance
demo's simulator devices work ([The attendance demo](10-attendance-demo.md)).
The API runs in production mode on Vercel, where simulators are refused
unless this is set. A client's production leaves it unset.

## How deploys happen

1. You merge a pull request into `main` (after CI is green and review).
2. Vercel builds both projects from the new `main`.
3. The API build runs `prisma migrate deploy` first, so **database migrations
   apply themselves** — merging a migration is all it takes.
4. A minute or two later, TEST is running your change.

Nothing to click, nothing to remember. If TEST breaks, check the deploy logs
in Vercel first; the API also answers `/api/v1/health`.

## Signing in on TEST

This repository is public, so **TEST's office accounts do not use the demo
password**. Anyone who read this page could otherwise sign in as an
administrator and create accounts.

- `supervisor@samtec.example` / `demo-password` stays public, for trying the
  dashboard as a supervisor.
- `admin@samtec.example` has a private password that Francis holds; ask him.
  It was reset with `pnpm --filter @samtec/api account:admin`, which is also
  how a lost admin sign-in on TEST is rescued.
- `hr@samtec.example` gets a private password next: the admin resets its
  sign-in from the Users page once that page is on TEST.

On your own computer every demo account keeps `demo-password` (the local seed
and the mock API), exactly as `docs/guides/03-frontend-guide.md` says. Admin
and HR set up an authenticator app at their first sign-in. That is the real
two-factor flow, and any authenticator app works.

## Rules for TEST

1. **Fictional data only.** The seed's remote-database guard exists exactly
   for this; seeding TEST is a deliberate, documented act.
2. **Never point local tools at TEST.** `pnpm db:migrate`, `db:reset` and
   `db:seed` are for the database on your own computer.
3. **TEST secrets are not production secrets.** When the client's production
   environment is built (Phase 8), it gets its own Supabase project, its own
   `AUTH_SECRET`, and its own rules.
