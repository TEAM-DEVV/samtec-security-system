# How the system works

This guide explains SAMTEC in plain English. No coding knowledge is needed. Read it before anything else, and come back to it before your defense.

## The problem, as a story

A security company in Accra pays 300 guards every month. One supervisor adds his cousin to the payroll. The cousin never works a single shift, but a salary is paid every month. Another guard leaves the company, yet his salary keeps going to an account that someone else controls. A third guard asks a friend to sign the attendance book for him while he works a second job.

None of this is visible, because attendance is a paper book and payroll is a spreadsheet. These fake or absent employees are called **ghost workers**, and they cost companies a lot of money.

## What SAMTEC does

SAMTEC links three things into one chain that is hard to fake:

1. **Identity.** Every employee is registered with their Ghana Card and their fingerprint or face. The system refuses a second record for the same fingerprint or Ghana Card.
2. **Presence.** Guards clock in and out with their fingerprint or face on a device at the client site. A signature in a book is no longer enough.
3. **Pay.** Salaries are calculated only from those verified clock-ins, and a second person must approve every payroll before it is locked.

If one link is missing (a salary with no clock-ins, or one fingerprint under two names) the system raises an alert for a manager to review.

## The parts of the system

A restaurant is a helpful comparison.

| Part | In the restaurant | In SAMTEC | Where it lives |
|---|---|---|---|
| **Dashboard** (frontend) | The dining room, where customers see the menu and receive food | The website managers use to see employees, attendance and payroll | `apps/web` |
| **API** (backend) | The kitchen, where the real work happens and the rules are followed | The program that checks permissions, applies business rules and saves data | `apps/api` |
| **Database** | The storeroom and the account books | PostgreSQL, where every employee, site and clock-in is recorded | Managed from `apps/api/prisma` |
| **API contract** | The menu: what can be ordered, and exactly what arrives | `openapi.yaml`, the agreed list of requests and responses | `packages/contracts` |
| **Biometric devices** | The staff entrance with a key card reader | Fingerprint terminals and face-recognition tablets at client sites | Connected in Phases 2 and 3 |

The dashboard never touches the database directly. It always asks the API, the same way a customer never walks into the storeroom. This keeps the rules in one place, the kitchen, where nobody can skip them.

## The journey of one click

Here is what happens when a manager opens the **Employees** page:

1. The browser shows the dashboard page.
2. The page asks the API for the list: `GET /api/v1/employees`.
3. The API checks the request: is it from an allowed website, and is the input valid? From Phase 1 it also checks that the person is signed in and allowed to see employees.
4. The API asks the database for the employees.
5. The database returns the rows.
6. The API removes sensitive fields that a list does not need, such as Ghana Card numbers.
7. The API sends back JSON shaped exactly as the contract describes.
8. The dashboard shows the table.

If something goes wrong at any step, the API sends a standard error with a `traceId`. The dashboard shows a clear message, and the backend developer can find that exact request in the logs using the ID.

## Working in parallel: the contract and the mock API

Samuel builds the dashboard while Francis builds the API. How can the dashboard be tested before the API exists?

1. Both agree on the contract first. For example: "`GET /employees` returns a list of items with a name, a staff number and a status."
2. Samuel's dashboard includes a **mock API**: pretend endpoints inside the browser that follow the contract and return fictional employees.
3. Francis builds the real API to follow the same contract.
4. When the real API is ready, the dashboard switches from the mock API to the real one. Because both follow the contract, it just works.

TypeScript checks both sides against the contract. If one side drifts, the code stops compiling before anyone ships a bug.

## From a clock-in to a payslip

This is the full business flow the later phases build.

1. A guard arrives at a client site and scans their finger on the terminal.
2. The terminal recognises the guard and records the time.
3. The terminal sends the clock-in to the API. If the internet is down, it stores the clock-in and sends it later.
4. The API pairs each clock-in with a clock-out to calculate hours, including night shifts that cross midnight.
5. Missing clock-outs or strange patterns go to a supervisor to resolve.
6. At the end of the month, the payroll officer calculates the payroll: hours, overtime, PAYE tax and SSNIT.
7. A different person, the checker, approves it. The payroll is then locked forever.
8. Payslips are produced, and a bank file is exported for payment.
9. Throughout, the ghost detection engine looks for fraud, such as a guard clocked in at two sites at the same time.

## How SAMTEC stays secure

- **Least privilege:** every person sees only what their role needs. A guard sees only their own payslips.
- **Two people for money:** the person who prepares a payroll can never approve it.
- **Nothing silently changes:** clock-ins and approved payrolls are never edited; corrections are recorded as new entries.
- **Sensitive data is protected:** fingerprints are stored as encrypted templates, never as pictures, with the employee's consent (Ghana's Data Protection Act, 2012).
- **Safe defaults in the code:** secure HTTP headers, strict checks on every input, and errors that never reveal internal details.
- **Safe dependencies:** the project refuses brand-new package versions and unapproved install scripts, which blocks a common kind of attack on developers.

## How the code stays clean

- **One repository** holds the dashboard, the API, the contract and these documents.
- **Automatic checks** (CI) run on every pull request: formatting, the contract, types, tests and the build.
- **Four review lenses** check every change: does it fit the design, is it built well, do the frontend and backend fit together, and what would an attacker do?
- **Every phase ends with a working demo,** so the project is always in a state that can be shown.

## Explaining SAMTEC in two minutes

Use this as a starting point for your defense:

> Security companies lose money to ghost workers because attendance and payroll are not verified. SAMTEC links identity, presence and pay into one chain. Guards are registered with biometrics and their Ghana Card, they clock in with a fingerprint or face at the client site, and salaries are calculated only from those verified clock-ins, with a second person approving every payroll.
>
> Technically, it is a React dashboard and a NestJS API sharing an OpenAPI contract, with PostgreSQL for data. The contract let us build the frontend and backend in parallel. Security runs through every layer: role-based access, maker–checker approval, encrypted biometric templates, and a detection engine that flags anomalies like one fingerprint under two names, or pay without attendance.

Next: [Set up your computer](02-setup-on-windows.md). Unfamiliar word? See the [Glossary](08-glossary.md).
