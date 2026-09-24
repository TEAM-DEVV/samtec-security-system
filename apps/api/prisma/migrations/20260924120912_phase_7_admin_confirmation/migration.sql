-- AlterTable
ALTER TABLE "users" ADD COLUMN     "admin_confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "admin_confirmed_by_user_id" UUID,
ADD COLUMN     "admin_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "admin_requested_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_admin_requested_by_user_id_fkey" FOREIGN KEY ("admin_requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_admin_confirmed_by_user_id_fkey" FOREIGN KEY ("admin_confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Written by hand: what Prisma cannot express (docs/plan/06, "Two
-- administrators").
-- ---------------------------------------------------------------------------

-- Administrators that exist before the rule stay usable: recorded as confirmed
-- when they were created, with nobody named, because nobody was asked.
UPDATE "users"
SET "admin_requested_at" = "created_at",
    "admin_confirmed_at" = "created_at"
WHERE "role" = 'ADMIN';

-- The four columns belong to ADMIN accounts only. An account WAITS when it
-- has a request and no confirmation. An ADMIN with neither was made directly
-- in the database (the seed, the setup script, a test): that already needs
-- database access, a stronger check than a second login. A confirmation or a
-- requester needs a request date, and a confirmation never comes before it.
ALTER TABLE "users" ADD CONSTRAINT "users_admin_confirmation_shape" CHECK (
  ("role" = 'ADMIN'
   AND ("admin_requested_at" IS NOT NULL
        OR ("admin_requested_by_user_id" IS NULL AND "admin_confirmed_by_user_id" IS NULL
            AND "admin_confirmed_at" IS NULL)))
  OR ("role" <> 'ADMIN'
      AND "admin_requested_by_user_id" IS NULL AND "admin_requested_at" IS NULL
      AND "admin_confirmed_by_user_id" IS NULL AND "admin_confirmed_at" IS NULL)
);
ALTER TABLE "users" ADD CONSTRAINT "users_admin_confirmation_dated" CHECK (
  ("admin_confirmed_by_user_id" IS NULL OR "admin_confirmed_at" IS NOT NULL)
  AND ("admin_confirmed_at" IS NULL OR "admin_confirmed_at" >= "admin_requested_at")
);

-- The whole point: the person confirming is never the person who asked, and
-- never the account itself. IS DISTINCT FROM, so a NULL can never make the
-- CHECK come out NULL and let the row through.
ALTER TABLE "users" ADD CONSTRAINT "users_admin_confirmed_by_someone_else" CHECK (
  "admin_confirmed_by_user_id" IS NULL
  OR ("admin_confirmed_by_user_id" IS DISTINCT FROM "admin_requested_by_user_id"
      AND "admin_confirmed_by_user_id" IS DISTINCT FROM "id")
);
