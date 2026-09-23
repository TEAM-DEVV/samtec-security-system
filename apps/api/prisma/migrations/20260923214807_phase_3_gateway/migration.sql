-- AlterEnum
ALTER TYPE "AttendanceExceptionType" ADD VALUE 'UNEXPECTED_DEVICE_ENROLLMENT';

-- CreateTable
CREATE TABLE "finger_enrollment_windows" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "opened_by_user_id" UUID NOT NULL,
    "opens_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finger_enrollment_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_enrollment_reports" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "device_user_ref" TEXT NOT NULL,
    "employee_id" UUID,
    "finger_index" SMALLINT,
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "credential_id" UUID,
    "window_id" UUID,
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_enrollment_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finger_enrollment_windows_device_id_expires_at_idx" ON "finger_enrollment_windows"("device_id", "expires_at");

-- CreateIndex
CREATE INDEX "finger_enrollment_windows_employee_id_idx" ON "finger_enrollment_windows"("employee_id");

-- CreateIndex
CREATE INDEX "terminal_enrollment_reports_company_id_reported_at_idx" ON "terminal_enrollment_reports"("company_id", "reported_at");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_enrollment_reports_device_id_device_user_ref_enrol_key" ON "terminal_enrollment_reports"("device_id", "device_user_ref", "enrolled_at");

-- AddForeignKey
ALTER TABLE "finger_enrollment_windows" ADD CONSTRAINT "finger_enrollment_windows_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finger_enrollment_windows" ADD CONSTRAINT "finger_enrollment_windows_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finger_enrollment_windows" ADD CONSTRAINT "finger_enrollment_windows_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_enrollment_reports" ADD CONSTRAINT "terminal_enrollment_reports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_enrollment_reports" ADD CONSTRAINT "terminal_enrollment_reports_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_enrollment_reports" ADD CONSTRAINT "terminal_enrollment_reports_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Rules the database keeps itself (docs/plan/13 section 5).
-- ---------------------------------------------------------------------------

ALTER TABLE "finger_enrollment_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "terminal_enrollment_reports" ENABLE ROW LEVEL SECURITY;

-- A window is always a real stretch of time, and never a long one: 30 minutes
-- is what an ADMIN opens, and a window that never closed would be a terminal
-- allowed to enroll people for ever.
ALTER TABLE "finger_enrollment_windows" ADD CONSTRAINT "finger_enrollment_windows_times_valid" CHECK (
  "expires_at" > "opens_at"
  AND "expires_at" <= "opens_at" + INTERVAL '30 minutes');

-- Only a ZKTeco terminal of the same company can have one, and only for a
-- worker whose record is not blocked as a duplicate.
CREATE FUNCTION public.finger_enrollment_windows_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.devices
    WHERE id = NEW.device_id AND kind = 'ZKTECO' AND company_id = NEW.company_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finger_enrollment_windows: only a ZKTeco terminal of the same company has enrollment windows';
  END IF;
  PERFORM public.biometric_lock_worker(NEW.employee_id, NEW.company_id, TG_TABLE_NAME);
  IF public.biometric_record_is_blocked(NEW.employee_id) THEN
    RAISE EXCEPTION 'finger_enrollment_windows: a record blocked as a duplicate can only be terminated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finger_enrollment_windows_before_insert
  BEFORE INSERT ON "finger_enrollment_windows"
  FOR EACH ROW EXECUTE FUNCTION public.finger_enrollment_windows_before_insert();

-- The only change a window ever takes is being closed early, when an ADMIN
-- opens a new one for the same worker on the same terminal.
CREATE FUNCTION public.finger_enrollment_windows_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.device_id <> OLD.device_id
     OR NEW.employee_id <> OLD.employee_id OR NEW.opened_by_user_id <> OLD.opened_by_user_id
     OR NEW.opens_at <> OLD.opens_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'finger_enrollment_windows: a window never changes except to close early';
  END IF;
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'finger_enrollment_windows: a window is never extended';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finger_enrollment_windows_guard_update
  BEFORE UPDATE ON "finger_enrollment_windows"
  FOR EACH ROW EXECUTE FUNCTION public.finger_enrollment_windows_guard();

-- An accepted report names the worker, the window that allowed it and the
-- credential it made; a refused one names none of them.
ALTER TABLE "terminal_enrollment_reports" ADD CONSTRAINT "terminal_enrollment_reports_shape" CHECK (
  "accepted" = ("credential_id" IS NOT NULL)
  AND "accepted" = ("window_id" IS NOT NULL)
  AND (NOT "accepted" OR "employee_id" IS NOT NULL)
  AND length("device_user_ref") BETWEEN 1 AND 32
  AND ("finger_index" IS NULL OR "finger_index" BETWEEN 0 AND 9));

-- What a terminal claimed is never rewritten: it is the evidence that makes a
-- terminal enrolling somebody by itself visible instead of silent.
CREATE FUNCTION public.terminal_enrollment_reports_are_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'terminal_enrollment_reports is append-only';
END;
$$;

CREATE TRIGGER terminal_enrollment_reports_no_update
  BEFORE UPDATE OR DELETE ON "terminal_enrollment_reports"
  FOR EACH ROW EXECUTE FUNCTION public.terminal_enrollment_reports_are_append_only();

CREATE TRIGGER terminal_enrollment_reports_no_truncate
  BEFORE TRUNCATE ON "terminal_enrollment_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION public.terminal_enrollment_reports_are_append_only();

-- An enrollment is not a punch, so this one exception type carries neither a
-- punch nor segments: its evidence is the terminal_enrollment_reports row.
ALTER TABLE "attendance_exceptions" DROP CONSTRAINT "attendance_exceptions_evidence";
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_evidence" CHECK (
  ("type" = 'OVERLAP' AND "segment_id" IS NOT NULL AND "second_segment_id" IS NOT NULL)
  OR ("type" = 'UNEXPECTED_DEVICE_ENROLLMENT'
      AND "punch_id" IS NULL AND "segment_id" IS NULL AND "second_segment_id" IS NULL)
  OR ("type" NOT IN ('OVERLAP', 'UNEXPECTED_DEVICE_ENROLLMENT') AND "punch_id" IS NOT NULL));

-- A report points at what it made and at what allowed it, and neither can
-- vanish underneath it: both tables refuse deletion anyway.
ALTER TABLE "terminal_enrollment_reports" ADD CONSTRAINT "terminal_enrollment_reports_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "biometric_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "terminal_enrollment_reports" ADD CONSTRAINT "terminal_enrollment_reports_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "finger_enrollment_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
