# attendance module (Phases 2 and 3)

**Purpose:** turn biometric clock-ins at guard posts into verified working hours.

**Owns these tables:** `devices`, `punch_events`, `work_segments`, `attendance_exceptions`, `attendance_checks`, and for Phase 3 `biometric_consents`, `biometric_credentials`, `biometric_exemptions`, `device_passkeys` and `clock_in_attempts`.

Every rule, with its reason, is in [docs/plan/12-attendance-design.md](../../../../../docs/plan/12-attendance-design.md) (attendance) and [docs/plan/13-biometrics-design.md](../../../../../docs/plan/13-biometrics-design.md) (biometrics). Read them first.


## Files

| File | What it does |
|---|---|
| `devices.controller.ts`, `devices.service.ts` | The device registry (ADMIN only). A secret is shown once and stored only encrypted. |
| `device-signature.ts` | Signing and checking a request: `HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`, and which kinds of device each route accepts (`kindMayUse`). Pure functions. |
| `device-signature.guard.ts` | `@DeviceSigned(route)` for device routes: no user token, a valid signature instead. It also counts the per-device rate limit. |
| `ingest.controller.ts`, `ingest.service.ts` | `POST /ingest/punches` and `/ingest/heartbeat`. Stores each punch once and queues who-punched problems. |
| `punch-rules.ts` | Pure rules: user number → staff number, the payload hash, impossible times, who may clock in. |
| `pairing.ts` | Pure rules: punches → shifts (IN then OUT, same site, at most 16 hours), and what must change in the stored segments and the queue. |
| `pairing.service.ts` | Re-pairs people's last 62 days after new punches or a resolution, and the heartbeat's check for forgotten clock-outs. |
| `attendance.controller.ts`, `attendance.service.ts` | `GET /attendance/segments`, the exception queue, and resolving an exception. |
| `attendance-lock.ts` | The per-company lock every attendance write takes, with its timeouts. |
| `biometric-provider.ts` | The `BiometricProvider` interface and the mock provider (`BIOMETRIC_PROVIDER`, default `mock`). Fingers only: faces go through `face-provider.ts`. |
| `face-thresholds.ts` | Every face number in one place, with the name (`ft-1`) stored on each attempt. |
| `face-match.ts` | Pure rules: Human's similarity formula copied to the server, who a face is (match, not sure, not recognised), the duplicate check, and whether a capture's frames agree. |
| `face-template.ts` | Sealing a template with AES-256-GCM, bound to its own row, and opening it again. |
| `face-provider.ts` | The only place that opens a sealed template: hands rows in, gets a decision back. |

## Rules that must hold

- Punches are **append-only**: a database trigger refuses UPDATE, DELETE and TRUNCATE. Corrections happen on work segments.
- A punch is unique by `(device_id, device_event_id)`, so resending does nothing. The same event ID with different content is a `CONFLICT`: not stored, and audited.
- Both the device time and the server receive time are stored. Impossible times are stored but never paired.
- The signature is checked against the **raw request body** (`rawBody: true` in `main.ts`, `serverless.ts` and the test apps), never a re-encoded one.
- Every failure to prove a device answers the same `401`, and the logs carry only a reason code and IDs.
- Counted (CONFIRMED) work segments of one person can never overlap: a database exclusion constraint checks it at commit.
- Each signed route accepts only some kinds of device (an allow-list, `kindMayUse`): a kiosk never posts raw punches, and simulators are refused in production unless `ALLOW_SIMULATOR_DEVICES=yes`. A refused kind gets the same `401` as a wrong signature.
- A shift's basis comes from one exhaustive function, `basisFor` in `pairing.ts`: a finger, a face, or a face confirmed by the kiosk's sensor is `BIOMETRIC`; a PIN, a co-sign, or a staff number confirmed by the sensor is `PIN_FALLBACK`, always flagged. The weaker punch decides.
- The biometric tables guard their own rules (docs/plan/13 section 1, and the Phase 3 migration): append-only consents and attempts, nothing ever deleted, a wiped face never back, a block final, and the enroller or asker never deciding. New rows start undecided on the right kind of device and inside the worker's company, a face needs the worker's own consent, a collided face is never matched until a second ADMIN clears it, and a trigger checked at commit keeps a SAME_PERSON decision whole (the losing record ends blocked, with no key or exemption left). One pair of records is never decided two ways. Every collision decision, every block and every new row for one worker lock that worker's employee row, so they happen one at a time; a service that changes several rows locks the workers first, in id order (docs/plan/13 section 2). A device keeps its company, site and kind for life, and switching its fingerprints off must revoke its keys in the same transaction.
- Biometric data is stored as encrypted templates, never as images, and is never logged. A template is sealed for its own row (company, worker, credential row and key version), so a template copied onto another row fails to open rather than quietly working. Only `face-provider.ts` opens one, and a row it cannot open is reported by id, never by its numbers.
- Face scores stay on the server. A kiosk answer says who it is, never how close anyone was, so nobody can use the answers to probe the stored faces.

Hardware choices and the `BiometricProvider` interface are described in `docs/plan/10-biometric-integration.md`.
