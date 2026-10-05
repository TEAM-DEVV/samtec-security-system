-- The company's own bank account: where the monthly bank file is paid from,
-- and what the payment receipt names.
--
-- Four nullable columns on "companies", owned by the new `company` module
-- (identity and payroll keep writing only their own tables). Nullable
-- together because a company may not have set one up yet, the same reason
-- "employee_payment_details" is nullable. No row-level-security change is
-- needed here: "companies" already carries it, and this adds columns to an
-- existing table rather than a new one.

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "account_name" TEXT,
ADD COLUMN     "account_number" TEXT;
