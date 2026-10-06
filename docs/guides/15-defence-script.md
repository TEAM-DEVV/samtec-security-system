# The defence script

**What this is.** The words and the clicks for Samuel's defence, start to
finish. The panel gives undergraduates about **five minutes**, so this is a
pitch, not a lecture: the problem in one sentence, the aim in one sentence,
straight to what was built, then a conclusion. The deep knowledge behind every
line is in [The defence pack](13-defence-pack.md); this page is only the
performance.

**How to use it.** Rehearse **aloud**, at least three times, with a timer. Five
minutes is shorter than it feels: a strict panel will cut you off, not wait
for you. When a step says SAY, the words are suggestions in plain language.
Put them in your own voice, but keep them this simple, and never say a word
you cannot explain if interrupted; everything here is explained in the pack.

**The slides.** [SAMTEC-defence-slides.pptx](SAMTEC-defence-slides.pptx) is
the deck for this script: ten slides in the same order as the steps below,
with the SAY text of each step in the speaker notes. Open it in PowerPoint,
press F5, and follow the script.

**The one rule for the whole day:** when you do not know, say "I don't know,
but I know where it is written", and name the document. That is a strong
answer. Guessing is the only losing move.

---

## The five minutes

| Step | Slide | Time |
|---|---|---|
| 1. The research problem | 2 | 20 seconds |
| 2. The research aim | 3 | 15 seconds |
| 3. What we have done | 4 to 8 | 3 minutes 30 seconds |
| 4. Conclusion | 9 | 40 seconds |

Slide 1 is the title: say your names and the project name while it is up,
nothing more. Slide 10 is "Questions".

### Step 1 · The research problem (slide 2, one sentence)

> **SAY:** "Security companies in Ghana pay for guards who never stood at
> their posts, because attendance is a paper book and payroll is a spreadsheet
> that simply trusts it."

Then, only if you have breath to spare: "That is ghost workers, buddy
punching, and invoices nobody can prove." Do not explain further. Move on.

### Step 2 · The research aim (slide 3, one sentence)

> **SAY:** "Our aim was to build a system in which a guard is paid only for
> the shifts their own face or fingerprint proved, and every cedi can be traced
> back to that proof."

### Step 3 · What we have done (slides 4 to 8)

**Slide 4, what we built (45 seconds).**

> **SAY:** "We built three things that work as one. A **kiosk**: a phone on the
> wall at each site that recognises the face, asks for a head turn a photo
> cannot make, and can read a fingerprint. A **dashboard**, where HR and the
> administrator manage workers and sites, watch attendance as it happens, run
> payroll and answer alerts. And one **API with a database** that enforces the
> rules itself. The chain is: enrol, clock in, shifts verified, payroll
> calculated, paid with proof. All three are live on our test system."

**Slide 5, proving presence (45 seconds).**

> **SAY:** "At the gate, the face becomes 512 numbers; no photo is kept. The
> kiosk asks for a live head turn, left or right at random, so a printed photo
> fails. It compares only with the workers posted to that site and needs a
> clear win: a face nobody enrolled is refused, even on the same phone. In our
> photo lab the most stranger-like pair scored 0.21 and the same person about
> 0.90, so the threshold at 0.40 has room on both sides."

**Slide 6, paying from proof (45 seconds).**

> **SAY:** "Payroll starts from those verified shifts. Ghana's rules are applied
> by the system, never typed: basic pay pro-rated, overtime from counted
> minutes, SSNIT, PAYE through the graduated bands, all in whole pesewas.
> Approving the run needs the administrator's own password, then the run locks
> and the database refuses any change. Out come a payslip for every worker, the
> bank file the company's bank pays from, a payment receipt for the company,
> and a client invoice per site and month."

**Slide 7, catching ghosts and keeping it safe (40 seconds).**

> **SAY:** "Every night, eleven rules hunt for pay without presence: paid but
> never seen, one person in two places, a device behaving oddly. A rule never
> punishes anybody. It raises a question with its evidence, a person answers in
> writing, and the answer is audited. Underneath, evidence is append-only in
> the database itself, each kiosk signs what it sends, and biometric data is
> consented, encrypted and deleted ninety days after a worker leaves."

**Slide 8, where it stands (35 seconds).**

> **SAY:** "How do we know it works? Almost seventeen hundred automated checks
> run on every change: 1,004 on the API, 483 on the dashboard, 170 on the
> kiosk, 35 on the gateway, including money calculated to the pesewa against
> payslips we worked by hand, and database rules proved on a real PostgreSQL.
> We measured the first face model, found it wanting, and replaced it. The
> whole system runs on our shared test environment today."

### Step 4 · Conclusion (slide 9)

> **SAY:** "In one sentence: SAMTEC pays people from evidence, and keeps the
> evidence. We built it, we proved it, and we made the hard decisions
> deliberately: the company's kiosk rather than the guard's phone, one
> administrator with a password step rather than a second approver, and
> records that are never edited. Its limit is honest: the face threshold still
> needs a pilot with real volunteers before a paying client. Thank you."

Stop talking. Slide 10 is up; wait for questions.

---

## If the panel gives you more time: the live demo

Only if invited. Do these in order and stop when they stop you; each step
stands alone. Sign in beforehand so no password is typed on stage, and have
the screenshots from the checklist ready.

1. **Clock in** (kiosk and the dashboard's Live board side by side): Start
   shift, turn your head, the name appears, the Live board shows the clock-in
   within seconds. Say: "The kiosk never shows a score or who somebody almost
   matched; anyone can stand in front of it."
2. **Pay the month** (Payroll, the seeded month): open the run, show the
   lines, approve. The password dialog appears: "it asks for my password
   because approving pay is sensitive." The run locks; open a payslip PDF and
   the bank file.
3. **Catch the ghosts** (Ghost detection): press **Run the rules now**, open
   one alert. "A worker paid but never clocked in. The rule raises the
   question with its rows; a person answers in writing."

## If something breaks on stage

Nothing on this list is an emergency. Move calmly to the fallback and keep
talking; a recovered demo impresses more than a smooth one.

| If | Then |
|---|---|
| The kiosk misbehaves | "Let me show you the result instead": the Live board already has seeded clock-ins; talk over those. |
| The dashboard will not load | The night-before screenshots. Say plainly: "the live system is deployed at samtec-test.vercel.app; here is what it shows." |
| Approval refuses (`PASSWORD_CONFIRMATION_REQUIRED`) | That IS the feature. Say: "it wants me to confirm my password before it lets me approve pay", type it into the dialog and continue. |
| Detection finds nothing | Open a previously resolved alert and walk its evidence instead. |
| A question stops you | "I don't know, but it is written in the design doc / the security chapter / the decision list." Name the paper. Never guess. |

## The night before

- [ ] Rehearsed aloud, timed, three times, under five minutes each time.
- [ ] The demo machine: repository pulled, `pnpm check` green, database seeded,
      both accounts signed in, kiosk paired.
- [ ] **Payroll approval works with one account**: submitting, approving behind
      the password dialog, and marking paid all succeed for the administrator
      who prepared the run; password and 2FA phone ready in the room.
- [ ] Screenshots of every demo screen, saved locally, in presentation order.
- [ ] Read Part 5 of [the defence pack](13-defence-pack.md) once more: the
      questions and short answers.
- [ ] The three bug stories ready to tell (the clock-drift cap, the R7 silent
      failure, the 2FA parallel-guess race): a panel loves "here is a bug I
      found, and what it taught me".
- [ ] Slides exported and ALSO on a USB stick; the talk works with no slides at
      all if it must.

## The one-page cheat sheet

If you memorise nothing else:

| They ask about… | The anchor sentence |
|---|---|
| The point of it all | "SAMTEC pays people from evidence, and keeps the evidence." |
| Data safety | "Templates, never photos; encrypted; consent recorded word-for-word; wiped 90 days after someone leaves." |
| Trust in the numbers | "Every important record is append-only in the database itself; history cannot be rewritten." |
| Fraud by insiders | "Any admin can act, but sensitive actions need their password, everything is in the audit log, and ghost detection still flags suspicious patterns." |
| Accuracy | "Money is tested to the pesewa against payslips we calculated by hand." |
| Honesty | "I can name every limit, and each one is written down with its numbers." |
