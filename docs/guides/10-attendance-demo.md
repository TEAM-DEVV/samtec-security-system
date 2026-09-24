# The attendance demo (Phase 2)

This is the Phase 2 exit demo: 30 days of clock-ins replay through the real
API, and the dashboard's attendance pages fill in. No hardware is involved.
Pretend terminals sign their requests exactly like real ones, so every
security rule applies.

Everything here is fictional: the demo company, its guards and its devices.

## What you need

- The local database running: `pnpm db:start` (keep that terminal open).
- The demo data: `pnpm db:seed`. Besides the company, the sites and the 50
  guards, it now also creates:
  - one **MOCK clock-in device per site**, named like `Demo terminal ACC-01` (on this computer only);
  - a **Night Watch** shift (22:00–06:00);
  - a post and a shift on every posting. Every fourth guard works nights,
    the rest work days.
- The API running: `pnpm dev:api` (or `pnpm dev` for the dashboard too).

## Run it

In a third terminal, from the repository root:

```bash
pnpm --filter @samtec/api mock:devices
```

Each device prints one line, for example
`Demo terminal ACC-01: 9 guards, 478 punches → 478 new, 0 duplicates, 0 conflicts.`
The whole replay takes a few seconds.

**Where to look.** The dashboard's attendance pages are Samuel's next task. Once
they exist, sign in as `admin@samtec.example` and open Attendance and the
exception queue. Until then, look at the data itself:

```bash
pnpm --filter @samtec/api db:studio
```

Prisma Studio opens in the browser. Look at the tables `work_segments` (the
shifts), `attendance_exceptions` (the queue) and `devices` (drift and last
seen). The API answers the same data at `GET /api/v1/attendance/segments`
and `GET /api/v1/attendance/exceptions` for a signed-in user.

**Run it a second time.** Every punch now comes back as a duplicate, and
nothing changes. That is idempotency: a device can always resend safely,
because `(device, event ID)` is unique.

## What the replay contains, and what the API does with it

| In the replay | What the API does | Where to see it |
|---|---|---|
| Normal day shifts (06:00–18:00, a few minutes early or late) | Pairs each IN with its OUT: one CONFIRMED shift of about 720 minutes | Attendance (`work_segments`) |
| Night Watch shifts (22:00–06:00) | One shift of about 480 minutes, counted on the day it **started** | Attendance (`work_segments`) |
| A forgotten clock-out or clock-in (about 1 shift in 60) | `MISSING_CLOCK_OUT` / `MISSING_CLOCK_IN` in the queue | Exception queue |
| A nervous second tap within 2 minutes | Stored, but ignored for pairing | Nowhere, which is the point |
| A wrong key (direction `UNKNOWN`) | Read as a clock-out, because a clock-in is open | Attendance |
| A PIN instead of a finger | The shift is marked `PIN_FALLBACK` | Attendance |
| TEM-01's terminal clock runs 7 minutes fast | Its drift is measured (420 s) and its punches are flagged `clockSuspect` | Devices |
| TKD-01 sends its last batch twice (a lost acknowledgement) | The second copy is all `DUPLICATE` | The script's output |
| User number `99001`, enrolled nobody | Stored unmatched, never paired, one `UNKNOWN_EMPLOYEE` item | Exception queue |
| A suspended guard clocks in one day | Stored (presence is a fact), one `INACTIVE_EMPLOYEE` item | Exception queue |
| One ACC-01 guard also clocks in at ACC-02 for 2 hours | Both shifts become DISPUTED (neither counts) and one `OVERLAP` item holds them | Exception queue |

Resolve a few items to finish the demo. For example, dismiss the unknown
number, add the missing hours around a forgotten clock-out, or keep one side
of the overlap. A supervisor sees only their own site's items, and nobody may
resolve their own attendance.

**Why some items say AUTO_CLOSED.** The replay sends each device's punches
oldest first, in batches of 100, just like a terminal that was offline for a
month. A clock-in at the end of one batch can wait for its clock-out in the
next batch. For that moment it looks forgotten, so an item opens. When the
clock-out arrives, the item closes itself.

## How the pretend devices sign

Real devices get a random secret that is shown once (docs/plan/12 §1). A
demo device's secret is instead **derived from `AUTH_SECRET`** and the device's
name (`apps/api/scripts/demo-devices.ts`). The seed and the simulator run on
the same computer with the same `.env`, so both compute the same secret.
The secret is never printed, and the database only ever holds it encrypted.

The simulator (`apps/api/scripts/device-simulator.ts`) never touches the
database to send punches. It only calls the signed endpoints, like the Phase 3
gateway will. It signs with this computer's clock, but sends the terminal's
own (possibly wrong) clock as `deviceClockAt`, so a fast terminal can still
connect and have its drift measured.

## On TEST (or any other API)

The demo mode above plays the local database only. Against TEST you play one
device at a time, the same way a real device would be set up. The TEST API
must have `ALLOW_SIMULATOR_DEVICES=yes` ([TEST environment](09-test-environment.md));
without it, a `MOCK` device's punches answer `401` (its heartbeats still work).

1. An administrator registers a device of kind `MOCK` on the Devices page
   (or with `POST /api/v1/devices`). They copy the secret it shows once.
2. **A second administrator switches the device on** — the "Switch on" button
   on its page, or `PATCH /api/v1/devices/{id}` with `{"status": "ACTIVE"}`. A
   new key is born switched off, and whoever registered the device may not be
   the one to switch it on (docs/plan/06, "Two administrators"). Until this
   step, every punch the simulator sends answers `401`.
3. Run the simulator with that device and the staff-number digits of the
   guards enrolled on it:

   ```bash
   API_URL=https://samtec-test.vercel.app/api/v1 DEVICE_ID=<id> DEVICE_SECRET=<secret> pnpm --filter @samtec/api mock:devices -- --users 1,2,3 --shift day
   ```

   `--shift` is `day`, `night` (18:00–06:00) or `night-watch` (22:00–06:00),
   and `--days` defaults to 30.

The secret goes in an environment variable, not an option, because other
users on a computer can read a program's options but not its environment.
Your shell may still remember the command, so rotate the device's secret
when the demo is over.

Demo devices with derived secrets are never created on TEST. The seed only
registers them in a database on this computer, because anyone who knows
`AUTH_SECRET` could compute their secrets.

## Starting again

`pnpm db:reset` rebuilds the local database from scratch and seeds it again.
Punches can never be deleted one by one, because the table is append-only.
