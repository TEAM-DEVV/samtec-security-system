# SAMTEC gateway

The small always-on service at a client's site that speaks to ZKTeco
fingerprint terminals and forwards what they saw to the API. It is the
production fingerprint path; the kiosk is the phone-and-face path.

Design: [Biometrics design](../../docs/plan/13-biometrics-design.md),
section 5. Node 24 and **built-in modules only** (`node:http`,
`node:sqlite`) — a mini PC at a site must not depend on anything that
needs installing beyond Node itself.

## The one promise everything here serves

**A terminal hears `OK` only after its lines are on disk.** Once a terminal
hears `OK` it never resends the line, so an `OK` for a line held only in
memory would quietly lose a punch — and a lost punch is a person quietly not
being paid. The outbox (`src/outbox.ts`) is written inside a transaction
before the answer is sent; the power can fail right after and nothing is
lost. Delivery to the API happens separately, in signed batches of at most
100, retried until the API has answered for every line.

## Running it

```bash
pnpm --filter @samtec/gateway start
```

It reads its configuration from `~/.samtec/gateway.json` (or
`SAMTEC_GATEWAY_CONFIG`) — **outside the repository, because it holds each
terminal's device secret**. The shape is documented at the top of
[`src/config.ts`](src/config.ts). Each terminal is a `ZKTECO` device
registered on the dashboard's Devices page: born switched off, switched on
by a second administrator, like every device key.

Point the terminal's "ADMS" / cloud-server setting at the gateway's address
and port (8081 by default). The gateway listens on the site's own network
and must never be exposed to the internet.

## Trying it with no hardware

The fake terminal drives the real gateway, which talks to the real API —
nothing in the chain is a stub except the hardware:

```bash
pnpm --filter @samtec/gateway fake-terminal -- --gateway http://127.0.0.1:8081 --serial ZKDEMO0001
```

It performs the handshake, uploads a burst of punches, resends the same
burst (which changes nothing — that is the point), and polls for commands.
The e2e test (`test/gateway.e2e.test.ts`) runs the same scenarios plus the
unpleasant ones: 500 lines into 5 batches, an API outage mid-delivery, a
`401` alarm, broken lines, a photo upload, an unknown serial.

## What each file does

| File | What it does |
|---|---|
| `src/iclock.ts` | The terminal's language, as pure rules: attendance and operation lines in, punches and enrollment proofs out. Photos are dropped whole — never parsed, never logged. |
| `src/outbox.ts` | The SQLite outbox and the command queue. Lines are stored before `OK`, marked sent only after the API answered, kept two weeks for disputes. |
| `src/server.ts` | The HTTP door: handshake, uploads, the command poll. Only listed serials from listed addresses; one `DENIED` for every refusal, so nothing can map what is listed. |
| `src/delivery.ts` | The loops: signed batches out, the roster back every five minutes (adds who is named, removes who is not — a blocked duplicate's fingers come off the terminal), and the heartbeat. A `401` raises one loud alarm and never drops rows. |
| `src/signing.ts` | The device signature, third implementation of the one scheme — pinned to the same shared vector the kiosk and the API assert. |
| `src/api.ts`, `src/config.ts`, `src/main.ts` | The signed calls, the checked configuration, and the assembly. |
| `test/fake-terminal.ts` | The simulator, usable by hand and by the tests. |

## Honest limits

- The iClock dialect here is the subset the fake terminal speaks. **When a
  real terminal is bought, its firmware's quirks are reconciled in
  `src/iclock.ts` and the fake terminal together** — the translation is pure
  precisely so that reconciling it cannot touch the outbox or delivery.
- The gateway trusts its terminals' matching. Our server cannot compare
  terminal fingerprints (docs/plan/13 section 9), which is why a finger
  enrolled outside an administrator's 30-minute window is blocked by the API
  and raises an exception rather than being believed.
- `gateway pull` (reading a terminal by hand for backfill) is not built; it
  waits for the hardware it would read.
