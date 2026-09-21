-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "site_assignments" ADD COLUMN     "post_id" UUID,
ADD COLUMN     "shift_pattern_id" UUID;

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "required_guards" INTEGER NOT NULL DEFAULT 1,
    "status" "PostStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_patterns" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_minutes" INTEGER NOT NULL,
    "end_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shift_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posts_company_id_idx" ON "posts"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "posts_site_id_name_key" ON "posts"("site_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "shift_patterns_company_id_name_key" ON "shift_patterns"("company_id", "name");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_assignments" ADD CONSTRAINT "site_assignments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_assignments" ADD CONSTRAINT "site_assignments_shift_pattern_id_fkey" FOREIGN KEY ("shift_pattern_id") REFERENCES "shift_patterns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, like every table (docs/plan/04-data-model.md).
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shift_patterns" ENABLE ROW LEVEL SECURITY;

-- The database refuses nonsense values even if application code slips.
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_minutes_valid"
  CHECK ("start_minutes" BETWEEN 0 AND 1439 AND "end_minutes" BETWEEN 0 AND 1439);
ALTER TABLE "posts" ADD CONSTRAINT "posts_required_guards_valid"
  CHECK ("required_guards" BETWEEN 1 AND 50);
