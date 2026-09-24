# detection module (Phase 5)

**Purpose:** find ghost workers and fraud patterns that slip past the other safeguards.

**Owns these tables:** `detection_rules`, `detection_alerts`, `detection_checks`.

Every rule, with its reason and its numbers, is in
[docs/plan/08-ghost-detection-engine.md](../../../../../docs/plan/08-ghost-detection-engine.md). Read it first.

## Files

| File | What it does |
|---|---|
| `detection-rules.ts` | The catalogue, and the rules themselves as **pure functions**: rows in, findings out. No database, no clock of its own. |
| `detection-rules.spec.ts` | One test per rule, including a threshold being moved and the finding changing with it — which is how the report's tuning table is built. |
| `detection.service.ts` | The plumbing: fetch what each rule needs through the other modules' services, run it, write what it found. |
| `detection.controller.ts` | `/api/v1/detection/*`. ADMIN and HR_PAYROLL only. |
| `detection.schemas.ts` | Every input, as a Zod rule. |

## Rules that must hold

- **A rule never acts on anybody.** It raises a question with the rows it
  looked at; an ADMIN or HR answers it, in writing, and the answer is
  audited. `CONFIRMED_FRAUD` is this company's record of what it found, never
  something the system did to a worker.
- **Imports point one way: detection → attendance → workforce → identity, and
  nothing imports detection.** That is why rule R3 — which blocks a payroll
  submission — is enforced inside payroll, from data payroll already has,
  instead of by a call back into here (docs/plan/08 §1). Detection raises the
  alert for the queue separately, from the same shared pure function.
- **Detection reads no other module's tables.** The questions it needs to ask
  about punches and the exception queue live in
  `attendance/attendance-facts.service.ts`, in the module that owns the
  answers. Each one is a counting question, never a dump of rows.
- **A sweep is repeatable.** Every finding carries a `dedupeKey` built from
  its rule, its subject and its window, and a unique index means a finding
  already raised is not raised twice — and one a person resolved is never
  reopened. Press the button twice and nothing happens.
- **One broken rule never stops the other ten.** A rule that throws is logged
  by its code and skipped, and the answer says which rules were skipped.
- **A rule that is not built yet is never silently "clean".** The catalogue
  marks it, the rules list says "not built yet", and a sweep reports it as
  skipped rather than run.
- **What a rule found is never rewritten.** A database trigger refuses any
  change to the rule, the window, the evidence or the key, refuses a second
  decision on a decided alert, and refuses DELETE and TRUNCATE outright.
- **Never a face, a template or a Ghana Card number in evidence.** Evidence
  names rows and counts: punch IDs, segment IDs, how many, how often.
- **A supervisor never sees this queue.** A supervisor is themselves a
  subject of rule R7, so it would show them their own file.

## Built so far

R1 (duplicate enrollment), R2 (identity collision, the phone for now), R3
(paid without presence), R4 (bilocation), R5 (never seen), R6 (terminated but
active), R7 (fallback abuse, counted for the worker **and** for the supervisor
doing the letting in), R8 (robot regularity), R9 (device anomaly, against a
device's own history), R10 (orphan punches) and R11 (a two-person decision
settled by somebody with a hand in it).

**All eleven.** Nothing in the catalogue is switched off any more, so a quiet
queue really is a quiet queue.

R3 and R6 are the two that read payroll, through
[`PayrollFactsService`](../payroll/payroll-facts.service.ts) — minutes and
identifiers, never money. R3 does **not** trust the `punchedMinutes` written
on the line it is judging: it counts the confirmed shifts again from the
attendance tables, which is the only way it can see a line that was edited or
a shift that was voided after the money went out. The comparison itself is
[`paidBeyondPresence`](../../common/paid-beyond-presence.ts), in `common` and
not here, so payroll can refuse a run at submission with the same arithmetic
without importing detection.

R11 reads two ways at once, so it is worth being plain about both.

The **direct** links are refused outright when the decision is made: a
database CHECK stops an ADMIN deciding the review of a face they enrolled
themselves, and the service stops anybody who wiped a face for either worker
or recorded their withdrawal. A finding pointing at one of those is about
**this system** — a migration or a repair script that went round the rules —
and not about a worker.

The **indirect** link is allowed on purpose and is expected to show up. An
ADMIN who enrolled the *other* worker's face may still decide the review,
because refusing that would deadlock a company with two ADMINs
([docs/plan/13-biometrics-design.md](../../../../../docs/plan/13-biometrics-design.md),
§2 decision 13). Those decisions are flagged, not blocked, and putting them in
front of the payroll checker is the whole job of this rule.

Either way the alert is about who signed the form, never about the worker
named on it. A hand the decision itself made — the losing record wiped in the
same transaction that settled it — is not counted, or every by-the-book
resolution would report itself.
