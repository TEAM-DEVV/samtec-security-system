# 14 · Who builds what next (Francis and Samuel)

**Read this page first, every session.** It says what each of us owns right
now, in plain words, and the rules that stop two people breaking the same
file. When it disagrees with anything said in a pull request or a chat, this
page wins.

Read [Roadmap](07-roadmap.md) for the order of the phases.

## Where the project is today

Eight phases. Five are finished or nearly so.

| Phase | What it is | Where it stands |
|---|---|---|
| 0 | Project set-up, CI, first migration | **Done** |
| 1 | Sign in, staff, sites, shifts, users | **Done** — API and screens |
| 2 | Attendance: punches paired into shifts, the exception queue | **Done** — API and screens |
| 3 | Biometrics: face and finger at a kiosk, ZKTeco terminals | **API done**, gateway endpoints included. Left: the kiosk app and the gateway, both Samuel's |
| 4 | Payroll: Ghana tax, payslips, bank file | **Not started — Samuel owns it, see Job A** |
| 5 | Ghost detection: the rules that catch fake workers | **Done — Francis.** All eleven rules, the queue, the sweep, and the three dashboard screens. Left: the owner's daily cron |
| 6 | Reports and the final visual pass | Not started |
| 7 | Security hardening | Not started — Francis |
| 8 | Deploy, defence pack, presentation | Not started — both |

## The split, from here to the end

Samuel has finished the dashboard and has time. So he now takes **whole
phases, backend included** — not just the screens.

| Who | Owns | Why |
|---|---|---|
| **Samuel** | **Phase 4 payroll, end to end** (database, API, screens) | It is a brand-new area. New tables, new files, nothing Francis is inside |
| **Samuel** | **Phase 6 reports** (payslip downloads, CSV and PDF, the guard's own payslip) | It grows straight out of payroll |
| **Samuel** | The kiosk app (`apps/kiosk`) and the ZKTeco gateway (`apps/gateway`) | Whole apps of their own. See Job B and Job C |
| **Francis** | The last three Phase 3 endpoints the gateway needs | They live inside the attendance module he wrote |
| **Francis** | **Phase 5 ghost detection, end to end** | Its rules read the attendance tables he wrote, line by line |
| **Francis** | Phase 7 hardening, and the final visual pass in Phase 6 | Whole-system review work |
| Both | Phase 8: deploy, defence pack, presentation | Shared |

**Order matters in one place only.** Ghost detection reads payroll data
(rules R3 and R6 in [Ghost detection engine](08-ghost-detection-engine.md)),
so **payroll must reach `main` before detection does.** That is why Samuel
starts payroll now and Francis finishes the Phase 3 endpoints first. Neither
of us waits for the other.

---

## Job A · Phase 4, the payroll engine — Samuel starts here

**Everything you need is written down.** Do not design it yourself:

- [Payroll engine (Ghana)](09-payroll-engine-ghana.md) — the tables, every
  endpoint, the calculation step by step, and **the twenty-one decisions that
  were open and are now settled**. Read it end to end before writing code.
- [How a backend module is built here](16-building-a-backend-module.md) — the
  house style, the traps, and which existing files to copy from.

**In one sentence:** close a month, calculate what each guard is owed from the
shifts the attendance module already confirmed, have a second person approve
it, lock it so it can never change, and produce a payslip and a bank file.

**Why it is safe to give away.** Payroll owns five brand-new tables that
nothing else writes to, and it reads attendance only through one service call.
It is the cleanest seam in the whole system.

**Done when** you can close September, calculate a run, fail to approve it as
the same person who prepared it, approve it as somebody else, and open a
payslip whose numbers add up by hand to the pesewa.

## Job B · The kiosk app (`apps/kiosk`)

This is the live demo: a guard walks up to a phone on the wall, looks at it,
and their shift starts. **Every API route it needs is merged and working.**
Nothing blocks it, and nothing waits on it, so fit it around Job A.

**What it is.** A separate Vite + React + TypeScript app, its own Vercel
project, plain CSS (do not pull in the dashboard's Tailwind setup — a kiosk
has six screens and must boot fast on a cheap Android phone). Design and
rules: [Biometrics design](13-biometrics-design.md) sections 2, 3, 4 and 7.

**The screens, in the order a device lives through them**

1. **Set-up** (once per device, by an ADMIN). Sign in, pick the site,
   register the device → `POST /devices` with `kind: FACE_KIOSK`. The secret
   comes back **once**: put it straight into a WebCrypto HMAC key that
   JavaScript cannot read back, and never store the raw string.
2. **Consent** (an ADMIN enrolling a worker). Show the exact words from
   `GET /biometrics/consent-text`, take the worker's agreement, ask for the
   last 4 digits of their Ghana Card → `POST /kiosk/consents`.
3. **Enrollment** (the same ADMIN). Three face captures half a second apart →
   `POST /kiosk/face-enrollments`. The answer says `PASSED` or `COLLISION`;
   on `COLLISION` say only "Needs an admin review", never who it looked like.
4. **Save the worker's finger** (the same ADMIN, right after the face, and
   only on a kiosk whose `passkeysEnabled` is on). The worker's finger must
   already be saved in the phone's own settings. `POST /kiosk/passkey-options`
   → hand `options` **unchanged** to `navigator.credentials.create()` →
   send the browser's answer, with the `ticket` exactly as it came, to
   `POST /kiosk/passkeys` within 2 minutes. If the answer says `synced: true`,
   tell the ADMIN the phone may copy this key to its cloud account.
5. **Clock in / out** (the everyday screen, no sign-in). Start shift / End
   shift → head-turn challenge → `POST /kiosk/identify` → show
   "Hello, Kwame A." for 2 seconds with a **Not me** button →
   `POST /kiosk/confirm`. "Not me" calls `POST /kiosk/not-me`.
   **If `identify` answers with `fingerprint`, the finger is required**: pass
   `fingerprint.options` unchanged to `navigator.credentials.get()` and send
   the answer as `assertion` on `POST /kiosk/confirm`. Cancelling it makes no
   punch at all — do not fall back to confirming without it, because the
   server will refuse anyway.
6. **Ask your supervisor.** After 3 failed face attempts, or straight away
   for a worker the server says cannot use their face: the supervisor looks
   at the camera and types the worker's staff number →
   `POST /kiosk/identify` with `purpose: CO_SIGN` → `POST /kiosk/assisted-punches`.
   That identify may ask for the **supervisor's own** finger too; when it
   does, send the assertion as `assertion` on the assisted punch.
   The same three failures also open `POST /kiosk/fingerprint-options`: the
   worker types their staff number and uses any finger the phone knows, and
   the answer's `options` go to `navigator.credentials.get()` and then to
   `POST /kiosk/confirm` like any other. Offer it only after three failures,
   because every call spends the unlock whatever the answer.

**Which screens need somebody signed in**

Two different doors, and mixing them up costs an afternoon:

| Screen | What the request carries |
|---|---|
| Set-up (`POST /devices`) | An ADMIN's access token. No signature — there is no device yet |
| Consent, enrollment, saving a finger | The ADMIN's token **and** the device's signature. The ADMIN signs in on the kiosk; that session works on kiosk screens only |
| Clock in, "Not me", confirm, the staff-number fallback, co-sign | The **device's signature alone**. No token, ever — the guard at the gate has no account |

**The four things that are easy to get wrong**

- **Signing.** Every `kiosk/…` call is signed by the device:
  `HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`, where `<route>`
  is the name (`kiosk/identify`), not the URL, and `<body>` is the **exact
  JSON text sent** — serialise once, sign that string, send that string.
  Headers: `X-Samtec-Device`, `X-Samtec-Timestamp`, `X-Samtec-Signature`.
  The one definition is `apps/api/src/modules/attendance/device-signature.ts`
  — read `signRequest` there and copy its shape exactly. There is no shared
  test vector yet, and writing one is part of this job (design section 8,
  row 6): a fixed secret, timestamp, route and body with the signature they
  must produce, checked by a test on **both** sides, so the two
  implementations can never drift apart without a test going red.
- **Liveness is the kiosk's job.** Human 3.3.6, pinned, face models only, from
  the kiosk's own origin. One face at least 224 pixels, `real` and `live` at
  least 0.60, a random LEFT or RIGHT head turn completed within 20 seconds,
  then one centred sample. The server checks the numbers again, but it cannot
  see the camera: if this is weak, the whole thing is weak.
- **WebAuthn's objects travel through untouched.** Whatever
  `passkey-options` or `fingerprint` hands over goes to the browser exactly
  as it came, and whatever the browser answers goes back exactly as it came
  (`response.toJSON()` in Chrome, or `@simplewebauthn/browser`). Rebuilding
  those objects by hand is how a whole afternoon disappears: the bytes are
  signed, so one changed field means the server refuses everything. The
  kiosk's address must be the one in `KIOSK_ORIGINS`, and **every address in
  that setting must be the same host** — a key made on one address can never
  be used on another, and the API now refuses to start if you mix hosts.
- **The answers never carry a score, and neither may the screen.** Show the
  name or "Try again". Never "close match", never a number, never who a face
  looked like. Anyone can stand in front of a kiosk.

**Done when** a real face clock-in on an Android phone appears on the
dashboard within 5 seconds, a printed photograph is refused, and a worker
whose finger is saved on that phone is asked for it and shows up on the
board as `FACE_PASSKEY`.

> Francis: create the Vercel project for `apps/kiosk` and add its address to
> `KIOSK_ORIGINS` before Samuel's first deploy. Ask the owner first.

## Job C · The fake ZKTeco terminal, and then the gateway

Last of the three, and it is the one job that **does** wait: the gateway talks
to `POST /ingest/roster`, `POST /ingest/enrollments` and
`POST /devices/{id}/finger-enrollment-windows`, which Francis is building now.
Check [Roadmap](07-roadmap.md) and the open pull requests before starting.

The **fake terminal** needs none of them and can be written any time: a small
script that behaves like a ZKTeco device, holding a roster and producing
punches with verify modes (1 → `FINGERPRINT`, 15 → `FACE`, anything else →
`PIN_FALLBACK`). Rules: [Biometrics design](13-biometrics-design.md) section 5.

## Done and merged

- **The Phase 3 dashboard screens** (pull request #43): the live clock-ins
  board, the employee Biometrics panel, the duplicate-enrollment queue and
  kiosk attempts per device.

---

# Staying in sync

We work on separate branches and never talk while we build, so these rules are
the whole of our coordination. They exist because two people are now editing
the **same repository at the same time**, which was not true before.

## 1. The sixteen files we both touch

A clean `git merge` is not proof that a shared file survived. Check each of
these by eye after every merge from `main`.

| File | What goes wrong | The rule |
|---|---|---|
| `packages/contracts/openapi.yaml` | Two appends to the same **four** blocks: tags, paths, `components/parameters` and schemas | Append only inside **your own `# --- … ---` banner**. Keep both sides |
| `packages/contracts/src/generated/api.d.ts` | 216 KB of conflict that looks terrifying | **Never hand-merge.** Take either side, run `pnpm contracts:generate`, commit |
| `pnpm-lock.yaml` | A hand-merge silently pins a different version | **Never hand-merge.** Take `main`'s, run `pnpm install`, commit |
| `apps/api/prisma/schema.prisma` | The conflict lands in `model Company` and `model Employee`, not at the end | Keep **both** back-relation lists in full. New models go at the end under your own comment |
| `apps/api/prisma/migrations/` | Git never reports a conflict — see rule 2 | See rule 2 |
| `apps/api/src/app.module.ts` | One lost line breaks **every** end-to-end test at once | Keep both imports and both array entries, then `pnpm lint:fix` |
| `apps/api/src/modules/payroll/payroll.module.ts` | Phase 5 created it, holding only the read seam detection needs | Keep both: Samuel's controller and payroll service join the module, and `PayrollFactsService` stays exported |
| `apps/api/prisma/seed.ts` | Two new blocks, one shared `main()` and one `console.log` | Keep both calls, payroll before detection. Never add a random call inside the existing 50-employee loop — the seed is deliberately repeatable |
| `apps/api/test/db-fixture.ts` | Wrong delete order fails only in CI, with a raw foreign-key error | Keep both deletes, **above** the employee and site deletes |
| `apps/web/src/app/routes.ts` | — | Keep both, each under its own comment |
| `apps/web/src/app/router.tsx` | A route placed after the catch-all silently shows "Not found" | Keep both, and keep `path: '*'` **last** |
| `apps/web/src/components/layout/nav-items.ts` | The Payroll and Ghost detection entries **already exist**, `available: false` | **Edit yours in place.** Never add a second one, never re-sort |
| `apps/web/src/lib/roles.ts` | Must match the `@Roles(...)` on the API controller exactly | Keep both. Also read rule 4 |
| `apps/web/src/mocks/handlers/index.ts` | — | Keep both imports and both spreads |
| `apps/web/src/test/setup.ts` | A missing reset makes an **unrelated** test flake later | Keep both imports and both calls |
| `docs/plan/07-roadmap.md`, `04-data-model.md` | Adjacent lines | Edit only your own phase's lines |
| `CLAUDE.md` | Both sessions rewrite "Current phase" | It is now one line per area. Edit **only your own line** |

## 2. Migrations: "it merged cleanly" means nothing

Every `pnpm db:migrate` makes its own timestamped folder, so git never
conflicts — and the problem only appears when the SQL actually runs.

- **The rule, in one sentence: whoever merges second regenerates their
  migration on top of `main`** — delete the not-yet-merged local folder, run
  `pnpm db:reset`, run `pnpm db:migrate` again — so its timestamp is later
  than the one already on `main`.
- **Never** edit, rename or renumber a migration folder once it is on `main`.
  TEST has already applied it and records its checksum.
- Two migrations that only create their **own** tables, enums and indexes are
  safe in any order. Do not over-engineer around this.
- Danger only appears when they share something: the same new value on an
  existing enum, a trigger function with the same name, or a new column on a
  shared table like `employees`. CLAUDE.md rule 9 says read every generated
  `migration.sql` — this is why.
- After pulling `main` with the other person's migration, run `pnpm db:reset`
  rather than carrying on with a local database that applied them in the other
  order.

## 3. Names carry their module

A duplicate name merges cleanly in git and then turns CI red on `main`, which
is the worst place to find it.

- Contract schemas and operation IDs: `PayrollRun`, `listPayrollRuns`,
  `DetectionAlert`, `resolveDetectionAlert`.
- Tables: `payroll_*`, `detection_*`.
- Trigger functions in SQL: `payroll_…()`, `detection_…()`.

## 4. Two decisions taken in advance, so neither of us is surprised

- **Guards may read their own payslips, and that lands in Phase 4.**
  `apps/web/src/lib/roles.test.ts` currently asserts that **no** page role
  includes `GUARD`. Samuel changes that test in the same pull request that
  adds the payslip page, and says so in the description. Otherwise it turns
  red for both of us and each assumes the other broke it.
- **Payroll does not call ghost detection yet.** The design says detection
  rule R3 blocks a payroll submission — but detection is built after payroll.
  So Phase 4 records the evidence R3 needs on each line and lets the
  submission through; Francis wires the block in during Phase 5.

## 5. The contract, when it has to change

Rule 1 of the root `CLAUDE.md`, and the only rule that can cost a day:

1. Change `packages/contracts/openapi.yaml` **first**, inside your banner.
2. Run `pnpm contracts:generate`.
3. Update the mock handlers in `apps/web/src/mocks/handlers/` in the **same**
   change.
4. Put what the other side must do under a heading **"For the API (Francis)"**
   or **"For the dashboard (Samuel)"** in the pull request description. Each
   of us reads the open pull requests for that heading at the start of every
   session.

Land a small, contract-only pull request first, before the code that uses it.
It touches the most contended file once, briefly, instead of for two weeks.

## 6. The rhythm

- Branch from `main`, prefix it (`feat/`, `fix/`, `contract/`, `docs/`).
- **Merge `origin/main` into your branch every day you work**, even when
  nothing looks related, and run `pnpm check`. A conflict found on day two is
  five minutes; on day ten it is an afternoon.
- At most two open pull requests each.
- Run the four review lenses before every pull request (`/lens-review`).
- `pnpm check` before calling anything finished.
- Every merge to `main` deploys to TEST by itself, migrations and all.
- **After the second of our two migrations lands**, one of us runs
  `pnpm db:reset` then `pnpm check` locally. That combination exists only on
  `main`, never on either branch, so nothing else proves it works.
