-- CreateTable
CREATE TABLE "employment_periods" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "termination_reason" "TerminationReason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employment_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employment_periods_company_id_idx" ON "employment_periods"("company_id");

-- CreateIndex
CREATE INDEX "employment_periods_employee_id_starts_on_idx" ON "employment_periods"("employee_id", "starts_on");

-- AddForeignKey
ALTER TABLE "employment_periods" ADD CONSTRAINT "employment_periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_periods" ADD CONSTRAINT "employment_periods_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Row-level security (written by hand): same rule as every table.
-- -----------------------------------------------------------------------------
ALTER TABLE "employment_periods" ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Backfill (written by hand): every existing employee gets one period from
-- their current record, so history starts complete. Employees created after
-- this migration get their periods from the API.
-- -----------------------------------------------------------------------------
INSERT INTO "employment_periods" (id, company_id, employee_id, starts_on, ends_on, termination_reason, created_at, updated_at)
SELECT gen_random_uuid(), company_id, id, hire_date, termination_date, termination_reason, now(), now()
FROM "employees";
