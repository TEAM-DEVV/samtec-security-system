# SAMTEC: Biometric Attendance and Payroll System

> Final year project (Samuel Ansong) and a product for a potential client.
> Repository: https://github.com/TEAM-DEVV/samtec-security-system

## The one-line pitch

A biometric attendance and payroll platform for security companies that makes it impossible to pay a person who never stood a post: every cedi paid traces back to a verified biometric clock-in at a known site.

## Map of the plan

1. [Vision and scope](01-vision-and-scope.md): what we build, and what we refuse to build
2. [Stack decisions](02-stack-decisions.md): the tools we use, and why
3. [System architecture](03-system-architecture.md): layers, modules and data flow
4. [Data model](04-data-model.md): tables, keys and rules
5. [API contract](05-api-contract.md): endpoints and conventions
6. [Security and review gates](06-security-and-review-gates.md): the four review lenses and phase checklists
7. [Roadmap](07-roadmap.md): nine phases, each ending with a working demo
8. [Ghost detection engine](08-ghost-detection-engine.md): the rules that catch fraud
9. [Payroll engine (Ghana)](09-payroll-engine-ghana.md): PAYE, SSNIT and locked payroll runs
10. [Biometric integration](10-biometric-integration.md): hardware options and the provider interface
11. [Client presentation plan](11-client-presentation-plan.md): turning the project into a sale
12. [Attendance design](12-attendance-design.md): how a punch becomes paid-for hours (Phase 2)
13. [Biometrics design](13-biometrics-design.md): company kiosks, face and fingerprint clock-in, and ZKTeco (Phase 3)

New to the project? Read [How the system works](../guides/01-how-the-system-works.md) first.

## Where things are in the repository

| Folder | What lives there | Owner |
|---|---|---|
| `apps/web` | The dashboard (React) | Samuel |
| `apps/api` | The API (NestJS) and the database schema (Prisma) | Francis |
| `packages/contracts` | The API contract (`openapi.yaml`) and the types generated from it | Both |
| `docs` | This plan and the step-by-step guides | Both |
| `.claude` | Claude Code review lenses and shared settings | Both |
| `.github` | The CI pipeline and the pull request template | Both |

## Ground rules

These are not negotiable.

- **Contract first.** No endpoint is built or used before it exists in `packages/contracts/openapi.yaml`.
- **Every phase ends with a working demo.** If we stopped today, the last finished phase would still run.
- **Four lenses on every merge:** architect, senior developer, full-stack and security analyst. See [Security and review gates](06-security-and-review-gates.md).
- **Money is integer pesewas.** Approved payroll runs are locked forever. Biometrics are stored as encrypted templates, never images.
- **Mock hardware and mock data from day one.** The whole system must demo with no physical devices connected.

## Who does what

| Area | Owner |
|---|---|
| API, database, integrations, payroll, detection | Francis |
| Dashboard | Samuel |
| Clock-in kiosk app (`apps/kiosk`) and the ZKTeco gateway (`apps/gateway`), Phase 3 | Francis |
| API contract | Both: every change needs both approvals |
