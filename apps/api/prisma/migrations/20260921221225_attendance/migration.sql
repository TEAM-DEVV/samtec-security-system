-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('MOCK', 'ZKTECO', 'FACE_KIOSK');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PunchDirection" AS ENUM ('IN', 'OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PunchMethod" AS ENUM ('FINGERPRINT', 'FACE', 'PIN_FALLBACK');

-- CreateEnum
CREATE TYPE "SegmentBasis" AS ENUM ('BIOMETRIC', 'PIN_FALLBACK', 'MANUAL');

-- CreateEnum
CREATE TYPE "SegmentStatus" AS ENUM ('CONFIRMED', 'DISPUTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "AttendanceExceptionType" AS ENUM ('MISSING_CLOCK_OUT', 'MISSING_CLOCK_IN', 'UNKNOWN_EMPLOYEE', 'INACTIVE_EMPLOYEE', 'OVERLAP');

-- CreateEnum
CREATE TYPE "AttendanceExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'AUTO_CLOSED');

-- CreateEnum
CREATE TYPE "ExceptionResolutionAction" AS ENUM ('DISMISS', 'ADD_SEGMENT', 'KEEP_SEGMENT', 'VOID_ALL');

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "secret_encrypted" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_clock_drift_seconds" INTEGER,
    "failed_signature_count" INTEGER NOT NULL DEFAULT 0,
    "last_failed_signature_at" TIMESTAMPTZ(3),
    "rate_window_starts_at" TIMESTAMPTZ(3),
    "rate_window_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "punch_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "device_event_id" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "employee_id" UUID,
    "device_user_ref" TEXT NOT NULL,
    "device_time" TIMESTAMPTZ(3) NOT NULL,
    "server_time" TIMESTAMPTZ(3) NOT NULL,
    "clock_drift_seconds" INTEGER,
    "clock_suspect" BOOLEAN NOT NULL DEFAULT false,
    "pairable" BOOLEAN NOT NULL DEFAULT true,
    "direction" "PunchDirection" NOT NULL,
    "method" "PunchMethod" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_segments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3) NOT NULL,
    "worked_minutes" INTEGER NOT NULL,
    "basis" "SegmentBasis" NOT NULL,
    "status" "SegmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "clock_in_punch_id" UUID,
    "clock_out_punch_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_exceptions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" "AttendanceExceptionType" NOT NULL,
    "status" "AttendanceExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "dedupe_key" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "second_site_id" UUID,
    "employee_id" UUID,
    "punch_id" UUID,
    "segment_id" UUID,
    "second_segment_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "work_date" DATE NOT NULL,
    "resolution_action" "ExceptionResolutionAction",
    "resolution_note" TEXT,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_segment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "devices_site_id_idx" ON "devices"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_company_id_name_key" ON "devices"("company_id", "name");

-- CreateIndex
CREATE INDEX "punch_events_employee_id_device_time_idx" ON "punch_events"("employee_id", "device_time");

-- CreateIndex
CREATE INDEX "punch_events_company_id_device_time_idx" ON "punch_events"("company_id", "device_time");

-- CreateIndex
CREATE INDEX "punch_events_device_id_device_time_idx" ON "punch_events"("device_id", "device_time");

-- CreateIndex
CREATE UNIQUE INDEX "punch_events_device_id_device_event_id_key" ON "punch_events"("device_id", "device_event_id");

-- CreateIndex
CREATE INDEX "work_segments_employee_id_started_at_idx" ON "work_segments"("employee_id", "started_at");

-- CreateIndex
CREATE INDEX "work_segments_company_id_work_date_idx" ON "work_segments"("company_id", "work_date");

-- CreateIndex
CREATE INDEX "work_segments_site_id_work_date_idx" ON "work_segments"("site_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "work_segments_clock_in_punch_id_clock_out_punch_id_key" ON "work_segments"("clock_in_punch_id", "clock_out_punch_id");

-- CreateIndex
CREATE INDEX "attendance_exceptions_company_id_status_occurred_at_idx" ON "attendance_exceptions"("company_id", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "attendance_exceptions_site_id_status_idx" ON "attendance_exceptions"("site_id", "status");

-- CreateIndex
CREATE INDEX "attendance_exceptions_second_site_id_idx" ON "attendance_exceptions"("second_site_id");

-- CreateIndex
CREATE INDEX "attendance_exceptions_employee_id_idx" ON "attendance_exceptions"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_exceptions_company_id_dedupe_key_key" ON "attendance_exceptions"("company_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_events" ADD CONSTRAINT "punch_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_events" ADD CONSTRAINT "punch_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_events" ADD CONSTRAINT "punch_events_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_events" ADD CONSTRAINT "punch_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_clock_in_punch_id_fkey" FOREIGN KEY ("clock_in_punch_id") REFERENCES "punch_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_clock_out_punch_id_fkey" FOREIGN KEY ("clock_out_punch_id") REFERENCES "punch_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_second_site_id_fkey" FOREIGN KEY ("second_site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_punch_id_fkey" FOREIGN KEY ("punch_id") REFERENCES "punch_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "work_segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_second_segment_id_fkey" FOREIGN KEY ("second_segment_id") REFERENCES "work_segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_resolution_segment_id_fkey" FOREIGN KEY ("resolution_segment_id") REFERENCES "work_segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written rules (Prisma cannot express these). Both developers review
-- this block; docs/plan/12-attendance-design.md explains each one.
-- =============================================================================

-- Row-level security, like every table (docs/plan/04-data-model.md).
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "punch_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_exceptions" ENABLE ROW LEVEL SECURITY;

-- Punches are ground truth: never changed, never deleted, never truncated
-- (the same idea as the audit log's trigger).
CREATE FUNCTION punch_events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'punch_events is append-only: punches can never be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER punch_events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "punch_events"
  FOR EACH ROW EXECUTE FUNCTION punch_events_are_append_only();

CREATE TRIGGER punch_events_no_truncate
  BEFORE TRUNCATE ON "punch_events"
  FOR EACH STATEMENT EXECUTE FUNCTION punch_events_are_append_only();

-- The database refuses nonsense values even if application code slips.
ALTER TABLE "devices" ADD CONSTRAINT "devices_values_valid" CHECK (
  length("name") BETWEEN 2 AND 60
  AND "failed_signature_count" >= 0
  AND "rate_window_count" >= 0);

ALTER TABLE "punch_events" ADD CONSTRAINT "punch_events_values_valid" CHECK (
  length("device_event_id") BETWEEN 1 AND 128
  AND length("device_user_ref") BETWEEN 1 AND 32
  AND "payload_hash" ~ '^[0-9a-f]{64}$');

-- A shift ends after it starts and lasts at most 16 hours; MANUAL shifts
-- have no punches, derived ones always have both; VOIDED goes with voided_at.
ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_times_valid" CHECK (
  "ended_at" > "started_at"
  AND "ended_at" - "started_at" <= interval '16 hours'
  AND "worked_minutes" = floor(extract(epoch FROM "ended_at" - "started_at") / 60));

ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_punches_match_basis" CHECK (
  ("basis" = 'MANUAL' AND "clock_in_punch_id" IS NULL AND "clock_out_punch_id" IS NULL)
  OR ("basis" <> 'MANUAL' AND "clock_in_punch_id" IS NOT NULL AND "clock_out_punch_id" IS NOT NULL));

ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_void_matches_status" CHECK (
  ("status" = 'VOIDED') = ("voided_at" IS NOT NULL));

-- An OVERLAP names its two shifts; every other exception names its punch.
-- A RESOLVED exception records who, when, how and why, all together.
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_evidence" CHECK (
  ("type" = 'OVERLAP' AND "segment_id" IS NOT NULL AND "second_segment_id" IS NOT NULL)
  OR ("type" <> 'OVERLAP' AND "punch_id" IS NOT NULL));

ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_resolution_complete" CHECK (
  ("status" = 'RESOLVED') = (
    "resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL
    AND "resolution_action" IS NOT NULL AND "resolution_note" IS NOT NULL));

-- No two COUNTED shifts of one person may overlap. The range includes its
-- start and excludes its end ('[)'), so 06:00-18:00 and 18:00-06:00 can touch.
-- DISPUTED and VOIDED rows are outside the rule, so overlap evidence (ghost
-- rule R4) survives. The check runs at COMMIT (DEFERRABLE INITIALLY
-- DEFERRED), so a transaction may reorder shifts in any sequence; only the
-- final state must be valid.
-- btree_gist lets a GiST index compare plain values (employee_id =). On
-- Supabase extensions live in the "extensions" schema; elsewhere in public.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
  ELSE
    CREATE EXTENSION IF NOT EXISTS btree_gist;
  END IF;
END $$;

ALTER TABLE "work_segments" ADD CONSTRAINT "work_segments_no_overlap"
  EXCLUDE USING gist ("employee_id" WITH =, tstzrange("started_at", "ended_at", '[)') WITH &&)
  WHERE ("status" = 'CONFIRMED')
  DEFERRABLE INITIALLY DEFERRED;
