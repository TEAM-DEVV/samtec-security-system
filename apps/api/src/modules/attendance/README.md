# attendance module (Phases 2 and 3)

**Purpose:** turn biometric clock-ins at guard posts into verified working hours.

**Owns these tables:** `devices`, `punch_events`, `work_segments`, `attendance_exceptions` (Phase 3 adds `biometric_credentials`).

Every rule, with its reason, is in [docs/plan/12-attendance-design.md](../../../../../docs/plan/12-attendance-design.md). Read it first.

## Files

| File | What it does |
|---|---|
| `devices.controller.ts`, `devices.service.ts` | The device registry (ADMIN only). A secret is shown once and stored only encrypted. |
| `device-signature.ts` | Signing and checking a request: `HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`. Pure functions. |
| `device-signature.guard.ts` | `@DeviceSigned(route)` for device routes: no user token, a valid signature instead. It also counts the per-device rate limit. |
| `ingest.controller.ts`, `ingest.service.ts` | `POST /ingest/punches` and `/ingest/heartbeat`. Stores each punch once and queues who-punched problems. |
| `punch-rules.ts` | Pure rules: user number → staff number, the payload hash, impossible times, who may clock in. |
| `attendance-lock.ts` | The per-company lock every attendance write takes, with its timeouts. |
| `biometric-provider.ts` | The `BiometricProvider` interface and the mock provider (`BIOMETRIC_PROVIDER`, default `mock`). |

## Rules that must hold

- Punches are **append-only**: a database trigger refuses UPDATE, DELETE and TRUNCATE. Corrections happen on work segments.
- A punch is unique by `(device_id, device_event_id)`, so resending does nothing. The same event ID with different content is a `CONFLICT`: not stored, and audited.
- Both the device time and the server receive time are stored. Impossible times are stored but never paired.
- The signature is checked against the **raw request body** (`rawBody: true` in `main.ts`, `serverless.ts` and the test apps), never a re-encoded one.
- Every failure to prove a device answers the same `401`, and the logs carry only a reason code and IDs.
- Counted (CONFIRMED) work segments of one person can never overlap: a database exclusion constraint checks it at commit.
- PIN clock-ins (Phase 3) are allowed as a fallback but always flagged.
- Biometric data is stored as encrypted templates, never as images, and is never logged.

Hardware choices and the `BiometricProvider` interface are described in `docs/plan/10-biometric-integration.md`.
