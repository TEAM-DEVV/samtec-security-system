-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'LOCKED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayrollRunExclusionReason" AS ENUM ('SUSPENDED', 'NO_PAY_TERMS');

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_tables" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tax_year" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "ssnit_employee_basis_points" INTEGER NOT NULL,
    "ssnit_employer_basis_points" INTEGER NOT NULL,
    "ssnit_tier1_basis_points" INTEGER NOT NULL,
    "ssnit_tier2_basis_points" INTEGER NOT NULL,
    "source_name" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_checked_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "tax_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_bands" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tax_table_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "width_pesewas" INTEGER,
    "rate_basis_points" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_pay_terms" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "basic_monthly_pesewas" INTEGER NOT NULL,
    "overtime_hourly_pesewas" INTEGER NOT NULL,
    "taxable_allowance_pesewas" INTEGER NOT NULL DEFAULT 0,
    "non_taxable_allowance_pesewas" INTEGER NOT NULL DEFAULT 0,
    "other_deduction_pesewas" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "employee_pay_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_payment_details" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "bank_name" TEXT,
    "account_name" TEXT,
    "account_number" TEXT,
    "momo_number" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_user_id" UUID NOT NULL,

    CONSTRAINT "employee_payment_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "tax_table_id" UUID NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "calculated_by_user_id" UUID NOT NULL,
    "calculated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by_user_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "submission_note" TEXT,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "approval_note" TEXT,
    "rejected_by_user_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "paid_by_user_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "paid_on" DATE,
    "payment_reference" TEXT,
    "payment_note" TEXT,
    "excluded_employees" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "staff_number" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "employee_status" "EmployeeStatus" NOT NULL,
    "pay_terms_id" UUID NOT NULL,
    "pay_terms_effective_from" DATE NOT NULL,
    "basic_monthly_pesewas" INTEGER NOT NULL,
    "overtime_hourly_pesewas" INTEGER NOT NULL,
    "days_in_period" INTEGER NOT NULL,
    "days_employed" INTEGER NOT NULL,
    "scheduled_minutes" INTEGER NOT NULL,
    "punched_minutes" INTEGER NOT NULL,
    "regular_minutes" INTEGER NOT NULL,
    "overtime_minutes" INTEGER NOT NULL,
    "basic_pesewas" INTEGER NOT NULL,
    "overtime_pesewas" INTEGER NOT NULL,
    "taxable_allowance_pesewas" INTEGER NOT NULL,
    "non_taxable_allowance_pesewas" INTEGER NOT NULL,
    "gross_pesewas" INTEGER NOT NULL,
    "taxable_gross_pesewas" INTEGER NOT NULL,
    "ssnit_employee_pesewas" INTEGER NOT NULL,
    "ssnit_employer_pesewas" INTEGER NOT NULL,
    "ssnit_tier1_pesewas" INTEGER NOT NULL,
    "ssnit_tier2_pesewas" INTEGER NOT NULL,
    "chargeable_income_pesewas" INTEGER NOT NULL,
    "paye_pesewas" INTEGER NOT NULL,
    "other_deductions_pesewas" INTEGER NOT NULL,
    "net_pay_pesewas" INTEGER NOT NULL,
    "tax_table_id" UUID NOT NULL,
    "tax_year" INTEGER NOT NULL,
    "adjusts_line_id" UUID,
    "adjustment_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "pdf" BYTEA NOT NULL,
    "pdf_size_bytes" INTEGER NOT NULL,
    "pdf_sha256" TEXT NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_periods_company_id_starts_on_idx" ON "payroll_periods"("company_id", "starts_on");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_company_id_year_month_key" ON "payroll_periods"("company_id", "year", "month");

-- CreateIndex
CREATE INDEX "tax_tables_company_id_tax_year_idx" ON "tax_tables"("company_id", "tax_year");

-- CreateIndex
CREATE UNIQUE INDEX "tax_tables_company_id_effective_from_key" ON "tax_tables"("company_id", "effective_from");

-- CreateIndex
CREATE INDEX "tax_bands_company_id_idx" ON "tax_bands"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_bands_tax_table_id_ordinal_key" ON "tax_bands"("tax_table_id", "ordinal");

-- CreateIndex
CREATE INDEX "employee_pay_terms_company_id_idx" ON "employee_pay_terms"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_pay_terms_employee_id_effective_from_key" ON "employee_pay_terms"("employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "employee_payment_details_employee_id_key" ON "employee_payment_details"("employee_id");

-- CreateIndex
CREATE INDEX "employee_payment_details_company_id_idx" ON "employee_payment_details"("company_id");

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_period_id_idx" ON "payroll_runs"("company_id", "period_id");

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_status_idx" ON "payroll_runs"("company_id", "status");

-- CreateIndex
CREATE INDEX "payroll_lines_company_id_run_id_idx" ON "payroll_lines"("company_id", "run_id");

-- CreateIndex
CREATE INDEX "payroll_lines_employee_id_idx" ON "payroll_lines"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_line_id_key" ON "payslips"("line_id");

-- CreateIndex
CREATE INDEX "payslips_company_id_employee_id_idx" ON "payslips"("company_id", "employee_id");

-- CreateIndex
CREATE INDEX "payslips_run_id_idx" ON "payslips"("run_id");

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_tables" ADD CONSTRAINT "tax_tables_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_bands" ADD CONSTRAINT "tax_bands_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_bands" ADD CONSTRAINT "tax_bands_tax_table_id_fkey" FOREIGN KEY ("tax_table_id") REFERENCES "tax_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_terms" ADD CONSTRAINT "employee_pay_terms_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_terms" ADD CONSTRAINT "employee_pay_terms_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_payment_details" ADD CONSTRAINT "employee_payment_details_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_payment_details" ADD CONSTRAINT "employee_payment_details_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tax_table_id_fkey" FOREIGN KEY ("tax_table_id") REFERENCES "tax_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_pay_terms_id_fkey" FOREIGN KEY ("pay_terms_id") REFERENCES "employee_pay_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tax_table_id_fkey" FOREIGN KEY ("tax_table_id") REFERENCES "tax_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_adjusts_line_id_fkey" FOREIGN KEY ("adjusts_line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Written by hand. Everything below is a rule the DATABASE enforces, so a bug
-- in the service can never write payroll that does not add up, change a run
-- after it was approved, or let one person approve their own work.
-- Design: docs/plan/09-payroll-engine-ghana.md, "the rules the database must
-- enforce", plus decisions 12, 16, 17, 20, 22 and 24.
-- ===========================================================================

-- Row-level security, like every table (docs/plan/04-data-model.md).
ALTER TABLE "payroll_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payslips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tax_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tax_bands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_pay_terms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_payment_details" ENABLE ROW LEVEL SECURITY;

-- Nothing in payroll is ever erased: it is the evidence behind what people
-- were paid. One function refuses every delete and every TRUNCATE.
CREATE FUNCTION public.payroll_rows_are_never_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
END;
$$;

-- ---------------------------------------------------------------------------
-- Periods: exactly one calendar month, opened once and closed once.
-- ---------------------------------------------------------------------------

-- The engine divides by the period's length, so a period that is not a whole
-- month would quietly pro-rate everybody's salary wrongly (decision 24).
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_whole_month" CHECK (
  "year" BETWEEN 2020 AND 2100
  AND "month" BETWEEN 1 AND 12
  AND "starts_on" = make_date("year", "month", 1)
  AND "ends_on" = (make_date("year", "month", 1) + INTERVAL '1 month' - INTERVAL '1 day')::date);

-- Who closed it and when are recorded together, or not at all.
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_closed_together" CHECK (
  ("closed_at" IS NULL) = ("closed_by_user_id" IS NULL)
  AND ("status" = 'CLOSED') = ("closed_at" IS NOT NULL));

CREATE FUNCTION public.payroll_periods_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.year <> OLD.year OR NEW.month <> OLD.month
     OR NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on THEN
    RAISE EXCEPTION 'payroll_periods: which month a period is never changes';
  END IF;
  -- A month is closed once and never reopens.
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'OPEN' AND NEW.status = 'CLOSED') THEN
    RAISE EXCEPTION 'payroll_periods: status % can never become %', OLD.status, NEW.status;
  END IF;
  IF OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.closed_by_user_id IS DISTINCT FROM OLD.closed_by_user_id) THEN
    RAISE EXCEPTION 'payroll_periods: closing a month is final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payroll_periods_guard_update
  BEFORE UPDATE ON "payroll_periods"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_periods_guard();
CREATE TRIGGER payroll_periods_no_delete
  BEFORE DELETE ON "payroll_periods"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_rows_are_never_deleted();
CREATE TRIGGER payroll_periods_no_truncate
  BEFORE TRUNCATE ON "payroll_periods"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Tax tables and bands: a rate change is a new version, never an edit.
-- ---------------------------------------------------------------------------

ALTER TABLE "tax_tables" ADD CONSTRAINT "tax_tables_values_valid" CHECK (
  "tax_year" BETWEEN 2020 AND 2100
  AND "ssnit_employee_basis_points" BETWEEN 0 AND 10000
  AND "ssnit_employer_basis_points" BETWEEN 0 AND 10000
  AND "ssnit_tier1_basis_points" BETWEEN 0 AND 10000
  AND "ssnit_tier2_basis_points" BETWEEN 0 AND 10000
  AND ("effective_to" IS NULL OR "effective_to" >= "effective_from")
  AND length("source_name") BETWEEN 2 AND 200
  AND length("source_url") BETWEEN 1 AND 500);

ALTER TABLE "tax_bands" ADD CONSTRAINT "tax_bands_values_valid" CHECK (
  "ordinal" BETWEEN 1 AND 20
  AND "rate_basis_points" BETWEEN 0 AND 10000
  AND ("width_pesewas" IS NULL OR "width_pesewas" >= 1));

-- A locked run's arithmetic must be reproducible for ever, so the version it
-- used is frozen the moment it is referred to (decision 12).
CREATE FUNCTION public.tax_tables_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.tax_table_id = OLD.id) THEN
    RAISE EXCEPTION 'tax_tables: a version a payroll run has used can never change';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION public.tax_bands_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.tax_table_id = OLD.tax_table_id) THEN
    RAISE EXCEPTION 'tax_bands: a version a payroll run has used can never change';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER tax_tables_freeze_change
  BEFORE UPDATE OR DELETE ON "tax_tables"
  FOR EACH ROW EXECUTE FUNCTION public.tax_tables_freeze();
CREATE TRIGGER tax_tables_no_truncate
  BEFORE TRUNCATE ON "tax_tables"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_rows_are_never_deleted();
CREATE TRIGGER tax_bands_freeze_change
  BEFORE UPDATE OR DELETE ON "tax_bands"
  FOR EACH ROW EXECUTE FUNCTION public.tax_bands_freeze();
CREATE TRIGGER tax_bands_no_truncate
  BEFORE TRUNCATE ON "tax_bands"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_rows_are_never_deleted();

-- The bands of one version must cover every income: ordinals 1..n with no
-- gaps, and exactly one band with no width — the last. Without an open top
-- band the highest earners would be silently untaxed. It is checked after the
-- whole set is written, because the rows arrive one at a time.
CREATE FUNCTION public.tax_bands_shape() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  band_count integer;
  highest integer;
  open_bands integer;
  open_ordinal integer;
BEGIN
  SELECT count(*), max(b.ordinal), count(*) FILTER (WHERE b.width_pesewas IS NULL),
         max(b.ordinal) FILTER (WHERE b.width_pesewas IS NULL)
    INTO band_count, highest, open_bands, open_ordinal
    FROM public.tax_bands b WHERE b.tax_table_id = NEW.tax_table_id;

  IF band_count <> highest THEN
    RAISE EXCEPTION 'tax_bands: ordinals run from 1 upwards with no gaps';
  END IF;
  IF open_bands <> 1 OR open_ordinal <> highest THEN
    RAISE EXCEPTION 'tax_bands: exactly the last band has no width, because it has no upper limit';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tax_bands_shape_valid
  AFTER INSERT OR UPDATE ON "tax_bands"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.tax_bands_shape();

-- ---------------------------------------------------------------------------
-- Pay terms: effective-dated history, never edited (decision 1).
-- ---------------------------------------------------------------------------

ALTER TABLE "employee_pay_terms" ADD CONSTRAINT "employee_pay_terms_money_valid" CHECK (
  "basic_monthly_pesewas" BETWEEN 0 AND 2000000000
  AND "overtime_hourly_pesewas" BETWEEN 0 AND 2000000000
  AND "taxable_allowance_pesewas" BETWEEN 0 AND 2000000000
  AND "non_taxable_allowance_pesewas" BETWEEN 0 AND 2000000000
  AND "other_deduction_pesewas" BETWEEN 0 AND 2000000000);

CREATE FUNCTION public.employee_pay_terms_are_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'employee_pay_terms is append-only: a change in pay is a new row';
END;
$$;

CREATE TRIGGER employee_pay_terms_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "employee_pay_terms"
  FOR EACH ROW EXECUTE FUNCTION public.employee_pay_terms_are_append_only();
CREATE TRIGGER employee_pay_terms_no_truncate
  BEFORE TRUNCATE ON "employee_pay_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION public.employee_pay_terms_are_append_only();

-- ---------------------------------------------------------------------------
-- Payment details: personal data, edited in place, never erased.
-- ---------------------------------------------------------------------------

-- These two values are written into the bank file, so a tab, a line break or
-- a leading character a spreadsheet would run as a formula is refused here
-- too, not only at the API boundary (decision 23).
ALTER TABLE "employee_payment_details" ADD CONSTRAINT "employee_payment_details_valid" CHECK (
  ("account_number" IS NULL OR "account_number" ~ '^[0-9]{5,20}$')
  AND ("momo_number" IS NULL OR "momo_number" ~ '^\+233[0-9]{9}$')
  AND ("bank_name" IS NULL OR "bank_name" ~ '^[^=+@\t\r\n"-][^\t\r\n]{1,99}$')
  AND ("account_name" IS NULL OR "account_name" ~ '^[^=+@\t\r\n"-][^\t\r\n]{1,99}$'));

CREATE TRIGGER employee_payment_details_no_delete
  BEFORE DELETE ON "employee_payment_details"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_rows_are_never_deleted();
CREATE TRIGGER employee_payment_details_no_truncate
  BEFORE TRUNCATE ON "employee_payment_details"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Runs: the maker is never the checker, and a locked run never changes.
-- ---------------------------------------------------------------------------

-- Hard rule 3, in the database and not only in the service.
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_maker_is_not_checker" CHECK (
  ("approved_by_user_id" IS NULL
   OR ("approved_by_user_id" <> "submitted_by_user_id"
       AND "approved_by_user_id" <> "calculated_by_user_id"))
  AND ("rejected_by_user_id" IS NULL
   OR ("rejected_by_user_id" <> "submitted_by_user_id"
       AND "rejected_by_user_id" <> "calculated_by_user_id")));

-- Every status carries the full evidence of how it got there.
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_evidence_valid" CHECK (
  ("submitted_by_user_id" IS NULL) = ("submitted_at" IS NULL)
  AND ("approved_by_user_id" IS NULL) = ("approved_at" IS NULL)
  AND ("rejected_by_user_id" IS NULL) = ("rejected_at" IS NULL)
  AND ("paid_by_user_id" IS NULL) = ("paid_at" IS NULL)
  AND ("rejected_at" IS NULL OR "rejection_reason" IS NOT NULL)
  AND ("paid_at" IS NULL OR "paid_on" IS NOT NULL)
  AND ("status" <> 'DRAFT' OR ("submitted_at" IS NULL AND "approved_at" IS NULL
       AND "rejected_at" IS NULL AND "paid_at" IS NULL))
  AND ("status" <> 'PENDING_APPROVAL' OR ("submitted_at" IS NOT NULL
       AND "approved_at" IS NULL AND "rejected_at" IS NULL AND "paid_at" IS NULL))
  AND ("status" <> 'LOCKED' OR ("submitted_at" IS NOT NULL AND "approved_at" IS NOT NULL
       AND "rejected_at" IS NULL AND "paid_at" IS NULL))
  AND ("status" <> 'PAID' OR ("approved_at" IS NOT NULL AND "paid_at" IS NOT NULL
       AND "rejected_at" IS NULL))
  AND ("status" <> 'REJECTED' OR ("submitted_at" IS NOT NULL AND "rejected_at" IS NOT NULL
       AND "approved_at" IS NULL AND "paid_at" IS NULL)));

-- Decision 17: a period may hold several drafts and rejected runs, but only
-- ever one that is LOCKED or PAID.
CREATE UNIQUE INDEX "payroll_runs_one_approved_per_period"
  ON "payroll_runs" ("period_id")
  WHERE "status" IN ('LOCKED', 'PAID');

CREATE FUNCTION public.payroll_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- What was calculated, and from what, never changes.
  IF NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id
     OR NEW.tax_table_id <> OLD.tax_table_id
     OR NEW.calculated_by_user_id <> OLD.calculated_by_user_id
     OR NEW.calculated_at <> OLD.calculated_at
     OR NEW.excluded_employees::text <> OLD.excluded_employees::text THEN
    RAISE EXCEPTION 'payroll_runs: what was calculated never changes';
  END IF;

  -- The status only moves forward (decision 16).
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'PENDING_APPROVAL')
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('LOCKED', 'REJECTED'))
    OR (OLD.status = 'LOCKED' AND NEW.status = 'PAID')) THEN
    RAISE EXCEPTION 'payroll_runs: status % can never become %', OLD.status, NEW.status;
  END IF;

  -- Once approved, the pay is settled: only the record of payment may be added.
  IF OLD.status IN ('LOCKED', 'PAID') AND (
       NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.submission_note IS DISTINCT FROM OLD.submission_note
    OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.approval_note IS DISTINCT FROM OLD.approval_note) THEN
    RAISE EXCEPTION 'payroll_runs: a locked run can never be changed';
  END IF;

  -- Every decision, once made, is final.
  IF OLD.submitted_at IS NOT NULL AND (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id) THEN
    RAISE EXCEPTION 'payroll_runs: a submission is final';
  END IF;
  IF OLD.rejected_at IS NOT NULL AND (NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
     OR NEW.rejected_by_user_id IS DISTINCT FROM OLD.rejected_by_user_id
     OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason) THEN
    RAISE EXCEPTION 'payroll_runs: a rejection is final';
  END IF;
  IF OLD.paid_at IS NOT NULL AND (NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.paid_by_user_id IS DISTINCT FROM OLD.paid_by_user_id
     OR NEW.paid_on IS DISTINCT FROM OLD.paid_on
     OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
     OR NEW.payment_note IS DISTINCT FROM OLD.payment_note) THEN
    RAISE EXCEPTION 'payroll_runs: a payment record is final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payroll_runs_guard_update
  BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_guard();
CREATE TRIGGER payroll_runs_no_delete
  BEFORE DELETE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_rows_are_never_deleted();
CREATE TRIGGER payroll_runs_no_truncate
  BEFORE TRUNCATE ON "payroll_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Lines: the arithmetic itself, so a bug cannot write pay that does not add up.
-- ---------------------------------------------------------------------------

-- Decision 24. These hold for an adjustment line too, because the difference
-- of two sums that balance is itself a sum that balances. No money or minute
-- column has a sign check for the same reason: a correction may be negative.
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_adds_up" CHECK (
  "gross_pesewas" = "basic_pesewas" + "overtime_pesewas"
    + "taxable_allowance_pesewas" + "non_taxable_allowance_pesewas"
  AND "taxable_gross_pesewas" = "gross_pesewas" - "non_taxable_allowance_pesewas"
  AND "chargeable_income_pesewas" = "taxable_gross_pesewas" - "ssnit_employee_pesewas"
  AND "net_pay_pesewas" = "gross_pesewas" - "ssnit_employee_pesewas"
    - "paye_pesewas" - "other_deductions_pesewas"
  AND "punched_minutes" = "regular_minutes" + "overtime_minutes");

-- The pro-rating fraction is always a pair of calendar facts, never a difference.
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_days_valid" CHECK (
  "days_in_period" BETWEEN 1 AND 31
  AND "days_employed" BETWEEN 0 AND "days_in_period");

-- An adjustment line points at a line on an earlier run, and says why.
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_adjustment_shape" CHECK (
  ("adjusts_line_id" IS NULL) = ("adjustment_note" IS NULL)
  AND ("adjusts_line_id" IS NULL OR "adjusts_line_id" <> "id"));

-- One ordinary line per employee per run; an employee may also carry any
-- number of adjustment lines on the same run (decision 20).
CREATE UNIQUE INDEX "payroll_lines_one_per_employee_per_run"
  ON "payroll_lines" ("run_id", "employee_id")
  WHERE "adjusts_line_id" IS NULL;

CREATE FUNCTION public.payroll_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE run_status text;
BEGIN
  SELECT r.status::text INTO run_status FROM public.payroll_runs r
    WHERE r.id = COALESCE(NEW.run_id, OLD.run_id);
  IF run_status IN ('LOCKED', 'PAID') THEN
    RAISE EXCEPTION 'payroll_lines: the lines of an approved run can never change';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER payroll_lines_guard_change
  BEFORE INSERT OR UPDATE OR DELETE ON "payroll_lines"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_lines_guard();
CREATE TRIGGER payroll_lines_no_truncate
  BEFORE TRUNCATE ON "payroll_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_rows_are_never_deleted();

-- ---------------------------------------------------------------------------
-- Payslips: made once, when the run locks, and never touched again.
-- ---------------------------------------------------------------------------

ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pdf_valid" CHECK (
  "pdf_size_bytes" >= 1 AND "pdf_sha256" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION public.payslips_are_written_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'payslips: a payslip is made once, when the run is locked, and never changed';
END;
$$;

CREATE TRIGGER payslips_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION public.payslips_are_written_once();
CREATE TRIGGER payslips_no_truncate
  BEFORE TRUNCATE ON "payslips"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payslips_are_written_once();
