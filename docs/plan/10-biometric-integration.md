# 10 · Biometric integration

**The core fact:** a web browser cannot talk to an ordinary USB fingerprint scanner. Every workable option goes around that problem. We build against an interface, so hardware never blocks the project.

Workers clock in on **company devices at the site**, never on their own phones. The detailed Phase 3 design is in [Biometrics design](13-biometrics-design.md).

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

- **Push (preferred):** switch the device to ADMS ("cloud server") mode. It then sends punch records over HTTP in real time to a small gateway on the client's network (`apps/gateway`), which signs them for our API, because the firmware cannot sign requests itself.
- **Pull (fallback):** a scheduled job uses `zkteco-js` or `node-zklib` over TCP port 4370 to read attendance records and the user list. This works on the same local network.
- **Enrollment:** happens at the terminal, inside a window an ADMIN opens for that worker. The gateway reports only that a finger was enrolled (the template is discarded) and keeps the terminal's user list in step with the site's roster. Our server cannot compare terminal fingerprints, so the duplicate check relies on the Ghana Card number and the face path.
- **Hardware:** K40 (budget), F22, or SpeedFace (face and fingerprint). **Bought when a client pays** (owner decision); until then the gateway is proven against a fake terminal.

## Path B: face kiosk in the browser (secondary, and the star of the demo)

`apps/kiosk` runs on any company phone, tablet or laptop with a camera, registered as a `FACE_KIOSK` device.

- **@vladmandic/human** (3.3.6, pinned) replaces the abandoned face-api.js. It provides face detection, face descriptors (embeddings of 1,024 numbers) and anti-spoofing and liveness scores. It is barely maintained now (its latest release is from August 2025), so it stays behind the `BiometricProvider` interface and can be swapped.
- **Enroll:** capture 3 frames and store the embedding, encrypted, on the server. **Identify:** the API decrypts the stored embeddings and compares the new one with each, using Human's own similarity formula. That formula is based on Euclidean distance, not cosine similarity. A vector index such as pgvector would need unencrypted embeddings, so it waits until a company has more than about 300 guards.
- **Liveness:** Human's anti-spoofing and liveness scores (checked again by the server), plus a random head-turn challenge. The honest line for the report: this is prototype-grade. It stops printed photos, but not a replayed video, a mask or a modified kiosk; the hardware terminal is the production answer.
- **Fingerprint on the same device:** where the kiosk has a fingerprint sensor (most Android phones, Windows Hello laptops), a passkey (WebAuthn) confirms the face match. The sensor proves only that a finger saved on the device unlocked the key, not whose finger it was, so the face identifies and the finger confirms.
- **Fallbacks** (a supervisor's co-sign, or staff number plus fingerprint) are allowed but flagged, which feeds detection rule R7.

## Path C: fingerprint reader in the browser (optional, only if the client insists)

- **SecuGen WebAPI:** a small service from the vendor, installed on the computer, lets a web page capture and match fingerprints from SecuGen readers. It is the one honest "fingerprint in the browser" option.
- **DigitalPersona (HID)** works in a similar way, through a local Windows service and a JavaScript SDK.
- **Costs:** vendor lock-in and an installation on every desk. Keep it out of version 1 unless the client requires it.

## Decision matrix (for the client presentation)

| | ZKTeco terminal | Face kiosk | SecuGen in browser |
|---|---|---|---|
| Resistance to spoofing | High (on the device) | Medium (liveness checks) | High |
| Cost per site | About $70 to $200 per device | Almost nothing (existing tablet) | Reader plus licence per desk |
| Works offline | Yes (device buffers) | No: missed hours become a payroll adjustment | Partly |
| Our integration effort | Low to medium | Medium | Medium |
| Wow factor in a demo | Medium | **High** | Low |

## Offline and trust rules (all paths)

- Terminals keep punches through an outage, and the gateway's outbox sends them later. The server records its own receive time and keeps the device time. The face kiosk needs the API for every clock-in; offline, the missed hours become a payroll adjustment (Phase 4, maker–checker).
- Every punch is unique by `(device_id, device_event_id)`, so re-syncing is always safe.
- Each device has its own HMAC secret. Punches from unknown devices are rejected and raise an alert.
- Templates and embeddings are encrypted at rest and never logged. Consent is recorded at enrollment (Act 843).

Related: [Biometrics design](13-biometrics-design.md) · [System architecture](03-system-architecture.md) · [Security and review gates](06-security-and-review-gates.md) · [Stack decisions](02-stack-decisions.md)
