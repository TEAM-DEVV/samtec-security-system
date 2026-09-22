# 13 · Biometrics design (Phase 3)

How a worker's face and fingerprint become a trusted clock-in. This page records the decisions behind Phase 3, so every line of code has a reason you can explain. The API contract (`packages/contracts/openapi.yaml`, tags **Kiosk** and **Biometrics**) gives the exact request and response shapes; this page explains the reasons behind them.

## The model in one paragraph

HR adds each worker to the central database once. An ADMIN then enrolls the worker's face on a **company device at the site**, plus a finger if the device has a fingerprint sensor. From then on, the worker clocks in every day on that company device. They need no phone of their own, no password and no location: their face tells the kiosk who they are. Until a client buys hardware, the company device is a phone, tablet or laptop running the kiosk app (`apps/kiosk`), registered as a `FACE_KIOSK`. For production, ZKTeco fingerprint terminals send their punches through a small gateway.

```
worker at the site kiosk
  → face (a random head turn proves a live person) → POST /kiosk/identify
  → server compares the face with every enrolled face in the company (1:N)
  → "Hello, Kwame A. (SMT-00042)", then the device's own fingerprint sensor if it has one
  → POST /kiosk/confirm → the same punch pipeline as Phase 2 (stored once, paired, checked)
  → the dashboard's live clock-ins board, within 5 seconds
```

## Owner decisions

These were agreed with the owner before the build started.

| Decision | Choice | Why |
|---|---|---|
| Where workers clock in | A company kiosk at the site, and a ZKTeco terminal later. Never the worker's own phone, and no location tracking | Many guards have no smartphone, and a company device is one the company controls |
| Who a face belongs to | The server matches the face against **everyone** in the company (1:N) | The "clearly ahead of the next person" rule only works when the face is compared with everyone |
| Fingerprint on test devices | The device's built-in sensor, through passkeys (WebAuthn). The face says who you are; the finger confirms it (`FACE_PASSKEY`) | The phone or laptop sensor works today, with no extra hardware |
| Fingerprint required? | Optional per device; once a worker has a finger saved on a device, that device always asks for it | iPhones and many laptops have no sensor the kiosk can use |
| Fallback when the face fails | After 3 failed face attempts: staff number plus finger (`STAFF_PASSKEY`, flagged), or a site supervisor co-signs with their own face (`PIN_FALLBACK`, flagged) | Nobody is stuck at the gate, and no secret is typed on a shared screen |
| Workers who refuse biometrics | Allowed. An ADMIN records an exemption; the worker clocks in only by a supervisor's co-sign, and every such punch is flagged | Consent must be a free choice (Act 843) |
| How long faces are kept | Wiped 90 days after the worker leaves | Long enough to catch a leaver re-hired under a new name |
| Who enrolls | ADMIN only (password, 2FA, and the kiosk's signature) | ADMINs have two-factor sign-in; HR creates records but never enrolls |
| Hardware | None until a paying client. For tests and the defense, an Android phone is the kiosk | The design works with the devices we already own |

## 1. What the database keeps

The attendance module owns every new table. Each table has row-level security, UUIDv7 IDs and UTC timestamps.

| Table | Holds | Rules |
|---|---|---|
| `biometric_consents` | employee, `GIVEN` or `WITHDRAWN`, text version (`bio-v1`), SHA-256 of the exact text shown, who recorded it, device, time | Append-only: a withdrawal is a new row |
| `biometric_credentials` | employee, kind (`FACE`, `TERMINAL_FINGER`), device, the **encrypted** face template, key version, enrolled by, duplicate-check result (`PASSED`, `COLLISION`, `CLEARED`, `NOT_CHECKED`), who it looked like and how closely, the resolution, status (`PENDING`, `ACTIVE`, `BLOCKED`, `REVOKED`), `wiped_at` | Never deleted; a wipe empties the template. One ACTIVE face per employee |
| `device_passkeys` | employee, device, credential ID, public key, signature counter, "synced" flag, `revoked_at` | Never deleted. One live key per employee per device |
| `clock_in_attempts` | ID (reused as the punch's `deviceEventId`), device, purpose (`CLOCK`, `CO_SIGN`, `STAFF_PASSKEY`), direction, outcome, employee, best and runner-up scores, anti-spoofing scores, threshold version, fingerprint challenge, time | Append-only. Scores stay on the server; embeddings are never stored here |

**Other changes**

- **Punch methods.** `PunchMethod` gains `FACE_PASSKEY` and `STAFF_PASSKEY`. `POST /ingest/punches` accepts a narrower list (`IngestPunchMethod`: `FINGERPRINT`, `FACE`, `PIN_FALLBACK`), so a terminal can never claim a kiosk method.
- **Devices** gain `serialNumber` (a ZKTeco terminal's serial, for the gateway) and `passkeysEnabled` (only a `FACE_KIOSK` can switch it on). A new exception type, `UNEXPECTED_DEVICE_ENROLLMENT`, is raised when a terminal reports a finger nobody asked for.
- **Workforce** gains `biometric_exempt_at`, and three calls the attendance module uses: `markBiometricsEnrolled`, `clearBiometricsEnrolled` and `checkGhanaCardLast4`. That keeps the module boundary: attendance never writes the employees table itself.
- **Pairing** decides a segment's basis from its punches' methods with one exhaustive function: `FINGERPRINT`, `FACE` and `FACE_PASSKEY` give `BIOMETRIC`; `STAFF_PASSKEY` and `PIN_FALLBACK` give `PIN_FALLBACK`. The weaker punch of a pair decides.

**Encryption.** A face template is a list of 1,024 numbers, not a photo. It is still personal data, because such numbers can be turned back into a rough face. It is stored with AES-256-GCM, like the device secrets and the authenticator secrets:

- The key is `deriveKey(AUTH_SECRET, 'face-template')` from `secret-box.ts`, so the project keeps **one master secret**. (A separate biometric secret was considered and dropped: `AUTH_SECRET` already protects the device secrets and the two-factor secrets, so rotating it is already a planned event, and one secret is easier to keep safe.)
- The encryption is bound to `companyId|employeeId|credentialId` (GCM "associated data"). A template copied onto another person's row fails to decrypt.
- A `key_version` column is stored next to each template, so a later key change can re-encrypt the templates instead of forcing everyone to re-enroll.
- Only the matcher decrypts templates. A test spies on the logger to prove an embedding never reaches a log.
- **Back up `AUTH_SECRET` offline.** Losing it means registering every device again, setting up two-factor again and enrolling every face again.

**Deletion (Act 843).** A withdrawal of consent or an ADMIN revoke wipes the face at once and switches off the worker's fingerprint keys. Leavers are handled by a **retention sweep that rides on the device heartbeat**, exactly like the overdue clock-out check in [Attendance design](12-attendance-design.md):

- The company's `attendance_checks` row gains a `retention_checked_at` bookmark. The first heartbeat after 24 hours runs the sweep and moves the bookmark forward.
- The sweep switches off the fingerprint keys of anyone past their termination date, and wipes the face of anyone terminated at least 90 days ago (at most 50 people per heartbeat; the next heartbeat carries on).
- There is no scheduled job and no extra secret. Kiosks send a heartbeat every minute, so the sweep runs daily in practice. If every device in the company is switched off, the sweep waits for the next heartbeat. Nobody can clock in during that time, and an ADMIN can still revoke anyone by hand.

Rows stay for the audit trail. Punches, attempts and consents are never deleted.

## 2. Enrollment and the duplicate check

HR creates the worker as `PENDING_ENROLLMENT`. The rest happens on the kiosk. The kiosk's ADMIN routes need **both** an ADMIN access token **and** the kiosk's signature (a new `@KioskOperator` guard). A stolen ADMIN password alone cannot enroll anyone, and neither can a stolen kiosk.

1. **The ADMIN signs in on the kiosk** with password and two-factor, sending `keepSignedIn: false`. The API then sets no refresh cookie, so the kiosk never stays signed in: the 15-minute access token lives in memory until 5 idle minutes pass or the ADMIN taps "Done".
2. **Pick the worker** and type the **last 4 digits of the Ghana Card** they are holding. Workforce checks them. The full number never reaches the kiosk. A mismatch answers 422 and is audited.
3. **Consent** (`POST /kiosk/consents`). The kiosk shows the `bio-v1` text from `GET /biometrics/consent-text`. It covers the purpose (correct pay), what is kept (numbers, never photos), how long (90 days after leaving), the worker's rights, and the alternative (co-signed clock-ins, with no loss of pay). The worker taps "I agree", and the server stores the SHA-256 of the exact text shown.
4. **Capture.** A random head turn, then 3 frames half a second apart. Each frame needs exactly one face at least 224 pixels wide and anti-spoofing scores (`real` and `live`) of at least 0.60. The 3 frames must match each other at 0.70 or more, which catches someone swapping faces mid-capture.
5. **Duplicate check** (`POST /kiosk/face-enrollments`; 409 without consent). It runs in one transaction under its own advisory lock (`biometrics:<companyId>`), so punches never wait for it, and two enrollments at the same moment cannot both slip through. The new face is compared with every unwiped face of every other employee, in any status. A score of 0.50 or more (looser than clock-in's 0.60, on purpose) is a `COLLISION`. Anything lower is `PASSED`.
6. **PASSED:** in the same transaction, `markBiometricsEnrolled` sets `biometricEnrolledAt` and makes the worker `ACTIVE`. Enrolling again wipes the old face.
7. **Fingerprint**, where the device has `passkeysEnabled` (section 4).

**COLLISION.** The worker stays pending, and the kiosk shows only "Needs an admin review" (never who they looked like). An ADMIN **other than the one who enrolled them** checks both people's Ghana Cards in person and records a verdict with a note:

- `DIFFERENT_PEOPLE` (for example brothers): the face becomes `CLEARED`, and the worker is activated.
- `SAME_PERSON`: the new face is wiped and the worker stays pending, so HR can investigate a possible ghost.

Phase 5's rule R1 (duplicate biometrics) reads these rows, so no extra alerts table is needed.

**Refusing consent.** An ADMIN records an exemption with a reason (`POST /employees/{id}/biometric-exemption`). The worker becomes `ACTIVE` without a face and clocks in only by a supervisor's co-sign, so every hour they work is flagged. A withdrawal of consent (`POST /employees/{id}/biometric-consents/withdraw`) ends the same way: the face is wiped, the keys are switched off, and the worker is exempted so they can keep working.

**Seed data** gains a second ADMIN (so collisions can be resolved), two pending guards and one pending supervisor.

## 3. Face clock-in on the kiosk

**The app.** `apps/kiosk` is a separate app built with Vite, React 19, TypeScript and plain CSS, so the dashboard's files are untouched. It runs **Human 3.3.6** (pinned) with its face models only, about 13 MB, served from the kiosk itself and cached. It uses WebGL, falling back to WebAssembly, under a strict content security policy (`script-src 'self' 'wasm-unsafe-eval'`). It is hosted as its own Vercel project with the same `/api/v1` rewrite as the dashboard, so it shares the API's origin and needs no CORS change.

**Setup.** An ADMIN signs in, picks the site and registers the device (the existing `POST /devices`, kind `FACE_KIOSK`). The secret goes straight into a WebCrypto HMAC key that JavaScript cannot read back. The kiosk sends a heartbeat every minute. If the browser's storage is lost, the ADMIN rotates the secret. Screen pinning and a device PIN known only to ADMINs lock the device to the kiosk app.

**Device kinds are checked.** Signed routes now know the device's kind. `/kiosk/*` accepts only `FACE_KIOSK`, and `/ingest/punches` refuses `FACE_KIOSK` (and `MOCK` outside TEST), all with the same `401`. A stolen kiosk key therefore cannot post raw `FACE` punches.

**Clock-in, step by step**

1. The worker taps **Start shift** or **End shift**.
2. The kiosk says "Look at the camera", then "Turn your head slowly LEFT" (or RIGHT, at random) and back. It needs one face of at least 224 pixels, `real` and `live` of at least 0.60, and the turn within 20 seconds. Then it takes one centred face sample.
3. `POST /kiosk/identify`. The server checks the anti-spoofing scores again, compares the sample with every `PASSED` or `CLEARED` face in the company, and records the attempt.
   - A **match** needs a best score of at least **0.60** and a lead of at least **0.05** over the best *other* person. Anything else is `AMBIGUOUS`, `NOT_RECOGNISED` or `LOW_LIVENESS`.
   - The score is Human's own similarity formula (MIT-licensed), copied to the server so both sides agree: `distance = 25 × Σ(aᵢ − bᵢ)²`, then `similarity = clamp((1 − √distance ÷ 100 − 0.2) ÷ 0.6, 0, 1)`. It is based on Euclidean distance, not cosine similarity. The thresholds live in one file (`face-thresholds.ts`, version `ft-1`), and every attempt records which version it used.
4. The answer contains the attempt ID, the worker's name and staff number, and a fingerprint challenge if one is needed. It **never contains a score**, so nobody can use the answers to probe the stored faces. No punch is made yet.
5. The kiosk shows "Hello, Kwame A. (SMT-00042)" for 2 seconds, with a **Not me** button, then asks for the finger if needed.
6. `POST /kiosk/confirm`. The attempt must come from the same device, be a match, be under 60 seconds old, and carry a valid fingerprint answer where one was asked for. The server then calls the Phase 2 `IngestService.ingestPunches` itself: `deviceEventId` is the attempt ID, `deviceUserRef` the staff number, the time is the **server's** time of the attempt (a kiosk cannot backdate), and the server chooses the method. Sending the confirmation again answers `DUPLICATE`. Pairing and `INACTIVE_EMPLOYEE` work exactly as in Phase 2.
7. The kiosk shows "Shift started 06:58", or "Recorded – please see your supervisor".

**After 3 failed face attempts,** the kiosk offers "Use fingerprint" (section 4) or "Ask your supervisor". For a co-sign, the worker types their staff number, and a supervisor passes identify with purpose `CO_SIGN`: they must be ACTIVE, assigned to this site, and not the worker. `POST /kiosk/assisted-punches` then makes one `PIN_FALLBACK` punch, with the reason audited. Rule R7 counts these per worker and per co-signer.

**Offline,** the kiosk says "Tell your supervisor", and the time is entered later through the Phase 2 exception queue.

## 4. Fingerprint on the kiosk (passkeys)

**Library.** `@simplewebauthn/server` 14.0.2 and `@simplewebauthn/browser` 14.0.0 (pinned; see [Stack decisions](02-stack-decisions.md)). The relying party ID is the kiosk's domain, or `localhost` in development.

**Which devices.** `passkeysEnabled` is switched on only for Android phones with a fingerprint sensor and laptops with a Windows Hello fingerprint reader. iPhones and laptops without a sensor are face-only, because a shared iPhone's Face ID holds only its owner's face. Each kiosk uses its own dedicated Google or Microsoft account.

**Registration.** The ADMIN first adds the worker's finger in the device's own settings (Android holds 4 or 5 fingers).

1. `POST /kiosk/passkey-options` asks for a key held on this device only (`platform`), not a discoverable one, with the finger (user verification) required and no attestation. The challenge travels inside a sealed ticket that only the server can open, valid for 2 minutes.
2. `POST /kiosk/passkeys` checks the origin, the relying party ID and user verification, and refuses keys from another device (`cross-platform`). The key is bound to this worker **and** this device. The "synced" flag is stored and shown on the dashboard.

**Face, then finger (`FACE_PASSKEY`).** When the matched worker has a key on this device, identify includes a challenge that only that key can answer. The finger is then **required**: cancelling means no punch. Confirm checks the signature, user verification, the origin, that the key belongs to this worker and to the signing device, and that its counter went up (when the device uses one).

**Staff number, then finger (`STAFF_PASSKEY`).** This is offered only after 3 failed face attempts, through `POST /kiosk/fingerprint-options`. It counts as `PIN_FALLBACK` (shown amber and counted by R7), because any finger saved on the device can unlock any worker's key.

**The honest limit.** The device proves only that a finger (or the device PIN) saved on it unlocked this worker's key, never *whose* finger it was. That is why the face identifies and the finger only confirms. The screen says "fingerprint"; the data says "passkey". The production answer is the ZKTeco terminal, which matches fingers against everyone itself.

## 5. ZKTeco: the gateway and the simulator

**Gateway** (`apps/gateway`). Node 24 using only built-in modules (`node:http`, `node:sqlite`), on an always-on mini PC at the client's site, listening on the local network only (port 8081). It accepts only listed serial numbers from listed IP addresses, plus the comm key where the firmware supports it. It answers the terminal's handshake (real-time mode, UTC, no photos) and its command polls, and drops any stray photos without logging them.

**Translation.** Each attendance line becomes one punch:

- time: the device time, read as UTC;
- `deviceEventId`: 32 hex characters of SHA-256 over serial, user, time, status and verify mode, so a resent line is the same punch;
- status: 0 → `IN`, 1 → `OUT`, anything else → `UNKNOWN`;
- verify mode: 1 → `FINGERPRINT`, 15 → `FACE`, anything else → `PIN_FALLBACK`.

**Delivery.** Each line is written to a SQLite outbox **before** the gateway answers `OK`, then sent in signed batches of at most 100, with that terminal's own secret. A server error or a timeout is retried; a `401` raises an alarm. The gateway, the API, the simulator and the kiosk all pass one shared file of signature test vectors.

**Roster.** Every 5 minutes, a signed `POST /ingest/roster` returns the site's active and pending staff. The gateway compares it with the terminal's user list and adds or removes users. It is safe to repeat, so the server needs no command table.

**Enrollment proof.** When a terminal reports a new finger, the gateway sends only "user 42 enrolled a finger on this terminal at this time" (`POST /ingest/enrollments`); the fingerprint template itself is discarded. A finger enrolled inside a 30-minute window that an ADMIN opened for that worker becomes ACTIVE (`NOT_CHECKED`, because our server cannot compare terminal fingerprints). Any other finger becomes `BLOCKED` and raises `UNEXPECTED_DEVICE_ENROLLMENT`. A terminal never activates anyone.

**Pull fallback.** `gateway pull` reads a terminal with `zkteco-js`, by hand, for backfilling only.

**Simulator** (`fake-terminal`). It talks to the real gateway, which talks to the real API. It covers the handshake, verify modes 1 and 15, Windows line endings and broken lines, a burst of 500 lines and a resend, command acknowledgements, fingers enrolled inside and outside a window, a photo, and an unknown serial number.

## 6. The contract

| Endpoint | Signed in as | Who |
|---|---|---|
| `POST /kiosk/identify`, `/kiosk/confirm`, `/kiosk/fingerprint-options`, `/kiosk/assisted-punches` | Kiosk signature | A `FACE_KIOSK` device |
| `POST /kiosk/consents`, `/kiosk/face-enrollments`, `/kiosk/passkey-options`, `/kiosk/passkeys` | Access token **and** kiosk signature | ADMIN |
| `POST /auth/login`, `/auth/2fa/verify` gain `keepSignedIn` | Public | The kiosk operator sends `false` |
| `GET /biometrics/consent-text` | Access token | Any signed-in user |
| `GET /attendance/punches` (live clock-ins board) | Access token | ADMIN, HR_PAYROLL; SUPERVISOR for their own sites |
| `GET /attendance/clock-in-attempts` | Access token | ADMIN |
| `GET /employees/{id}/biometrics` (statuses only) | Access token | ADMIN, HR_PAYROLL; SUPERVISOR for their own sites |
| `POST /employees/{id}/biometrics/revoke`, `/biometric-exemption` | Access token | ADMIN |
| `POST /employees/{id}/biometric-consents/withdraw` | Access token | ADMIN, HR_PAYROLL |
| `GET /biometric-collisions`, `POST /biometric-collisions/{credentialId}/resolve` | Access token | ADMIN, never the one who enrolled |
| `PATCH /devices/{id}` gains `serialNumber` and `passkeysEnabled` | Access token | ADMIN |
| `POST /devices/{id}/finger-enrollment-windows`, `POST /ingest/roster`, `/ingest/enrollments` | Access token / terminal signature | Added to the contract with the gateway (pull requests 8 and 9) |

No response carries an embedding, a template or a Ghana Card number, and no kiosk response carries a score.

## 7. Testing, and the demo without hardware

- **Where to test:** laptops on `localhost`, and phones only on the fixed TEST kiosk address. Preview addresses change the relying party ID, and plain-HTTP addresses on the local network block the camera. Load time and frame rate are measured on an Android phone, an iPhone and a Windows laptop.
- **CI:** Playwright with Chrome's virtual authenticator, and a stand-in for Human that produces made-up face samples.
- **Pilot:** 10 or more consenting volunteers. A `face:scores` script prints how same-person and different-person scores spread, which is how threshold version `ft-1` (including the duplicate threshold) gets its final numbers.
- **The defense demo** (the Android phone is the kiosk, the laptop shows the dashboard):
  1. Samuel, as ADMIN, creates Kwame and registers the phone as kiosk ACC-01.
  2. On the phone: Ghana Card digits, consent, then the face → `PASSED`, and Kwame is ACTIVE. Samuel saves Kwame's finger, and enrolls a supervisor.
  3. Kwame taps Start shift, turns his head and touches the sensor. A `FACE_PASSKEY` clock-in appears on the dashboard within 5 seconds.
  4. A printed photo of Kwame is refused.
  5. Kwame enrolled again as "Kofi" → `COLLISION`, which the second ADMIN resolves.
  6. The supervisor co-signs for a worker with his own face → an amber `PIN_FALLBACK` punch.
  7. The fake terminal sends punches through the gateway → `FINGERPRINT` punches appear, and ending the shift creates a work segment.
- **Exit criterion:** a real face-plus-fingerprint clock-in on a phone acting as the site kiosk reaches the dashboard within 5 seconds, and the ZKTeco path passes end to end against the simulator.

## 8. The build, as pull requests

At most two open at a time, merged as soon as each is green.

| # | Pull request | Key tests |
|---|---|---|
| 1 | Contract, mock API, this page and the plan updates | `contracts:check`; the mock API's rules |
| 2 | Migration, device-kind checks, `IngestPunchMethod`, the basis function | Triggers refuse UPDATE and DELETE; a kiosk on `/ingest/punches` → 401 |
| 3 | Face matching, template encryption, the face provider | Same values as Human; a template moved to another row fails to decrypt |
| 4 | Operator sign-in, consent, enrollment, collisions, revoke, withdraw, exemption, retention sweep | The same face twice → COLLISION; parallel enrollments caught; resolver ≠ enroller; clean logs |
| 5 | Identify, confirm, co-sign, the live clock-ins board | A resend → `DUPLICATE`; the margin rule; no scores returned |
| 6 | `apps/kiosk` (needs the owner's OK for a new Vercel project) | Shared signature vectors; Playwright. **The face demo works.** |
| 7 | Passkeys | No user verification, keys from another device, and foreign keys all refused. **The full demo works.** |
| 8 | Gateway and fake terminal | Outbox written before `OK`; 500 lines → 5 batches |
| 9 | Roster, enrollment windows, pull script, demo guide, threshold report | A finger nobody asked for → an exception |

**Samuel's dashboard screens** (enrollment itself happens on the kiosk):

- a live clock-ins board, refreshed every 5 seconds, with method badges, and `PIN_FALLBACK` and `STAFF_PASSKEY` shown in amber (`GET /attendance/punches`);
- a Biometrics panel on the employee page: consent, face status, fingerprint keys, exemption, and the revoke, exempt and withdraw actions;
- the duplicate-enrollment queue, where the note is required and the enroller cannot decide;
- kiosk attempts per device (ADMIN);
- the new device fields (`serialNumber`, `passkeysEnabled`) on the Devices page.

The mock API already supports all of them.

## 9. Risks and honest limits (for the report)

1. **The kiosk is trusted.** Browser anti-spoofing is prototype-grade. It stops printed photos and screens held up to the camera, but not a replayed video, a mask or a modified kiosk. The production answer is terminals with infrared sensors.
2. **The device fingerprint identifies nobody** (section 4), and a phone holds only about 5 fingers.
3. **Passkeys can sync** (always on iCloud, by default on Google). A new kiosk domain means registering the fingers again.
4. **Face accuracy on Ghanaian faces is unpublished.** The margin rule, the "Not me" button and Phase 4's maker–checker payroll limit the harm of a false match. Twins may need the finger or a co-sign.
5. **More guards means more false collisions:** the chance is 1 − (1 − FMR)^N. At a 0.1% false-match rate and 500 guards, about 39% of enrollments would need a review, so the pilot sets the threshold.
6. **Every clock-in decrypts every face.** That is fine up to about 300 guards. A vector index (pgvector) would need unencrypted templates, so it waits until the size demands it.
7. **Human is barely maintained** (3.3.6, from August 2025, is its latest release). It is pinned behind the `BiometricProvider` interface. Changing the model means enrolling everyone again.
8. **One ADMIN can create and enroll the same fake person.** Both steps are audited, Phase 5 flags it, and probing shows in the attempt log.
9. **ZKTeco firmware is unverified** until a terminal is bought, and our server cannot compare terminal fingerprints.
10. **Act 843** needs a legal check, and the client must register with the Data Protection Commission.

Related: [Biometric integration](10-biometric-integration.md) · [Attendance design](12-attendance-design.md) · [Security and review gates](06-security-and-review-gates.md) · [Roadmap](07-roadmap.md)
