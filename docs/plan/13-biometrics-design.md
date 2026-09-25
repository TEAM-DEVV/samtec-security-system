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
| Workers who refuse biometrics | Allowed. One ADMIN asks for an exemption and a **second ADMIN approves it** after checking the Ghana Card; the worker then clocks in only by a supervisor's co-sign, and every such punch is flagged | Consent must be a free choice (Act 843), and no single person may activate a worker without a face check |
| How long faces are kept | Wiped 90 days after the worker leaves | Long enough to catch a leaver re-hired under a new name |
| Who enrolls | ADMIN only (password, 2FA, and the kiosk's signature), in a kiosk-only session | ADMINs have two-factor sign-in; HR creates records but never enrolls |
| Hardware | None until a paying client. For tests and the defense, an Android phone is the kiosk | The design works with the devices we already own |

## 1. What the database keeps

The attendance module owns every new table. Each table has row-level security, UUIDv7 IDs and UTC timestamps.

| Table | Holds | Rules |
|---|---|---|
| `biometric_consents` | employee, `GIVEN` or `WITHDRAWN`, text version (`bio-v1`), SHA-256 of the exact text shown, who recorded it, device, time | Append-only: a withdrawal is a new row. Consent is given on one of the company's kiosks; a withdrawal is recorded on the dashboard (no device) or on one of those kiosks, never on a terminal or another company's device. The database sets the time, so a consent and its withdrawal are always in the right order |
| `biometric_credentials` | employee, kind (`FACE`, `TERMINAL_FINGER`), device, the **encrypted** face template, key version, enrolled by, duplicate-check result (`PASSED`, `COLLISION`, `CLEARED`, `NOT_CHECKED`), who it looked like and how closely, the review (open until decided: the verdict, the record kept, the note, who decided), status (`PENDING`, `ACTIVE`, `BLOCKED`, `REVOKED`), `wiped_at` | Never deleted; a wipe empties the template but keeps who it looked like. At most one unwiped face per employee (a partial unique index). A new face is enrolled on one of the company's kiosks, undecided, and only with the worker's own consent, still given; a finger comes from one of its ZKTeco terminals. Only a face that collided names who it looked like, and it is never matched until a second ADMIN clears it. The record that loses a SAME_PERSON decision keeps a blocked face and no face, fingerprint key or exemption in use (checked when the change is saved), and one pair of records is never decided two ways. A face blocked as a duplicate stays `BLOCKED` for good and is never decided afterwards. A blocked record gets nothing live, and a decision, a block and anything new for the same worker happen one at a time (a lock on the employee row) |
| `biometric_exemptions` | employee, status (`REQUESTED`, `APPROVED`, `REJECTED`, `ENDED`), reason code (`DECLINED`, `CANNOT_ENROLL`, `CONSENT_WITHDRAWN`), a short note, who asked and when, who decided and when | Never deleted. A request is decided once, by a different ADMIN, while it is still waiting. It ends when its record is blocked as a duplicate |
| `device_passkeys` | employee, device, credential ID, public key, signature counter, "synced" flag, `revoked_at` | Never deleted. One live key per employee per device, and a new key only on one of the company's kiosks with fingerprints switched on; switching them off is refused unless the same transaction revokes every key on it. The counter only goes up; a revoked key is never used again |
| `clock_in_attempts` | ID (reused as the punch's `deviceEventId`, so a punch finds its attempt without changing it), device, purpose (`CLOCK`, `CO_SIGN`, `STAFF_PASSKEY`), direction, the staff number typed (for fallbacks and co-signs, even one that matches nobody), the co-signed worker, outcome (a `NOT_ME` row points at the attempt it cancels), employee, best and runner-up scores, anti-spoofing scores, threshold version, fingerprint challenge, the request's network address, time | Append-only. Scores stay on the server; embeddings are never stored here |

**Other changes**

- **Punch methods.** `PunchMethod` gains `FACE_PASSKEY` and `STAFF_PASSKEY`. `POST /ingest/punches` accepts a narrower list (`IngestPunchMethod`: `FINGERPRINT`, `FACE`, `PIN_FALLBACK`), so a terminal can never claim a kiosk method.
- **Devices** gain `serialNumber` (a ZKTeco terminal's serial, for the gateway) and `passkeysEnabled` (only a `FACE_KIOSK` can switch it on). A new exception type, `UNEXPECTED_DEVICE_ENROLLMENT`, is raised when a terminal reports a finger nobody asked for.
- **Workforce** gains the calls the attendance module uses to set or clear `biometricEnrolledAt`, to move an employee between `PENDING_ENROLLMENT` and `ACTIVE`, and to check the Ghana Card digits (`checkGhanaCardLast4`). That keeps the module boundary: attendance never writes the employees table itself.
- **The activation rule.** Biometrics only ever move an employee from `PENDING_ENROLLMENT` to `ACTIVE` (a `PASSED` face, a face a second ADMIN cleared, or an approved exemption) and from `ACTIVE` back to `PENDING_ENROLLMENT` (a revoke, which also ends an approved exemption; a new enrollment; a withdrawal of consent, until a second ADMIN approves the exemption the API files; or a record blocked as a duplicate). They never touch a `SUSPENDED` or `TERMINATED` employee. No other endpoint can make an employee `ACTIVE`, so the biometric check is the only door.
- **Pairing** decides a segment's basis from its punches' methods with one exhaustive function: `FINGERPRINT`, `FACE` and `FACE_PASSKEY` give `BIOMETRIC`; `STAFF_PASSKEY` and `PIN_FALLBACK` give `PIN_FALLBACK`. The weaker punch of a pair decides.

**Encryption.** A face template is a list of 1,024 numbers, not a photo. It is still personal data, because such numbers can be turned back into a rough face. It is stored with AES-256-GCM, like the device secrets and the authenticator secrets:

- The key is `deriveKey(AUTH_SECRET, 'face-template')` from `secret-box.ts`, so the project keeps **one master secret**. A separate biometric secret was considered and dropped. Both would be kept in the same place (the hosting provider's settings), so a leak of one would almost always be a leak of both. `AUTH_SECRET` already protects the device secrets and the two-factor secrets, and one secret is easier to keep safe. TEST and production never share it.
- The encryption is bound to `companyId|employeeId|credentialId|keyVersion` (GCM "associated data"). A template copied onto another person's row fails to decrypt.
- A `key_version` column is stored next to each template. Changing the key is a Phase 7 hardening task: a script re-encrypts every template while the old and the new secret are both configured, so nobody has to enroll again.
- The sealed bytes are `[1 byte format][12 bytes IV][16 bytes tag][the numbers]`, each number 8 bytes, exactly as it arrived. Two seals of the same face never look alike, and damaged bytes fail to open instead of opening wrong.
- Only the matcher decrypts templates (`face-provider.ts`, built). A test spies on the logger to prove an embedding never reaches a log.
- **Back up `AUTH_SECRET` offline.** Losing it means registering every device again, setting up two-factor again and enrolling every face again.

**Deletion (Act 843).** A withdrawal of consent or an ADMIN revoke wipes the face at once and switches off the worker's fingerprint keys. Leavers are handled by a **retention sweep that rides on the device heartbeat**, exactly like the overdue clock-out check in [Attendance design](12-attendance-design.md):

- The company's `attendance_checks` row gains a `retention_checked_at` bookmark. The first heartbeat after 24 hours runs the sweep and moves the bookmark forward.
- The sweep switches off the fingerprint keys of anyone past their termination date, and wipes the face of anyone terminated at least 90 days ago. It also wipes a face that has waited 90 days for a duplicate review — whatever became of the worker meanwhile, including a suspension — or for an abandoned hire; the review stays open, because only a second ADMIN may close it, and the verdict still blocks the losing record when it comes. A face blocked as a duplicate is already wiped, and the sweep leaves it blocked. For leavers, it clears the exemption note and the attempts' network addresses after the same 90 days (the reason codes and the rows stay). It handles at most 50 people per heartbeat, cleaning the whole batch in a handful of statements rather than two for each person, because it runs inside a device's heartbeat while holding locks the dashboard also wants; the next heartbeat carries on.
- There is no scheduled job and no extra secret. Kiosks send a heartbeat every minute, so the sweep runs daily in practice. If every device in the company is switched off, the sweep waits for the next heartbeat. Nobody can clock in during that time, and an ADMIN can still revoke anyone by hand. A company that stops using SAMTEC altogether has its data deleted as part of ending the contract (Phase 8).

Rows stay for the audit trail. Punches, attempts and consents are never deleted.

## 2. Enrollment and the duplicate check

HR creates the worker as `PENDING_ENROLLMENT`. The rest happens on the kiosk. The kiosk's ADMIN routes need **both** an ADMIN access token **and** the kiosk's signature (a new `@KioskOperator` guard, which is never `@Public()`). A stolen ADMIN password alone cannot enroll anyone, and neither can a stolen kiosk without an ADMIN.

1. **The ADMIN signs in on the kiosk** with password and two-factor. Only an ADMIN may: any other role is refused at a kiosk address (`403`), because enrollment is the only thing that happens there. Two settings list the addresses the API trusts: `CORS_ORIGINS` for the dashboard and `KIOSK_ORIGINS` for the kiosk. The request's `Origin` decides, for all three sign-in steps (`/auth/login`, `/auth/2fa/verify` and `/auth/2fa/enable`). An address in neither list, or none, is refused (`403`). The lists may never overlap: the API refuses to start if they do.
   - A **kiosk sign-in** gets **no refresh cookie**, so the kiosk never stays signed in. The 15-minute access token lives in memory until 5 idle minutes pass or the ADMIN taps "Done", which forgets it; it dies within 15 minutes anyway.
   - Its token works **only for the kiosk screens**: `GET /auth/me`, `GET /sites`, `GET /employees` (the list has no Ghana Card numbers), `GET /devices`, `POST /devices` and `POST /devices/{id}/rotate-secret` for a `FACE_KIOSK`, the consent text and the kiosk's ADMIN routes. Everything else answers `403` ("This kiosk session can only use the kiosk screens."). The kiosk's ADMIN routes, in turn, accept only a kiosk token.
   - Two-factor **setup** is refused on the kiosk (`403`): the ADMIN sets it up on the dashboard first, so the secret never appears on a shared screen.
   - The browser sets the `Origin` header itself, so a changed kiosk page cannot pretend to be the dashboard.
2. **Pick the worker** and type the **last 4 digits of the Ghana Card** they are holding. Workforce checks them, and the full number never reaches the kiosk.
   - A mismatch answers `400` on `ghanaCardLast4` and is audited.
   - After 5 wrong answers in a row for one worker within an hour, that worker waits an hour (`429`). The attempt is counted before the digits are looked at, so answers sent all at once are counted too; a right answer clears the count, so an ADMIN who mistypes is never stuck.
   - This check catches mistakes, like the wrong person in front of the kiosk. It cannot stop a dishonest ADMIN, who can read the full number on the dashboard. That is what the audit trail and the duplicate check are for.
3. **Consent** (`POST /kiosk/consents`). The kiosk shows the `bio-v1` text from `GET /biometrics/consent-text`. It covers the purpose (correct pay), what is kept (numbers, never photos), how long (90 days after leaving), the worker's rights, and the alternative (co-signed clock-ins, with no loss of pay). The worker taps "I agree", and the server stores the SHA-256 of the exact text shown. A worker who already has a current consent (for example when enrolling again) gets it back with `200`, after the card check, so every enrollment starts with the card.
4. **Capture.** A random head turn, then 3 frames half a second apart. Each frame needs exactly one face at least 224 pixels wide and anti-spoofing scores (`real` and `live`) of at least 0.60. The 3 frames must match each other at 0.70 or more, which catches someone swapping faces mid-capture.
5. **Duplicate check** (`POST /kiosk/face-enrollments`; `409` without consent, or while the worker has an open question, below). It runs in one transaction under its own advisory lock (`biometrics:<companyId>`), so punches never wait for it, and two enrollments at the same moment cannot both slip through. The new face is compared with every unwiped face of every other employee, in any status. A score of 0.50 or more (looser than clock-in's 0.60, on purpose) is a `COLLISION`. Anything lower is `PASSED`.
6. **PASSED:** in the same transaction, `markBiometricsEnrolled` sets `biometricEnrolledAt` and makes a `PENDING_ENROLLMENT` worker `ACTIVE` (a `SUSPENDED` worker stays suspended). A face in use ends any exemption. A worker has **one face at a time**: enrolling again replaces it, and an `ACTIVE` worker goes back to `PENDING_ENROLLMENT` until the new face passes.
7. **Fingerprint**, where the device has `passkeysEnabled` (section 4).

**COLLISION.** The worker stays pending, and the kiosk shows only "Needs an admin review" (never who they looked like). A **second ADMIN** checks both people's Ghana Cards in person and records a verdict with a note. It may never be the ADMIN who enrolled this face, nor anyone who revoked or withdrew a face of either record.

- **Why wiping counts.** Wiping a face is the step an insider needs in order to reuse it, and it is rare in normal work.
- **Why the rule stops there.** A wider rule (everyone who created either record, or enrolled the other face) would deadlock a company with two ADMINs in ordinary cases, such as two brothers enrolled by different ADMINs. So those links are allowed, but the ghost rules flag them (R11) for the payroll checker.
- **If nobody may decide** (an unusual case), the review waits for another ADMIN. Meanwhile R1 has already flagged both records for the payroll checker.

- `DIFFERENT_PEOPLE` (for example brothers): the face becomes `CLEARED`.
- `SAME_PERSON`: one person with two records. The reviewer says which record belongs to the person whose card they checked (`keepEmployeeId`). The choice matters. Suppose an insider wipes a real guard's face and enrolls a ghost with it. When the real guard enrolls again, the reviewer keeps the real guard's record and blocks the ghost, instead of always blocking the newer face.
  - The kept record, if it is the new one, gets a `CLEARED` face.
  - The **other record is blocked**: its face is wiped (`BLOCKED`), its fingerprint keys are revoked, any exemption ends, and an `ACTIVE` employee goes back to `PENDING_ENROLLMENT`, so the ghost can no longer clock in by any path.
  - Only the closest match is reviewed. If a face looks like two records, the other one is caught when either worker enrolls again (the new face names it), and R1 flags it meanwhile. Keeping a record that is already blocked is allowed: it blocks the other one too, so a second copy of a ghost is caught the same way.
  - The decision is final. The blocked record can only be terminated: consent, enrollment, exemption and revoke are refused for it, a withdrawal of consent leaves it blocked, and the retention sweep leaves it alone. Nothing turns `BLOCKED` back into `REVOKED`.

A cleared face activates the worker only if they are `PENDING_ENROLLMENT`, and only if the face is still there.

**Only a second ADMIN can close a review.**

- A revoke is refused while a review is open — for **both** records, the one whose face is under review and the one it looked like. A review is a question about two people, so neither of them changes while it waits.
- A withdrawal of consent, or the retention sweep, wipes the face as the law requires, but the review **stays open**, and the reviewer still decides from the Ghana Cards and the record of who the face looked like. The verdict still lands: a record whose face is already wiped is blocked where it stands, keeping the original wipe's time and the name of whoever made it (the sweep leaves no name), because a wipe is never undone or re-signed.
- A face wiped in the meantime stays wiped, even after a `DIFFERENT_PEOPLE` verdict; that worker then enrolls again or asks for an exemption.
- **A blocked record closes its own review.** If a record is blocked by a *second* review before its first one was answered, that first question is over: the record is finished either way, the database refuses to decide a blocked face, and the queue stops offering it. Deciding it answers `409` with that sentence, and the worker it was holding is free again — otherwise an honest guard could be locked out of consent, enrollment, exemption and revoke for the rest of their employment by a question nobody was able to answer.
- **The same two records are never decided two ways.** The database enforces it; the API says so first, naming the decision that stands, so a reviewer who changes their mind is told rather than shown an error with nothing in it.

So an ADMIN can never wipe a collision away and retry captures until a score slips under the threshold. Phase 5's rule R1 (duplicate biometrics) reads these rows, so no extra alerts table is needed.

**One open question at a time.** An open duplicate review or an exemption request waiting stops consent, enrollment, new exemption requests and revokes (`409`) until a second ADMIN settles it; each has exactly one way out, and it goes through that second ADMIN. A face blocked as a duplicate stops them for good: only termination follows.

**Refusing consent.** An exemption takes **two ADMINs**, like the collision review:

- One ADMIN asks (`POST /employees/{id}/biometric-exemption`). This is only for a worker still `PENDING_ENROLLMENT` with no face on record (none waiting, in use or blocked) and no open review.
- The request carries a reason code (`DECLINED`, or `CANNOT_ENROLL` when the kiosk cannot read the face) and a short, factual note. Religion and health details are never written down; the code is enough. Supervisors see only the code.
- A **different** ADMIN checks the Ghana Card in person and approves or rejects it (`POST /employees/{id}/biometric-exemption/review`). It may never be the ADMIN who asked, anyone who enrolled a face for this worker, or anyone who revoked or withdrew one. Whoever created the record may decide, but R11 flags it. Approving checks the rules again, not only when someone asked; rejecting is always possible while a request waits.
- Once approved, the worker is `ACTIVE` without a face and clocks in only by a supervisor's co-sign, so every hour they work is flagged. If the worker later enrolls a face that **passes**, the exemption ends (`ENDED`). Any other new enrollment, including one that collides, sends an `ACTIVE` worker back to `PENDING_ENROLLMENT` until the question is settled — unpaid meanwhile, which is the whole point of the duplicate check. The exemption row itself is left standing, so it is there to be asked for again.
- Approving is refused (`409`) while a duplicate review about this worker is open, whichever side of it they are on: approving would put a record back to work with no biometric at all while the older question — whether this record is a real person — is still unanswered.

**Withdrawing consent** (`POST /employees/{id}/biometric-consents/withdraw`) wipes the face at once and switches off the keys.

- Only an ADMIN records a withdrawal (HR may take the worker's written request to one). It is recorded on the dashboard, with no device; the database also allows one of the company's own kiosks, for a later kiosk route.
- If the face was in use and the worker is `ACTIVE`, the worker goes back to `PENDING_ENROLLMENT`, and the API **files** an exemption request (`CONSENT_WITHDRAWN`). The ADMIN who recorded the withdrawal is its asker, so a **different** ADMIN decides it: every exemption takes two ADMIN accounts.
  - While it waits, the worker can still clock in by a supervisor's co-sign. Those punches are stored and paired, but they raise `INACTIVE_EMPLOYEE` like any punch of a worker waiting for enrollment ([Attendance design](12-attendance-design.md) section 3), and payroll counts them only once a second ADMIN has approved. The worker's presence is on record from the first day, and they are paid in full once approved.
  - Once approved, the worker is `ACTIVE` again and clocks in by co-sign.
  - A worker who had **no face at all** — one already working under an approved exemption — loses nothing. There is nothing to wipe, their exemption stands, and their status does not move: one ADMIN must never be able to undo what two ADMINs agreed.
  - While a duplicate review about this worker is open, the face still goes — the law does not wait — but **no request is filed**, because approving one would put a record back to work before anyone has said whether it is a real person. The worker asks again once the review is settled.
- **Why not exempt at once?** A wiped face is no longer in the duplicate check. If one ADMIN could withdraw a face and keep that record working, they could enroll the same face again on a second record, and a third, with nobody else ever looking. Requiring a second person for every faceless worker closes that loop.
- An exemption already approved is kept. Any other face (waiting for review, or blocked) gives no request. An open review stays open, and a blocked face stays blocked. **Withdrawing never activates anyone.**
- A worker who withdrew may consent again later, unless the record is blocked as a duplicate.

**Transactions (for pull requests 4, 5, 7 and 9).** Every biometric transaction runs at READ COMMITTED, the default, because the database rules read the newest saved rows after waiting for a lock. A service that changes several rows (a decision and its block, a withdrawal, a revoke, the retention sweep, an exemption approval) first locks the workers involved, in id order (`SELECT … FROM employees WHERE id = ANY(…) ORDER BY id FOR NO KEY UPDATE`). Otherwise two ADMINs acting on the same people at the same moment can deadlock; PostgreSQL then cancels one, and the API answers `409` so they can try again. A decision locks every worker it can reach, including the one the losing record's own face looked like, because blocking that face makes the database lock that worker too — so the whole set is taken in one sorted statement, in the same order the retention sweep takes its batch. Waiting for a row is capped at 10 seconds everywhere, and running out answers `503` with a `Retry-After`, never a bare error. Registering a fingerprint key locks the kiosk's device row first, for the same reason.

**Seed data** gains a second ADMIN (so collisions and exemptions can be decided), two pending guards and one pending supervisor.

## 3. Face clock-in on the kiosk

**The app.** `apps/kiosk` is a separate app built with Vite, React 19, TypeScript and plain CSS, so the dashboard's files are untouched. It runs **Human 3.3.6** (pinned) with its face models only, about 13 MB, served from the kiosk itself and cached. It uses WebGL, falling back to WebAssembly, under a strict content security policy (`script-src 'self' 'wasm-unsafe-eval'`). It is hosted as its own Vercel project with the same `/api/v1` rewrite as the dashboard, so it shares the API's origin and needs no CORS change. In development, the kiosk's dev server forwards `/api/v1` to the API the same way (a Vite proxy on its own fixed port). The kiosk's address goes in `KIOSK_ORIGINS`, never in `CORS_ORIGINS`.

**Setup.** An ADMIN signs in on the kiosk, picks the site and registers the device (the existing `POST /devices`, kind `FACE_KIOSK`). The secret goes straight into a WebCrypto HMAC key that JavaScript cannot read back.

- A device registered from a kiosk session starts `INACTIVE`. An ADMIN switches it on from the dashboard's Devices page, so a kiosk session alone can never make a working key.
- The kiosk sends a heartbeat every minute.
- **If the browser's storage is lost,** an ADMIN signs in on the kiosk and rotates its secret (`POST /devices/{id}/rotate-secret`). The device then waits, `INACTIVE`, until it is switched on again from the dashboard. Its ID stays, so its fingerprint keys stay too.
- **If a kiosk's key may have been copied,** an ADMIN rotates it from the dashboard at once, then re-pairs the kiosk the same way.
- Screen pinning and a device PIN known only to ADMINs lock the device to the kiosk app.

**Device kinds are checked.** Each signed route lists the kinds it **allows**, and every other kind gets the same `401`:

- `/kiosk/*` allows only `FACE_KIOSK`;
- `/ingest/punches` allows `ZKTECO`, and `MOCK` only where the simulator is allowed (`ALLOW_SIMULATOR_DEVICES`: when it is not set, simulators work in development and are refused in production; TEST sets `yes` for its attendance demo);
- `/ingest/heartbeat` allows every kind.

A stolen kiosk key therefore cannot post raw `FACE` punches. A test proves that a correctly signed request with no token is refused on the ADMIN kiosk routes.

**Clock-in, step by step**

1. The worker taps **Start shift** or **End shift**.
2. The kiosk says "Look at the camera", then "Turn your head slowly LEFT" (or RIGHT, at random) and back. It needs one face of at least 224 pixels, `real` and `live` of at least 0.60, and the turn within 20 seconds. Then it takes one centred face sample.
3. `POST /kiosk/identify`. The server checks the anti-spoofing scores again, compares the sample with every `PASSED` or `CLEARED` face in the company, and records the attempt. The re-check catches a faulty kiosk, not a dishonest one: the kiosk measures the scores itself, so the kiosk is trusted (section 9).
   - A **match** needs a best score of at least **0.60** and a lead of at least **0.05** over the best *other* person. Anything else is `AMBIGUOUS`, `NOT_RECOGNISED` or `LOW_LIVENESS`.
   - A sample from another model, or with the wrong number of numbers, is refused by the contract's own schema with a `400` before any of this; the matcher checks again anyway, and says which of the two it was, so a broken kiosk is never recorded as a worker whose face did not look alive.
   - **If any stored face cannot be opened** (a damaged or moved template; the matcher reports them by id), identify and the duplicate check refuse to answer instead of deciding on the faces that did open, and the ADMIN sees it on the device page. A quietly shrunken comparison would break both the lead rule and the duplicate check (pull requests 4 and 5).
   - The score is Human's own similarity formula (MIT-licensed), copied to the server so both sides agree: `distance = 25 × Σ(aᵢ − bᵢ)²`, then `similarity = clamp((1 − √distance ÷ 100 − 0.2) ÷ 0.6, 0, 1)`. It is based on Euclidean distance, not cosine similarity. The thresholds live in one file (`face-thresholds.ts`, version `ft-1`), and every attempt records which version it used.
4. The answer contains the attempt ID, the worker's name and staff number, and a fingerprint challenge if one is needed. It **never contains a score**, so nobody can use the answers to probe the stored faces. No punch is made yet.
5. The kiosk shows "Hello, Kwame A. (SMT-00042)" for 2 seconds, with a **Not me** button, then asks for the finger if needed. **Not me** calls `POST /kiosk/not-me`: the attempt can no longer be confirmed, it counts as a failed attempt, and the pilot counts these wrong matches to tune the thresholds.
6. `POST /kiosk/confirm`. The attempt must come from the same device, be a `CLOCK` match (never a co-sign), be under 60 seconds old, and carry a valid fingerprint answer where one was asked for. The server then calls the Phase 2 `IngestService.ingestPunches` itself: `deviceEventId` is the attempt ID, `deviceUserRef` the staff number, the time is the **server's** time of the attempt (a kiosk cannot backdate), and the server chooses the method. Sending the confirmation again answers `DUPLICATE`. Pairing and `INACTIVE_EMPLOYEE` work exactly as in Phase 2.
7. The kiosk shows "Shift started 06:58", or "Recorded – please see your supervisor".

**After 3 failed face attempts in a row,** the kiosk offers "Use fingerprint" (section 4) or "Ask your supervisor".

A co-sign is only for three kinds of worker, and the server checks which (the kiosk cannot know):

- a worker with an **approved exemption** (a second ADMIN always decided it), who goes straight to "Ask your supervisor" with no face scan (scanning the face of someone who refused consent would break that refusal);
- a worker whose withdrawal of consent is waiting for a second ADMIN (the punch is stored but raises `INACTIVE_EMPLOYEE`, and is paid only after approval);
- a worker with a face in use (`ACTIVE`) whose face failed on this device: the same unlock as the fingerprint fallback (section 4), which the co-sign uses up.

The worker types their staff number. A supervisor then passes identify with purpose `CO_SIGN`, **that staff number** and the direction.

- Identify only records the staff number; it never checks it, so its answer cannot reveal who works where.
- If the supervisor has a fingerprint key on this kiosk, the co-sign needs the supervisor's finger too.
- `POST /kiosk/assisted-punches` must come from the **same device**, within 60 seconds. It checks everything:
  - the supervisor is ACTIVE, assigned to this site, and not the worker;
  - the worker is ACTIVE (or waiting for a withdrawal's decision) and posted to this site;
  - the worker is exempt, or is waiting for a withdrawal's decision (`PENDING_ENROLLMENT` with a `CONSENT_WITHDRAWN` request waiting), or has a face in use and the fallback is unlocked. An exempt or waiting worker goes straight to "Ask your supervisor", with no face scan and no unlock.

  Every refusal gets one identical answer.
- It then makes **one** `PIN_FALLBACK` punch, with the reason audited. The punch's ID comes from the co-sign attempt, so a co-sign can never be reused for a second punch, on another kiosk, or for a different worker.
- Rule R7 counts these per worker and per co-signer.

**Network address.** Every attempt records the client address as the hosting platform reports it, never a header the kiosk could set. Pull request 5 checks which header survives the kiosk's rewrite, with a test.

**Load.** One kiosk handles one person at a time. A clock-in takes about 15 seconds and 2 or 3 requests, so the existing limit of 60 signed requests per minute per device is plenty, even at a shift change.

**Offline,** nothing can be recorded, because the kiosk needs the server's time and a match for every clock-in. The kiosk says "Tell your supervisor", and the missed hours become a payroll adjustment in Phase 4, which needs maker–checker approval. They are never typed into attendance by hand: attendance only completes hours around real punches.

## 4. Fingerprint on the kiosk (passkeys)

**Library.** `@simplewebauthn/server` 14.0.2 and `@simplewebauthn/browser` 14.0.0 (pinned; see [Stack decisions](02-stack-decisions.md)). The relying party ID is the kiosk's domain, or `localhost` in development.

**Which devices.** `passkeysEnabled` is switched on only for Android phones with a fingerprint sensor and laptops with a Windows Hello fingerprint reader. iPhones and laptops without a sensor are face-only, because a shared iPhone's Face ID holds only its owner's face. Each kiosk uses its own dedicated Google or Microsoft account.

**Registration.** The ADMIN first adds the worker's finger in the device's own settings (Android holds 4 or 5 fingers).

1. `POST /kiosk/passkey-options` asks for a key held on this device only (`platform`), not a discoverable one, with the finger (user verification) required and no attestation. The key's user name is the staff number only, and its user ID is a random value, because a synced key can appear in the kiosk's cloud account. The challenge travels inside a sealed ticket that only the server can open, valid for 2 minutes.
2. `POST /kiosk/passkeys` checks the origin, the relying party ID and user verification, and refuses keys that say they come from another device (`cross-platform`). Without attestation this is what the browser reports: a safety net, not a proof. The key is bound to this worker **and** this device. The "synced" flag is stored and shown on the dashboard.

**Switching fingerprints off** on a device (`passkeysEnabled: false`) revokes every key saved on it, audited. The workers there clock in face-only (`FACE`) until their fingers are saved again, so the change is always visible and never a silent downgrade.

**Face, then finger (`FACE_PASSKEY`).** When the matched worker has a key on this device, identify includes a challenge that only that key can answer. The finger is then **required**: cancelling means no punch. Confirm checks the signature, user verification, the origin, that the key belongs to this worker and to the signing device, and that its counter went up (when the device uses one).

**Staff number, then finger (`STAFF_PASSKEY`).** This is offered through `POST /kiosk/fingerprint-options`, with narrow limits:

- It unlocks only when the 3 newest `CLOCK` attempts on this device **since its last fallback** all failed, the newest under 2 minutes old. A match cancelled with "Not me" is skipped, so the match and its `NOT_ME` row count as one failure. A fallback is any `STAFF_PASSKEY` attempt, or a co-sign that made a punch.
- **Every call uses up the unlock**, whatever the answer. It is recorded as a `STAFF_PASSKEY` attempt with the staff number tried (`FALLBACK_REFUSED` when refused), so one unlock can never be used to try staff numbers one after another, and someone trying numbers shows up in the attempt log.
- It works only for an ACTIVE worker posted to this site who has a key on this device.
- Every refusal gets the same answer, so the kiosk cannot be used to learn who works where.
- It counts as `PIN_FALLBACK` (shown amber and counted by R7), because any finger saved on the device can unlock any worker's key.

**The honest limit.** The device proves only that a finger (or the device PIN) saved on it unlocked this worker's key, never *whose* finger it was. That is why the face identifies and the finger only confirms. The screen says "fingerprint"; the data says "passkey". The production answer is the ZKTeco terminal, which matches fingers against everyone itself.

## 5. ZKTeco: the gateway and the simulator

**Gateway** (`apps/gateway`). Node 24 using only built-in modules (`node:http`, `node:sqlite`), on an always-on mini PC at the client's site, listening on the local network only (port 8081). It accepts only listed serial numbers from listed IP addresses, plus the comm key where the firmware supports it. It answers the terminal's handshake (real-time mode, UTC, no photos) and its command polls, and drops any stray photos without logging them.

**Translation.** Each attendance line becomes one punch:

- time: the device time, read as UTC;
- `deviceEventId`: 32 hex characters of SHA-256 over serial, user, time, status and verify mode, so a resent line is the same punch;
- status: 0 → `IN`, 1 → `OUT`, anything else → `UNKNOWN`;
- verify mode: 1 → `FINGERPRINT`, 15 → `FACE`, anything else → `PIN_FALLBACK`.

**Delivery.** Each line is written to a SQLite outbox **before** the gateway answers `OK`, then sent in signed batches of at most 100, with that terminal's own secret. A server error or a timeout is retried; a `401` raises an alarm. The gateway, the API, the simulator and the kiosk all pass one shared file of signature test vectors.

**Roster.** Every 5 minutes, a signed `POST /ingest/roster` returns the site's active and pending staff, leaving out any record blocked as a duplicate (so its fingers come off the terminals too). The gateway compares it with the terminal's user list and adds or removes users. It is safe to repeat, so the server needs no command table.

**Enrollment proof.** When a terminal reports a new finger, the gateway sends only "user 42 enrolled a finger on this terminal at this time" (`POST /ingest/enrollments`); the fingerprint template itself is discarded. A finger enrolled inside a 30-minute window that an ADMIN opened for that worker becomes ACTIVE (`NOT_CHECKED`, because our server cannot compare terminal fingerprints). Any other finger becomes `BLOCKED` and raises `UNEXPECTED_DEVICE_ENROLLMENT`. A terminal never activates anyone.

**Pull fallback.** `gateway pull` reads a terminal with `zkteco-js`, by hand, for backfilling only.

**Simulator** (`fake-terminal`). It talks to the real gateway, which talks to the real API. It covers the handshake, verify modes 1 and 15, Windows line endings and broken lines, a burst of 500 lines and a resend, command acknowledgements, fingers enrolled inside and outside a window, a photo, and an unknown serial number.

## 6. The contract

| Endpoint | Signed in as | Who |
|---|---|---|
| `POST /kiosk/identify`, `/kiosk/confirm`, `/kiosk/not-me`, `/kiosk/fingerprint-options`, `/kiosk/assisted-punches` | Kiosk signature | A `FACE_KIOSK` device |
| `POST /kiosk/consents`, `/kiosk/face-enrollments`, `/kiosk/passkey-options`, `/kiosk/passkeys` | Access token **and** kiosk signature | ADMIN |
| `POST /auth/login`, `/auth/2fa/verify`, `/auth/2fa/enable`: a sign-in from a `KIOSK_ORIGINS` address gets no refresh cookie and a kiosk-only token; two-factor setup is refused there | Public | The kiosk operator |
| `POST /devices`, `POST /devices/{id}/rotate-secret` from a kiosk sign-in: `FACE_KIOSK` only, and the device stays `INACTIVE` until switched on from the dashboard | Kiosk token | ADMIN |
| `GET /biometrics/consent-text` | Access token | Any signed-in user |
| `GET /attendance/punches` (live clock-ins board) | Access token | ADMIN, HR_PAYROLL; SUPERVISOR for their own sites |
| `GET /attendance/clock-in-attempts` | Access token | ADMIN |
| `GET /employees/{id}/biometrics` (statuses only) | Access token | ADMIN, HR_PAYROLL; SUPERVISOR for their own sites |
| `POST /employees/{id}/biometrics/revoke`, `/biometric-exemption` | Access token | ADMIN |
| `POST /employees/{id}/biometric-exemption/review` | Access token | ADMIN who did not ask, and did not enroll, revoke or withdraw a face for the worker |
| `POST /employees/{id}/biometric-consents/withdraw` | Access token | ADMIN (its exemption request then needs a different ADMIN) |
| `GET /biometric-collisions` | Access token | ADMIN |
| `POST /biometric-collisions/{credentialId}/resolve` | Access token | ADMIN who did not enroll this face, and did not revoke or withdraw a face of either record |
| `PATCH /devices/{id}` gains `serialNumber` (ZKTeco only, unique) and `passkeysEnabled` (kiosks only; off revokes the keys) | Access token | ADMIN |
| `POST /devices/{id}/finger-enrollment-windows`, `POST /ingest/roster`, `/ingest/enrollments` | Access token / terminal signature | Added to the contract with the gateway (pull requests 8 and 9) |

No response carries an embedding, a template or a Ghana Card number, and no kiosk response carries a score.

## 7. Testing, and the demo without hardware

- **Where to test:** laptops on `localhost`, and phones only on the fixed TEST kiosk address. Preview addresses change the relying party ID, and plain-HTTP addresses on the local network block the camera. Load time and frame rate are measured on an Android phone, an iPhone and a Windows laptop.
- **CI:** Playwright with Chrome's virtual authenticator, and a stand-in for Human that produces made-up face samples. The logger-spy test that proves an embedding never reaches a log also covers the error paths (a `400` and a `413` on the kiosk routes).
- **Pilot:** 10 or more consenting volunteers. A `face:scores` script prints how same-person and different-person scores spread, which is how threshold version `ft-1` (including the duplicate threshold) gets its final numbers. **The script is built** (`pnpm --filter @samtec/api face:scores`, machinery in `face-score-study.ts`) and written up in [The face-matcher threshold report](../guides/14-face-threshold-report.md), which also says what a generated stand-in cannot show and exactly what the pilot must do. The pilot itself is still owed.
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
| 4a | The kiosk door: sign-in (`KIOSK_ORIGINS`, no refresh cookie, kiosk-only token), the kiosk ADMIN guard, the consent text and consent | Overlapping origin lists stop the API; a kiosk sign-in gets no cookie and 403s everywhere but the kiosk screens; two-factor setup is refused on a kiosk; a half-done sign-in cannot be finished elsewhere; a kiosk sets up only a kiosk; consent needs the kiosk **and** the ADMIN, and a wrong card answer is a 400 that is audited, five of them a 429 |
| 4b | Enrollment, collisions, revoke, withdraw, the two-ADMIN exemption, retention sweep | The same face twice → COLLISION; parallel enrollments caught; resolver ≠ enroller; nobody decides on their own action (the enroller, the asker, whoever wiped a face); a withdrawn face enrolled again on a new record leaves the first record `PENDING_ENROLLMENT` and unpaid until a second ADMIN approves; a revoke during a review, or while an exemption request waits → 409; a blocked record stays blocked through revoke, withdrawal and the sweep; withdrawal never activates; a suspended worker stays suspended; clean logs |
| 5 | Identify, confirm, "Not me", co-sign, the live clock-ins board | A resend → `DUPLICATE`; the margin rule; no scores returned; one co-sign makes one punch, on its own device only, and only for an exempt worker, a worker waiting for a withdrawal's decision (the punch raises `INACTIVE_EMPLOYEE`), or after the unlock; a pending worker with no withdrawal waiting is refused; confirm refuses a co-sign; every fallback call uses up its unlock |
| 6 | `apps/kiosk` (needs the owner's OK for a new Vercel project) | Shared signature vectors; Playwright. **The face demo works.** |
| 7 | Passkeys | No user verification, keys from another device, and foreign keys all refused. **The full demo works.** |
| 8 | Gateway and fake terminal | Outbox written before `OK`; 500 lines → 5 batches |
| 9 | Roster, enrollment windows, pull script, demo guide, threshold report | A finger nobody asked for → an exception; a record blocked as a duplicate leaves the roster |

**Samuel's dashboard screens** (enrollment itself happens on the kiosk):

- a live clock-ins board, refreshed every 5 seconds, with method badges, and `PIN_FALLBACK` and `STAFF_PASSKEY` shown in amber (`GET /attendance/punches`);
- a Biometrics panel on the employee page: consent, face status, fingerprint keys and exemption, with the actions revoke, withdraw, ask for an exemption, and approve or reject one (the ADMIN who asked, or who enrolled or wiped a face for the worker, cannot decide it);
- the duplicate-enrollment queue (open and resolved), where the note is required, the enroller and anyone who wiped either face cannot decide, and `SAME_PERSON` asks which record to keep;
- kiosk attempts per device (ADMIN);
- the new device fields (`serialNumber`, `passkeysEnabled`) on the Devices page, and switching on a kiosk that is waiting (`INACTIVE`) after its set-up.

The mock API already supports all of them.

## 9. Risks and honest limits (for the report)

1. **The kiosk is trusted.** Browser anti-spoofing is prototype-grade. It stops printed photos and screens held up to the camera, but not a replayed video, a mask or a modified kiosk.
   - The kiosk measures the scores itself. So someone who copies a kiosk's key can make face samples from a photo, give them high scores and clock a worker in from anywhere, and the server cannot tell.
   - A copied key can also make co-signed punches (flagged `PIN_FALLBACK`) for anyone posted to that site, using a supervisor who has no fingerprint key on that kiosk.
   - What limits the harm: the key only works on the kiosk routes; a worker or supervisor with a fingerprint key on that kiosk still needs the finger; every attempt records its network address, so Phase 5 can flag a kiosk key used from two places; and the ADMIN can rotate the secret.
   - The production answer is terminals with infrared sensors. A further step would be a key pair made inside the kiosk that can never be read out, so no secret ever travels.
2. **The device fingerprint identifies nobody** (section 4), and a phone holds only about 5 fingers.
3. **Passkeys can sync** (always on iCloud, by default on Google). A new kiosk domain means registering the fingers again.
4. **Face accuracy on Ghanaian faces is unpublished.** The margin rule, the "Not me" button and Phase 4's maker–checker payroll limit the harm of a false match. Twins may need the finger or a co-sign.
5. **More guards means more false collisions:** the chance is 1 − (1 − FMR)^N. At a 0.1% false-match rate and 500 guards, about 39% of enrollments would need a review, so the pilot sets the threshold.
6. **Every clock-in decrypts every face.** That is fine up to about 300 guards. A vector index (pgvector) would need unencrypted templates, so it waits until the size demands it.
7. **Human is barely maintained** (3.3.6, from August 2025, is its latest release). It is pinned behind the `BiometricProvider` interface. Changing the model means enrolling everyone again.
8. **One ADMIN can create and enroll a fake person with an accomplice's face** (a face nobody else has enrolled). Both steps are audited, Phase 5 flags it, and probing shows in the attempt log. Activating someone *without* a face always takes a second ADMIN account.
9. **ZKTeco firmware is unverified** until a terminal is bought, and our server cannot compare terminal fingerprints.
10. **Act 843** needs a legal check, and the client must register with the Data Protection Commission.
11. **One master secret.** A leaked `AUTH_SECRET` lets someone forge sign-ins and, together with a copy of the database, read the face templates. It lives only in the hosting settings, is never shared between TEST and production, and is backed up offline.
12. **One person with two ADMIN accounts** (for example one they created, or one whose sign-in they reset) defeats every two-person rule. User changes are audited, rule R11 flags a decision made by an account that a handler created, reset or promoted, and Phase 7 makes creating or resetting an ADMIN account need a second ADMIN.
13. **Indirect links are flagged, not blocked.** An ADMIN who created a record, or enrolled the other face, may still decide its review, so that small companies never deadlock. Rule R11 shows those decisions to the payroll checker.
14. **One ADMIN can register a device and send punches with its key** (a terminal or, where allowed, a simulator), with any method a terminal may claim. Registration is audited, every punch names its device, rule R9 flags a device whose volume jumps, and the payroll checker sees the device behind each shift. Phase 7 makes registering a device or rotating its secret need a second ADMIN.

Related: [Biometric integration](10-biometric-integration.md) · [Attendance design](12-attendance-design.md) · [Security and review gates](06-security-and-review-gates.md) · [Roadmap](07-roadmap.md)
