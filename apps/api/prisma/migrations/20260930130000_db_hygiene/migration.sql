-- ---------------------------------------------------------------------------
-- Three things the hosted database's own advisor pointed at, on the first day
-- real phones used it (docs/plan/04-data-model.md for the rules they follow).
--
-- 1. Prisma's bookkeeping table was the one table without row-level security.
--    The API connects as the owner, so nothing changes for it; the platform's
--    anonymous keys, which this application never uses, now see nothing there
--    either, the same as every other table.
-- 2. "This worker's shifts in this month" is read by payroll for every line
--    and by the attendance pages; it had no index of its own.
-- 3. The two append-only trigger functions ran with a mutable search path.
--    They reference nothing outside themselves, so pinning it changes no
--    behaviour and removes the warning.
-- ---------------------------------------------------------------------------

ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

CREATE INDEX "work_segments_employee_id_work_date_idx" ON "work_segments"("employee_id", "work_date");

ALTER FUNCTION "audit_logs_are_append_only"() SET search_path = public;
ALTER FUNCTION "punch_events_are_append_only"() SET search_path = public;
