-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "activated_at" TIMESTAMPTZ(3),
ADD COLUMN     "activated_by_user_id" UUID,
ADD COLUMN     "key_issued_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_key_issued_by_user_id_fkey" FOREIGN KEY ("key_issued_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_activated_by_user_id_fkey" FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- Who switched a device on, and when, are only meaningful while it is on.
ALTER TABLE "devices" ADD CONSTRAINT "devices_activator_only_when_active" CHECK (
  "status" = 'ACTIVE' OR ("activated_by_user_id" IS NULL AND "activated_at" IS NULL)
);

-- **A live key was switched on by somebody.** Without this, a write that only
-- flips the status -- a racing update, a repair script -- would leave a device
-- working that nobody ever approved, and the CHECK above would not notice,
-- because a sole administrator legitimately leaves the activator empty. The
-- date is what every path must set, so it is the one this insists on. A device
-- with no issuer recorded predates the rule and is left alone.
ALTER TABLE "devices" ADD CONSTRAINT "devices_active_key_was_switched_on" CHECK (
  "status" <> 'ACTIVE' OR "key_issued_by_user_id" IS NULL OR "activated_at" IS NOT NULL
);
