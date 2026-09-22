# 01 · Vision and scope

## Problem

Security companies deploy guards across many client sites. Attendance is recorded by hand or not verified at all, so payrolls carry **ghost workers**, hours get inflated, and management cannot prove who stood which post. The result is direct financial loss.

## Vision

One system where **identity → presence → pay** is a single verified chain:

1. **Identity.** An employee exists only with a verified identity: biometrics enrolled, Ghana Card captured, and a duplicate check passed.
2. **Presence.** Attendance exists only as a biometric clock-in at a registered site and device.
3. **Pay.** Pay exists only as a calculated, locked payroll line backed by that attendance.

Break any link and the system flags it. That removes ghost workers by design, and the [ghost detection engine](08-ghost-detection-engine.md) catches whatever slips through.

## In scope (version 1)

- **Employee life cycle:** register, enroll biometrics, post to a site and shift, suspend, terminate.
- **Sites and rosters:** sites, posts, and shift patterns including 12-hour day and night rotations that cross midnight.
- **Biometric attendance** on company devices at each site: a face-recognition kiosk on any phone, tablet or laptop (confirmed by the device's own fingerprint sensor where it has one), and fingerprint terminals (ZKTeco) for production, which keep punches through an outage.
- **Attendance processing:** pair clock-ins and clock-outs, calculate hours, lateness and absence, and queue exceptions for a supervisor.
- **Payroll:** Ghana PAYE and SSNIT, overtime, allowances and deductions, locked payroll runs with maker–checker approval, and payslips.
- **Ghost detection:** a rules engine with a review queue and an audit trail.
- **Dashboard:** live attendance, rosters, payroll runs, detection alerts, and PDF or CSV reports.
- **Roles:** Admin, HR/Payroll Officer, Operations Supervisor, and Guard (who sees only their own records).

## Out of scope (version 1)

Say no politely to these.

- A mobile app. The kiosk is a web page on a company device, so guards need no app, and never clock in on their own phones.
- Multi-company SaaS. The database keys allow it later, but we do not build it now.
- Paying salaries through a bank or mobile money API. We export a bank file instead.
- Leave management beyond a simple absence or leave flag.
- GPS patrol tracking and guard-tour checkpoints. These are a version 2 upsell for the client.

## Success criteria

| For | Success looks like |
|---|---|
| Final year defense | A working end-to-end demo, plus a detection module with real, explainable algorithms |
| Client presentation | A 15-minute live demo: enroll a guard, clock in, run payroll, and catch a planted ghost |
| The team | A codebase clean enough that a third developer could start contributing within a day |

## Constraints and risks

- **Hardware is the slowest item.** Order or borrow a device in Phase 0, and build against mocks meanwhile ([Biometric integration](10-biometric-integration.md)).
- **Two developers, part-time,** with an academic deadline.
- **Unreliable internet at guard posts,** so offline clock-in and later sync are required, not optional.
- **Biometric data is sensitive personal data** under Ghana's Data Protection Act, 2012 (Act 843). See [Security and review gates](06-security-and-review-gates.md).

Related: [Stack decisions](02-stack-decisions.md) · [Roadmap](07-roadmap.md)
