-- CreateTable
CREATE TABLE "attendance_checks" (
    "company_id" UUID NOT NULL,
    "overdue_checked_until" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_checks_pkey" PRIMARY KEY ("company_id")
);

-- AddForeignKey
ALTER TABLE "attendance_checks" ADD CONSTRAINT "attendance_checks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, like every table (docs/plan/04-data-model.md).
ALTER TABLE "attendance_checks" ENABLE ROW LEVEL SECURITY;
