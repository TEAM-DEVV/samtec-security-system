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

-- PENDING and ACTIVE are live (not wiped); BLOCKED and REVOKED are wiped,
-- with the time. A PENDING face is exactly one that waits for a collision
-- review, and an ACTIVE face is one that passed the check or that a second
-- ADMIN cleared: a face that collided can never become ACTIVE (matched at
-- clock-in) without a decision.
-- (Every CHECK here is written so that it is TRUE or FALSE, never NULL:
-- PostgreSQL lets a row through when a CHECK comes out NULL.)
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_status_valid" CHECK (
  ("status" IN ('PENDING', 'ACTIVE')) = ("wiped_at" IS NULL)
  AND ("wiped_by_user_id" IS NULL OR "wiped_at" IS NOT NULL)
  AND ("status" <> 'PENDING' OR ("dedupe" = 'COLLISION' AND "verdict" IS NULL))
  AND ("kind" <> 'FACE' OR "status" <> 'ACTIVE' OR "dedupe" IN ('PASSED', 'CLEARED')));

-- A collision records who the face looked like and how closely; a face that
-- passed, or a finger, records neither. Nobody looks like themselves.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_collision_evidence" CHECK (
  ("dedupe" IN ('COLLISION', 'CLEARED')) = ("collision_employee_id" IS NOT NULL)
  AND ("dedupe" IN ('COLLISION', 'CLEARED')) = ("collision_similarity" IS NOT NULL)
  AND ("collision_similarity" IS NULL OR "collision_similarity" BETWEEN 0 AND 1)
  AND ("collision_employee_id" IS NULL OR "collision_employee_id" <> "employee_id"));

-- A decision records who, when, what and why, all together. SAME_PERSON names
-- the record kept, which is one of the two. The ADMIN who enrolled the face
-- never decides it: maker–checker in the database itself.
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_decision_valid" CHECK (
  ("verdict" IS NOT NULL)
    = ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL AND "resolution_note" IS NOT NULL)
  AND ("verdict" IS NULL OR "collision_employee_id" IS NOT NULL)
  AND COALESCE("verdict" = 'SAME_PERSON', false) = ("kept_employee_id" IS NOT NULL)
  AND ("kept_employee_id" IS NULL
    OR COALESCE("kept_employee_id" IN ("employee_id", "collision_employee_id"), false))
  AND ("resolved_by_user_id" IS NULL OR "resolved_by_user_id" IS DISTINCT FROM "enrolled_by_user_id")
  AND ("resolution_note" IS NULL OR length("resolution_note") BETWEEN 3 AND 500)
  -- CLEARED: a second ADMIN let this face through (different people, or this
  -- is the real record), so there is always a verdict. A decided face that
  -- stays a COLLISION lost: it is the duplicate, and it is blocked.
  AND ("dedupe" <> 'CLEARED'
    OR COALESCE("verdict" = 'DIFFERENT_PEOPLE'
      OR ("verdict" = 'SAME_PERSON' AND "kept_employee_id" = "employee_id"), false))
  AND ("dedupe" <> 'COLLISION' OR "verdict" IS NULL
    OR COALESCE("verdict" = 'SAME_PERSON' AND "kept_employee_id" = "collision_employee_id"
      AND "status" = 'BLOCKED', false)));

-- At most one live (not wiped) face per employee: PENDING or ACTIVE.
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

  -- A wiped template never comes back. A live one changes only when it is
  -- sealed again with a newer key (key rotation): the template and its key
  -- version change together, and the version only rises.
  IF OLD.template_sealed IS NULL AND NEW.template_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'biometric_credentials: a wiped template can never come back';
  END IF;
  IF NEW.template_sealed IS NOT NULL
     AND (NEW.template_sealed <> OLD.template_sealed OR NEW.key_version <> OLD.key_version)
     AND NOT (NEW.template_sealed <> OLD.template_sealed AND NEW.key_version > OLD.key_version) THEN
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
  -- A blocked face is never decided afterwards: its record already lost.
  IF OLD.verdict IS NULL AND NEW.verdict IS NOT NULL AND OLD.status = 'BLOCKED' THEN
    RAISE EXCEPTION 'biometric_credentials: a blocked face is never decided';
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
  -- A decision is made in one step only: a waiting request becomes APPROVED
  -- or REJECTED. It is never added to an ended request, nor to a request
  -- that ends without being decided.
  IF OLD.reviewed_at IS NULL AND NEW.reviewed_at IS NOT NULL
     AND NOT (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'REJECTED')) THEN
    RAISE EXCEPTION 'biometric_exemptions: a decision is made only on a waiting request';
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
     OR NEW.public_key <> OLD.public_key
     OR NEW.registered_by_user_id <> OLD.registered_by_user_id
     OR NEW.registered_at <> OLD.registered_at THEN
    RAISE EXCEPTION 'device_passkeys: a registered key never changes';
  END IF;
  -- The "synced" flag may switch on later (the device may copy the key to
  -- its cloud account after registration), but it is never hidden again.
  IF OLD.backed_up AND NOT NEW.backed_up THEN
    RAISE EXCEPTION 'device_passkeys: a key that was synced stays marked synced';
  END IF;
  -- A counter that goes down means a cloned key.
  IF NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION 'device_passkeys: the signature counter may only go up';
  END IF;
  -- A revoked key is never used again.
  IF OLD.revoked_at IS NOT NULL AND (NEW.sign_count <> OLD.sign_count
     OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at) THEN
    RAISE EXCEPTION 'device_passkeys: a revoked key is never used';
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

-- ---------------------------------------------------------------------------
-- Rules across rows: a new row always starts at the beginning, a device keeps
-- what it is, and a duplicate verdict really blocks the record that lost.
-- ---------------------------------------------------------------------------

-- A device keeps its company, site and kind for life: which routes it may
-- call (kindMayUse) depends on its kind.
CREATE FUNCTION public.devices_keep_their_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.kind <> OLD.kind OR NEW.site_id <> OLD.site_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'devices: a device keeps its company, site and kind for life';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER devices_keep_their_identity
  BEFORE UPDATE ON "devices"
  FOR EACH ROW EXECUTE FUNCTION public.devices_keep_their_identity();

-- A kiosk's fingerprints are switched off only in the same transaction that
-- revokes every key on it (checked when the transaction is saved). The
-- database never revokes them itself.
CREATE FUNCTION public.devices_fingerprints_off_revokes_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT NEW.passkeys_enabled AND EXISTS (
    SELECT 1 FROM public.device_passkeys WHERE device_id = NEW.id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'devices: switch a kiosk''s fingerprints off only in the same transaction that revokes every key on it';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER devices_fingerprints_off_revokes_keys
  AFTER UPDATE OF passkeys_enabled ON "devices"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.devices_fingerprints_off_revokes_keys();

-- A record blocked as a duplicate (one of its faces is BLOCKED) can only be
-- terminated: nothing new may be given to it. A terminal finger blocked for
-- an unexpected enrollment does not block the record.
CREATE FUNCTION public.biometric_record_is_blocked(target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.biometric_credentials
    WHERE employee_id = target AND kind = 'FACE' AND status = 'BLOCKED');
$$;

-- Every change that gives a worker something (a consent, a face, a finger, an
-- exemption, a fingerprint key), and every collision decision or block, locks
-- the worker's employee row. So they happen one at a time for each worker: a
-- new key can never slip in while another ADMIN is blocking the same record,
-- and a block is never saved while a new key is being added. After waiting,
-- the next check reads the newest saved rows; that holds at READ COMMITTED,
-- the level every biometric transaction uses (docs/plan/13 section 2).
-- This function also checks that the row and the worker belong to the same
-- company; the decision lock below needs only the order, because both
-- records were checked when their faces were enrolled.
-- An UPDATE locks its own row before its triggers run, so a service that
-- changes several rows (a decision and its block, a withdrawal) locks the
-- workers involved first, in id order, to avoid deadlocks.
CREATE FUNCTION public.biometric_lock_worker(worker uuid, company uuid, source text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.employees WHERE id = worker AND company_id = company FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%: the worker belongs to another company', source;
  END IF;
END;
$$;

-- Consents: a consent is given on one of the company's kiosks, and never to a
-- blocked record; a withdrawal is recorded on the dashboard (no device) or on
-- one of the company's kiosks. The database, not the caller, sets the time it is recorded,
-- so the order of a consent and its withdrawal can be trusted.
CREATE FUNCTION public.biometric_consents_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.recorded_at := clock_timestamp();
  PERFORM public.biometric_lock_worker(NEW.employee_id, NEW.company_id, TG_TABLE_NAME);
  IF NEW.status = 'GIVEN' THEN
    IF public.biometric_record_is_blocked(NEW.employee_id) THEN
      RAISE EXCEPTION 'biometric_consents: a record blocked as a duplicate can only be terminated';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.devices
                   WHERE id = NEW.device_id AND kind = 'FACE_KIOSK' AND company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'biometric_consents: consent is given on a face kiosk of the same company';
    END IF;
  ELSIF NEW.device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.devices
    WHERE id = NEW.device_id AND kind = 'FACE_KIOSK' AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'biometric_consents: a withdrawal is recorded on the dashboard or on a face kiosk of the same company';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER biometric_consents_before_insert
  BEFORE INSERT ON "biometric_consents"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_consents_before_insert();

-- Credentials: a new face starts live with no decision, on one of the
-- company's kiosks, with this worker's own consent still standing. A new
-- finger comes from one of the company's ZKTeco terminals: ACTIVE, or BLOCKED
-- when nobody asked for it (kept as evidence, even for a blocked record).
-- Nothing live is ever given to a blocked record.
CREATE FUNCTION public.biometric_credentials_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.verdict IS NOT NULL OR NEW.kept_employee_id IS NOT NULL OR NEW.resolution_note IS NOT NULL
     OR NEW.resolved_by_user_id IS NOT NULL OR NEW.resolved_at IS NOT NULL OR NEW.dedupe = 'CLEARED' THEN
    RAISE EXCEPTION 'biometric_credentials: a new credential starts with no decision';
  END IF;
  PERFORM public.biometric_lock_worker(NEW.employee_id, NEW.company_id, TG_TABLE_NAME);
  IF NEW.status <> 'BLOCKED' AND public.biometric_record_is_blocked(NEW.employee_id) THEN
    RAISE EXCEPTION 'biometric_credentials: a record blocked as a duplicate can only be terminated';
  END IF;
  IF NEW.collision_employee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees WHERE id = NEW.collision_employee_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'biometric_credentials: a face only looks like someone in the same company';
  END IF;
  IF NEW.kind = 'FACE' THEN
    IF NEW.status NOT IN ('PENDING', 'ACTIVE') OR NEW.wiped_at IS NOT NULL THEN
      RAISE EXCEPTION 'biometric_credentials: a new face starts live';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.devices
                   WHERE id = NEW.device_id AND kind = 'FACE_KIOSK' AND company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'biometric_credentials: a face is enrolled on a face kiosk of the same company';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.devices
                    WHERE id = NEW.device_id AND kind = 'ZKTECO' AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'biometric_credentials: a terminal finger comes from a ZKTeco terminal of the same company';
  END IF;
  -- The consent is this worker's own, was given, and has not been withdrawn
  -- since. A withdrawal recorded at the same moment counts as later.
  IF NEW.consent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.biometric_consents c
    WHERE c.id = NEW.consent_id AND c.employee_id = NEW.employee_id AND c.status = 'GIVEN'
      AND NOT EXISTS (
        SELECT 1 FROM public.biometric_consents w
        WHERE w.employee_id = NEW.employee_id AND w.status = 'WITHDRAWN'
          AND w.recorded_at >= c.recorded_at)) THEN
    RAISE EXCEPTION 'biometric_credentials: the consent must be this worker''s own, given and not withdrawn';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER biometric_credentials_before_insert
  BEFORE INSERT ON "biometric_credentials"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_credentials_before_insert();

-- Exemptions: a new request is waiting, not yet decided or ended, and never
-- for a blocked record.
CREATE FUNCTION public.biometric_exemptions_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'REQUESTED' OR NEW.reviewed_at IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL
     OR NEW.review_note IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'biometric_exemptions: a new request starts waiting, with no decision';
  END IF;
  PERFORM public.biometric_lock_worker(NEW.employee_id, NEW.company_id, TG_TABLE_NAME);
  IF public.biometric_record_is_blocked(NEW.employee_id) THEN
    RAISE EXCEPTION 'biometric_exemptions: a record blocked as a duplicate can only be terminated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER biometric_exemptions_before_insert
  BEFORE INSERT ON "biometric_exemptions"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_exemptions_before_insert();

-- Fingerprint keys: only on one of the company's kiosks whose fingerprints
-- are switched on, never already revoked, and never for a blocked record.
-- FOR SHARE waits for an ADMIN who is switching the kiosk's fingerprints off
-- at that moment, so a key can never slip in after that switch has revoked
-- the others.
CREATE FUNCTION public.device_passkeys_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.devices
    WHERE id = NEW.device_id AND kind = 'FACE_KIOSK' AND passkeys_enabled
      AND company_id = NEW.company_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'device_passkeys: fingerprint keys are only saved on a kiosk of the same company with fingerprints switched on';
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'device_passkeys: a new key starts live';
  END IF;
  PERFORM public.biometric_lock_worker(NEW.employee_id, NEW.company_id, TG_TABLE_NAME);
  IF public.biometric_record_is_blocked(NEW.employee_id) THEN
    RAISE EXCEPTION 'device_passkeys: a record blocked as a duplicate can only be terminated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_passkeys_before_insert
  BEFORE INSERT ON "device_passkeys"
  FOR EACH ROW EXECUTE FUNCTION public.device_passkeys_before_insert();

-- A collision decision (either verdict) or a block takes the same worker lock
-- as above, for both records, in id order. So two decisions about the same
-- people, or a decision and a new key, never commit without seeing each other.
CREATE FUNCTION public.biometric_credentials_lock_workers() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.verdict IS NOT NULL AND OLD.verdict IS NULL)
     OR (NEW.kind = 'FACE' AND NEW.status = 'BLOCKED' AND OLD.status <> 'BLOCKED') THEN
    PERFORM 1 FROM public.employees
      WHERE id IN (NEW.employee_id, NEW.collision_employee_id)
      ORDER BY id
      FOR NO KEY UPDATE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER biometric_credentials_lock_workers
  BEFORE UPDATE ON "biometric_credentials"
  FOR EACH ROW EXECUTE FUNCTION public.biometric_credentials_lock_workers();

-- A SAME_PERSON decision and the block it causes, checked together when the
-- transaction commits (DEFERRABLE INITIALLY DEFERRED). When the new record is
-- kept, the decision (on the new face) and the block (on the older face) may
-- be written in either order; when the older record is kept, the verdict and
-- the block are one UPDATE of the new face.
-- 1. The record that lost has no live face, has a BLOCKED face, has no live
--    fingerprint key and no exemption waiting or approved. (Its fingers on
--    ZKTeco terminals are taken off by the roster, docs/plan/13 section 5.)
-- 2. A face becomes BLOCKED only as the losing record of such a decision.
-- 3. One pair of records is never decided two ways: a later decision about
--    the same two people gives the same verdict and keeps the same record.
CREATE FUNCTION public.biometric_duplicate_decisions_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  loser uuid;
BEGIN
  IF NEW.verdict = 'SAME_PERSON' AND (TG_OP = 'INSERT' OR OLD.verdict IS NULL) THEN
    loser := CASE WHEN NEW.kept_employee_id = NEW.employee_id
      THEN NEW.collision_employee_id ELSE NEW.employee_id END;
    IF EXISTS (SELECT 1 FROM public.biometric_credentials
               WHERE employee_id = loser AND kind = 'FACE' AND wiped_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.biometric_credentials
                      WHERE employee_id = loser AND kind = 'FACE' AND status = 'BLOCKED')
       OR EXISTS (SELECT 1 FROM public.device_passkeys
                  WHERE employee_id = loser AND revoked_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.biometric_exemptions
                  WHERE employee_id = loser AND status IN ('REQUESTED', 'APPROVED')) THEN
      RAISE EXCEPTION 'biometric_credentials: a SAME_PERSON decision must block the other record (face wiped and blocked, keys revoked, exemption ended)';
    END IF;
  END IF;
  IF NEW.verdict IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.verdict IS NULL) AND EXISTS (
    SELECT 1 FROM public.biometric_credentials d
    WHERE d.id <> NEW.id AND d.verdict IS NOT NULL
      AND ((d.employee_id = NEW.employee_id AND d.collision_employee_id = NEW.collision_employee_id)
        OR (d.employee_id = NEW.collision_employee_id AND d.collision_employee_id = NEW.employee_id))
      AND (d.verdict <> NEW.verdict OR d.kept_employee_id IS DISTINCT FROM NEW.kept_employee_id)) THEN
    RAISE EXCEPTION 'biometric_credentials: one pair of records is never decided two ways';
  END IF;
  IF NEW.kind = 'FACE' AND NEW.status = 'BLOCKED' AND (TG_OP = 'INSERT' OR OLD.status <> 'BLOCKED') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.biometric_credentials d
      WHERE d.verdict = 'SAME_PERSON'
        AND ((d.employee_id = NEW.employee_id AND d.kept_employee_id = d.collision_employee_id)
          OR (d.collision_employee_id = NEW.employee_id AND d.kept_employee_id = d.employee_id))) THEN
      RAISE EXCEPTION 'biometric_credentials: a face is blocked only by a SAME_PERSON decision against its record';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER biometric_credentials_duplicate_decisions_hold
  AFTER INSERT OR UPDATE ON "biometric_credentials"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.biometric_duplicate_decisions_hold();
