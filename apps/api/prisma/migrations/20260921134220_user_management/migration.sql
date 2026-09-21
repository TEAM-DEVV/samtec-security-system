-- AlterEnum
ALTER TYPE "AuthChallengePurpose" ADD VALUE 'SET_PASSWORD';

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- The database refuses nonsense accounts even if application code slips:
-- SUPERVISOR and GUARD accounts are always linked to an employee (their data
-- access follows the link), and ADMIN and HR_PAYROLL accounts never are, so
-- terminating an employee can never switch off an office account.
ALTER TABLE "users" ADD CONSTRAINT "users_role_matches_employee_link"
  CHECK (("role" IN ('SUPERVISOR', 'GUARD')) = ("employee_id" IS NOT NULL));

-- Emails are stored trimmed and lower-case, so sign-in is not case-sensitive
-- and "Ama@x" can never sit beside "ama@x".
ALTER TABLE "users" ADD CONSTRAINT "users_email_is_normalized"
  CHECK ("email" = lower(btrim("email")));
