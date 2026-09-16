# attendance module (Phases 2 and 3)

**Purpose:** turn biometric clock-ins at guard posts into verified working hours.

**Will own these tables:** `devices`, `punch_events`, `work_segments`, `attendance_exceptions`, `biometric_credentials`.

## Rules that must hold

- Punches are **append-only**: never updated, never deleted. Corrections are new rows that point to the original.
- Every punch is unique by `(device_id, device_event_id)`, so re-sending the same punch does nothing (idempotency).
- Store both the device's clock time and the server's receive time. Large differences raise an alert.
- Devices sign every request with their own secret (HMAC). Unknown devices are rejected.
- PIN clock-ins are allowed as a fallback but always flagged.
- Biometric data is stored as encrypted templates, never as images, and is never logged.

Hardware choices and the `BiometricProvider` interface are described in `docs/plan/10-biometric-integration.md`.
