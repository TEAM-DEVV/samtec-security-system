## What does this change?

<!-- One or two plain sentences. Name the roadmap phase, e.g. "Phase 1: employee list page". -->

## How can a reviewer test it?

<!-- Exact steps, e.g. "pnpm dev:web, open http://localhost:5173/employees, search for Mensah". -->

## Screenshots

<!-- Required for any screen change. Delete this section otherwise. -->

---

## Four-lens review

Tick every box that is true. If you cannot tick one, explain why under it.
Details: `docs/plan/06-security-and-review-gates.md`. In Claude Code, run `/lens-review` for an automated pass.

### 1. Architect: does it still fit the design?

- [ ] The code lives in the right app and module. No module writes to another module's tables.
- [ ] Any API change is in `packages/contracts/openapi.yaml` in this PR or an earlier one.
- [ ] No new tool or dependency without a line in `docs/plan/02-stack-decisions.md`.

### 2. Senior developer: is it built well?

- [ ] Types are strict (no `any`) and inputs are validated with Zod at the boundary.
- [ ] Tests are added or updated. Money logic is tested to the pesewa.
- [ ] Names state their units (`amountPesewas`, `clockedInAtUtc`).
- [ ] A database migration is included and its SQL was read (only if the schema changed). New tables enable row-level security.

### 3. Full-stack: does the seam hold?

- [ ] The dashboard uses the generated API client only (no hand-written `fetch`).
- [ ] Mock handlers match the contract.
- [ ] Every new screen has loading, empty and error states.
- [ ] Dates are stored in UTC and shown in Africa/Accra time.

### 4. Security analyst: what would I attack?

- [ ] Every new endpoint checks the user's role **and** whether they may see that specific record.
- [ ] No secrets, tokens, Ghana Card numbers, real names or biometric data in code, tests or logs. Log lines hold IDs and the `traceId` only.
- [ ] Responses include only the fields each role needs.
- [ ] New dependencies are well known and `pnpm audit` is clean.

## Final check

- [ ] `pnpm check` passes on my machine.
