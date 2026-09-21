# SAMTEC Security System

**Biometric attendance and payroll that stops ghost workers in security companies.**

[![CI](https://github.com/TEAM-DEVV/samtec-security-system/actions/workflows/ci.yml/badge.svg)](https://github.com/TEAM-DEVV/samtec-security-system/actions/workflows/ci.yml)

Security companies lose money when salaries are paid for shifts nobody worked. SAMTEC links **identity → presence → pay** into one verified chain:

1. Guards are registered with their Ghana Card and their fingerprint or face.
2. They clock in and out biometrically at the client site.
3. Pay is calculated only from those verified clock-ins, and a second person approves every payroll.

A detection engine flags whatever slips through, such as one fingerprint under two names, pay without attendance, or a guard clocked in at two sites at once.

## Who builds what

| Person | Builds | Folder | Your guide |
|---|---|---|---|
| **Samuel** | The dashboard (what users see) | [`apps/web`](apps/web) | [Frontend guide](docs/guides/03-frontend-guide.md) |
| **Francis** | The API and database (the engine) | [`apps/api`](apps/api) | [Backend guide](docs/guides/04-backend-guide.md) |

The two halves meet in one file: [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml), the **API contract**. It describes every request the dashboard can send and every answer the API gives back. Because it is written first, you can each build your half on your own computer, at your own pace, and the halves fit when they meet.

## First time on your computer (both of you, once)

1. Install Git, Node.js 24 and pnpm 12 — exact steps with screenshots-level detail: [Set up your computer](docs/guides/02-setup-on-windows.md).
2. Then:

```bash
git clone https://github.com/TEAM-DEVV/samtec-security-system.git
cd samtec-security-system
pnpm install
```

## Samuel: start here

Your first session is scripted for you: [Frontend kickoff](docs/guides/00-frontend-kickoff.md) — three commands, one prompt to paste into Claude Code, and it sets your machine up and starts your first task with you. Your task list lives in [`apps/web/CLAUDE.md`](apps/web/CLAUDE.md), and Claude Code loads it automatically when you work in this repository.

To just see the dashboard run:

```bash
pnpm dev:web
```

Open http://localhost:5173 in Chrome, Edge or Firefox. That is the whole dashboard, running on built-in **pretend data** — you never need the backend, a database, or Francis to be online. Build every page against the pretend data first; it behaves exactly like the real API will.

Read in this order:

1. [How the system works](docs/guides/01-how-the-system-works.md) — the big picture in plain words (15 minutes)
2. [Frontend guide](docs/guides/03-frontend-guide.md) — how to add a page, step by step, with full example code
3. [Roadmap](docs/plan/07-roadmap.md) — what to build in each phase

## Francis: start here

```bash
# Terminal 1: the database. Leave it running.
pnpm db:start

# Terminal 2: first time only
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm db:seed

# Terminal 2: the API (restarts itself when you save a file)
pnpm dev:api
```

Check http://localhost:3000/api/v1/health — it should say `"database": "up"`. Your path is the [Backend guide](docs/guides/04-backend-guide.md), which walks through adding an endpoint from contract to test.

## The five rules that keep us out of trouble

1. **Contract first.** No feature starts before its endpoint is in `openapi.yaml`.
2. **`pnpm check` before every pull request.** It runs exactly what CI runs.
3. **Never push to `main`.** Branch, open a pull request, the other person reviews.
4. **Money is whole pesewas, never decimals.** GHS 12.50 is stored as `1250`.
5. **Only fictional data** in code, tests and screenshots. Real people's data never enters this repository.

Everything else — every decision and the reason behind it — is written down in [`docs/`](docs/README.md), so either of us can explain any part of the system from the documents alone. For the one-page picture of the whole system (layers, phases and review lenses), open [`docs/build-map.html`](docs/build-map.html) in a browser.

## Right now

**Phases 0 and 1 are done, and the Phase 2 (attendance) backend is complete.** Sign-in, the workforce and user management run against the live API. Devices, signed clock-ins, pairing into worked shifts and the exception queue are in, with a 30-day replay for the exit demo ([The attendance demo](docs/guides/10-attendance-demo.md)). The dashboard's attendance screens come next. The mock accounts are listed in the [frontend guide](docs/guides/03-frontend-guide.md). See the [roadmap](docs/plan/07-roadmap.md).
