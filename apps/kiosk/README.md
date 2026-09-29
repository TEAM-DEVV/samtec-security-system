# SAMTEC kiosk

The app on the phone at the gate. A guard walks up, looks at it, and their
shift starts.

This is the live demo of the whole project: it is where a face becomes a punch,
which becomes a shift, which becomes pay.

Design: [Biometrics design](../../docs/plan/13-biometrics-design.md), sections
2, 3, 4 and 7. Who owns what: [Work split](../../docs/plan/14-work-split.md),
Job B.

## Running it

```bash
pnpm dev:kiosk
```

Opens on <http://localhost:5174> with a **pretend camera**, so it runs on any
machine. The dashboard keeps port 5173, and both can run at once. Press
**Start shift** and the pretend head performs the turn by itself.

To set a phone up you need the **device ID and secret**, both shown on the
dashboard right after you register a device (Devices → Add device). The secret is
shown once only.

**The API is always on this app's own origin, `/api/v1`.** The dev server proxies
it to `http://localhost:3000` (`vite.config.ts`) and the deployment rewrites it
(`vercel.json`). That is not a convenience: the deployed content security policy
sets `connect-src 'self'`, and a WebAuthn key is bound to an origin, so a
cross-origin API would break the fingerprint path. Override with
`VITE_API_BASE_URL` (the same name the dashboard uses) only when you mean to, and
`VITE_API_PROXY` to move where the dev server forwards.

## Why it looks nothing like the dashboard

| | Dashboard | Kiosk |
|---|---|---|
| Styling | Tailwind + shadcn/ui | One hand-written stylesheet |
| Routing | React Router | None — two states |
| Data | TanStack Query through `$api` | One `fetch` wrapper |
| Who signs in | Everybody | **Nobody** |

A kiosk has six screens and has to start quickly on a cheap Android phone
screwed to a wall, so every kilobyte of framework is a kilobyte a guard waits
for in the rain. There is no router because a router would let somebody type
their way to a screen, and every screen except the everyday one belongs to an
administrator.

## The heartbeat is not optional

Every kiosk posts `ingest/heartbeat` once a minute
([`lib/heartbeat.ts`](src/lib/heartbeat.ts)). This looks like a nicety and is
not: the API has **no scheduled job** for either of the two things that ride on
it.

- `repairOverdueClockIns` — the only way a forgotten clock-out is ever noticed
  when nothing else happens at that site.
- the biometric retention sweep — the only thing that deletes a face template
  when its time is up, which is a promise made to every worker who consented.

A kiosk that does not tick is a kiosk where nobody's shift gets repaired and
nobody's biometrics are ever deleted. The design chose a heartbeat over a cron
entry precisely so there is no extra secret to manage, which means the kiosk
carries that responsibility.

## The three things that are easy to get wrong

**1. Signing.** Every `kiosk/…` call is signed by the device:
`HMAC-SHA256(secret, "v1\n<timestamp>\n<route>\n<body>")`, where `<route>` is
the route *name* (`kiosk/identify`) and not the URL, and `<body>` is the **exact
JSON text sent**. Serialise once, sign that string, send that string —
re-serialising changes a space somewhere and the server refuses everything with
a 401 that says nothing about why.

The one definition on the server is
[`device-signature.ts`](../api/src/modules/attendance/device-signature.ts).
Both sides assert the same worked example
([`device-signature-vector.ts`](../../packages/contracts/src/device-signature-vector.ts)),
so if either implementation drifts, exactly one test goes red and it names the
side that moved. **Do not change one without the other.**

**2. The secret is never written down.** It is turned into a non-extractable
`CryptoKey` the moment it is typed in, and only the key object is stored (in
IndexedDB, which can hold one). The browser keeps the bytes and will not hand
them back — not to our code, and not to anything that later manages to run on
this page. `localStorage` could not do this: it stores text, so the secret would
be readable forever by one line of script.

**3. Liveness is the kiosk's job.** The server checks the anti-spoofing numbers
again, but **it cannot see the camera**. If the challenge here is weak, the whole
thing is weak. A random LEFT or RIGHT head turn, completed within 20 seconds,
then one centred sample — which is what a printed photograph cannot do, and what
`clock-screen.test.tsx` proves with a pretend head that never turns.

## The pretend camera must never be deployed

It accepts any frame. A production build running on it would do **no face check
at all** — anybody could clock in as whoever the server last matched. So
`defaultEngine()` in `app.tsx` **throws** in a production build rather than fall
back to it. The kiosk refuses to run instead of pretending to check faces, and
that guard stops mattering only when the real Human engine lands.

## The face engine is behind a seam

[`lib/face.ts`](src/lib/face.ts) defines a `FaceEngine`; nothing above that line
knows what produces a face template. Two reasons, both the same reason the API
puts its matching behind `BiometricProvider`:

- Human 3.3.6 is pinned and its last release is from August 2025. The day it
  stops working, the replacement goes in behind this interface and no screen
  changes.
- A real engine needs a camera, a face and about 10 MB of models, and gives a
  slightly different answer every run. None of that can be asserted against, so
  [`lib/face-mock.ts`](src/lib/face-mock.ts) fakes **the camera and nothing
  else** — every threshold, the challenge and the shape of a sample are the real
  ones.

What the mock cannot prove is whether the real models accept a real face. That
is what the Android check in design section 7 is for, and it is still to do.

## What is built, and what is not

Built:

- **Set-up** (`screens/pairing-screen.tsx`) — an administrator pastes the device
  ID and secret from the dashboard's Devices page.
- **Clock in and out** (`screens/clock-screen.tsx`) — the head-turn challenge,
  `POST /kiosk/identify`, the name for two seconds with a **Not me** button, then
  `POST /kiosk/confirm`. Three failures in a row offer the fallbacks.
- **An administrator signing in** (`screens/admin-sign-in-screen.tsx`) — email,
  password and the six-digit code. Reached from the small **Admin** button on the
  resting screen. Two-factor *set-up* is refused here on purpose: it means
  showing a QR code and a secret key on a screen bolted to a wall.
- **Consent and enrollment** (`screens/enroll-screen.tsx`) — the official consent
  wording shown exactly as the server sends it, the last four digits of the Ghana
  Card, then three face captures with a fresh head turn before each. A collision
  says only *needs an admin review*.

### Why an administrator can sign in on a phone on a wall

Because enrollment can only happen at a kiosk, and nothing else in the system can
put a face on file. The session is deliberately poor, and the server makes it so:
**no refresh token at all**, fifteen minutes, ADMIN only, and it works on the
kiosk screens and nowhere else. It is held in a variable — never `localStorage`,
never IndexedDB — so a reload ends it, and the app signs out on the way back to
the clock-in screen rather than waiting for the clock.

The API knows a sign-in is a *kiosk* sign-in from the browser's `Origin` header,
which a page cannot forge. That is why the kiosk's address has to be in
`KIOSK_ORIGINS` (already set to `http://localhost:5174` in `.env.example`) and why
this app talks to `/api/v1` on its own origin.

**Everything is built.** The real camera is Human 3.3.6 behind the
`FaceEngine` seam (`lib/face-human.ts`): loaded lazily so the everyday screen
never waits for it, with its five model files committed at `public/models/`
and served from this app's own origin, their SHA-256s pinned in the README
there. Production builds always get the real engine; `pnpm dev:kiosk` keeps
the pretend camera (set `VITE_FACE_ENGINE=human` to try the real one locally).

**One check no test can do** (docs/plan/13 section 7): on a real Android
phone and an iPhone at the deployed kiosk address, confirm the models accept
real faces, that a printed photograph is refused, and that the head-turn
direction matches the instruction — `YAW_SIGN` in `lib/face-human.ts` is the
one value that check exists to confirm, and flipping it is a one-line fix.

The fingerprint paths are built: a clock-in whose worker has a key here asks
the sensor and confirms with its assertion (`FACE_PASSKEY`); after three failed
faces the **Another way in** screen (`screens/fallback-screen.tsx`) offers the
staff-number-plus-finger fallback (`STAFF_PASSKEY`, flagged) and the
supervisor's co-sign (`PIN_FALLBACK`, with an audited reason); and the enroll
screen saves a worker's finger (`kiosk/passkey-options` → the sensor →
`kiosk/passkeys`). The WebAuthn JSON↔buffer translation lives in
`lib/passkeys.ts` and is pinned by tests, because one wrong character there
fails every fingerprint with an error that names nothing.

## A rule about messages

**Nothing on the everyday screen may ever show a score, or say who a face looked
like.** Anyone at all can stand in front of a kiosk, so every message has to be
safe to show a stranger: a name they have just proved, or "try again". A
collision at enrollment says only "needs an admin review".

`clock-screen.test.tsx` asserts this by reading the whole rendered screen and
refusing to find a number, an outcome name, or the words score, match or
confidence.
