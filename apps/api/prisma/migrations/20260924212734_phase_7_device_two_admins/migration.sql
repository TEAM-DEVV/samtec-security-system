-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "activated_by_user_id" UUID,
ADD COLUMN     "key_issued_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- Written by hand: the rule itself (docs/plan/06, "Two administrators").
-- ---------------------------------------------------------------------------

-- A device key can post punches, so the person who issued it is never the
-- person who switches it on. The same shape as payroll's maker-is-not-checker
-- rule, and IS DISTINCT FROM throughout so a NULL can never make the whole
-- CHECK come out NULL and let the row through.
--
-- Both empty means nobody was recorded: a device from before this rule, or one
-- the seed made. One empty means nobody else was needed — a company with a
-- single administrator, which the service decides and audits.
ALTER TABLE "devices" ADD CONSTRAINT "devices_issuer_is_not_activator" CHECK (
  "activated_by_user_id" IS NULL
  OR "activated_by_user_id" IS DISTINCT FROM "key_issued_by_user_id"
);

-- Who switched a device on is only meaningful while it is on.
ALTER TABLE "devices" ADD CONSTRAINT "devices_activator_only_when_active" CHECK (
  "status" = 'ACTIVE' OR "activated_by_user_id" IS NULL
);
