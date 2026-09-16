# 10 · Biometric integration

**The core fact:** a web browser cannot talk to an ordinary USB fingerprint scanner. Every workable option goes around that problem. We build against an interface, so hardware never blocks the project.

## The provider interface (backend, Phase 2)

```ts
interface BiometricProvider {
  /** Capture and store a new template. Returns the template and its quality. */
  enroll(employeeId: string, capture: CaptureRequest): Promise<EnrollResult>;
  /** 1:N identification: whose finger or face is this? */
  identify(sample: Sample): Promise<MatchResult>;
  /** Compare a new template against every stored one. */
  dedupeCheck(template: Template): Promise<CollisionResult>;
  // Punches usually arrive through the ingest endpoint, not through this interface.
}
```

Implementations: `MockProvider` (development, demos, CI), `ZKTecoProvider` and `FaceKioskProvider`. A configuration setting picks one, and the rest of the system cannot tell the difference. **This is why the whole system can be demonstrated with no hardware at all.**

## Path A: ZKTeco terminal (primary, recommended to the client)

The device captures the fingerprint, stores the templates and matches on board. We receive the punch logs.

- **Push (preferred):** switch the device to ADMS ("cloud server") mode. It then sends punch records to our API over HTTP in real time, which also works behind routers. Open-source Node.js implementations exist for reference.
- **Pull (fallback):** a scheduled job uses `zkteco-js` or `node-zklib` over TCP port 4370 to read attendance records and the user list. This works on the same local network.
- **Enrollment:** happens at the terminal. We sync the user list and link each device user ID to an employee. Export templates for the duplicate check where the firmware allows it; otherwise the duplicate check relies on the Ghana Card number and the face path.
- **Hardware:** K40 (budget), F22, or SpeedFace (face and fingerprint). **Order in Phase 0.**

## Path B: face kiosk in the browser (secondary, and the star of the demo)

`apps/kiosk` runs on any tablet or laptop with a camera.

- **@vladmandic/human** is actively maintained and replaces the abandoned face-api.js. It provides face detection, face descriptors (embeddings) and a built-in anti-spoofing score.
- **Enroll:** capture several frames and store the embedding on the server. **Identify:** compare a new embedding against the stored ones (cosine similarity in PostgreSQL, with pgvector if needed).
- **Liveness:** Human's anti-spoofing score, plus a random blink or head-turn challenge. The honest line for the report: photo attacks are partly mitigated, and the hardware terminal is the production answer.
- **PIN fallback** is allowed but flagged, which feeds detection rule R7.

## Path C: fingerprint reader in the browser (optional, only if the client insists)

- **SecuGen WebAPI:** a small service from the vendor, installed on the computer, lets a web page capture and match fingerprints from SecuGen readers. It is the one honest "fingerprint in the browser" option.
- **DigitalPersona (HID)** works in a similar way, through a local Windows service and a JavaScript SDK.
- **Costs:** vendor lock-in and an installation on every desk. Keep it out of version 1 unless the client requires it.

## Decision matrix (for the client presentation)

| | ZKTeco terminal | Face kiosk | SecuGen in browser |
|---|---|---|---|
| Resistance to spoofing | High (on the device) | Medium (liveness checks) | High |
| Cost per site | About $70 to $200 per device | Almost nothing (existing tablet) | Reader plus licence per desk |
| Works offline | Yes (device buffers) | Yes (browser queue) | Partly |
| Our integration effort | Low to medium | Medium | Medium |
| Wow factor in a demo | Medium | **High** | Low |

## Offline and trust rules (all paths)

- Devices and kiosks store punches locally when offline and sync later. The server records its own receive time and keeps the device time.
- Every punch is unique by `(device_id, device_event_id)`, so re-syncing is always safe.
- Each device has its own HMAC secret. Punches from unknown devices are rejected and raise an alert.
- Templates and embeddings are encrypted at rest and never logged. Consent is recorded at enrollment (Act 843).

Related: [System architecture](03-system-architecture.md) · [Security and review gates](06-security-and-review-gates.md) · [Stack decisions](02-stack-decisions.md)
