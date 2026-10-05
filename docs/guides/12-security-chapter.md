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

## 2. One administrator, with a password

Until issue #99 closed on 1 October 2026, the rule the whole design turned on
was that **any action that could create money or create an identity took two
different people.** That rule is gone: a company with only one or two
administrators kept finding itself deadlocked, or simply slowed down, by a
safeguard built for a bigger team. The rule now is that **any ADMIN can act
alone**, and a sensitive action instead asks that administrator to confirm
their own password, is always written to the audit log, and stays inside the
reach of ghost detection.

| What | Used to need a second person | Now needs |
|---|---|---|
| Approving a payroll run | Whoever calculated it (maker is not checker) | The administrator's password |
| Creating, promoting, resetting or switching on an ADMIN account | Whoever asked for it, and the account itself | The administrator's password |
| Registering a device or rotating its secret, or switching one on | Whoever issued the key | The administrator's password |
| Letting a worker skip biometrics (an exemption) | Whoever recorded it | The administrator's password (the same administrator may ask and approve) |
| Deciding a duplicate-face review | Anybody who already acted on that worker | The administrator's password (including the one who enrolled the face) |

**The new safeguard is enforced once, globally, not per route.**
`PasswordConfirmationGuard` runs on every request, fourth after the sign-in
wall, the kiosk limit and the role check, so a sensitive route cannot
quietly forget to ask for a password the way a hand-written check in each
handler could. An end-to-end test checks that the contract's list of
sensitive routes (`x-needs-password: true`) and the guard's own list are the
same one. There is no database CHECK behind it — no row a constraint could
inspect to prove a password was just typed — so the backstop is the audit log
instead: `auth.password_confirmed` and the action it protected are both
written there, and ghost detection keeps watching for the patterns a stolen
session would leave.

**What the old rule cost, and why it was removed.** The rule above used to be
a literal second account: creating, promoting, resetting or switching on an
ADMIN waited for a different administrator to confirm it, and a device key's
issuer could not switch it on either. Both were enforced twice — once in the
service, once as a database CHECK — and a Phase 7 review hunted down four
separate ways round them before the rule shipped: a brand-new administrator
with no password yet could mint pre-confirmed accounts all afternoon if
"another administrator" was counted by who could sign in; an account still
waiting kept whoever touched it last, so "please resend their link" could
quietly hand the confirmation to somebody new; a device's switch-on read its
gate from before the transaction, so a rotate and a switch-on fired together
skipped it; and switching the *other* administrator off — which deliberately
needed nobody's approval — could mint the remaining admin a second
pre-confirmed account. All four were fixed and pinned by tests. But the rule
still asked a company with one or two administrators for a person who often
did not exist, and the one-administrator company already had its own named
exception (`SOLE_ADMINISTRATOR`, audited). The owner closed issue #99 and
removed the second-person requirement everywhere, in favour of the password
step above.

## 3. The device is not trusted

A terminal at a gate is in a car park, not a server room. The system treats
every message from one as a claim to be checked:

- Each device has its own secret, and every request is signed with it. An
  unsigned or wrongly signed request is refused.
- A signature is only good for five minutes, and every punch carries an id
  and a hash of its own contents, so a captured request cannot be replayed.
- A key works only on the routes for its kind of device: a kiosk key can
  never post raw punches.
- A new or rotated key is **born switched off**. Switching it on is a
  separate, password-confirmed step on the dashboard — any administrator may
  take it, including whoever issued the key — once they have checked the
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
| R11 | A duplicate-face or exemption decision settled by somebody with an indirect link to the worker |

Two design decisions are worth defending.

**R3 is two controls, not one.** The comparison lives in a shared file that
depends on nothing, so detection raises an alert with it on the nightly
sweep, and payroll independently refuses to submit a run with it —
`refuseHoursNobodyWorked` in `payroll-approval.service.ts` counts presence
afresh rather than trusting the line it is judging — without the two modules
importing each other.

**One rule was built, then thrown away — twice.** An early extra clause for
R11 would have asked whether the "second administrator" on a decision was
somebody whose own account was created by the first. It worked, and it was
wrong: in a company with two administrators the second account was
*necessarily* made by the first, so the clause fired on the very flow the
direct rule forced. Every honest decision would have raised a permanent HIGH
alert. It was rejected with that reasoning written down
([Ghost detection engine](../plan/08-ghost-detection-engine.md) §9). A rule
that cries wolf on correct behaviour is worse than no rule, because people
stop reading the queue. When issue #99 removed the second-person rule itself
(1 October 2026), R11 was simplified the same way: it no longer flags the
administrator who enrolled a face deciding that face's own review, because
that is normal now. The rest of R11 stands — a decision by somebody whose
own face was wiped still gets flagged.

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
- **A company with one administrator has nobody to double-check a
  password-confirmed action.** The audit log and ghost detection stand in
  for a second person now, not another account.
- **The hosting accounts are part of the system.** Whoever can sign in to
  Vercel or Supabase can read the database password and the signing secret.
  No amount of application security changes that.
- **Statutory payments are still made by hand**, outside the system.

## 9. What a marker can check live

1. Try a sensitive action — such as approving payroll or revoking a face —
   without confirming your password first, and watch it refuse with
   `PASSWORD_CONFIRMATION_REQUIRED`; then confirm your password and watch the
   dialog finish the action for you.
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
