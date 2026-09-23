# 14 · Who builds what next (Francis and Samuel)

Samuel is close to finished on the dashboard's current work, so this page says
exactly what he picks up next, why it is his, and what he never has to wait
for. It exists so neither of us ever sits idle, and so we never edit the same
file at the same time.

Read [Roadmap](07-roadmap.md) for the order of the phases and
[Biometrics design](13-biometrics-design.md) for the rules of Phase 3.

## The split, in one line

**Francis builds what decides things** (the API, the rules, the database).
**Samuel builds what people touch** (the dashboard, the kiosk app, the fake
terminal) — and those are whole apps of their own, so our files never meet.

| Folder | Owner | Why |
|---|---|---|
| `apps/api` | Francis | One person owns the rules, so they stay consistent |
| `apps/web` | Samuel | The dashboard |
| `apps/kiosk` | **Samuel** | A new app. See Job 1 |
| `apps/gateway` | **Samuel** | A new app. See Job 3 |
| `packages/contracts/openapi.yaml` | Both | Rule 1: contract first. See "When it has to change" |
| `docs/` | Both | Whoever does the work writes the page |

Nothing in Samuel's list needs Francis to finish anything first. Every API
route each job uses is **already built and merged**, or already answered by
the mock API.

---

## Job 1 · The kiosk app (`apps/kiosk`) — start here

This is the demo. A guard walks up to a phone on the wall, looks at it, and
their shift starts. It is the single most valuable thing left to build, and
every API route it needs is merged and working today.

**What it is.** A separate Vite + React + TypeScript app, its own Vercel
project, plain CSS (do not pull in the dashboard's Tailwind setup — a kiosk
has six screens and must boot fast on a cheap Android phone). Design and
rules: [Biometrics design](13-biometrics-design.md) sections 2, 3, 4 and 7.

**The screens, in the order a device lives through them**

1. **Set-up** (once per device, by an ADMIN). Sign in, pick the site,
   register the device → `POST /devices` with `kind: FACE_KIOSK`. The secret
   comes back **once**: put it straight into a WebCrypto HMAC key that
   JavaScript cannot read back, and never store the raw string.
2. **Consent** (an ADMIN enrolling a worker). Show the exact words from
   `GET /biometrics/consent-text`, take the worker's agreement, ask for the
   last 4 digits of their Ghana Card → `POST /kiosk/consents`.
3. **Enrollment** (the same ADMIN). Three face captures half a second apart →
   `POST /kiosk/face-enrollments`. The answer says `PASSED` or `COLLISION`;
   on `COLLISION` say only "Needs an admin review", never who it looked like.
4. **Save the worker's finger** (the same ADMIN, right after the face, and
   only on a kiosk whose `passkeysEnabled` is on). The worker's finger must
   already be saved in the phone's own settings. `POST /kiosk/passkey-options`
   → hand `options` **unchanged** to `navigator.credentials.create()` →
   send the browser's answer, with the `ticket` exactly as it came, to
   `POST /kiosk/passkeys` within 2 minutes. If the answer says `synced: true`,
   tell the ADMIN the phone may copy this key to its cloud account.
5. **Clock in / out** (the everyday screen, no sign-in). Start shift / End
   shift → head-turn challenge → `POST /kiosk/identify` → show
   "Hello, Kwame A." for 2 seconds with a **Not me** button →
   `POST /kiosk/confirm`. "Not me" calls `POST /kiosk/not-me`.
   **If `identify` answers with `fingerprint`, the finger is required**: pass
   `fingerprint.options` unchanged to `navigator.credentials.get()` and send
   the answer as `assertion` on `POST /kiosk/confirm`. Cancelling it makes no
   punch at all — do not fall back to confirming without it, because the
   server will refuse anyway.
6. **Ask your supervisor.** After 3 failed face attempts, or straight away
   for a worker the server says cannot use their face: the supervisor looks
   at the camera and types the worker's staff number →
   `POST /kiosk/identify` with `purpose: CO_SIGN` → `POST /kiosk/assisted-punches`.
   That identify may ask for the **supervisor's own** finger too; when it
   does, send the assertion as `assertion` on the assisted punch.
   The same three failures also open `POST /kiosk/fingerprint-options`: the
   worker types their staff number and uses any finger the phone knows, and
   the answer's `options` go to `navigator.credentials.get()` and then to
   `POST /kiosk/confirm` like any other. Offer it only after three failures,
   because every call spends the unlock whatever the answer.

**Which screens need somebody signed in**

Two different doors, and mixing them up costs an afternoon:

| Screen | What the request carries |
|---|---|
| Set-up (`POST /devices`) | An ADMIN's access token. No signature — there is no device yet |
| Consent, enrollment, saving a finger | The ADMIN's token **and** the device's signature. The ADMIN signs in on the kiosk; that session works on kiosk screens only |
| Clock in, "Not me", confirm, the staff-number fallback, co-sign | The **device's signature alone**. No token, ever — the guard at the gate has no account |

**The three things that are easy to get wrong**

- **Signing.** Every `kiosk/…` call is signed by the device:
  `HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`, where `<route>`
  is the name (`kiosk/identify`), not the URL, and `<body>` is the **exact
  JSON text sent** — serialise once, sign that string, send that string.
  Headers: `X-Samtec-Device`, `X-Samtec-Timestamp`, `X-Samtec-Signature`.
  The one definition is `apps/api/src/modules/attendance/device-signature.ts`
  — read `signRequest` there and copy its shape exactly. There is no shared
  test vector yet, and writing one is part of this job (design section 8,
  row 6): a fixed secret, timestamp, route and body with the signature they
  must produce, checked by a test on **both** sides, so the two
  implementations can never drift apart without a test going red.
- **Liveness is the kiosk's job.** Human 3.3.6, pinned, face models only, from
  the kiosk's own origin. One face at least 224 pixels, `real` and `live` at
  least 0.60, a random LEFT or RIGHT head turn completed within 20 seconds,
  then one centred sample. The server checks the numbers again, but it cannot
  see the camera: if this is weak, the whole thing is weak.
- **WebAuthn's objects travel through untouched.** Whatever
  `passkey-options` or `fingerprint` hands over goes to the browser exactly
  as it came, and whatever the browser answers goes back exactly as it came
  (`response.toJSON()` in Chrome, or `@simplewebauthn/browser`). Rebuilding
  those objects by hand is how a whole afternoon disappears: the bytes are
  signed, so one changed field means the server refuses everything. The
  kiosk's address must be the one in `KIOSK_ORIGINS` — a key made on one
  address can never be used on another, which is the point.
- **The answers never carry a score, and neither may the screen.** Show the
  name or "Try again". Never "close match", never a number, never who a face
  looked like. Anyone can stand in front of a kiosk.

**Done when** a real face clock-in on an Android phone appears on the
dashboard within 5 seconds, a printed photograph is refused, and a worker
whose finger is saved on that phone is asked for it and shows up on the
board as `FACE_PASSKEY`.

> Francis: create the Vercel project for `apps/kiosk` and add its address to
> `KIOSK_ORIGINS` before Samuel's first deploy. Ask the owner first.

## Job 2 · The Phase 3 dashboard screens

All five are answered by the mock API today and by the real API on TEST.

- The **live clock-ins board** — `GET /attendance/punches`, refreshed every 5
  seconds, method badges, `PIN_FALLBACK` and `STAFF_PASSKEY` in amber.
- The employee **Biometrics panel** — `GET /employees/{id}/biometrics`, with
  revoke, withdraw, ask for an exemption, and approve or reject one. Whoever
  asked, or enrolled or removed a face for that worker, cannot decide it: the
  API answers 403, so show that plainly rather than hiding the button.
- The **duplicate-enrollment queue** — `GET /biometric-collisions`, resolve
  with `POST /biometric-collisions/{id}/resolve`. The note is required, and
  `SAME_PERSON` asks which record to keep.
- **Kiosk attempts per device** (ADMIN) — `GET /attendance/clock-in-attempts`.
  This is how an ADMIN sees somebody holding photographs up to a camera.
- The new **device fields** on the Devices page: `serialNumber`,
  `passkeysEnabled`, and switching on a kiosk that is waiting (`INACTIVE`).

## Job 3 · The fake ZKTeco terminal, and then the gateway

Only after Jobs 1 and 2, and only if Francis has not reached it first — check
`docs/plan/07-roadmap.md` and the open pull requests before starting.

The **fake terminal** is a small script that behaves like a ZKTeco device:
it holds a roster, produces punches with verify modes (1 → `FINGERPRINT`,
15 → `FACE`, anything else → `PIN_FALLBACK`), and drives the gateway end to
end. It needs no new API. Rules: [Biometrics design](13-biometrics-design.md)
section 5.

## Phases 4 and 5 stay with Francis

Payroll ([Payroll engine (Ghana)](09-payroll-engine-ghana.md)) and ghost
detection ([Ghost detection engine](08-ghost-detection-engine.md)) are money
and evidence: one person owns those rules end to end. Samuel builds their
**screens** once the endpoints land — the period close, the approval, the
payslip, the alert queue — and the contract and mock API for each arrive
before the API does, so he is never blocked.

## When the contract has to change

Rule 1 of the root `CLAUDE.md`, and it is the only rule that can cost us a
day if we skip it:

1. Change `packages/contracts/openapi.yaml` **first**.
2. Run `pnpm contracts:generate`.
3. Update the mock handlers in `apps/web/src/mocks/handlers/` in the **same**
   change.
4. Put what the other side must do under a heading **"For the API (Francis)"**
   or **"For the dashboard (Samuel)"** in the pull request description. Each
   of us reads the open pull requests for that heading at the start of every
   session.

`openapi.yaml`, the mock handlers and this roadmap are the three files we
both touch. When they conflict, **keep both sides** — never delete the other
person's lines to make a conflict go away.

## The rhythm

- Branch from `main`, prefix it (`feat/`, `fix/`, `docs/`), open the pull
  request early and merge it as soon as CI is green.
- At most two open pull requests each, so conflicts stay small.
- Every merge to `main` deploys to TEST by itself, migrations and all.
- `pnpm check` before calling anything finished.
