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
machine. The dashboard keeps port 5173, and both can run at once.

To point it at a real API, set `VITE_API_URL`. It defaults to
`http://localhost:3000/api/v1`.

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

Still to do, in this order:

1. **Consent and enrollment**, and saving a worker's finger — the three screens
   an administrator uses to put somebody on the system. These need an ADMIN
   signed in on the kiosk, which set-up deliberately does not do today.
2. **The staff-number fingerprint fallback** and **the supervisor's co-sign** —
   the screen currently names them as the way out after three failures without
   offering them yet.
3. **The real Human engine** behind `FaceEngine`, with the models served from
   this app's own origin (never a CDN: a tampered model that always passes
   liveness would be invisible).

## A rule about messages

**Nothing on the everyday screen may ever show a score, or say who a face looked
like.** Anyone at all can stand in front of a kiosk, so every message has to be
safe to show a stranger: a name they have just proved, or "try again". A
collision at enrollment says only "needs an admin review".

`clock-screen.test.tsx` asserts this by reading the whole rendered screen and
refusing to find a number, an outcome name, or the words score, match or
confidence.
