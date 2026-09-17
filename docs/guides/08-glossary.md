# Glossary

Every technical word used in this project, in plain English. Words are in alphabetical order.

**ADMS**
The protocol ZKTeco attendance devices use to send clock-ins to a server over the internet.

**API (Application Programming Interface)**
A set of addresses that programs call to ask for data or actions. SAMTEC's API is the backend at `/api/v1`.

**API contract**
The written agreement describing every API request and response. Ours is `packages/contracts/openapi.yaml`.

**argon2id**
A slow-on-purpose way to scramble passwords before storing them, so stolen data cannot easily be turned back into passwords.

**Audit log**
A record of who changed what and when. Entries are only ever added, never edited.

**Backend**
The part of the system that runs on a server: it applies rules and talks to the database. Ours is `apps/api`.

**Biometric template**
A mathematical summary of a fingerprint or face, used for matching. It is not a picture, and a picture cannot be rebuilt from it.

**Branch**
A separate line of work in git, so changes do not affect `main` until they are reviewed and merged.

**Build**
Turning source code into files ready to run or to put online.

**CI (Continuous Integration)**
Automatic checks that GitHub runs on every pull request: lint, types, tests and build.

**Commit**
A saved snapshot of changes in git, with a message describing them.

**Component**
A reusable piece of the user interface in React, such as a button or a table.

**CORS (Cross-Origin Resource Sharing)**
A browser rule that controls which websites may call an API. SAMTEC's API only accepts calls from the dashboard's own address.

**Cursor pagination**
Loading a long list page by page, where each page includes a bookmark (`nextCursor`) for the next page.

**Database**
Organised, permanent storage for data. SAMTEC uses PostgreSQL.

**Dependency**
Code written by others that our project uses, installed with pnpm.

**Dependency injection**
A pattern where a class receives the things it needs (like the database client) instead of creating them. It makes code easy to test with fakes. NestJS does this automatically.

**Endpoint**
One address plus method in an API, for example `GET /api/v1/employees`.

**End-to-end (e2e) test**
A test that starts the real application and sends real requests to it.

**Environment variable**
A setting given to a program from outside its code, such as the database address. Kept in `.env` files that git ignores.

**ES modules (ESM)**
The modern JavaScript way of splitting code into files with `import` and `export`.

**Frontend**
The part of the system that runs in the browser. Ours is `apps/web`.

**Ghana Card**
Ghana's national ID card, issued by the National Identification Authority. Its personal ID number also serves as the SSNIT number.

**Ghost worker**
Someone on the payroll who does not actually work: a fake person, a departed employee, or an absent employee whose attendance is faked.

**Helmet**
A small library that adds secure HTTP headers to every API response.

**HMAC**
A signature made with a shared secret. It proves that a message, such as a clock-in from a device, really came from that device and was not changed.

**HTTP status code**
A number in every API response: 200 means OK, 400 means the request was invalid, 401 means not signed in, 403 means not allowed, 404 means not found, and 500 means a server error.

**Idempotency**
Doing the same thing twice has the same effect as doing it once. A clock-in sent twice is stored only once.

**JWT (JSON Web Token)**
A signed token that proves who is signed in. The dashboard sends it with each request.

**Lint**
Automatic checking of code for mistakes and style problems. We use Biome.

**Maker–checker**
A control where one person prepares something, such as a payroll, and a different person must approve it.

**Middleware**
Code that runs on every request before it reaches the endpoint, for example to add a request ID.

**Migration**
A file of database changes (such as adding a table) applied in order, so every copy of the database has the same structure.

**Mock / MSW**
Pretend versions of the API. MSW (Mock Service Worker) runs them inside the browser and in tests, so the dashboard works before the real API exists.

**Module (NestJS)**
A group of related controllers and services, such as everything about payroll.

**Monorepo**
One repository holding several related projects. Ours holds the dashboard, the API and the contract.

**NestJS**
The framework our API is built with. It organises code into modules, controllers and services.

**Node.js**
The program that runs JavaScript outside the browser. It runs our API and our tools.

**OpenAPI**
The standard format for describing web APIs. Our contract is written in it.

**ORM (Object-Relational Mapper)**
A tool that lets code work with database tables as objects. We use Prisma.

**PAYE (Pay As You Earn)**
Income tax deducted from salaries every month and paid to the Ghana Revenue Authority.

**Pesewa**
One hundredth of a Ghana cedi. SAMTEC stores all money as whole pesewas to avoid rounding errors.

**pnpm**
The package manager that installs our dependencies and runs our scripts.

**PostgreSQL**
The database SAMTEC uses: reliable, free, and strong at protecting related data.

**Prisma**
The tool that defines our database tables in `schema.prisma`, creates migrations and runs queries.

**Problem Details**
A standard shape for API errors (RFC 9457), with fields like `title`, `detail` and `traceId`.

**Pull request (PR)**
A request to merge a branch into `main`, where the change is reviewed and checked.

**Rate limiting**
Refusing too many requests in a short time, for example to stop someone guessing passwords.

**React**
The library our dashboard is built with.

**React Query (TanStack Query)**
The library that loads data from the API and handles loading, errors and caching for us.

**Refresh token**
A long-lived token, kept in a secure cookie, used to get new short-lived access tokens without signing in again.

**Role-based access control (RBAC)**
Permissions based on a user's role: ADMIN, HR_PAYROLL, SUPERVISOR or GUARD.

**Row-level security (RLS)**
A PostgreSQL feature that decides which rows each database user may see. SAMTEC switches it on for every table, so only the API, which owns the tables, can read them.

**Same site**
Two web addresses under the same domain, such as `app.samtec.example` and `api.samtec.example`. Browsers send a `SameSite=Strict` cookie only between addresses on the same site.

**scrypt**
The password-hashing function SAMTEC uses, built into Node.js. Deliberately slow and memory-hungry, so guessing millions of stolen password hashes stays impractical.

**Schema**
A description of the shape of data. A database schema describes tables; a Zod schema describes valid input; a contract schema describes API data.

**Seed data**
Fictional starter data loaded into a development database with `pnpm db:seed`.

**Service (NestJS)**
A class that holds business logic and database access. Controllers call services.

**Service worker**
A script a browser runs in the background for a website. MSW uses one to answer the dashboard's requests with mock data.

**shadcn/ui**
A collection of well-designed React components that are copied into our code, so we own and can change them.

**SSNIT**
Social Security and National Insurance Trust: Ghana's pension scheme. Employees contribute 5.5% of basic salary and employers 13%.

**Supply-chain attack**
An attack that hides malicious code inside a dependency that developers install.

**Tailwind CSS**
A styling system where you style elements with small class names like `text-sm` and `font-medium`.

**TOTP / two-factor authentication (2FA)**
A second sign-in step using a 6-digit code from an authenticator app, which changes every 30 seconds.

**TypeScript**
JavaScript with types. It catches many mistakes before the code runs.

**Unit test**
A small test that checks one piece of logic on its own.

**UTC**
Coordinated Universal Time, the world's reference clock. Ghana's time zone (Africa/Accra) matches UTC all year.

**UUID**
A long, random-looking unique ID, like `01927c3e-5a4b-7c8d-9e0f-1a2b3c4d5e6f`. Version 7 UUIDs also sort by creation time.

**Validation**
Checking that input has the right shape and values before using it.

**Vite**
The tool that runs the dashboard during development and builds it for production.

**Vitest**
The test runner for both the dashboard and the API.

**Zod**
A library for describing and checking the shape of data, used to validate API input and configuration.
