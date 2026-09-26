-- ---------------------------------------------------------------------------
-- A closed month is final, in the database too.
--
-- Design: docs/plan/09-payroll-engine-ghana.md, decisions 16, 17 and 22.
--
-- `payroll_runs_start_as_draft` already refuses a *new* run in a closed month,
-- but nothing refused moving a run that was already in one. So a draft left
-- behind in a month that was closed afterwards could still be submitted,
-- approved and paid -- and a run that reaches LOCKED can never be unlocked, by
-- anybody, by design. The one mistake this prevents is also the one mistake
-- that cannot be corrected afterwards.
--
-- That is why it is worth a third guard. Payroll's other irreversible rules are
-- each enforced in three places: the service answers a clear 409, the database
-- refuses it, and the run records the names so a refusal can be shown rather
-- than asserted. One of those guards on its own would be a promise; three is a
-- control. The service half of this rule is `refuseAClosedMonth` in
-- payroll-approval.service.ts; this is the database half.
--
-- Marking an approved run paid stays allowed, because the money may leave the
-- bank after the books are closed (`PayrollPeriodsService.close` says so, and
-- that is why `markPaid` is the one decision the service does not refuse in a
-- closed month). That carve-out is the whole reason this guard is written
-- against the status change rather than against any write: the rule is "a
-- closed month decides nothing new", not "a closed month is read-only".
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.payroll_runs_closed_month_is_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  period_status text;
BEGIN
  -- Only a decision is refused here. A write that leaves the status alone is
  -- some other rule's business, and `payroll_runs_guard` already has it.
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- The money may still be sent after the books are closed.
  IF OLD.status = 'LOCKED' AND NEW.status = 'PAID' THEN
    RETURN NEW;
  END IF;

  -- OLD, not NEW: the month this run actually lives in. `payroll_runs_guard`
  -- refuses a change of period_id, but this trigger runs first, so it does not
  -- lean on that. The row is locked FOR SHARE exactly as
  -- `payroll_runs_start_as_draft` locks it, so a month cannot be closed by
  -- another transaction between this check and the write it guards.
  SELECT p.status::text INTO period_status
    FROM public.payroll_periods p WHERE p.id = OLD.period_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_runs: a run needs a payroll period';
  END IF;
  IF period_status = 'CLOSED' THEN
    RAISE EXCEPTION 'payroll_runs: this month is closed, so the run can no longer become %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- This fires before `payroll_runs_guard_update`, because PostgreSQL runs a
-- table's BEFORE triggers in alphabetical order by trigger name and
-- `closed_month` sorts before `guard`. Either order refuses the same writes;
-- this way a write that is wrong for both reasons names the closed month, which
-- is the more useful of the two.
CREATE TRIGGER payroll_runs_closed_month_is_final_update
  BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_closed_month_is_final();
