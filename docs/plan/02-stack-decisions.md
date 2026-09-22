# 02 · Stack decisions

These decisions are **locked**. Reopening one needs both developers to agree, and the change gets a line in the decision log at the bottom. Every choice has a reason, because examiners and the client's IT staff will ask why.

Versions are the ones installed in Phase 0 (September 2026).

## Workspace

| Decision | Choice | Why |
|---|---|---|
| Repository layout | **Monorepo** with pnpm workspaces | One pull request can change the contract, the API and the dashboard together. Shared types remove a whole class of integration bugs. |
| Package manager | **pnpm 12** | Fast, saves disk space, and has the strongest supply-chain protections of any package manager. |
| Language | **TypeScript 6**, strict mode, everywhere | One language for the whole team. Types catch mistakes before the code runs. |
| Lint and format | **Biome 2** | One tool and one config file for linting and formatting. Very fast. |
| Build orchestration | **Plain pnpm scripts** | With three packages, pnpm already runs tasks in the right order. Turborepo can be added if builds ever get slow. |

**Why TypeScript 6 and not 7?** TypeScript 7, the new native compiler released in July 2026, has no programmatic API until version 7.1. The NestJS CLI and openapi-typescript both need that API. We move to 7.x once 7.1 ships and those tools support it.

## API contract

| Decision | Choice | Why |
|---|---|---|
| Style | **Design-first OpenAPI 3.1** in `packages/contracts/openapi.yaml` | Written before the code, so the frontend and backend can be built at the same time against an agreed document. |
| Types | **openapi-typescript 7** generates the `@samtec/contracts` package | Both apps import the same types, so a mismatch becomes a compile error. |
| Checks | **Redocly CLI 2** lint, plus `openapi-typescript --check`, in CI | Catches an invalid contract and generated types that are out of date. |
| Errors | **Problem Details (RFC 9457)** | One standard error shape that the dashboard handles in one place. |

## Backend (Francis)

| Decision | Choice | Why |
|---|---|---|
| Framework | **NestJS 12** with ES modules on Express 5 | A clear structure (modules, controllers, services, dependency injection) that is easy to explain and review. Keeps the proposal's Express choice underneath. |
| Validation | **Zod 4** through Nest's built-in `StandardSchemaValidationPipe` | NestJS 12 accepts Zod schemas directly (`@Body({ schema })`), so no extra validation library is needed. |
| Database | **PostgreSQL 17** | Payroll is money. It needs transactions, foreign keys and constraints. |
| ORM | **Prisma 7.9.1**, pinned to that exact version, with the `pg` driver adapter | A readable schema file, safe migrations and fully typed queries. The decision log explains the exact pin. |
| Local database | **embedded-postgres** through `pnpm db:start` | A real PostgreSQL server with no Docker and no installer, which matters on student Windows laptops. |
| Hosted database | **Supabase**, used as plain PostgreSQL | A free tier with backups for the demo. We do not use its login features, and its Data API is switched off; every table also has row-level security as a safety net. |
| TypeScript scripts | **tsx** | Runs the seed file and the local database script straight from TypeScript, with no build step. |
| Security middleware | **Helmet 8**, strict CORS, request IDs | Secure headers and traceable errors from the first day. |
| Tests | **Vitest 4** and Supertest | The same test runner as the dashboard. The official NestJS 12 template also uses it. |
| Sign-in | JWT access token (15 minutes) signed with **jose**, rotating refresh cookie with reuse detection, **scrypt** password hashes, TOTP two-factor implemented from the RFCs | Standard and defensible, with no vendor lock-in. The decision log explains scrypt and jose. |
| Sign-in rate limiting | A database-backed per-email lockout (5 wrong passwords → 15-minute lock) | No extra dependency, survives restarts, and the lockout itself never reveals whether an email has an account. |

## Frontend (Samuel)

| Decision | Choice | Why |
|---|---|---|
| Build tool | **Vite 8** | An instant development server. The dashboard is an internal app, so a single-page app is the simplest fit. |
| UI library | **React 19** | The most widely used UI library, with the most tutorials and help available. |
| Routing | **React Router 8** in data mode | Standard page routing with error pages built in. |
| Styling | **Tailwind CSS 4** and **shadcn/ui** on Radix | Professional, accessible components that live in our code, so we can change them. |
| Class names | **cn** | Joins class names and settles clashing Tailwind classes (`cn('px-3', isActive && 'font-medium')`). The shadcn/ui components expect it. |
| Font | **Geist**, bundled with `@fontsource-variable/geist` | A clear interface font served from our own build, so the dashboard makes no request to an outside font service. |
| Data fetching | **TanStack Query 5** with **openapi-fetch** and **openapi-react-query** | One typed hook per endpoint (`$api.useQuery`) and no hand-written fetch code. |
| Mock API | **MSW 2** (Mock Service Worker) | The dashboard runs and is tested against pretend endpoints before the backend exists. |
| Tests | **Vitest 4** and **Testing Library** | Tests use each page the way a person would. |
| QR codes | **qrcode.react** | Draws the two-factor setup secret as a QR code in the browser. The decision log explains why a library, unlike TOTP. |

## Biometrics

Details are in [Biometric integration](10-biometric-integration.md).

| Path | Choice |
|---|---|
| Primary | **ZKTeco terminal**: matching happens on the device; punches are pushed to the API (ADMS protocol) or pulled with `zkteco-js` |
| Secondary and demo | **@vladmandic/human 3.3.6** (pinned, MIT, no dependencies): face recognition in the kiosk app (`apps/kiosk`), with anti-spoofing and liveness scores |
| Fingerprint on the kiosk device | **@simplewebauthn/server 14.0.2** and **@simplewebauthn/browser 14.0.0** (MIT): passkeys unlocked by the device's own fingerprint sensor |
| ZKTeco gateway | `apps/gateway`: Node 24's built-in modules only (`node:http`, `node:sqlite`); `zkteco-js` only for the manual pull fallback |
| Optional | **SecuGen WebAPI** for a USB fingerprint reader used from a browser |
| Always | A `BiometricProvider` interface with a **mock provider**, so everything demos without hardware |

## Quality, security and delivery

| Decision | Choice |
|---|---|
| Continuous integration | GitHub Actions on every pull request: lint, contract check, type check, tests, build, database migrations and a dependency audit |
| Action pinning | Every GitHub Action is pinned to a full commit SHA |
| Supply chain | pnpm refuses package versions less than a day old, refuses versions whose publishing trust dropped (for example, provenance suddenly missing), requires approval for install scripts (`allowBuilds`) and blocks packages from git or tarball sources |
| Commit messages | Conventional Commits (`feat:`, `fix:`, `docs:` and so on) |
| Reviews | The four-lens checklist in every pull request, plus `/lens-review` in Claude Code |
| Code owners | `.github/CODEOWNERS` asks both developers to review changes, including dependencies, CI and migrations |
| Action updates | Dependabot proposes new versions of the pinned GitHub Actions every week |
| Shared TEST environment | Dashboard and API on Vercel (the API as a serverless function), database on Supabase, one address via a rewrite ([TEST environment](../guides/09-test-environment.md)). Every merge to `main` deploys automatically. |
| Production hosting (Phase 8) | Decided when the client signs: either the same Vercel+Supabase layout, or the API as a long-running server on Railway or Render if Phase 2's device ingestion needs it. Production gets its own separate projects and secrets. |

## Consciously rejected

- **MongoDB.** No foreign keys, and payroll needs guaranteed relationships between records.
- **Microservices.** There are two developers. A modular monolith with strict module boundaries tells the same architecture story at a fraction of the cost.
- **Firebase.** Login and data lock-in, and no relational integrity.
- **Storing fingerprint or face images.** Templates only, encrypted. This is a legal and ethical line.
- **TypeScript 7 and Prisma 8, for now.** See the notes above and the decision log.

## Decision log

| Date | Change | Reason |
|---|---|---|
| 2026-09-14 | First stack chosen | Planning session |
| 2026-09-15 | Dropped Turborepo. Chose TypeScript 6, NestJS 12, Prisma 7, Vitest 4 and React Router 8. The contract became design-first YAML instead of being generated from code. | Phase 0 research into current versions, and the goal of keeping the project easy to learn |
| 2026-09-15 | Pinned Prisma to exactly 7.9.1 instead of 7.10.0 | pnpm's trust policy blocked `prisma@7.10.0`. Every 7.9.x release came from Prisma's verified GitHub pipeline with signed provenance, but the 7.10.0 CLI package was published with a plain access token and has no provenance. That is most likely a publishing mistake, yet it is exactly what a hijacked maintainer account looks like. Upgrade once a Prisma release is published with provenance again. |
| 2026-09-15 | Raised NestJS to 12.0.2, overrode mysql2 inside the Prisma CLI to 3.24.4, and accepted one advisory in writing | The first dependency audit found 7 advisories. NestJS 12.0.2 brings the patched multer 2.3.0, which fixes four of them. The mysql2 override fixes two more, in a MySQL driver we never use. The deepmerge-ts advisory only affects the Prisma CLI merging our own config file, and its fix is a major version that Prisma pins against, so it is accepted in `pnpm-workspace.yaml` until Prisma updates. |
| 2026-09-15 | Added a one-off trust policy exception for `semver@6.3.1` | A 2023 security release published without provenance, which pnpm reports as a trust downgrade (a known false positive). The shadcn CLI needs it. |
| 2026-09-16 | The public health check reports only status, time and database state. The refresh cookie became `SameSite=Strict`, so the dashboard and API must share one site. Two-factor setup joined the sign-in contract. Employee records leave out the Ghana Card number for roles that do not need it. | Four-lens review of the Phase 0 pull request. Version and environment details help attackers plan; a strict same-site cookie shuts out cross-site request forgery; data minimisation is required by Act 843. |
| 2026-09-16 | Regenerated the first migration before merging: `site_assignments` gained `company_id` and `updated_at`, `employees` gained `biometric_enrolled_at`, and every table got row-level security | Nothing had been deployed yet, so one clean first migration is easier to read and defend than a fix-up migration. Row-level security protects the data even if Supabase's Data API is switched on by mistake. |
| 2026-09-17 | Password hashing uses **scrypt** (built into Node.js) instead of argon2id | Both are memory-hard and OWASP-approved. argon2id would add a native dependency with install scripts — exactly the kind of supply-chain surface this project minimises — while scrypt ships inside Node. The stored format records its own settings, so parameters can be raised later without breaking accounts. |
| 2026-09-17 | Added **jose** for signing and checking JWT access tokens | The standard modern JWT library: pure JavaScript (no install scripts), audited, and built for ES modules. Refresh and challenge tokens are plain random values stored only as SHA-256 hashes, so they need no library at all. |
| 2026-09-17 | TOTP two-factor codes implemented directly from RFC 6238/4226 (about 100 lines on Node's crypto), not a library | The algorithm is small and standard; the tests prove it against the official RFC test vectors. One less dependency to trust, and easy to explain at the defense. |
| 2026-09-19 | Built the shared TEST environment now instead of waiting for Phase 8: Supabase (`samtec-test`, Data API off) + two Vercel projects, auto-deploying from `main`, migrations applied during the API build | Both developers now see every merged change running online. The API runs as a Vercel serverless function for TEST — simpler than adding a third hosting provider; whether production needs a long-running server is decided in Phase 8 with the client. |
| 2026-09-22 | Phase 3 design ([Biometrics design](13-biometrics-design.md)): company kiosks at the site, **Human 3.3.6** for faces, **SimpleWebAuthn 14** for the device's fingerprint sensor, and ZKTeco through a gateway with no dependencies. The face-template key is derived from `AUTH_SECRET`, and the retention sweep rides on device heartbeats. | Owner decisions. Human is the only browser face library with anti-spoofing that is still published, but its latest release is from August 2025, so it is pinned behind `BiometricProvider`. WebAuthn checking (CBOR, COSE keys, signature formats) is far too much to write ourselves, unlike TOTP; SimpleWebAuthn is the standard MIT library for it, and neither package runs install scripts. One master secret and no scheduled job keep the setup simple to run and explain. Each package passes pnpm's supply-chain policy in the pull request that adds it. |
| 2026-09-19 | Added **qrcode.react** (4.x) to the dashboard for the two-factor setup screen | QR encoding (Reed–Solomon error correction, masking, versions) is thousands of lines, so unlike TOTP it is not worth writing ourselves. qrcode.react is ISC-licensed (as permissive as MIT), pure JavaScript with no install scripts, has no dependencies of its own, renders an SVG (no canvas, so it works in tests), and passed pnpm's supply-chain policy. The secret is only ever drawn on the screen, never stored. |
