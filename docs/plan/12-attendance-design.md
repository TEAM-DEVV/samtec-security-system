# 12 · Attendance design (Phase 2)

How a punch becomes paid-for hours. This page records the decisions behind the Phase 2 attendance module, so every line of code has a reason you can explain. The API contract (`packages/contracts/openapi.yaml`, tags **Devices**, **Ingest** and **Attendance**) is the exact shape; this page is the *why*.

## The flow in one picture

```
device (or its gateway)
  → POST /ingest/punches, signed with the device's own secret
  → punch_events: stored once, never changed (idempotent)
  → match: device user number → employee (staff-number digits)
  → pairing: IN + OUT at the same site within 16 hours → work_segments
  → exception queue: a person looks at what does not fit
  → Phase 4 payroll pays CONFIRMED segments only
```

## 1. Devices prove who they are

- An ADMIN registers each terminal or kiosk for **one site**, for life. The API shows its **secret once** (32 random bytes). It stores only an encrypted copy (AES-256-GCM, the same helper as the authenticator secrets).
- Every request is signed: `HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`. `<route>` is a fixed name (`ingest/punches` or `ingest/heartbeat`), not the URL, so hosting rewrites can never break it and a signature can never be moved to the other endpoint. Since Phase 3, each route also accepts only some kinds of device: `ingest/punches` takes terminals (and the simulator where `ALLOW_SIMULATOR_DEVICES` allows it), never a kiosk, whose punches the server makes from a face match ([Biometrics design](13-biometrics-design.md), section 3).
- A timestamp more than 5 minutes from the server clock, a wrong signature, and an unknown or switched-off device all get the **same** `401`, so nobody can learn which device IDs exist.
- A wrong signature bumps the device's `failedSignatureCount` **at most once a minute**. A stranger who knows a device ID can make at most one database write per minute, and can never lock the real device out.
- **Rotation** gives a new secret and kills the old one at once. The device keeps any batch that was not acknowledged and resends it, so nothing is lost.
- Rate limit: 60 signed requests per minute per device, counted in one atomic SQL statement (like the sign-in lockout). It is a fixed one-minute window, so up to 120 requests can pass around a window boundary. That is still plenty of protection for one device, and far simpler to explain than a sliding window.
- A request naming a device that does not exist costs one lookup by primary key and writes nothing. Flooding the API from outside is left to the hosting platform's firewall, like any other public endpoint.

*Phase 3:* ZKTeco firmware cannot sign requests. A small gateway on the client's network talks to the terminals (ADMS push or `zkteco-js` pull), translates their records, and signs them with the device's secret. The API side does not change.

## 2. A punch is stored exactly once

- `(device_id, device_event_id)` is unique. Resending a batch answers `DUPLICATE` and changes nothing, so a device may always retry.
- `payload_hash` is a SHA-256 of the punch's fields in a fixed order. The same event ID with **different** content answers `CONFLICT`: it is not stored, and the attempt is audited (replay tampering).
- `punch_events` is **append-only**. A database trigger refuses every UPDATE, DELETE and TRUNCATE. Corrections are made on work segments, never on punches.
- Both the device's time and the server's receive time are stored. A big gap between them is normal (the device was offline).
- **Clock drift:** when a batch carries the device's current clock (`deviceClockAt`), a difference of more than 5 minutes marks its punches `clock_suspect`. They are still used.
- **Impossible times** (before 2020, or in the future beyond the device's measured drift) are stored and flagged but **never paired**. A fast clock cannot create future hours.

## 3. Who punched?

In Phase 2 a device user number is the **digits of the staff number**: `42`, `00042` and `SMT-00042` all mean SMT-00042. ZKTeco user numbers are numeric by default, so real terminals can be enrolled the same way in Phase 3 without changing ingest.

- **No match:** the punch is stored unmatched and never paired, and the queue gets an `UNKNOWN_EMPLOYEE` exception (grouped per device, number and day, so one misconfigured terminal cannot flood the queue). It can only be dismissed. Giving an unidentified punch to a named person is exactly what a ghost-worker fraud needs.
- **Matched, but may not clock in** (waiting for enrollment, suspended, or after the termination date): the punch is stored and paired, because presence is a fact. The queue gets an `INACTIVE_EMPLOYEE` exception, and payroll decides later.

## 4. Pairing: one rule

> A work segment is an **IN** followed by an **OUT** of the same person, **at the same site**, **no more than 16 hours later**.

- **Each site is paired on its own.** One person on shift at two sites at once therefore makes two segments that overlap, which the queue then shows (never one silently merged shift).
- Pairing compares moments in time (UTC) and never reads clock times, dates or shift patterns. A 22:00–06:00 night shift is just an IN followed 8 hours later by an OUT (480 minutes), and midnight never appears in the code. Editing a shift pattern can never rewrite past attendance.
- **A shift's hours belong to the Ghana date it started.** Monday 22:00 to Tuesday 06:00 counts 480 minutes on Monday. Payroll puts a segment in the period that contains that date and never splits it.
- **Repeat taps:** a punch less than 2 minutes after the previous punch at the same site is the same act when it is UNKNOWN or means what that punch counted as (IN or OUT). It is stored but ignored for pairing. A chain of quick taps is one act. A real clock-out 90 seconds after an UNKNOWN clock-in is not a repeat: it closes a very short shift.
- **UNKNOWN direction** counts as OUT when an IN is open and at most 16 hours old; otherwise it counts as IN.
- Ties at the same second are ordered OUT, then UNKNOWN, then IN. So a 06:00 handover makes two touching segments (06:00–18:00 and 18:00–06:00 never overlap: the ranges include their start and exclude their end).
- **Re-pairing:** whenever new punches arrive for a person, their **last 62 days are paired again from scratch** and the stored segments are brought in line. Segments that are no longer wanted are voided (never deleted), and new ones are added. A segment a *person* voided is never recreated. Because the result depends only on which punches exist, the order they arrive in cannot change it. Tests prove this by shuffling batches. Segments that started more than 62 days ago are never changed (their punches stay with them). A shift that began more than 62 days ago is never created, even when its clock-out is newer, and nothing older than 62 days goes into the queue. A punch that arrives more than 62 days late is stored but not paired.

## 5. Overlaps and the exception queue

- **No two counted segments of one person may overlap.** A PostgreSQL exclusion constraint enforces this on CONFIRMED segments, checked at commit.
- A segment that overlaps another live segment of the same person is `DISPUTED`, and does not count until a person decides. The queue gets an `OVERLAP` exception holding both segments. This is the evidence ghost rule R4 (bilocation) needs.
- Exceptions are de-duplicated **in the database** (a unique key per type and evidence). Automatic ones close themselves when later punches clear them (`AUTO_CLOSED`), for example when a late clock-out arrives.

| Type | Raised when | A person may |
|---|---|---|
| `MISSING_CLOCK_OUT` | an IN has no OUT within 16 h | add the shift by hand, or dismiss |
| `MISSING_CLOCK_IN` | an OUT has no IN in the 16 h before | add the shift by hand, or dismiss |
| `UNKNOWN_EMPLOYEE` | a user number matches nobody | dismiss |
| `INACTIVE_EMPLOYEE` | someone who may not clock in punched | dismiss |
| `OVERLAP` | one person, two shifts at once | keep one, or void both |

**Who sees and resolves:** ADMIN for any site. A SUPERVISOR only exceptions whose every site is theirs: an overlap that reaches a site they do not run is hidden from them (`404`), so they never see a shift at someone else's site, and an ADMIN deals with it. **HR_PAYROLL reads but never creates hours**, which keeps Phase 4's maker–checker split meaningful. **Nobody resolves their own attendance.** A hand-added shift must contain the real punch's time, last at most 16 hours and end in the past, so hours are only ever completed around real biometric evidence. It may not overlap any other live shift of the person, counted or disputed (`409`). The API checks this inside the company's attendance lock; for two counted shifts the database's exclusion constraint is the final guard. Every resolution is audited; its free-text note is not.

**Why one person may resolve alone:** a resolution never pays anyone by itself. The hours it confirms flow into a payroll run, and Phase 4's payroll approval is maker–checker (the person who prepares a run can never approve it), so a second person always reviews the hours before money moves. Each resolution is also in the audit log with who did it, and the hours a person added by hand are marked `MANUAL`, which the Phase 5 ghost rules can count.

## 6. When the work happens

Everything runs **inside the request that causes it**. There are no background workers, which suits serverless hosting.

- Each ingest batch (up to 100 punches) is **one transaction** under a per-company lock: store, match, raise exceptions, re-pair, commit. If anything fails, nothing is kept and the device resends. The lock waits at most 10 seconds (otherwise `503`, and the device retries), and a stuck transaction is killed after 30 seconds, so a crashed server can never freeze a company.
- **Clock-ins that never get a clock-out** only become visible with time. The company keeps a bookmark (`attendance_checks`): every punch before it has already been looked at. Each signed heartbeat re-pairs the people whose punches turned 16 hours old since the bookmark, and moves it forward (at most 16 hours of punch time per heartbeat, so catching up after an outage never makes one huge transaction). Pairing itself then decides what is missing, so the rules exist in one place only. When nothing turned 16 hours old, the usual case, the check takes no lock.
- **Reads never write.**

## 7. The mock provider and the demo

- `BiometricProvider` (`enroll`, `identify`, `dedupeCheck`) has a deterministic mock, chosen by the `BIOMETRIC_PROVIDER` setting. The real providers arrive in Phase 3.
- The device simulator (`pnpm --filter @samtec/api mock:devices`) is an outside client of the real endpoint, exactly like a Phase 3 gateway. It signs with the seeded devices' secrets and replays 30 days of realistic punches, like terminals that were offline for a month. The replay has small jitter, each guard's own shift pattern, a repeated send, a device with a fast clock, forgotten clock-outs, an unknown number, a suspended guard and one planted overlap. Running it twice proves idempotency: every item comes back `DUPLICATE`. [The attendance demo](../guides/10-attendance-demo.md) walks through it.
- A seeded demo device's secret is derived from `AUTH_SECRET` and the device's name, so the simulator on the same computer can compute it. It is never printed, and the database only ever holds it encrypted. Real devices get 32 random bytes, shown once.

## Deliberately later

| What | When | Why |
|---|---|---|
| PIN co-sign by a supervisor | Phase 3 (kiosk) | PIN punches are already flagged (`method`, segment `basis`) |
| Linking device users to people, re-matching old unknown punches | Phase 3 | needs `biometric_credentials` |
| Lateness, absence, overtime | Phase 4/6 | only useful once payroll or reports consume them |
| Voiding a hand-added shift | Phase 4 | who may delete hours is a maker–checker question |
| Device serial numbers and time zones | Phase 3 | Phase 2 clients send times with their UTC offset |
