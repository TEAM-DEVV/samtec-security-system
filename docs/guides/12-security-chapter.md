# 12 · The security chapter, drafted

The Phase 7 exit demo ([Roadmap](../plan/07-roadmap.md)): a draft of the
security chapter of the report, written from what was actually built and
measured rather than from what was planned. Every number here comes from a
run that happened; every gap is named.

Sources: the threat model in
[Security and review gates](../plan/06-security-and-review-gates.md), the
rules in [Ghost detection engine](../plan/08-ghost-detection-engine.md), the
drill in [Backup and restore](11-backup-and-restore.md).

## 1. What is being protected, and from whom

SAMTEC holds, for a Ghanaian security company: every guard's name, Ghana Card
number, phone number, pay, bank and mobile-money details, and an encrypted
copy of their face and fingerprint templates. It also decides who gets paid.

That makes two very different attackers, and the system is built for both:

- **The outsider** wants the data — a file of Ghana Card numbers and bank
  details is worth money.
- **The insider** wants the money. This is the one the project exists for.
  A ghost worker is an employee who does not exist, or who left, kept on the
  payroll by somebody inside the company. An insider has a password, a role,
  and time.

Most security writing is about the first. SAMTEC's own contribution is mostly
about the second, so that is where this chapter spends its words.

## 2. Nothing important takes one person

The rule the whole design turns on: **any action that could create money or
create an identity takes two different people.** Not two passwords — two
accounts, belonging to two people, and the system refuses to let one person
be both.

| What | Who may not be the second person |
|---|---|
| Approving a payroll run | Whoever calculated it (maker is not checker) |
| Creating, promoting, resetting or switching on an ADMIN account | Whoever asked for it, and the account itself |
| Registering a device or rotating its secret | Whoever issued the key |
| Letting a worker skip biometrics (an exemption) | Whoever recorded it |
| Deciding a duplicate-face review | Anybody who already acted on that worker |

Two things make this hold up under questioning.

**Each rule is enforced twice** — once in the service, and once as a database
CHECK constraint. The service can be bypassed by a bug or by somebody with
database access; the constraint cannot be bypassed by an ordinary connection
at all. `apps/api/test/payroll-rules.e2e-spec.ts` and
`apps/api/test/db.e2e-spec.ts` prove the database half by trying the forbidden
writes directly against a real PostgreSQL and expecting them to fail.

**The escapes were hunted, not assumed.** Four separate ways round the
two-administrator rule were found by review after it was built, and all four
are fixed and pinned by tests:

1. A brand-new administrator has no password, so asking "can another
   administrator sign in?" counted nobody — and one person could mint
   pre-confirmed accounts all afternoon.
2. An account still waiting kept whoever touched it last, so an innocent
   "their link expired, please resend it" handed the confirmation to somebody
   new and freed the creator to confirm their own account.
3. A device key's switch-on was decided from a read taken before the
   transaction, so firing a rotate and a switch-on together skipped the gate.
4. Switching the other administrator off — which deliberately needs nobody's
   approval — made the remaining one the "sole administrator" and handed them
   a second pre-confirmed account with its one-time link.

The honest remainder: a company with **genuinely one** administrator cannot be
asked for a second person, so the first account is confirmed on its own and
audited as `SOLE_ADMINISTRATOR`. That is a limitation, not an oversight, and
it is written in the threat model.

## 3. The device is not trusted

A terminal at a gate is in a car park, not a server room. The system treats
every message from one as a claim to be checked:

- Each device has its own secret, and every request is signed with it. An
  unsigned or wrongly signed request is refused.
- A signature is only good for five minutes, and every punch carries an id
  and a hash of its own contents, so a captured request cannot be replayed.
- A key works only on the routes for its kind of device: a kiosk key can
  never post raw punches.
- A new or rotated key is **born switched off**, and the person who issued it
  may not switch it on. The second administrator's job is to confirm the
  device is really at the site.
- A punch dated in the future is stored but never paired into paid hours. The
  allowance for a device whose clock runs fast is capped at five minutes,
  because the device is the one reporting its own drift — uncapped, a
  terminal could claim a nine-hour-fast clock and be paid for a shift that
  had not happened.

## 4. The record cannot be rewritten

Punches, work segments, payroll lines and audit entries refuse edits and
deletes at the database level, by trigger. A correction is a new row that
points at the old one, never a change to the old one. A locked payroll run
refuses every later change, including from the person who approved it.

This is what makes the audit log worth reading: it is not a log that a
careful attacker could tidy up afterwards.

One real defect found in review is worth reporting, because it is the kind a
reader should expect to see caught: the **backup script silently rewrote 52
audit rows**. An audit entry saved with no detail holds SQL NULL; the library
handed that back as plain `null`, and writing plain `null` stored the JSON
word "null" instead. Restoring from a backup therefore changed the one table
whose whole purpose is to be unchanged. It is fixed, and the drill below
re-ran against the fixed script.

## 5. Hunting the ghost

Eleven rules run on a sweep, once a day on their own. They look for the
shapes a ghost makes rather than for a ghost:

| | |
|---|---|
| R1 | A new face matches somebody already enrolled |
| R2 | A phone, bank account or mobile-money number shared by two employees |
| R3 | A payroll line pays more hours than the shifts support |
| R4 | One worker at two sites at once, repeatedly |
| R5 | Active for weeks with no punches at all — the classic ghost |
| R6 | Punches or pay after the leaving date |
| R7 | A worker, or a supervisor, leaning on the PIN fallback |
| R8 | Punch times with almost no variation — manufactured logs |
| R9 | A device's volume spikes, or its clock drifts |
| R10 | Punches whose device reference matches nobody |
| R11 | A two-person decision settled by somebody who should not have settled it |

Two design decisions are worth defending.

**R3 is meant to be two controls, not one.** The comparison lives in a shared
file that depends on nothing, so detection can raise an alert with it *and*
payroll can refuse to submit a run with it, without the two modules importing
each other. Only the alert exists today: payroll's run endpoints are Phase 4
and not built. This is stated rather than glossed over, because a reader who
checks will find one control where the design says two.

**One rule was built and then thrown away.** An extra clause for R11 would
have asked whether the "second administrator" on a decision was somebody
whose own account was created by the first. It works, and it is wrong: in a
company with two administrators the second account is *necessarily* made by
the first, so the clause fires on the very flow the direct rule forces.
Every honest decision would have raised a permanent HIGH alert. It was
rejected with that reasoning written down
([Ghost detection engine](../plan/08-ghost-detection-engine.md) §9). A rule
that cries wolf on correct behaviour is worse than no rule, because people
stop reading the queue.

## 6. The data itself

- **Biometric templates are encrypted**, each sealed to its own row, and no
  image is ever stored. A face template can be turned back into a rough face,
  so it is treated as sensitive data in its own right.
- **Consent is recorded** at enrollment, with the version and hash of the
  exact text shown; a worker may refuse or withdraw without losing pay, and a
  withdrawn face is wiped at once.
- **Answers never carry a score.** Probing the matcher to learn who is
  enrolled gets nothing back, and every attempt is recorded.
- **Nothing personal reaches a log.** The rule is enforced in the error filter
  and the database client, and tested in CI.
- **The hosted database's public API is switched off**, so the tables cannot
  be read from the internet at all; row-level security is on besides.

## 7. How it was tested

The claims above are not self-assessment. Each phase was read by four
independent reviews — an architect, a senior developer, a full-stack
developer and a security analyst — and then **every serious finding was given
to a sceptic whose job was to refute it**, so that plausible-sounding findings
that the code already prevented did not survive into the fix list.

The Phase 7 whole-system pass, across every module, the database, every screen
and the repository itself, produced **twenty confirmed findings, three of them
blockers**, all fixed. The three blockers were: the sole-administrator escape
above; the uncapped device clock; and rule R7 dying on every sweep the moment
any terminal sent an ordinary PIN fallback punch, which switched that rule off
silently while the screen still showed it on.

Measured, not estimated:

| | |
|---|---|
| Automated tests | 733 on the API, 344 on the dashboard, run on every push |
| Punch ingestion under load | 1,000 punches in about a second, each stored exactly once; sending the whole burst again changes nothing. At 5,000 with sixteen batches at a time it sheds load politely (`503` with `Retry-After`) and loses none |
| Backup and restore | 17,535 rows out, the database destroyed, rebuilt empty, put back; every count matched, and the whole API test suite passed against the restored copy |

## 8. What this system does not solve

A defence is stronger for saying this plainly.

- **Face liveness is version 1.** Scores are checked on the kiosk and again on
  the server, with a random head-turn challenge, but a good replayed video or
  a mask can still pass. A copied kiosk key can clock in a worker who has no
  fingerprint on that kiosk.
- **Nobody takes a backup automatically.** Restoring is proven; scheduling is
  not built. The hosted database is on a free plan with no scheduled backups
  and no point-in-time recovery, so today's real exposure is however old the
  last hand-made backup is.
- **R3 has one control where the design calls for two**, until payroll's run
  endpoints land.
- **A company with one administrator** cannot be held to the two-person rule.
- **The hosting accounts are part of the system.** Whoever can sign in to
  Vercel or Supabase can read the database password and the signing secret.
  No amount of application security changes that.
- **Statutory payments are still made by hand**, outside the system.

## 9. What a marker can check live

1. Create an ADMIN account and watch it refuse to sign in until a second
   administrator confirms it — then try to confirm it yourself.
2. Register a device, take the secret, and try to send a punch before anybody
   has switched the device on.
3. Send the same punch twice and watch the second be counted as a duplicate.
4. Edit a payroll line directly in the database and watch the trigger refuse.
5. Run the sweep and read the three planted ghosts out of the queue.
6. Run `pnpm --filter @samtec/api db:backup`, drop the database, restore it,
   and run the tests against what came back.

Related: [Security and review gates](../plan/06-security-and-review-gates.md) ·
[Backup and restore](11-backup-and-restore.md) ·
[Client presentation plan](../plan/11-client-presentation-plan.md)
