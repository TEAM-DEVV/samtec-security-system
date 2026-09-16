# detection module (Phase 5)

**Purpose:** find ghost workers and fraud patterns that slip past the other safeguards.

**Will own these tables:** `detection_rules`, `detection_alerts`.

## Rules that must hold

- Each rule is a small, testable function that reads data (through other modules' services) and returns alerts with evidence.
- Rules never punish anyone automatically. A person reviews each alert and records a decision.
- Every alert resolution is audited.
- Some rules run inline and block progress: a duplicate fingerprint blocks activation, and pay without attendance blocks a payroll run.

The full rule list is in `docs/plan/08-ghost-detection-engine.md`.
