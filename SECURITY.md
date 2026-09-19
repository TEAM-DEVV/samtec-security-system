# Security Policy

SAMTEC processes some of the most sensitive data a company holds: biometric
templates, Ghana Card numbers, phone numbers and payroll. Security is a core
feature of this product, not an afterthought.

## Reporting a vulnerability

**Do not open a public issue.** This repository is public.

Report it privately through GitHub:
[Report a vulnerability](https://github.com/TEAM-DEVV/samtec-security-system/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**). Only the maintainers
can see the report.

If that page is not available, ask a maintainer on GitHub for a private way to
send the details, without describing the problem in public:

- Francis (backend): GitHub [@AnnorFrancis](https://github.com/AnnorFrancis)
- Samuel (frontend): GitHub [@ALPHA-TEAM-dev](https://github.com/ALPHA-TEAM-dev)

Describe what you found, how to reproduce it, and the impact you expect.
We aim to acknowledge reports within three days.

## Rules for everyone working on this repository

1. **No real personal data in the repository.** Seed data, mocks, tests and
   screenshots use fictional people only. Never paste real employee records,
   Ghana Card numbers, phone numbers or payslips into code, issues or pull
   requests.
2. **No secrets in git.** Real values live only in `.env` files, which git
   ignores. `.env.example` files contain placeholders only. If a secret is ever
   committed, treat it as leaked: change it immediately, then clean the history.
3. **Biometric data is special.** Store templates, never fingerprint or face
   images. Encrypt them at rest. Never log them. Record the employee's consent
   at enrollment, because biometrics are sensitive personal data under Ghana's
   Data Protection Act, 2012 (Act 843).
4. **Least privilege everywhere.** Every endpoint checks the user's role and
   whether they may access that specific record. Approving payroll always needs
   a second person (maker–checker).
5. **Careful with dependencies.** pnpm refuses packages published less than a
   day ago, refuses versions whose publishing trust dropped (for example,
   signed provenance suddenly missing), and blocks install scripts that are not
   explicitly approved in `pnpm-workspace.yaml`. Never loosen these settings
   without a reviewed pull request. These rules already stopped one suspicious
   package version in Phase 0 (see the decision log in
   `docs/plan/02-stack-decisions.md`).
6. **Review through the security lens.** Every pull request completes the
   security checklist in the pull request template. `.github/CODEOWNERS` asks
   both developers to review sensitive files such as dependencies, CI and
   database migrations.
7. **Logs hold IDs, not people.** Never log request bodies, query strings,
   names, phone numbers, Ghana Card numbers or tokens. Log the `traceId` and
   record IDs instead.
8. **Seed data stays local.** `pnpm db:seed` refuses any database that is not
   on your own computer unless `ALLOW_REMOTE_SEED=yes` is set on purpose.

## Supported versions

The project is in active development. Only the `main` branch receives fixes.
