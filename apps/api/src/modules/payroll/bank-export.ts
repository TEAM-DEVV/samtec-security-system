/**
 * The bank file: one row per worker, in a format a bank acts on.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md, decisions 22 and 23. A pure
 * function, because this is the one output of the whole system that moves real
 * money, and every rule in it should be provable on its own.
 *
 * Three rules are not obvious and all three matter:
 *
 * 1. **Every cell is quoted, and every quote inside is doubled** (RFC 4180). A
 *    worker's name containing a comma would otherwise shift every column after
 *    it — including the account number — so one person's money would be sent
 *    with another person's details.
 * 2. **A cell that a spreadsheet would run as a formula gets a leading
 *    apostrophe.** A payroll officer opens this file in Excel before sending
 *    it, and a name like `=HYPERLINK(...)` would execute there. The apostrophe
 *    is the standard way to say "this is text".
 * 3. **A row whose net pay is zero or less is left out.** A bank cannot take a
 *    negative payment. The payroll line and the payslip still show it, so the
 *    money is recovered by an adjustment line in a later month (decision 24).
 *
 * The file is byte-for-byte the shape the dashboard's mock produces, so a
 * screen built against the mock reads the real thing unchanged.
 */

/** What one worker's row is built from. */
export interface BankRowInput {
  employeeId: string;
  staffNumber: string;
  fullName: string;
  /** Summed across every line of the run, adjustments included. */
  netPayPesewas: number;
}

/** Where that worker's money goes, if anybody has said. */
export interface BankDestination {
  employeeId: string;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  momoNumber: string | null;
  /** When the destination was last changed, to compare with the approval. */
  updatedAt: Date;
}

/** The columns, in the order the contract documents them. */
const HEADER = [
  'staff_number',
  'full_name',
  'bank_name',
  'account_name',
  'account_number',
  'momo_number',
  'net_pay_pesewas',
  'net_pay_ghs',
  'employee_reference',
  'details_changed_after_approval',
];

/**
 * Anything a spreadsheet treats as the start of a formula. A tab and a carriage
 * return are here too: both can begin a formula once the sheet trims them.
 */
const LOOKS_LIKE_A_FORMULA = /^[=+\-@\t\r]/;

/**
 * One cell, safe to write.
 *
 * Empty for anything absent, so a worker with no details on file still gets a
 * row with the right number of columns — a payroll officer needs to see that
 * somebody is missing, not have them silently vanish from the file.
 */
export function csvCell(value: string | null | undefined): string {
  const text = value === null || value === undefined ? '' : value;
  const safe = LOOKS_LIKE_A_FORMULA.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Pesewas as the cedis a person would read, always with two decimal places. */
export function toGhs(pesewas: number): string {
  return (pesewas / 100).toFixed(2);
}

/**
 * The whole file.
 *
 * `approvedAt` is when the run was approved, and it decides the last column: a
 * destination changed after that point was **not** covered by the approval, so
 * the file says so rather than quietly paying to somewhere nobody signed off
 * (decision 22). A run with no approval yet has no bank file at all, so
 * `approvedAt` being null can only mean the caller asked too early.
 */
export function bankExportCsv(
  rows: readonly BankRowInput[],
  destinations: ReadonlyMap<string, BankDestination>,
  period: { endDate: string },
  approvedAt: Date | null,
): string {
  // The month the pay belongs to, for the reference a bank quotes back.
  const month = period.endDate.slice(0, 7);

  const payable = rows
    // A bank cannot take a negative payment.
    .filter((row) => row.netPayPesewas > 0)
    // Plain text order: a staff number is always SMT- and five digits, so this
    // sorts correctly, and it is the same comparison everywhere else.
    .sort((left, right) =>
      left.staffNumber < right.staffNumber ? -1 : left.staffNumber > right.staffNumber ? 1 : 0,
    );

  const body = payable.map((row) => {
    const destination = destinations.get(row.employeeId);
    const movedAfterApproval =
      approvedAt !== null && destination !== undefined && destination.updatedAt > approvedAt;
    return [
      row.staffNumber,
      row.fullName,
      destination?.bankName,
      destination?.accountName,
      destination?.accountNumber,
      destination?.momoNumber,
      String(row.netPayPesewas),
      toGhs(row.netPayPesewas),
      `SAMTEC-${month}-${row.staffNumber}`,
      movedAfterApproval ? 'yes' : 'no',
    ]
      .map(csvCell)
      .join(',');
  });

  return [HEADER.map(csvCell).join(','), ...body].join('\n');
}

/**
 * Adds up every line of a run per worker, so one person with an ordinary line
 * and two corrections is paid once.
 */
export function netPerEmployee(
  lines: readonly {
    employeeId: string;
    staffNumber: string;
    fullName: string;
    netPayPesewas: number;
  }[],
): BankRowInput[] {
  const perEmployee = new Map<string, BankRowInput>();
  for (const line of lines) {
    const running = perEmployee.get(line.employeeId) ?? {
      employeeId: line.employeeId,
      staffNumber: line.staffNumber,
      fullName: line.fullName,
      netPayPesewas: 0,
    };
    running.netPayPesewas += line.netPayPesewas;
    perEmployee.set(line.employeeId, running);
  }
  return [...perEmployee.values()];
}
