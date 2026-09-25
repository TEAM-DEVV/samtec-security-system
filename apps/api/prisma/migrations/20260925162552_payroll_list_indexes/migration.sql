-- Three indexes that match exactly how the payroll lists are read.
--
-- Each one mirrors an `orderBy` that a cursor pages on, tiebreaker included, so
-- the database walks the index instead of sorting the whole table. Without them
-- a company with a few years of payroll behind it pays for a full sort on every
-- page of every list.
--
-- The descending sort is part of the index, not an afterthought: these lists all
-- read newest first, and an ascending index cannot serve that without a reverse
-- scan.

-- CreateIndex
CREATE INDEX "payroll_lines_company_id_run_id_staff_number_id_idx" ON "payroll_lines"("company_id", "run_id", "staff_number", "id");

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_calculated_at_id_idx" ON "payroll_runs"("company_id", "calculated_at" DESC, "id");

-- CreateIndex
CREATE INDEX "payslips_company_id_generated_at_id_idx" ON "payslips"("company_id", "generated_at" DESC, "id");
