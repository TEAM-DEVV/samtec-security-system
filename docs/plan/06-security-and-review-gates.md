# 06 · Security and review gates: the four lenses

The senior roles on this project (architect, senior developer, full-stack engineer, cybersecurity analyst) are **built into the process**, not left as advice. Every pull request and every phase exit is checked through all four lenses.

## Where the lenses live

| Place | What it does | When it runs |
|---|---|---|
| `.github/pull_request_template.md` | The four checklists appear in every pull request, for a person to tick | Every pull request |
| `.claude/agents/*-lens.md` | Four Claude Code reviewer agents, one per lens | On request |
| `.claude/skills/lens-review/` | The `/lens-review` command runs all four agents in parallel and combines their verdicts | Before opening or merging a pull request; `/lens-review phase` at a phase gate |
| `.github/workflows/ci.yml` | Automated checks that no one can forget: lint, contract, types, tests, build, migrations, audit | Every push to a pull request |

How to use them day to day: [Using Claude Code](../guides/07-using-claude-code.md).

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
- [ ] Maker–checker cannot be bypassed by calling the API directly, even if the dashboard hides the button.
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
| Secrets | `.env` git-ignored; `.env.example` placeholders only; Claude Code settings deny reading `.env` | **Phase 0** |
| Transport | HTTPS only, with HSTS, on the hosted demo | Phase 8 |
| Passwords | scrypt hashes (settings recorded per hash). 5 wrong passwords for one email lock it for 15 minutes with a `429`, whether or not the account exists, and a stand-in hash keeps the timing identical for unknown emails. The counter is one atomic SQL statement, so parallel guesses cannot slip past it, and the throttle table stores only keyed hashes (HMAC), never emails. | **Phase 1 (built)** |
| Two-factor authentication | TOTP required for ADMIN and HR_PAYROLL, set up at first sign-in. Challenge and setup tokens expire (5 and 10 minutes), work once and belong to one account; 5 wrong codes cancel a challenge; an accepted code cannot be used again. Wrong codes are **also counted per account**, so signing in again never grants fresh guesses — a leaked password cannot brute-force the 6-digit code. Authenticator secrets are stored AES-256-GCM-encrypted. A lost authenticator is reset by another ADMIN with **reset sign-in**, which clears the password too, so someone holding a stolen password cannot simply ask for "a new phone". Refresh also refuses an ADMIN or HR_PAYROLL account without two-factor, so a promotion can never skip it. | **Phase 1 (built)** |
| Two administrators | Creating, promoting, resetting or switching on an ADMIN account holds it (`AWAITING_CONFIRMATION`) until a different administrator confirms it; the service and a database CHECK both refuse the requester and the account itself. See "Two administrators" below | **Phase 7 (built)** |
| Accounts | Only ADMIN manages sign-in accounts. **Nobody ever sees another person's password:** a new or reset account gets a one-time link (72 hours, single use, stored as a SHA-256 hash, sent with `Cache-Control: no-store`) and the person chooses their own password (12–128 characters). An administrator can never change, switch off or reset their own account (only their name), and every change to an existing account first locks the administrator's and the target's rows and re-checks the administrator — so two admins switching each other off at the same instant can never leave the company with none. SUPERVISOR and GUARD accounts must be linked to an employee and office accounts never are (a database CHECK); terminating an employee switches their account off in the same transaction. Every account change is audited with field names only. The recovery path for a sole locked-out admin is `pnpm --filter @samtec/api account:admin`, which needs database access and is audited. | **Phase 1 (built)** |
| Sessions | 15-minute access tokens kept in memory only. A 7-day refresh cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`) rotates on every use with an atomic claim, so even two simultaneous replays cannot both mint sessions; a reused refresh token revokes all of that user's sessions; the database stores only token hashes. `Origin` is checked on refresh and logout, the only two endpoints that act on the cookie alone. Phase 3 also checks it on the sign-in steps, to tell a dashboard sign-in from a kiosk sign-in (`CORS_ORIGINS`, `KIOSK_ORIGINS`). Revocation on logout. **The access-token guard also checks the account on every request** (one lookup by ID), so switching an account off, changing its role or employee link, or resetting its sign-in takes effect on the very next request rather than when the token expires. A session that was simply ended (sign-out, admin action) answers `401` without the stolen-token alarm; only a token that was already swapped for a newer one raises it. Accepted risk: after a *self-service* password change, another device's access token lives out its remaining minutes (at most 15), though it can no longer refresh. | **Phase 1 (built)** |
| Object-level access | Every route needs a token unless marked public; roles checked per route; supervisors scoped to their sites, guards to themselves; hidden records answer 404. Proven by tests against a real database. | **Phase 1 (built)** |
| Rate limiting | Sign-in (built). Device ingest: 60 signed requests per device per minute, counted in one atomic SQL statement; a wrong signature is counted at most once a minute, so a stranger cannot lock a device out (built) | **Phases 1–2 (built)** |
| Devices | A 32-byte secret per device, shown once and stored encrypted (AES-256-GCM, its own key derived from `AUTH_SECRET`). Every request is signed with HMAC-SHA256 over a version, the timestamp, the route name and the raw body; timestamps older or newer than 5 minutes are refused; every failure answers the same `401`. Rotating a secret kills the old one at once. Punches are append-only (database trigger), unique per device and event ID, and a changed resend is refused and audited | **Phase 2 (built)** |
| Audit | Append-only audit log — a database trigger rejects every change and delete (built, recording sign-in events). Attendance exception resolutions are audited without their free-text note (built, Phase 2). Payroll approvals always audited | Phases 2–5 |
| Biometric data | Templates only, AES-256-GCM at rest, key outside the database, deleted on termination according to the retention policy | Phase 3 |
| Backups | Supabase daily backups plus a database dump before every payroll lock | Phase 4 |

## Two administrators (Phase 7)

Every biometric decision already takes two ADMIN accounts (Phase 3). That is
only as strong as the guarantee that two accounts are two people. This closes
the gap, and each decision below is settled — build to it.

**1. Four changes put an ADMIN account on hold:** creating one, promoting an
account to ADMIN, resetting an ADMIN's sign-in, and switching an ADMIN back
on. Until a second administrator confirms it, the account cannot be used at
all — sign-in, refresh and every request refuse it, password or no password.
The contract shows it as `AWAITING_CONFIRMATION`.

**2. Who may confirm:** any other usable ADMIN, through
`POST /users/{id}/confirm-admin`, audited. Never the administrator who made
the change, never the account itself. A database CHECK refuses both, whatever
the service does, so a repair script cannot quietly undo the rule.

**3. Changes that take power away need nobody else.** Demoting an ADMIN,
switching one off, or editing a name happen at once, as before — otherwise a
company could be stuck with an administrator it wants rid of.

**4. The one shortcut: a company gaining its first second administrator.**
While **no other administrator account exists**, *creating* or *promoting* an
administrator is confirmed on the spot and audited as
`adminConfirmation: SOLE_ADMINISTRATOR`. Without it a one-administrator
company could never get its second one except through the rescue script.

It asks whether another administrator **account** exists, not whether one
could sign in today. That distinction is the rule: a brand-new administrator
has no password yet, so counting only those who can sign in would have let
one person create a second pre-confirmed account, then a third, and so on,
with nobody else ever appearing.

It **never** applies to an account that is already an administrator.
Resetting one, or switching one back on, is exactly the move this rule
exists to catch: in a company of two, the other administrator is the one
being changed, so counting only the requester would wave through precisely
the case where one person ends up holding both accounts. In a company of two
those changes therefore wait for a third administrator who does not exist —
the honest escape is `pnpm --filter @samtec/api account:admin`, which needs
database access and is audited. A company with three administrators never
meets this.

**5. What is recorded:** who asked and when, who confirmed and when, on the
account itself. An ADMIN made directly in the database (the seed, the rescue
script) has no request recorded and does not wait — database access is a
stronger check than a second login. Administrators that existed before this
rule were recorded as confirmed when they were created, naming nobody.

**What it still does not stop, stated plainly.** A company with genuinely one
administrator has nobody to ask, so that person can give themselves a second
account. No rule can change that while only one person exists. What is
bounded is the rest: the shortcut fires only while no other administrator
account exists, so it cannot be used twice in a row, and every use is audited
as `SOLE_ADMINISTRATOR`. A determined sole administrator could still
switch off the account they just made and repeat, and each of those steps is
in the audit log under their name.

**Rule R11 does not cover this yet.** Ghost detection flags a two-person
*biometric* decision made by somebody with a hand in it, and knows nothing
about who created or confirmed an administrator account
([Ghost detection engine](08-ghost-detection-engine.md), "What version 1
leaves out", still accurate). Feeding these four columns to R11 is the next
Phase 7 change; until then this risk is watched by reading the audit log, not
by a rule.

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
| Editing payroll after approval | HR user | Locked runs, maker–checker, audit log, database trigger |
| A fake device sending punches | Outsider or insider | Per-device HMAC secret and device registry, clock-drift measurement (built, Phase 2); each signed route accepts only some device kinds, so a kiosk key never posts raw punches (built, Phase 3); volume anomaly detection (Phase 5); registering a device or rotating its secret needs a second ADMIN (Phase 7) |
| Stealing biometric templates | Outsider | Encryption at rest, bound to each row; no images stored; templates never leave the server or reach a log. Face templates can be turned back into a rough face, so they are treated as sensitive data (Phase 3) |
| Replaying captured punches | Network attacker | Idempotency key and payload hash, plus a signed timestamp that expires after 5 minutes (built, Phase 2) |
| Holding a photo up to the face kiosk | Guard | Anti-spoofing and liveness scores, checked on the kiosk and again on the server, plus a random head-turn challenge; documented as a version 1 limitation, because a replayed video or a mask can still pass (Phase 3) |
| A stolen kiosk, or a copied kiosk key | Outsider or insider | The key works only on `/kiosk` routes, never for raw punches; enrollment also needs an ADMIN's token with two-factor, and a kiosk sign-in gets no refresh cookie and a kiosk-only token; attempts record their network address for Phase 5; the ADMIN rotates the secret. **Accepted for version 1:** the kiosk measures its own face scores, so a copied key can clock in a worker who has no fingerprint key on that kiosk, and make flagged co-signed punches for anyone posted to that site (Phase 3) |
| One insider activating a ghost without a face | Insider (ADMIN) | Every exemption takes two ADMIN accounts (a withdrawal, recorded by an ADMIN, only files one), and every collision decision needs a second ADMIN who did not act on the worker; hours of a worker waiting for that decision are paid only after it; one open question at a time; a revoke cannot wipe away an open review; withdrawing never activates anyone; a record blocked as a duplicate can only be terminated; rule R11 flags decisions with indirect links (Phases 3 and 5) |
| One person using two ADMIN accounts | Insider (ADMIN) | Creating, promoting, resetting or switching on an ADMIN account leaves it unusable until a **second** administrator confirms it, refused to the requester and the account itself by the service and by a database CHECK; a waiting account keeps the name of whoever put it there, so an innocent "please resend their link" cannot hand the confirmation to somebody new ("Two administrators", built, Phase 7); audited user changes. What remains: a company with genuinely one administrator, audited as `SOLE_ADMINISTRATOR`. Teaching rule R11 to read these columns is the next Phase 7 change |
| Probing the face matcher to learn who is enrolled | Insider | Answers never contain a score; every attempt is recorded; per-device rate limit (Phase 3) |
| A malicious package version | Supply chain | 1-day release age rule, install-script approval, lockfile, `pnpm audit`, code owner review of dependency changes |
| Stealing a refresh token | Outsider | `HttpOnly` cookie, rotation with reuse detection, `SameSite=Strict`, `Origin` check |
| Guessing passwords or two-factor codes | Outsider | scrypt, per-email lockout with atomic counting, per-account two-factor lockout across fresh challenges, answers that never reveal whether an email has an account |
| Reading tables directly through Supabase | Outsider | Data API switched off, row-level security, no privileges for the Data API roles |
| Personal data leaking into logs | Insider or outsider with log access | Logging rules in `ProblemDetailsFilter` and `PrismaService`, tested in CI |

## Phase exit gate (for every roadmap phase)

A phase is **done** only when all of these are true:

1. Its exit demo runs end to end.
2. The four checklists pass on the phase's changes (`/lens-review phase`).
3. CI is green.
4. The documents in `docs/` still describe what was built.
5. Security findings are fixed, or accepted in writing with a reason.

Related: [Roadmap](07-roadmap.md) · [API contract](05-api-contract.md)
