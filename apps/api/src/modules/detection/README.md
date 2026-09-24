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

R1 (duplicate enrollment), R2 (identity collision, the phone for now), R4
(bilocation), R5 (never seen), R7 (fallback abuse, counted for the worker
**and** for the supervisor doing the letting in) and R10 (orphan punches).

R8, R9 and R11 are in the catalogue, switched off and reported as skipped,
and land with their own tests. R3 and R6 wait for payroll.
