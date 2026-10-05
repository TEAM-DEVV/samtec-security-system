# 06 · Security and review gates: the four lenses

The senior roles on this project (architect, senior developer, full-stack engineer, cybersecurity analyst) are **built into the process**, not left as advice. Every pull request and every phase exit is checked through all four lenses.

## Where the lenses live

| Place | What it does | When it runs |
|---|---|---|
| `.github/pull_request_template.md` | The four checklists appear in every pull request, for a person to tick | Every pull request |
| `.github/workflows/ci.yml` | Automated checks that no one can forget: lint, contract, types, tests, build, migrations, audit | Every push to a pull request |

## Lens 1: Architect. Does it still fit the design?

- [ ] The change lives in the right module. No module writes to another module's tables.
- [ ] The contract changed first. There are no undocumented endpoints.
- [ ] No new infrastructure or dependency without a note in [Stack decisions](02-stack-decisions.md).
- [ ] The rules in [System architecture](03-system-architecture.md) and [Data model](04-data-model.md) still hold, or were consciously changed and documented.

## Lens 2: Senior developer. Is it built well?

- [ ] Types are strict with no `any`. Inputs are validated with Zod at the boundary.
- [ ] Errors are handled and returned as Problem Details. No promise is left un-awaited.
- [ ] Payroll and detection logic have unit tests with edge cases. Endpoints have at least a success test and an access-denied test.
- [ ] Names state their units where confusion is possible: `pesewas`, `Utc`, `minutes`.
- [ ] Migrations were read before merging and do not lose data.

## Lens 3: Full-stack. Does the seam hold?

- [ ] The dashboard uses only the generated API client. No hand-written fetch calls.
- [ ] Mock handlers match the contract.
- [ ] Every new screen has loading, empty and error states.
- [ ] Pagination and time zones display correctly: stored in UTC, shown in Africa/Accra time.
- [ ] Kiosk screens work in the browser of a cheap Android tablet.

## Lens 4: Security analyst. What would I attack?

- [ ] Object-level authorization is tested: can guard A read guard B's payslip? A test must prove the answer is no.
- [ ] A sensitive action cannot skip password confirmation by calling the API directly, even if the dashboard hides the button.
- [ ] The device ingest endpoint verifies each device's HMAC signature, ignores repeated punches and rejects oversized batches.
- [ ] No secrets or personal data in logs. Biometric templates are never logged and never leave the server unencrypted.
- [ ] Sign-in and ingest are rate-limited. Repeated failed sign-ins slow down and lock.
- [ ] `pnpm audit` is clean, or every finding is explained in writing.
- [ ] Database access uses Prisma's query builder. Any raw SQL is reviewed by both developers.
- [ ] A migration that creates a table also enables row-level security on it.
- [ ] Responses include only the fields each role needs (for example, the Ghana Card number).

## Security controls

| Control | Implementation | Status |
|---|---|---|
| Secure headers | Helmet on every response; `X-Powered-By` removed | **Phase 0** |
| Cross-origin requests | CORS limited to the dashboard's own address (`CORS_ORIGINS`) | **Phase 0** |
| Traceable errors | Request ID on every response; Problem Details errors with `traceId`; unexpected errors never reveal internals | **Phase 0** |
| Safe logging | Client errors (4xx) logged as one line: method, path, status and `traceId`. Server errors (5xx) add the error type, code and stack. Request bodies, query strings and error messages are never logged. Prisma errors use the short format. | **Phase 0** |
| Request size | JSON bodies limited to 100 kB; bigger bodies are refused with `413` before any of our code runs | **Phase 0** |
| Public health check | Reports only status, time and database state; the database check times out after 3 seconds and is reused for 5 seconds | **Phase 0** |
| Configuration | Environment variables validated at startup; the API refuses to start with bad values; secret values never printed; `CORS_ORIGINS` must be exact website addresses, and `https://` in production | **Phase 0** |
| Input validation | Global `StandardSchemaValidationPipe` ready for Zod schemas on every route; unknown fields rejected | **Phase 0** (used from Phase 1) |
| Database exposure | Row-level security on every table; Supabase's Data API switched off and its roles' privileges removed; the seed refuses remote databases | **Phase 0** |
| Repository | Code owners review changes; Dependabot updates pinned Actions; private vulnerability reporting ([SECURITY.md](../../SECURITY.md)) | **Phase 0** (owner settings: see the roadmap) |
| Mock API | Exists only in development builds; a production build contains no mock code | **Phase 0** |
| Supply chain | pnpm: package versions under 1 day old refused, versions with a publishing trust downgrade refused, install scripts need approval in `allowBuilds`, git and tarball sources blocked; CI actions pinned to commit SHAs; `pnpm audit` in CI | **Phase 0** |
| Secrets | `.env` git-ignored; `.env.example` placeholders only | **Phase 0** |
| Transport | HTTPS only, with HSTS, on the hosted demo | Phase 8 |
| Passwords | scrypt hashes (settings recorded per hash). 5 wrong passwords for one email lock it for 15 minutes with a `429`, whether or not the account exists, and a stand-in hash keeps the timing identical for unknown emails. The counter is one atomic SQL statement, so parallel guesses cannot slip past it, and the throttle table stores only keyed hashes (HMAC), never emails. | **Phase 1 (built)** |
| Two-factor authentication | TOTP required for ADMIN and HR_PAYROLL, set up at first sign-in. Challenge and setup tokens expire (5 and 10 minutes), work once and belong to one account; 5 wrong codes cancel a challenge; an accepted code cannot be used again. Wrong codes are **also counted per account**, so signing in again never grants fresh guesses — a leaked password cannot brute-force the 6-digit code. Authenticator secrets are stored AES-256-GCM-encrypted. A lost authenticator is reset by another ADMIN with **reset sign-in**, which clears the password too, so someone holding a stolen password cannot simply ask for "a new phone". Refresh also refuses an ADMIN or HR_PAYROLL account without two-factor, so a promotion can never skip it. | **Phase 1 (built)** |
| One administrator, with a password | Any ADMIN can create, promote, reset or switch on another ADMIN account alone, and the account is usable as soon as its password is set. A device key is still born switched off; any administrator, including whoever registered it or last rotated its secret, can switch it on as a separate step. Sensitive actions ask the administrator to confirm their own password instead, and every one is audited. See "One administrator, with a password" below | **Phase 7, updated by issue #99 (built)** |
| Accounts | Only ADMIN manages sign-in accounts. **Nobody ever sees another person's password:** a new or reset account gets a one-time link (72 hours, single use, stored as a SHA-256 hash, sent with `Cache-Control: no-store`) and the person chooses their own password (12–128 characters). An administrator can never change, switch off or reset their own account (only their name), and every change to an existing account first locks the administrator's and the target's rows and re-checks the administrator — so two admins switching each other off at the same instant can never leave the company with none. SUPERVISOR and GUARD accounts must be linked to an employee and office accounts never are (a database CHECK); terminating an employee switches their account off in the same transaction. Every account change is audited with field names only. The recovery path for a sole locked-out admin is `pnpm --filter @samtec/api account:admin`, which needs database access and is audited. | **Phase 1 (built)** |
| Sessions | 15-minute access tokens kept in memory only. A 7-day refresh cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`) rotates on every use with an atomic claim, so even two simultaneous replays cannot both mint sessions; a reused refresh token revokes all of that user's sessions; the database stores only token hashes. `Origin` is checked on refresh and logout, the only two endpoints that act on the cookie alone. Phase 3 also checks it on the sign-in steps, to tell a dashboard sign-in from a kiosk sign-in (`CORS_ORIGINS`, `KIOSK_ORIGINS`). Revocation on logout. **The access-token guard also checks the account on every request** (one lookup by ID), so switching an account off, changing its role or employee link, or resetting its sign-in takes effect on the very next request rather than when the token expires. A session that was simply ended (sign-out, admin action) answers `401` without the stolen-token alarm; only a token that was already swapped for a newer one raises it. Accepted risk: after a *self-service* password change, another device's access token lives out its remaining minutes (at most 15), though it can no longer refresh. | **Phase 1 (built)** |
| Object-level access | Every route needs a token unless marked public; roles checked per route; supervisors scoped to their sites, guards to themselves; hidden records answer 404. Proven by tests against a real database. | **Phase 1 (built)** |
| Rate limiting | Sign-in (built). Device ingest: 60 signed requests per device per minute, counted in one atomic SQL statement; a wrong signature is counted at most once a minute, so a stranger cannot lock a device out (built) | **Phases 1–2 (built)** |
| Devices | A 32-byte secret per device, shown once and stored encrypted (AES-256-GCM, its own key derived from `AUTH_SECRET`). Every request is signed with HMAC-SHA256 over a version, the timestamp, the route name and the raw body; timestamps older or newer than 5 minutes are refused; every failure answers the same `401`. Rotating a secret kills the old one at once. Punches are append-only (database trigger), unique per device and event ID, and a changed resend is refused and audited | **Phase 2 (built)** |
| Audit | Append-only audit log — a database trigger rejects every change and delete (built, recording sign-in events). Attendance exception resolutions are audited without their free-text note (built, Phase 2). Payroll approvals always audited | Phases 2–5 |
| Biometric data | Templates only, AES-256-GCM at rest, key outside the database, deleted on termination according to the retention policy | Phase 3 |
| Backups | **The hosted database has no backups**: it is on Supabase's free plan, where scheduled backups and point-in-time recovery are both paid. Ours is `pnpm --filter @samtec/api db:backup`, which needs no PostgreSQL tools, and a restore is rehearsed and measured in [Backup and restore](../guides/11-backup-and-restore.md) — against a local PostgreSQL 17, not yet end to end against the hosted one. Nothing takes a backup automatically yet; that guide says what it would cost to fix | **Phase 7 (restore rehearsed locally, scheduling owed)** |

## One administrator, with a password (Phase 7, updated by issue #99)

Until the owner closed issue #99 on 1 October 2026, two rules in this system
asked for a second person: every biometric decision needed a second ADMIN
account, and creating, promoting, resetting or switching on an ADMIN account
waited for a different administrator to confirm it. Both are gone. A company
with only one or two administrators kept finding itself deadlocked, or just
slowed down, by a safeguard built for a bigger team. Build to the rule below
instead.

**Any ADMIN can do every task alone.** Creating a user, promoting one to
ADMIN, resetting a sign-in or switching an account back on all take effect
at once, with nobody else's confirmation. The account is usable as soon as
its password is set. The `AWAITING_CONFIRMATION` status and
`POST /users/{id}/confirm-admin` no longer exist. Who made the change is
still recorded on the account — the "requested by" and "confirmed by"
columns now simply name the same person — and in the audit log.

### The safeguard: sensitive actions ask for the administrator's password

1. `POST /auth/confirm-password` takes `{ password }`. A right password
   returns a new access token for the same session, carrying the
   confirmation for **five minutes** (`confirmedForSeconds: 300`). A wrong
   password answers `400` on the field `password` and counts towards the
   **same per-email lockout as signing in** — five wrong answers in 15
   minutes locks both. The step is audited as `auth.password_confirmed`.
   `POST /auth/refresh` carries a still-fresh confirmation over to the new
   token, so a person is not asked twice partway through a job.
2. A sensitive route is marked `@NeedsPassword()` in the API — enforced by
   `PasswordConfirmationGuard`, the fourth global guard, after the sign-in
   wall, the kiosk limit and the role check — and `x-needs-password: true`
   in the OpenAPI contract. Calling it without a fresh confirmation answers
   `403` with `code: PASSWORD_CONFIRMATION_REQUIRED`. An end-to-end test
   checks that the contract's list of sensitive routes and the code's list
   are the same one.
3. **On the dashboard,** one "Confirm with your password" dialog is mounted
   once. When any action is refused with `PASSWORD_CONFIRMATION_REQUIRED`,
   the API client opens it, and a right password sends the same action
   again by itself. One confirmation covers five minutes of work, so a
   person is asked once, not at every click. Cancelling leaves the action
   refused, and the page says "Confirm with your password to continue."
4. **On the kiosk,** nothing extra is asked: the administrator already
   typed their password to sign in there, that session lasts 15 minutes and
   can only reach the kiosk screens, so it passes the guard as it is.

**What needs a password:** wiping a face or fingerprint, lifting a block,
recording a withdrawal of consent, deciding an exemption or a duplicate-face
review; ending employment; editing bank or mobile-money details; creating,
changing, deactivating, reactivating or resetting a user account;
registering a device, changing it, or rotating its secret; approving
payroll, marking it paid, and the bank export (the maker–checker rule is
gone — whoever prepared a run may approve it); and changing a
ghost-detection rule.

### Devices

**A new device key is still born switched off.** Registering a device, or
rotating its secret, always leaves it `INACTIVE` until somebody switches it
on — true since a kiosk first set itself up in Phase 3, and true of every
device however it was made. Switching one on is now a separate step on the
dashboard that **any** administrator can take, including the one who
registered the device or last rotated its key. Checking that the device is
really on the wall at that site still matters; it no longer has to be a
different person who checks, and the step asks for the administrator's
password instead.

Switching a device **off** stays open to any administrator, at once, and
still forgets who switched it on, so going back on is always answered for
again.

**What this does not change.** Every action is still written to the audit
log, with who did it and when. Ghost detection still flags suspicious
patterns: rule R11 no longer treats the administrator who enrolled a face
deciding its own review as suspicious — that is normal now — but it still
flags other indirect links, such as a decision by somebody whose own face
was wiped. The defence answer to "what stops one insider?" is now: any admin
can act, but sensitive actions need their password, everything is in the
audit log, and ghost detection still flags suspicious patterns.

## Law: Ghana Data Protection Act, 2012 (Act 843)

Biometric data is sensitive personal data. SAMTEC therefore:

- records the employee's **consent** during enrollment (a step on the kiosk, before the face is captured; the text's version and SHA-256 are stored), and lets an employee refuse or withdraw it without losing pay;
- uses biometric data **only for attendance** (purpose limitation);
- keeps a written **retention schedule** and deletes templates when it expires: a face is wiped at once when consent is withdrawn, and 90 days after the worker leaves.

This section belongs in Samuel's report and in the client presentation.

## Threat model (update it every phase)

| Threat | Who | Mitigation |
|---|---|---|
| Buddy punching: a friend clocks in for an absent guard | Guard | Biometric-only clock-in; PIN fallback flagged and co-signed by a supervisor |
| Editing payroll after approval | HR user | Locked runs, password-confirmed approval and payout, audit log, database trigger |
| A fake device sending punches | Outsider or insider | Per-device HMAC secret and device registry, clock-drift measurement (built, Phase 2); each signed route accepts only some device kinds, so a kiosk key never posts raw punches (built, Phase 3); volume anomaly detection (built, Phase 5); **a new or rotated key is born switched off**, and switching it on is a separate, password-confirmed step on the dashboard that any administrator — including the issuer — can take once the device is checked to be really at the site (built, Phase 7; updated by issue #99) |
| Stealing biometric templates | Outsider | Encryption at rest, bound to each row; no images stored; templates never leave the server or reach a log. Face templates can be turned back into a rough face, so they are treated as sensitive data (Phase 3) |
| Replaying captured punches | Network attacker | Idempotency key and payload hash, plus a signed timestamp that expires after 5 minutes (built, Phase 2) |
| Holding a photo up to the face kiosk | Guard | Anti-spoofing and liveness scores, checked on the kiosk and again on the server, plus a random head-turn challenge; documented as a version 1 limitation, because a replayed video or a mask can still pass (Phase 3) |
| A stolen kiosk, or a copied kiosk key | Outsider or insider | The key works only on `/kiosk` routes, never for raw punches; enrollment also needs an ADMIN's token with two-factor, and a kiosk sign-in gets no refresh cookie and a kiosk-only token; attempts record their network address for Phase 5; the ADMIN rotates the secret. **Accepted for version 1:** the kiosk measures its own face scores, so a copied key can clock in a worker who has no fingerprint key on that kiosk, and make flagged co-signed punches for anyone posted to that site (Phase 3) |
| One insider activating a ghost without a face | Insider (ADMIN) | Asking for an exemption, deciding one, and deciding a duplicate-face review all need the administrator's password and are audited; hours of a worker waiting for a decision are paid only after it; one open question at a time; a revoke cannot wipe away an open review; withdrawing never activates anyone; a record blocked as a duplicate can only be terminated, or have its block lifted to enrol again from scratch; rule R11 still flags other indirect links, such as a decision by somebody whose own face was wiped (Phases 3, 5 and 7) |
| One person using two ADMIN accounts | Insider (ADMIN) | Since issue #99, any admin can create, promote or reset another admin account alone, so this is no longer closed by a second-person rule. What is left: every such change is audited by name, so two accounts quietly run by one person leave a trail; rule R11 flags a decision made by an account that a handler created, reset or promoted (except an admin deciding its own enrollment, which is normal); and sensitive actions on either account still need that account's own password. R11 itself is built and runs on every sweep ([Ghost detection engine](08-ghost-detection-engine.md) §9) |
| Probing the face matcher to learn who is enrolled | Insider | Answers never contain a score; every attempt is recorded; per-device rate limit (Phase 3) |
| A malicious package version | Supply chain | 1-day release age rule, install-script approval, lockfile, `pnpm audit`, reviewer review of dependency changes |
| Stealing a refresh token | Outsider | `HttpOnly` cookie, rotation with reuse detection, `SameSite=Strict`, `Origin` check |
| Guessing passwords or two-factor codes | Outsider | scrypt, per-email lockout with atomic counting, per-account two-factor lockout across fresh challenges, answers that never reveal whether an email has an account |
| Reading tables directly through Supabase | Outsider | Data API switched off, row-level security, no privileges for the Data API roles |
| Personal data leaking into logs | Insider or outsider with log access | Logging rules in `ProblemDetailsFilter` and `PrismaService`, tested in CI |
| A ghost kept on the payroll | Insider (ADMIN or HR) | All eleven detection rules run on a sweep and look for the shapes a ghost makes: never seen (R5), paid more hours than the shifts support (R3), punches or pay after the leaving date (R6), one worker at two sites at once (R4), and the rest. A sweep runs once a day on its own (below) instead of waiting for somebody to press a button. R11 is the one exception to how they are used: it asks whether an indirect link ties the decider to the worker, so its alerts are shown but never weigh on a worker's risk score (built, Phases 5 to 7; updated by issue #99). R3 has both of its controls: the sweep alert, and payroll's own refusal at submission — `refuseHoursNobodyWorked` in `payroll-approval.service.ts` — of a run that pays for hours nobody was present for, counted afresh from its own copy of the shared comparison (built, Phase 4) |
| Losing the database | Accident, a mistaken delete, or an outsider with database access | `db:backup` reads every table at one instant and writes one file; `db:restore` puts it back, and refuses a file that was cut short, a database that is not empty, and a different migration. Rehearsed end to end and written up with its numbers in [Backup and restore](../guides/11-backup-and-restore.md). **Open, and the honest position:** the hosted database is on Supabase's free plan, which has no scheduled backups and no point-in-time recovery, and nothing takes ours automatically yet — so today the loss is however old the last hand-made backup is |
| A stolen backup file | Whoever gets hold of the file | A backup is the whole company in one file: names, Ghana Card numbers, pay, bank details and the encrypted biometric templates. The templates stay encrypted in it, the rest does not. The script refuses to write anywhere inside the repository, so no careless `git add` can publish one, and it writes outside the project by default. **Accepted for version 1:** the file is not itself encrypted — it is treated like printed payslips, and where it is kept is a person's responsibility |
| Calling the daily sweep from outside | Anybody on the internet | The sweep route is deliberately open, because a shared secret in the hosting dashboard would protect nothing it could not already reach. What bounds it instead is the work: a company is swept at most once every 20 hours, the bookmark is rolled back if a company fails so nothing is skipped, and an instance that has just found nothing due answers from memory for a minute. So calling it a thousand times does a thousand cheap reads and no more work than calling it once ([Ghost detection engine](08-ghost-detection-engine.md)) |
| Reading or changing the deployment's secrets | Whoever can sign in to Vercel or Supabase | Those dashboards are the real keys to the system: the database password and `AUTH_SECRET` live there, and anyone who can edit them can read everything. The account sign-in and its two-factor are therefore part of the system's security, not outside it. TEST and production never share an `AUTH_SECRET` or a database (Phase 8), so a leak of one does not open the other |

## Phase exit gate (for every roadmap phase)

A phase is **done** only when all of these are true:

1. Its exit demo runs end to end.
2. The four review checklists pass on the phase's changes.
3. CI is green.
4. The documents in `docs/` still describe what was built.
5. Security findings are fixed, or accepted in writing with a reason.

Related: [Roadmap](07-roadmap.md) · [API contract](05-api-contract.md)
