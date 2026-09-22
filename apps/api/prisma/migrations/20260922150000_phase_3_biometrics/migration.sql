-- CreateEnum
CREATE TYPE "BiometricConsentStatus" AS ENUM ('GIVEN', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BiometricCredentialKind" AS ENUM ('FACE', 'TERMINAL_FINGER');

-- CreateEnum
CREATE TYPE "DedupeResult" AS ENUM ('PASSED', 'COLLISION', 'CLEARED', 'NOT_CHECKED');

-- CreateEnum
CREATE TYPE "BiometricCredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CollisionVerdict" AS ENUM ('DIFFERENT_PEOPLE', 'SAME_PERSON');

-- CreateEnum
CREATE TYPE "ExemptionStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'ENDED');

-- CreateEnum
CREATE TYPE "ExemptionReason" AS ENUM ('DECLINED', 'CANNOT_ENROLL', 'CONSENT_WITHDRAWN');

-- CreateEnum
CREATE TYPE "AttemptPurpose" AS ENUM ('CLOCK', 'CO_SIGN', 'STAFF_PASSKEY');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('MATCHED', 'AMBIGUOUS', 'NOT_RECOGNISED', 'LOW_LIVENESS', 'FINGERPRINT_REQUESTED', 'NOT_ME', 'FALLBACK_REFUSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PunchMethod" ADD VALUE 'FACE_PASSKEY';
ALTER TYPE "PunchMethod" ADD VALUE 'STAFF_PASSKEY';

-- AlterTable
ALTER TABLE "attendance_checks" ADD COLUMN     "retention_checked_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "passkeys_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serial_number" TEXT;

-- CreateTable
CREATE TABLE "biometric_consents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "BiometricConsentStatus" NOT NULL,
    "text_version" TEXT NOT NULL,
    "text_sha256" TEXT NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "device_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_credentials" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "BiometricCredentialKind" NOT NULL,
    "device_id" UUID NOT NULL,
    "template_sealed" BYTEA,
    "key_version" SMALLINT,
    "face_model" TEXT,
    "consent_id" UUID,
    "enrolled_by_user_id" UUID,
    "dedupe" "DedupeResult" NOT NULL,
    "collision_employee_id" UUID,
    "collision_similarity" REAL,
    "verdict" "CollisionVerdict",
    "kept_employee_id" UUID,
    "resolution_note" TEXT,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "status" "BiometricCredentialStatus" NOT NULL,
    "wiped_at" TIMESTAMPTZ(3),
    "wiped_by_user_id" UUID,
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "biometric_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_exemptions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "ExemptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "ExemptionReason" NOT NULL,
    "note" TEXT,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "biometric_exemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_passkeys" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "backed_up" BOOLEAN NOT NULL,
    "registered_by_user_id" UUID NOT NULL,
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clock_in_attempts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "purpose" "AttemptPurpose" NOT NULL,
    "direction" "PunchDirection" NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "employee_id" UUID,
    "co_sign_for_employee_id" UUID,
    "staff_number_tried" TEXT,
    "cancels_attempt_id" UUID,
    "best_score" REAL,
    "runner_up_score" REAL,
    "real_score" REAL,
    "live_score" REAL,
    "threshold_version" TEXT,
    "fingerprint_challenge" TEXT,
    "client_address" INET,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clock_in_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "biometric_consents_employee_id_recorded_at_idx" ON "biometric_consents"("employee_id", "recorded_at");

-- CreateIndex
CREATE INDEX "biometric_credentials_employee_id_idx" ON "biometric_credentials"("employee_id");

-- CreateIndex
CREATE INDEX "biometric_credentials_collision_employee_id_idx" ON "biometric_credentials"("collision_employee_id");

-- CreateIndex
CREATE INDEX "biometric_credentials_company_id_dedupe_idx" ON "biometric_credentials"("company_id", "dedupe");

-- CreateIndex
CREATE INDEX "biometric_exemptions_employee_id_idx" ON "biometric_exemptions"("employee_id");

-- CreateIndex
CREATE INDEX "device_passkeys_employee_id_idx" ON "device_passkeys"("employee_id");

-- CreateIndex
CREATE INDEX "device_passkeys_device_id_idx" ON "device_passkeys"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_passkeys_credential_id_key" ON "device_passkeys"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "clock_in_attempts_cancels_attempt_id_key" ON "clock_in_attempts"("cancels_attempt_id");

-- CreateIndex
CREATE INDEX "clock_in_attempts_device_id_attempted_at_idx" ON "clock_in_attempts"("device_id", "attempted_at");

-- CreateIndex
CREATE INDEX "clock_in_attempts_company_id_attempted_at_idx" ON "clock_in_attempts"("company_id", "attempted_at");

-- CreateIndex
CREATE INDEX "clock_in_attempts_employee_id_attempted_at_idx" ON "clock_in_attempts"("employee_id", "attempted_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_company_id_serial_number_key" ON "devices"("company_id", "serial_number");

-- AddForeignKey
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "biometric_consents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_collision_employee_id_fkey" FOREIGN KEY ("collision_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_exemptions" ADD CONSTRAINT "biometric_exemptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_exemptions" ADD CONSTRAINT "biometric_exemptions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_passkeys" ADD CONSTRAINT "device_passkeys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_passkeys" ADD CONSTRAINT "device_passkeys_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_passkeys" ADD CONSTRAINT "device_passkeys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_co_sign_for_employee_id_fkey" FOREIGN KEY ("co_sign_for_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_cancels_attempt_id_fkey" FOREIGN KEY ("cancels_attempt_id") REFERENCES "clock_in_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- Hand-written rules (Prisma cannot express these). Both developers review
-- this block; docs/plan/13-biometrics-design.md explains each one. The
-- database guards the rules that matter most, so a bug in the application can
-- never unblock a duplicate, bring back a wiped face, or rewrite history.
-- New functions use an empty search_path and name every table in full, so a
-- look-alike object in another schema can never be picked up by mistake.
-- =============================================================================

-- Row-level security, like every table (docs/plan/04-data-model.md).
ALTER TABLE "biometric_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biometric_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biometric_exemptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_passkeys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clock_in_attempts" ENABLE ROW LEVEL SECURITY;

-- One function refuses deletes (row by row) and TRUNCATE (whole tables) for
-- every Phase 3 table: biometric history is evidence, and is never removed.
CREATE FUNCTION public.biometric_rows_are_never_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
END;
$$;

-- ---------------------------------------------------------------------------
-- Devices: a serial number only for a ZKTeco terminal (typed from its label),
-- and the device's own fingerprint sensor only on a kiosk.
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" ADD CONSTRAINT "devices_phase_3_fields_valid" CHECK (
  ("serial_number" IS NULL OR ("kind" = 'ZKTECO' AND "serial_number" ~ '^[A-Za-z0-9-]{1,64}$'))
  AND ("passkeys_enabled" = false OR "kind" = 'FACE_KIOSK'));

-- ---------------------------------------------------------------------------
-- Consents: a new row for every consent and every withdrawal, never changed.
-- ---------------------------------------------------------------------------
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_values_valid" CHECK (
  length("text_version") BETWEEN 1 AND 32
  AND "text_sha256" ~ '^[0-9a-f]{64}$'
  -- Consent is given on a kiosk; a withdrawal may be recorded on the dashboard.
  AND ("status" = 'WITHDRAWN' OR "device_id" IS NOT NULL));

CREATE FUNCTION public.biometric_consents_are_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'biometric_consents is append-only: a withdrawal is a new row';
END;
$$;

CREATE TRIGGER biometric_consents_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "biometric_consents"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_consents_are_append_only();
CREATE TRIGGER biometric_consents_no_truncate
  BEFORE TRUNCATE ON "biometric_consents"
  FOR EACH STATEMENT EXECUTE FUNCTION public.biometric_consents_are_append_only();

-- ---------------------------------------------------------------------------
-- Credentials: a face (encrypted numbers, never a photo) or a terminal finger.
-- ---------------------------------------------------------------------------

-- A face has a consent, a model and an enroller, and holds its template until
-- it is wiped. A terminal finger keeps nothing here (the terminal holds it)
-- and has no duplicate check, so it is never waiting for a review.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_shape" CHECK (
  ("kind" = 'FACE'
    AND "consent_id" IS NOT NULL AND "face_model" IS NOT NULL AND "enrolled_by_user_id" IS NOT NULL
    AND "dedupe" IN ('PASSED', 'COLLISION', 'CLEARED')
    AND ("template_sealed" IS NOT NULL) = ("wiped_at" IS NULL))
  OR ("kind" = 'TERMINAL_FINGER'
    AND "template_sealed" IS NULL AND "face_model" IS NULL
    AND "dedupe" = 'NOT_CHECKED' AND "status" <> 'PENDING'));

-- A template always says which key sealed it.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_template_key" CHECK (
  ("template_sealed" IS NULL) = ("key_version" IS NULL)
  AND ("key_version" IS NULL OR "key_version" >= 1));

-- PENDING and ACTIVE are in use; BLOCKED and REVOKED are wiped, with the time.
-- A PENDING face is exactly one that waits for a collision review.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_status_valid" CHECK (
  ("status" IN ('PENDING', 'ACTIVE')) = ("wiped_at" IS NULL)
  AND ("wiped_by_user_id" IS NULL OR "wiped_at" IS NOT NULL)
  AND ("status" <> 'PENDING' OR ("dedupe" = 'COLLISION' AND "verdict" IS NULL)));

-- A collision records who the face looked like and how closely; a face that
-- passed does not. Nobody looks like themselves.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_collision_evidence" CHECK (
  ("dedupe" IN ('COLLISION', 'CLEARED'))
    = ("collision_employee_id" IS NOT NULL AND "collision_similarity" IS NOT NULL)
  AND ("collision_similarity" IS NULL OR "collision_similarity" BETWEEN 0 AND 1)
  AND ("collision_employee_id" IS NULL OR "collision_employee_id" <> "employee_id"));

-- A decision records who, when, what and why, all together. SAME_PERSON names
-- the record kept, which is one of the two. The ADMIN who enrolled the face
-- never decides it: maker–checker in the database itself.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_decision_valid" CHECK (
  ("verdict" IS NOT NULL)
    = ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL AND "resolution_note" IS NOT NULL)
  AND ("verdict" IS NULL OR "collision_employee_id" IS NOT NULL)
  AND (COALESCE("verdict" = 'SAME_PERSON', false)) = ("kept_employee_id" IS NOT NULL)
  AND ("kept_employee_id" IS NULL OR "kept_employee_id" IN ("employee_id", "collision_employee_id"))
  AND ("resolved_by_user_id" IS NULL OR "resolved_by_user_id" IS DISTINCT FROM "enrolled_by_user_id")
  AND ("resolution_note" IS NULL OR length("resolution_note") BETWEEN 3 AND 500)
  -- CLEARED: a second ADMIN let this face through (different people, or this
  -- is the real record). A decided face that stays a COLLISION lost: it is
  -- the duplicate, and it is blocked.
  AND ("dedupe" <> 'CLEARED'
    OR "verdict" = 'DIFFERENT_PEOPLE'
    OR ("verdict" = 'SAME_PERSON' AND "kept_employee_id" = "employee_id"))
  AND ("dedupe" <> 'COLLISION' OR "verdict" IS NULL
    OR ("verdict" = 'SAME_PERSON' AND "kept_employee_id" = "collision_employee_id" AND "status" = 'BLOCKED')));

-- At most one face in use (not wiped) per employee.
CREATE UNIQUE INDEX "biometric_credentials_one_live_face"
  ON "biometric_credentials" ("employee_id")
  WHERE "kind" = 'FACE' AND "wiped_at" IS NULL;

-- What may change after enrollment, and how.
CREATE FUNCTION public.biometric_credentials_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- The facts of an enrollment never change: who, where, when, by whom, with
  -- which consent and model, and who the face looked like.
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id
     OR NEW.kind <> OLD.kind OR NEW.device_id <> OLD.device_id OR NEW.enrolled_at <> OLD.enrolled_at
     OR NEW.face_model IS DISTINCT FROM OLD.face_model
     OR NEW.consent_id IS DISTINCT FROM OLD.consent_id
     OR NEW.enrolled_by_user_id IS DISTINCT FROM OLD.enrolled_by_user_id
     OR NEW.collision_employee_id IS DISTINCT FROM OLD.collision_employee_id
     OR NEW.collision_similarity IS DISTINCT FROM OLD.collision_similarity THEN
    RAISE EXCEPTION 'biometric_credentials: the facts of an enrollment never change';
  END IF;

  -- A wiped template never comes back. A live one may only be sealed again
  -- with a newer key (key rotation), never swapped for other numbers.
  IF OLD.template_sealed IS NULL AND NEW.template_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'biometric_credentials: a wiped template can never come back';
  END IF;
  IF NEW.template_sealed IS NOT NULL AND NEW.template_sealed <> OLD.template_sealed
     AND NEW.key_version <= OLD.key_version THEN
    RAISE EXCEPTION 'biometric_credentials: a template may only be sealed again with a newer key';
  END IF;
  IF OLD.wiped_at IS NOT NULL AND (NEW.wiped_at IS DISTINCT FROM OLD.wiped_at
     OR NEW.wiped_by_user_id IS DISTINCT FROM OLD.wiped_by_user_id) THEN
    RAISE EXCEPTION 'biometric_credentials: a wipe is never undone or changed';
  END IF;

  -- The status only moves forward, and a block is final.
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('ACTIVE', 'BLOCKED', 'REVOKED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('BLOCKED', 'REVOKED'))
    OR (OLD.status = 'REVOKED' AND NEW.status = 'BLOCKED')) THEN
    RAISE EXCEPTION 'biometric_credentials: status % can never become %', OLD.status, NEW.status;
  END IF;

  -- The duplicate check's result only moves from COLLISION to CLEARED, and a
  -- decision, once made, is final.
  IF NEW.dedupe <> OLD.dedupe AND NOT (OLD.dedupe = 'COLLISION' AND NEW.dedupe = 'CLEARED') THEN
    RAISE EXCEPTION 'biometric_credentials: dedupe % can never become %', OLD.dedupe, NEW.dedupe;
  END IF;
  IF OLD.verdict IS NOT NULL AND (NEW.verdict IS DISTINCT FROM OLD.verdict
     OR NEW.kept_employee_id IS DISTINCT FROM OLD.kept_employee_id
     OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note
     OR NEW.resolved_by_user_id IS DISTINCT FROM OLD.resolved_by_user_id
     OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
    RAISE EXCEPTION 'biometric_credentials: a collision decision is final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER biometric_credentials_guard_update
  BEFORE UPDATE ON "biometric_credentials"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_credentials_guard();
CREATE TRIGGER biometric_credentials_no_delete
  BEFORE DELETE ON "biometric_credentials"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_rows_are_never_deleted();
CREATE TRIGGER biometric_credentials_no_truncate
  BEFORE TRUNCATE ON "biometric_credentials"
  FOR EACH STATEMENT EXECUTE FUNCTION public.biometric_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Exemptions: asked by one ADMIN, decided by another, and only moving forward.
-- ---------------------------------------------------------------------------
ALTER TABLE "biometric_exemptions" ADD CONSTRAINT "biometric_exemptions_values_valid" CHECK (
  ("note" IS NULL OR length("note") BETWEEN 3 AND 500)
  AND ("review_note" IS NULL OR length("review_note") BETWEEN 3 AND 500));

-- A decision records who, when and why, all together, and the ADMIN who asked
-- never decides it. A waiting request has no decision and has not ended.
ALTER TABLE "biometric_exemptions" ADD CONSTRAINT "biometric_exemptions_review_valid" CHECK (
  ("reviewed_at" IS NOT NULL) = ("reviewed_by_user_id" IS NOT NULL)
  AND ("reviewed_at" IS NOT NULL) = ("review_note" IS NOT NULL)
  AND ("reviewed_by_user_id" IS NULL OR "reviewed_by_user_id" <> "requested_by_user_id")
  AND ("status" NOT IN ('APPROVED', 'REJECTED') OR "reviewed_at" IS NOT NULL)
  AND ("status" <> 'REQUESTED' OR "reviewed_at" IS NULL)
  AND ("status" = 'ENDED') = ("ended_at" IS NOT NULL));

-- At most one request waiting or approved per employee.
CREATE UNIQUE INDEX "biometric_exemptions_one_open"
  ON "biometric_exemptions" ("employee_id")
  WHERE "status" IN ('REQUESTED', 'APPROVED');

CREATE FUNCTION public.biometric_exemptions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id
     OR NEW.reason <> OLD.reason OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'biometric_exemptions: who asked, for whom, when and why never change';
  END IF;
  -- Only forward: REQUESTED to APPROVED, REJECTED or ENDED; APPROVED to ENDED.
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'REJECTED', 'ENDED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'ENDED')) THEN
    RAISE EXCEPTION 'biometric_exemptions: status % can never become %', OLD.status, NEW.status;
  END IF;
  -- A decision is final, and so is an end.
  IF OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
     OR NEW.review_note IS DISTINCT FROM OLD.review_note) THEN
    RAISE EXCEPTION 'biometric_exemptions: a decision is final';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'biometric_exemptions: an end is final';
  END IF;
  -- The note may only be cleared (by the retention sweep), never rewritten.
  IF NEW.note IS DISTINCT FROM OLD.note AND NEW.note IS NOT NULL THEN
    RAISE EXCEPTION 'biometric_exemptions: the note may only be cleared';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER biometric_exemptions_guard_update
  BEFORE UPDATE ON "biometric_exemptions"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_exemptions_guard();
CREATE TRIGGER biometric_exemptions_no_delete
  BEFORE DELETE ON "biometric_exemptions"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_rows_are_never_deleted();
CREATE TRIGGER biometric_exemptions_no_truncate
  BEFORE TRUNCATE ON "biometric_exemptions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.biometric_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Fingerprint keys: one live key per worker per kiosk; a revoke is final.
-- ---------------------------------------------------------------------------
ALTER TABLE "device_passkeys" ADD CONSTRAINT "device_passkeys_values_valid" CHECK (
  -- base64url; PostgreSQL caps a regex repeat at 255, so the length is checked apart.
  "credential_id" ~ '^[A-Za-z0-9_-]+$'
  AND length("credential_id") BETWEEN 16 AND 1400
  AND "sign_count" >= 0
  AND ("revoked_by_user_id" IS NULL OR "revoked_at" IS NOT NULL));

CREATE UNIQUE INDEX "device_passkeys_one_live_key"
  ON "device_passkeys" ("employee_id", "device_id")
  WHERE "revoked_at" IS NULL;

CREATE FUNCTION public.device_passkeys_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id
     OR NEW.device_id <> OLD.device_id OR NEW.credential_id <> OLD.credential_id
     OR NEW.public_key <> OLD.public_key OR NEW.backed_up <> OLD.backed_up
     OR NEW.registered_by_user_id <> OLD.registered_by_user_id
     OR NEW.registered_at <> OLD.registered_at THEN
    RAISE EXCEPTION 'device_passkeys: a registered key never changes';
  END IF;
  -- A counter that goes down means a cloned key.
  IF NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION 'device_passkeys: the signature counter may only go up';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id) THEN
    RAISE EXCEPTION 'device_passkeys: a revoke is final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_passkeys_guard_update
  BEFORE UPDATE ON "device_passkeys"
  FOR EACH ROW EXECUTE FUNCTION public.device_passkeys_guard();
CREATE TRIGGER device_passkeys_no_delete
  BEFORE DELETE ON "device_passkeys"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_rows_are_never_deleted();
CREATE TRIGGER device_passkeys_no_truncate
  BEFORE TRUNCATE ON "device_passkeys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.biometric_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Clock-in attempts: append-only; the retention sweep may clear the address.
-- ---------------------------------------------------------------------------

-- The shape of each kind of attempt (docs/plan/13 §3 and §4):
-- a CLOCK attempt is a face at the kiosk; a CO_SIGN is a supervisor's face
-- for one named worker; a STAFF_PASSKEY is a typed staff number, then a
-- finger. "Not me" is a CLOCK row that points at the match it cancels.
ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_shape" CHECK (
  "direction" <> 'UNKNOWN'
  AND ("purpose" = 'CLOCK') = ("staff_number_tried" IS NULL)
  AND ("purpose" = 'CO_SIGN' OR "co_sign_for_employee_id" IS NULL)
  AND ("purpose" = 'STAFF_PASSKEY') = ("outcome" IN ('FINGERPRINT_REQUESTED', 'FALLBACK_REFUSED'))
  AND ("outcome" = 'NOT_ME') = ("cancels_attempt_id" IS NOT NULL)
  AND ("outcome" <> 'NOT_ME' OR "purpose" = 'CLOCK')
  AND ("outcome" NOT IN ('MATCHED', 'FINGERPRINT_REQUESTED', 'NOT_ME') OR "employee_id" IS NOT NULL)
  AND ("staff_number_tried" IS NULL OR length("staff_number_tried") BETWEEN 1 AND 32)
  AND ("threshold_version" IS NULL OR length("threshold_version") BETWEEN 1 AND 16));

ALTER TABLE "clock_in_attempts" ADD CONSTRAINT "clock_in_attempts_scores_valid" CHECK (
  ("best_score" IS NULL OR "best_score" BETWEEN 0 AND 1)
  AND ("runner_up_score" IS NULL OR "runner_up_score" BETWEEN 0 AND 1)
  AND ("real_score" IS NULL OR "real_score" BETWEEN 0 AND 1)
  AND ("live_score" IS NULL OR "live_score" BETWEEN 0 AND 1));

CREATE FUNCTION public.clock_in_attempts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  cleared public.clock_in_attempts;
BEGIN
  -- The only change ever allowed: clearing the network address.
  cleared := OLD;
  cleared.client_address := NULL;
  IF NEW IS NOT DISTINCT FROM cleared THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'clock_in_attempts is append-only: only the retention sweep may clear the network address';
END;
$$;

CREATE TRIGGER clock_in_attempts_guard_update
  BEFORE UPDATE ON "clock_in_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.clock_in_attempts_guard();
CREATE TRIGGER clock_in_attempts_no_delete
  BEFORE DELETE ON "clock_in_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_rows_are_never_deleted();
CREATE TRIGGER clock_in_attempts_no_truncate
  BEFORE TRUNCATE ON "clock_in_attempts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.biometric_rows_are_never_deleted();
