# The face-matcher threshold report

**What this is.** The five numbers the face matcher uses are called `ft-1`
(`apps/api/src/modules/attendance/face-thresholds.ts`). Every clock-in attempt
records the name of the set it was judged by, so a later change can never make
an old attempt look as if it were judged by the new numbers. This report says
what each number is, why it is where it is, and what would change if it moved.

**Its honest status, first, because everything else depends on it.** The pilot
with real volunteers has **not** happened. The numbers below come from a
**stand-in** set of faces, generated to a stated separation. They show how the
decisions move as the thresholds move — which is a real and checkable thing —
but they are **not a measurement of real faces**, and they cannot confirm `ft-1`
for production. Section 9 says exactly what they cannot show, and section 10 says
what the pilot must do. At a defence, say this before quoting any figure.

**The one result to remember.** Ordinary crowds are comfortable for `ft-1`, and
a crowd containing **near-twins is not**: two people scoring 0.75 against each
other, when the same person scores 0.78, defeat the thresholds — 5 clock-ins in
200 go to the wrong person, and no value of `match` or `lead` fixes it at an
acceptable cost. The answer is not a number. It is section 6.

Run it yourself:

```bash
pnpm --filter @samtec/api face:scores
```

---

## 1. The five numbers

| Number | `ft-1` | What it decides |
|---|---|---|
| `match` | 0.60 | A clock-in needs at least this score against an enrolled face. |
| `lead` | 0.05 | …and must beat the runner-up by this much, or the answer is "not sure". |
| `duplicate` | 0.50 | A new face this close to *another* record is held for a second administrator. |
| `frameAgreement` | 0.70 | The three frames of one capture must agree with each other. |
| `antiSpoofing` | 0.60 | How sure the kiosk must be that it is looking at a live face. |

A score is Human's own formula, copied to the server so the kiosk and the server
always agree on what "alike" means:

```
distance   = 25 × Σ(aᵢ − bᵢ)²
similarity = clamp((1 − √distance ÷ 100 − 0.2) ÷ 0.6, 0, 1)
```

1 means identical numbers, 0 means nothing alike. One useful fact falls out of
it: with 1,024 numbers per template, the whole score band lives between a
per-number difference of 0.125 (score 1) and 0.5 (score 0). Test vectors made up
outside that band all score 0 or 1, which has caught out more than one test.

**Why these numbers to begin with.** `match`, `lead` and `antiSpoofing` are the
Human library's own suggested working points; `duplicate` is deliberately looser
than `match`, and `frameAgreement` deliberately tighter, for the reasons in
sections 7 and 8. The pilot's job is to confirm or move them — not to invent them
from nothing.

## 2. How the measurement works

`apps/api/src/modules/attendance/face-score-study.ts` builds a study set and
scores it. Two rules keep the report honest:

- **It uses the shipped matcher.** Every score comes from `similarity()` in
  `face-match.ts` — the same function the kiosk flow uses. A report measured with
  its own private copy of the formula would prove nothing.
- **Its decision rule is pinned to the shipped one.** The report can ask "what if
  `match` were 0.65?", which the shipped `identifyFace` cannot, because that
  function reads the constants directly. So the rule is written once more, in
  `verdictFor`, and a test proves the two agree on every attempt at the `ft-1`
  numbers. A second test does the same for the duplicate check against
  `findDuplicateFace`. If they ever drift apart, the tests fail.

The study set is 40 people. Each has one enrolled face and five later captures,
so each capture is scored **1:N** against all 40 enrolled faces, exactly as a
real clock-in is: 200 attempts, 8,000 comparisons. A seeded random generator
makes every run repeatable, so two runs of the same command print the same
numbers and a reader can check them.

Three settings shape the stand-in, and all three are printed at the top of every
run:

- **`--spread`** — how widely capture quality and facial likeness vary. This is
  what makes the two score distributions overlap, which is the whole question.
- **`--lookalikes`** — how many pairs of people are placed deliberately close
  together, as real siblings and look-alikes are. Without them the stand-in
  cannot produce a near-miss at all: spread evenly over 1,024 numbers, a random
  stranger practically never beats your own enrolled face, so the lead rule
  would never be exercised and "nobody was matched to the wrong person" would be
  a fact about the generator, not about the thresholds.
- **`--lookalike-score`** — *how close* such a pair is. This turned out to be the
  setting that matters most (section 6).

**A caution about the three target scores.** `--same`, `--different` and the
frame score are targets, and only `--spread 0` hits them exactly. Above that they
come out a little low, and the different-person target lowest of all, because a
score is a square root of a distance: an even spread of distances gives a
lop-sided spread of scores, and the low tail is then cut off at the formula's
floor of 0. At `--spread 0.28` a different-person target of 0.30 measures about
0.19. **So every figure quoted below is what a run measured, never what it was
asked for**, and a test pins that gap at the two spreads this report uses.

## 3. A typical crowd

`pnpm --filter @samtec/api face:scores` — the default: same-person faces
targeted around 0.80, different people around 0.30, ordinary variation, two
look-alike pairs at 0.68.

```
                    count   lowest    5%   middle    95%  highest    mean
  same person         200     0.62    0.69    0.79    0.89    0.98    0.79
  other people       7800     0.00    0.10    0.24    0.40    0.77    0.25

  same person                                          .  :  |  #  #  :  .  .
  other people     .  .  :  #  #  #  |  :  .  .  .  .  .  .  .  .
                   0.0      0.2      0.4      0.6      0.8      1.0
```

The two humps are well apart, but their tails cross: the lowest same-person score
is 0.62 and the highest other-person score is 0.77 — that 0.77 is one of the
look-alike pairs. **There is therefore no single score that separates every
comparison correctly**, which is the honest starting point for choosing any
threshold. The line that gets the most comparisons right is 0.66, and it still
gets 9 of the 8,000 wrong.

`ft-1` sits at 0.60, below that best line, on purpose: a score just under the
line becomes "try again", and a guard tries again. A score just over it becomes
a payment.

**Clock-in, at `ft-1`:**

| Outcome | Attempts | What happens to the guard |
|---|---|---|
| matched, right person | 197 of 200 (98.5%) | paid |
| matched, **wrong** person | 0 of 200 | — the number that must be zero |
| not sure (the lead rule) | 3 of 200 (1.5%) | falls back, and the punch is flagged |
| not recognised | 0 of 200 | tries again, then falls back |

Nobody is ever turned away: after three failures a staff number plus a finger is
allowed, flagged as such and counted by the ghost rules. So a high "not sure"
rate costs patience; a single "wrong person" costs the whole idea.

## 4. A hard crowd

The same run with more variation and four look-alike pairs
(`--spread 0.28 --lookalikes 4`) — poor light, mixed phones, and more people who
resemble each other:

```
                    count   lowest    5%   middle    95%  highest    mean
  same person         200     0.54    0.62    0.78    0.92    0.99    0.78
  other people       7800     0.00    0.00    0.18    0.45    0.79    0.19
```

| Outcome | Attempts |
|---|---|
| matched, right person | 190 of 200 (95.0%) |
| matched, **wrong** person | 0 of 200 |
| not sure | 4 of 200 (2.0%) |
| not recognised | 6 of 200 (3.0%) |

Worse conditions send **10 clock-ins in 200** round for a second attempt, against
3 in the typical crowd. They still cost zero wrong payments — and section 5 shows
why.

## 5. What the lead rule is worth

This is the clearest result in the report, because it can be shown rather than
asserted. Holding `match` at 0.60 and moving only `lead`, on the hard crowd:

| `lead` | matched | **wrong person** | not sure |
|---|---|---|---|
| 0.00 | 190 | **4** | 0 |
| 0.02 | 190 | **4** | 0 |
| 0.05 (`ft-1`) | 190 | **0** | 4 |
| 0.10 | 175 | 0 | 19 |
| 0.15 | 167 | 0 | 27 |
| 0.20 | 150 | 0 | 44 |

**Without the lead rule, four of the two hundred clock-ins are matched to the
wrong person.** Each of those four is a look-alike who scored above 0.60 and
happened to edge out the right person. At 0.05 all four become "not sure", and
the guard tries again or falls back — flagged, and visible on the live board.

At 0.10 the rule starts costing honest guards: 19 attempts in 200 need a second
try, for no further gain. 0.05 is the point where the wrong answers have gone and
the cost has not yet started.

On the typical crowd the right person won every attempt even with no lead at all,
and the rule only turned 3 narrow wins into a second try. Both readings matter:
the rule is cheap when conditions are good and decisive when they are not.

**Moving `match` instead**, on the typical crowd:

| `match` | matched | wrong | not sure | not recognised |
|---|---|---|---|---|
| 0.50 | 197 | 0 | 3 | 0 |
| 0.55 | 197 | 0 | 3 | 0 |
| 0.60 (`ft-1`) | 197 | 0 | 3 | 0 |
| 0.65 | 196 | 0 | 3 | 1 |
| 0.70 | 180 | 0 | 2 | 18 |
| 0.80 | 81 | 0 | 1 | 118 |

Nothing at all changes between 0.50 and 0.60 — and the reason is worth being
precise about, because it is easy to tell a tidier story than the truth. It is
**not** that the lead rule is absorbing the difference. It is that in this run no
attempt's best score falls between 0.50 and 0.60 at all: the lowest is 0.62
(section 3), so raising the bar through that range crosses nothing. A different
crowd whose scores reached lower would behave differently. What the lead rule
*does* explain is why the `wrong` column stays at 0 across the whole table: that
rule works on the gap between the top two scores, which raising `match` does not
touch. From 0.65 upward, honest guards start being refused in numbers. **`match`
is a floor, not the real defence.**

## 6. Near-twins: where `ft-1` breaks

The sections above vary *how many* look-alikes there are. They do not vary *how
close* one can be — and that turns out to be the setting that matters. Two people
placed at 0.75, in a run whose same-person scores average 0.78
(`--spread 0.28 --lookalikes 4 --lookalike-score 0.75`), which is the identical-twin
case rather than the ordinary-siblings one:

| Outcome | Attempts |
|---|---|
| matched, right person | 175 of 200 (87.5%) |
| matched, **wrong person** | **5 of 200 (2.5%)** |
| not sure | 15 of 200 (7.5%) |
| not recognised | 5 of 200 (2.5%) |

**At `ft-1`, five clock-ins in two hundred are matched to the wrong person.** And
no setting of either number buys its way out:

| `lead` | matched | **wrong person** | not sure |
|---|---|---|---|
| 0.00 | 182 | **13** | 0 |
| 0.05 (`ft-1`) | 175 | **5** | 15 |
| 0.10 | 165 | **4** | 26 |
| 0.15 | 155 | 0 | 40 |
| 0.20 | 147 | 0 | 48 |

The lead rule still earns its place — it cuts 13 wrong matches to 5 — but it does
not close the gap. Closing it needs `lead` at 0.15, which sends **40 attempts in
200** round again: one guard in five failing at the gate, every shift. Raising
`match` does not help at all (5 wrong at 0.60, still 4 at 0.70, still 3 at 0.80,
by which point 114 of 200 honest guards are refused).

**So the honest conclusion is that thresholds cannot separate two nearly
identical faces, and no choice of the five numbers will.** That is a real
property of face recognition, not a defect in this build.

**What does work, and it is already built.** The enrollment check sees these
pairs. In the same run, `duplicate` at 0.50 holds 12 of 40 new enrollments
(30%) for a second administrator — and that 12 includes every one of the eight
people in the four near-twin pairs. So the system never meets a near-twin pair
without an administrator having looked at both records and decided they are two
different people. **That decision is exactly the right moment to require a second
factor for those two workers** — the fingerprint or the staff number the system
already supports — so that the face narrows it to two people and something else
settles which. Recorded as a recommendation in section 11.

## 7. Enrollment: catching a second enrollment

`duplicate` answers a different question: somebody **already enrolled** comes
back as a brand-new employee record. That is the ghost the whole system exists to
stop, and it is the one moment it can be caught cleanly.

The study measures both sides at once — every person's own second capture
enrolled as a new record (a ghost), and every person's enrollment checked against
everybody else (an honest stranger). On the typical crowd:

| `duplicate` | ghosts caught | honest starters wrongly queried |
|---|---|---|
| 0.40 | 40 of 40 (100%) | 23 of 40 (57.5%) |
| 0.45 | 40 of 40 (100%) | 10 of 40 (25.0%) |
| 0.50 (`ft-1`) | 40 of 40 (100%) | 7 of 40 (17.5%) |
| 0.55 | 40 of 40 (100%) | 4 of 40 (10.0%) |
| 0.60 | 40 of 40 (100%) | 4 of 40 (10.0%) |
| 0.65 | 39 of 40 (97.5%) | 2 of 40 (5.0%) |
| 0.70 | 34 of 40 (85.0%) | 0 of 40 (0%) |

Note where the catching starts to fail: **0.65, not 0.70.** The first ghost slips
through immediately above 0.60, so the plateau is narrower than a table sampled
every 0.10 would suggest. There is no comfortable margin above 0.60 to spend.

The two costs are not equal: a ghost that gets in is paid every month until
somebody notices, while a stranger wrongly queried costs a second administrator
one minute. That is the whole reason `duplicate` (0.50) is **looser** than a
clock-in (0.60): at enrollment we would rather ask a person than let a ghost
through.

**One finding worth acting on.** The false-query rate grows with the size of the
company, because each new face is compared with every existing one — the more
people on file, the likelier *somebody* resembles you. With look-alike pairs
switched off, so this is the crowd effect alone:

| People on file | Honest starters wrongly queried at 0.50 |
|---|---|
| 20 | 0% |
| 40 | 0% |
| 100 | 11% |
| 200 | 21.5% |

At two hundred people on file, about one new starter in five would go to the
duplicate queue — **in this stand-in**. Only the upward trend generalises to real
faces; the fraction itself depends on how real faces are actually spread, and
that is what the pilot measures. The trend is not an artifact, though: it is the
same arithmetic as the birthday problem, and it would happen with any set of
faces. Every ghost is still caught at 0.55 and 0.60, where this stand-in's rate
falls to 10%. Hence the recommendation in section 11.

## 8. The three frames of one capture

`frameAgreement` (0.70) catches one person starting a capture and another
finishing it. Frames are moments apart, so they should agree far more closely
than two captures on different days — in the study they sit around 0.89, and at
0.70 none of the 120 honest frame pairs is refused. It is a cheap check with
almost no cost to honest guards, which is why it is set tight.

`antiSpoofing` (0.60) is **not** measured here. It is the Human library's own
liveness and realness score, and it needs real photographs and real screens held
up to a real camera. The demo does test it — step 4 of the defence demo is a
printed photograph of a guard being refused — but that is one case, not a
measurement.

## 9. What this report cannot show

Say these plainly rather than being caught on them.

1. **These are not real faces.** No conclusion here is evidence about how the
   matcher treats real people, real light or real cameras. It is evidence about
   how the *decision logic* behaves as the numbers move. Where a fraction is
   quoted, only its direction generalises.
2. **The stand-in cannot invent a look-alike on its own.** Random differences
   spread over 1,024 numbers concentrate, so strangers never come close; every
   near-miss in this report exists because pairs were placed close together
   deliberately, at a closeness this report chose. Real faces have structure, and
   real crowds contain relatives. The pilot must go looking for exactly this.
3. **Nothing here says how the matcher behaves across skin tones, ages or
   between men and women.** Commercial face recognition is well documented to be
   less accurate for some groups than others, and a generated set cannot show it
   because its "faces" have no such properties at all. For a system built for
   Ghanaian security companies this is the most important untested question in
   this report, and the pilot in section 10 must be built to answer it. If
   accuracy turns out to differ by group, the fair answer is not a different
   threshold per person — it is the second factor of section 6, offered to
   whoever the face serves least well.
4. **`antiSpoofing` is untested by it** (section 8).
5. **Nothing here says how often a face fails to be found at all** — a guard in
   the dark, a camera that never gets a lock. That is a property of the camera
   and the kiosk app, not of these numbers, and it belongs in the kiosk's own
   testing.
6. **The fingerprint side is not in this report and cannot be.** A device
   fingerprint says "a registered finger on this device unlocked this key", never
   whose finger it was (`docs/plan/13-biometrics-design.md` section 4). There is
   no threshold to tune and no accuracy to measure — only the honest limit, which
   is already written into the design and the security chapter.

Two smaller honesty notes, so nobody has to find them: the percentiles are
nearest-rank rather than interpolated, and the "best single line" is searched at
steps of 0.01. Neither touches any threshold; both only describe.

## 10. What the pilot must do

1. **Ten or more consenting volunteers**, on the phones and in the light the
   sites really use — including at night, which is when guards work.
2. **A pool that looks like the workforce**, across skin tone, age and sex, and
   large enough that a difference between groups would show. This is point 3 of
   section 9, and it is the reason the pilot cannot be ten volunteers who all
   resemble each other.
3. **Several captures each, on different days**, so the same-person scores
   include a bad hair day and a dusty camera.
4. **Hunt the hard cases on purpose:** siblings, and twins above all. Section 6
   is the finding that matters most in this report, and it rests on a chosen
   number; the pilot's job is to find out what closeness real relatives actually
   reach. One real near-miss is worth a thousand easy comparisons.
5. Export the captures and run:

   ```bash
   pnpm --filter @samtec/api face:scores -- --from <export.json>
   ```

   The file is a list of `{ "person": "…", "frames": [[…1024 numbers…], …] }`,
   at least two captures per person. **It is biometric data:** keep it outside
   this repository, and delete it once the report is written. The script refuses
   captures from another model or the wrong number of numbers.
6. Replace sections 3 to 8 with the real numbers, and either keep `ft-1` or
   publish `ft-2`. Never edit `ft-1` in place — old attempts record the set they
   were judged by, and that promise is the point of naming them.

## 11. Verdict

**Keep `ft-1` as it stands for the demo and the TEST environment.** For ordinary
crowds the tuning tables put `match` 0.60 and `lead` 0.05 in a sensible place:
the wrong answers have gone and the cost to honest guards has not yet begun.
`duplicate` 0.50 catches every ghost this study could produce, and
`frameAgreement` 0.70 costs honest captures nothing.

Three things are owed before a paying client, in this order:

1. **Require a second factor for a pair the duplicate queue reported as two
   different people** (section 6). This is the only real answer to near-twins,
   and it is the one finding here that thresholds cannot substitute for. The
   parts already exist — the fingerprint, the staff number, the flag on the
   punch; what is missing is the rule that switches it on for those two workers
   when an administrator closes their collision as `DIFFERENT_PEOPLE`.
2. **The pilot** (section 10), which must answer both the twin question and the
   fairness question in section 9's point 3. Until it happens `ft-1` rests on the
   library's suggested working points and on the reasoning here — enough for a
   demo, not enough for real pay.
3. **`duplicate` should rise with headcount** (section 7). At two hundred people
   0.50 sends about one new starter in five to the duplicate queue in this
   stand-in, and 0.55 caught every ghost for less work. But note from the same
   table that the room above 0.60 is thin: the first ghost escapes at 0.65, so
   this is a small adjustment, not a free one.

And one improvement to the system itself, which this report is the argument for:
**move the five face numbers into the database**, as the eleven detection rules
already are, so a threshold can be tuned without a deploy — and so the next
version of these tables can be produced by moving them and running the study
again.

---

| Where to look | |
|---|---|
| The numbers themselves | `apps/api/src/modules/attendance/face-thresholds.ts` |
| The matcher | `apps/api/src/modules/attendance/face-match.ts` |
| This report's machinery, and its tests | `apps/api/src/modules/attendance/face-score-study.ts` |
| The script | `apps/api/scripts/face-scores.ts` |
| Every biometric rule, with its reason | [Biometrics design](../plan/13-biometrics-design.md) |
| The honest limits, for the write-up | [The security chapter](12-security-chapter.md) |
