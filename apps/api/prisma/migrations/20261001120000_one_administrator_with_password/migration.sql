-- ---------------------------------------------------------------------------
-- Every administrator acts alone (issue #99, task 5; docs/plan/06, "One
-- administrator, with a password").
--
-- Until now five rules in this database insisted that the person who started
-- a sensitive action was never the person who finished it: the maker-checker
-- rule on payroll runs, the second administrator on ADMIN accounts, the second
-- administrator on device keys, and the reviewer of a duplicate face or an
-- exemption never being the one who enrolled or asked. The owner has replaced
-- that with a different safeguard: sensitive actions ask the administrator for
-- their own password, every action stays in the audit log, and ghost detection
-- still flags suspicious patterns. The columns that record who did what are
-- all kept; only the "and it was somebody else" clauses go.
--
-- A block is no longer final either: an administrator may lift it, and the
-- record enrolls again from scratch. The wiped template never comes back.
-- ---------------------------------------------------------------------------

-- 1. A duplicate review may be decided by whoever enrolled the face, and a
--    lifted block leaves the losing face REVOKED instead of BLOCKED.
ALTER TABLE "biometric_credentials" DROP CONSTRAINT "biometric_credentials_decision_valid";
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_decision_valid" CHECK (
  ("verdict" IS NOT NULL)
    = ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL AND "resolution_note" IS NOT NULL)
  AND ("verdict" IS NULL OR "collision_employee_id" IS NOT NULL)
  AND COALESCE("verdict" = 'SAME_PERSON', false) = ("kept_employee_id" IS NOT NULL)
  AND ("kept_employee_id" IS NULL
    OR COALESCE("kept_employee_id" IN ("employee_id", "collision_employee_id"), false))
  AND ("resolution_note" IS NULL OR length("resolution_note") BETWEEN 3 AND 500)
  AND ("dedupe" <> 'CLEARED'
    OR COALESCE("verdict" = 'DIFFERENT_PEOPLE'
      OR ("verdict" = 'SAME_PERSON' AND "kept_employee_id" = "employee_id"), false))
  AND ("dedupe" <> 'COLLISION' OR "verdict" IS NULL
    OR COALESCE("verdict" = 'SAME_PERSON' AND "kept_employee_id" = "collision_employee_id"
      AND "status" IN ('BLOCKED', 'REVOKED'), false)));

-- 2. An exemption may be decided by the administrator who asked for it.
ALTER TABLE "biometric_exemptions" DROP CONSTRAINT "biometric_exemptions_review_valid";
ALTER TABLE "biometric_exemptions" ADD CONSTRAINT "biometric_exemptions_review_valid" CHECK (
  ("reviewed_at" IS NOT NULL) = ("reviewed_by_user_id" IS NOT NULL)
  AND ("reviewed_at" IS NOT NULL) = ("review_note" IS NOT NULL)
  AND ("status" NOT IN ('APPROVED', 'REJECTED') OR "reviewed_at" IS NOT NULL)
  AND ("status" <> 'REQUESTED' OR "reviewed_at" IS NULL)
  AND ("status" = 'ENDED') = ("ended_at" IS NOT NULL));

-- 3. Whoever calculated or submitted a payroll run may approve or reject it.
ALTER TABLE "payroll_runs" DROP CONSTRAINT "payroll_runs_maker_is_not_checker";

-- 4. An ADMIN account needs no second administrator's confirmation.
ALTER TABLE "users" DROP CONSTRAINT "users_admin_confirmed_by_someone_else";

-- 5. The administrator who registered a device may switch it on.
ALTER TABLE "devices" DROP CONSTRAINT "devices_issuer_is_not_activator";

-- 6. The credential guard, with the one new transition: BLOCKED to REVOKED.
CREATE OR REPLACE FUNCTION public.biometric_credentials_guard() RETURNS trigger
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

  -- The status only moves forward. A block may be lifted by an administrator
  -- (it becomes a plain revocation: the wiped template never comes back, and
  -- the worker enrolls again from scratch), which is the one step back.
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('ACTIVE', 'BLOCKED', 'REVOKED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('BLOCKED', 'REVOKED'))
    OR (OLD.status = 'REVOKED' AND NEW.status = 'BLOCKED')
    OR (OLD.status = 'BLOCKED' AND NEW.status = 'REVOKED')) THEN
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

-- 7. Nobody is left waiting. An account held under the old rule is confirmed
--    now, in the name of whoever asked, so it can be used as soon as its
--    password is set.
UPDATE "users"
SET "admin_confirmed_by_user_id" = "admin_requested_by_user_id", "admin_confirmed_at" = now()
WHERE "role" = 'ADMIN' AND "admin_requested_at" IS NOT NULL AND "admin_confirmed_at" IS NULL;
