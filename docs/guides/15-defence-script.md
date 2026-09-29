# The defence script

**What this is.** The words and the clicks for Samuel's defence, start to
finish: what to say, what to show, in what order, with a way out if any step
misbehaves. The deep knowledge behind every line is in
[The defence pack](13-defence-pack.md) — this page is only the performance.

**How to use it.** Rehearse **aloud**, at least three times, with the real
system in front of you. Reading it silently is not rehearsal. Time yourself:
the talk is built for **fifteen minutes**, and a strict panel will cut you off,
not wait for you. When a step says SAY, the words are suggestions in plain
language — put them in your own voice, but keep them this simple. Never say a
word you cannot explain if interrupted; everything here is explained in the
pack.

**The one rule for the whole day:** when you do not know, say "I don't know,
but I know where it is written" — and name the document. That is a strong
answer. Guessing is the only losing move.

---

## Part 1 · The opening (2 minutes, no computer)

Stand still. No slides yet, no screen. This is the part you must know cold.

> **SAY:** "A security company in Ghana pays hundreds of guards every month.
> Nobody in the head office can see who actually stood at a gate last night.
> Two things follow from that. Ghost workers — a name on the payroll that no
> real person works for. And buddy punching — a real guard signing in for a
> friend who stayed home. Both are paid with real money, every month.
>
> My project stops this. A guard proves they are present with their **face**,
> on a company device at the site. That proof becomes a worked shift. The shift
> becomes pay, calculated to Ghana's PAYE and SSNIT rules. A second person must
> approve the pay, and then it is locked so nobody — not even an administrator
> — can quietly change it. And every night, eleven rules hunt through the data
> for pay without presence.
>
> In one sentence: **SAMTEC pays people from evidence, and keeps the
> evidence.**"

If you say nothing else well today, say this part well. Every question the
panel asks afterwards is really a question about this chain:

```
face at the gate → punch → worked shift → pay → second-person approval → locked
                                                  ↑ eleven rules watch it all
```

## Part 2 · How it is built (3 minutes, one diagram slide)

Show the architecture diagram (from [docs/plan/03](../plan/03-system-architecture.md)).

> **SAY:** "There are three apps and one database. The **API** is the brain —
> every rule lives there. The **dashboard** is what the office staff see. The
> **kiosk** is the phone at the gate — deliberately tiny, with nobody signed in
> on its everyday screen, because a phone on a wall is the least private
> computer in the company. They all speak to the API through one written
> contract, so the parts cannot drift apart.
>
> The database has **thirty-five tables in six modules**, and one rule keeps it
> clean: a module writes only to its own tables. Payroll never touches the
> attendance tables — it asks the attendance module. That is why I can reason
> about each part on its own.
>
> Three ideas run through everything. First: **evidence is never edited.**
> Punches, consent records, audit lines and locked pay runs are append-only in
> the database itself — a trigger rejects changes, so even an administrator
> cannot rewrite history. Second: **nobody important acts alone.** Approving
> pay, deciding a duplicate face, creating an administrator — each needs a
> second person, and the database checks it, not just the screen. Third: **a
> rule never punishes anybody.** Detection raises a question with evidence; a
> human answers it in writing, and the answer is audited."

Panel members hear hundreds of projects. "The database itself enforces it"
is what separates this one — return to that phrase whenever pressed.

## Part 3 · The live demo (7 minutes)

**Before the defence, without fail:** run through this once *that morning* on
the machine you will present with. Sign in beforehand so no password is typed
on stage. Have the fallback pictures ready (see Part 5).

### Step 1 — Enroll a guard (2 minutes) · the kiosk

Open the kiosk (`pnpm dev:kiosk` locally, pretend camera).

> **SAY:** "This is the kiosk — in production a phone mounted at the site. An
> administrator signs in, for fifteen minutes only, to put a new guard on the
> system. First, **consent**: the exact legal wording comes from the server,
> and the worker's answer is stored with the version and a fingerprint of that
> text, so we can always prove what they agreed to — that is the Data
> Protection Act. Then three face captures, each with a fresh head-turn so a
> photograph cannot enroll. No photo is ever stored: the face becomes 1,024
> numbers, encrypted before they reach the database."

**DO:** Admin → sign in → consent → Ghana Card digits → three captures →
"enrolled".

### Step 2 — Clock in, and watch it land (1 minute) · kiosk + dashboard

Kiosk on one half of the screen, the dashboard's **Live board** on the other.

> **SAY:** "Now the everyday moment. The guard walks up, turns their head the
> way the kiosk asks — left or right is random, so two printed photos don't
> work — and that is all they do."

**DO:** Start shift → head turn → the name appears → watch the Live board show
the clock-in within five seconds.

> **SAY:** "Notice what the kiosk never shows: a score, or who somebody almost
> matched. Anyone can stand in front of it, so every message must be safe to
> show a stranger. There is even a test that reads the whole screen and fails
> if a score ever appears."

### Step 3 — Pay the month (2½ minutes) · the dashboard

Use the seeded month. Payroll → the month → the run.

> **SAY:** "At month end, HR calculates the run. Every guard's confirmed hours
> become pay: basic pro-rated for days employed, overtime, SSNIT, then PAYE
> through the graduated bands. Money is always whole pesewas — never a decimal,
> because decimals lose money. And every input is copied onto the line, so this
> run can be re-checked years from now without reading anything else."

**DO:** open the run → show the lines → submit.

> **SAY:** "I prepared this run, so the system will not let *me* approve it.
> A different person must." **DO:** approve as the second account. "The moment
> it is approved it locks — the database refuses any change to the figures from
> now on — and the payslip PDF is written in the same transaction, so what was
> sent is exactly what exists." **DO:** open a payslip PDF, show the bank file.

### Step 4 — Catch the ghosts (1½ minutes) · Ghost detection

> **SAY:** "Finally, the reason the system exists. The seeded data has planted
> frauds in it. I press one button."

**DO:** Ghost detection → **Run the rules now** → open one alert.

> **SAY:** "An employee who is paid but never clocked in. The rule does not
> punish anyone — it raises this question, with the rows it looked at, and a
> human answers it in writing. The answer is audited. Eleven rules run like
> this every night on their own."

## Part 4 · Rigour and limits (2 minutes, back to slides)

> **SAY:** "How do I know it works? Almost twelve hundred automated checks run
> on every change — 752 on the API, 383 on the dashboard, 62 on the kiosk —
> including money calculated to the pesewa against payslips we worked by hand,
> and database rules proved against a real PostgreSQL. Every
> phase went through four reviews — architecture, code quality, full-stack and
> security — and each serious finding was handed to a sceptic told to refute
> it. The whole-system review found twenty real problems; three were serious;
> all twenty are fixed, each with a test.
>
> And I will name the limits myself. The browser's anti-spoofing stops a
> printed photo, not a good mask — production uses infrared terminals.
> A device fingerprint cannot say *whose* finger, so it is never used alone.
> Identical twins can defeat any face threshold — we measured it — so the
> answer is a second factor, not a bigger number. And the face-matching
> thresholds still need a pilot with real volunteers before a paying client.
> Every number I did quote comes from a run anyone can repeat with one
> command."

Naming your own limits before they do is worth more marks than any feature.
Every limit above has its numbers in [the threshold report](14-face-threshold-report.md)
and [the security chapter](12-security-chapter.md).

## Part 5 · If something breaks on stage

Nothing on this list is an emergency. Move calmly to the fallback and keep
talking; a recovered demo impresses more than a smooth one.

| If | Then |
|---|---|
| The kiosk misbehaves | "Let me show you the result instead" → the Live board already has seeded clock-ins; talk over those. |
| The dashboard won't load | The night-before screenshots (take them — every screen in Parts 3's steps). Say plainly: "the live system is deployed at samtec-test.vercel.app; here is what it shows." |
| Approval refuses | That IS the feature. Say: "the system is refusing because this account prepared the run — exactly what it is for", then use the second account. |
| Detection finds nothing | Open a previously resolved alert and walk its evidence instead. |
| A question stops you | "I don't know, but it is written in <the design doc / the security chapter / the decision list>." Name the paper. Never guess. |

## Part 6 · The night before — a checklist

- [ ] Rehearsed aloud, timed, three times.
- [ ] The demo machine: repository pulled, `pnpm check` green, database seeded,
      both accounts signed in, kiosk paired.
- [ ] **Two accounts that can act on payroll** (the maker and the checker) —
      confirmed working, passwords in your head, 2FA phones in the room.
- [ ] Screenshots of every demo screen, saved locally, in presentation order.
- [ ] Read Part 5 of [the defence pack](13-defence-pack.md) once more — the
      questions and short answers.
- [ ] The three bug stories ready to tell (the clock-drift cap, the R7 silent
      failure, the 2FA parallel-guess race) — a panel loves "here is a bug I
      found, and what it taught me".
- [ ] Slides exported and ALSO on a USB stick; the talk works with no slides at
      all if it must (Part 1 needs none).

## The one-page cheat sheet

If you memorise nothing else:

| They ask about… | The anchor sentence |
|---|---|
| The point of it all | "SAMTEC pays people from evidence, and keeps the evidence." |
| Data safety | "Templates, never photos; encrypted; consent recorded word-for-word; wiped 90 days after someone leaves." |
| Trust in the numbers | "Every important record is append-only in the database itself — history cannot be rewritten." |
| Fraud by insiders | "Nobody important acts alone: pay, faces, administrators and device keys all need a second person, checked by the database." |
| Accuracy | "Money is tested to the pesewa against payslips we calculated by hand." |
| Honesty | "I can name every limit, and each one is written down with its numbers." |
