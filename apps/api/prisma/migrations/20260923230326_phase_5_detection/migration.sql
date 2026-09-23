-- CreateEnum
CREATE TYPE "DetectionRuleCode" AS ENUM ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11');

-- CreateEnum
CREATE TYPE "DetectionSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM');

-- CreateEnum
CREATE TYPE "DetectionAlertStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CONFIRMED_FRAUD');

-- CreateTable
CREATE TABLE "detection_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" "DetectionRuleCode" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "DetectionSeverity" NOT NULL,
    "thresholds" JSONB NOT NULL DEFAULT '{}',
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "detection_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection_alerts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "rule_code" "DetectionRuleCode" NOT NULL,
    "severity" "DetectionSeverity" NOT NULL,
    "status" "DetectionAlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupe_key" TEXT NOT NULL,
    "employee_id" UUID,
    "device_id" UUID,
    "site_id" UUID,
    "window_from" DATE NOT NULL,
    "window_to" DATE NOT NULL,
    "evidence" JSONB NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "detection_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detection_checks" (
    "company_id" UUID NOT NULL,
    "swept_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "detection_checks_pkey" PRIMARY KEY ("company_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "detection_rules_company_id_code_key" ON "detection_rules"("company_id", "code");

-- CreateIndex
CREATE INDEX "detection_alerts_company_id_status_opened_at_idx" ON "detection_alerts"("company_id", "status", "opened_at");

-- CreateIndex
CREATE INDEX "detection_alerts_employee_id_idx" ON "detection_alerts"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "detection_alerts_company_id_dedupe_key_key" ON "detection_alerts"("company_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "detection_rules" ADD CONSTRAINT "detection_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_alerts" ADD CONSTRAINT "detection_alerts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_alerts" ADD CONSTRAINT "detection_alerts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_alerts" ADD CONSTRAINT "detection_alerts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_alerts" ADD CONSTRAINT "detection_alerts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_checks" ADD CONSTRAINT "detection_checks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Rules the database keeps itself (docs/plan/08-ghost-detection-engine.md).
-- ---------------------------------------------------------------------------

ALTER TABLE "detection_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "detection_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "detection_checks" ENABLE ROW LEVEL SECURITY;

-- An alert is about something: a person, a device, or a site. One with no
-- subject at all could never be acted on.
ALTER TABLE "detection_alerts" ADD CONSTRAINT "detection_alerts_has_a_subject" CHECK (
  "employee_id" IS NOT NULL OR "device_id" IS NOT NULL OR "site_id" IS NOT NULL);

-- The window is a real stretch of days, and a resolution records who, when
-- and why, all together — the same shape every decision in this system has.
ALTER TABLE "detection_alerts" ADD CONSTRAINT "detection_alerts_shape" CHECK (
  "window_to" >= "window_from"
  AND length("dedupe_key") BETWEEN 1 AND 200
  AND ("status" IN ('RESOLVED', 'CONFIRMED_FRAUD')) = ("resolved_at" IS NOT NULL)
  AND ("resolved_at" IS NOT NULL) = ("resolved_by_user_id" IS NOT NULL)
  AND ("resolved_at" IS NOT NULL) = ("resolution_note" IS NOT NULL)
  AND ("resolution_note" IS NULL OR length("resolution_note") BETWEEN 3 AND 500));

-- A rule never acts by itself, and a decision is never quietly rewritten:
-- what the rule found stays, and a closed alert stays closed.
CREATE FUNCTION public.detection_alerts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.rule_code <> OLD.rule_code
     OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.opened_at <> OLD.opened_at
     OR NEW.window_from <> OLD.window_from OR NEW.window_to <> OLD.window_to
     OR NEW.evidence::text <> OLD.evidence::text THEN
    RAISE EXCEPTION 'detection_alerts: what a rule found is never rewritten';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.severity <> OLD.severity THEN
    RAISE EXCEPTION 'detection_alerts: who an alert is about never changes';
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'detection_alerts: a decided alert is never decided again';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER detection_alerts_guard_update
  BEFORE UPDATE ON "detection_alerts"
  FOR EACH ROW EXECUTE FUNCTION public.detection_alerts_guard();

CREATE FUNCTION public.detection_alerts_are_never_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'detection_alerts rows are never deleted';
END;
$$;

CREATE TRIGGER detection_alerts_no_delete
  BEFORE DELETE ON "detection_alerts"
  FOR EACH ROW EXECUTE FUNCTION public.detection_alerts_are_never_deleted();

CREATE TRIGGER detection_alerts_no_truncate
  BEFORE TRUNCATE ON "detection_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.detection_alerts_are_never_deleted();

-- Rule R10 asks one question of punch_events: which of this company's punches
-- matched nobody, lately. Every existing index on that table is on
-- device_time, so without this one the sweep would filter on a column nothing
-- is ordered by, and read across companies to do it.
CREATE INDEX "punch_events_orphans" ON "punch_events" ("company_id", "server_time");
