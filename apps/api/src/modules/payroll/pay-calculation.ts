/**
 * What one worker is owed for one period.
 *
 * Design: docs/plan/09-payroll-engine-ghana.md — the calculation pipeline, the
 * statutory tables, and decisions 3, 4, 9 and 24. A pure function: no
 * database, no `this`, no decorators, so every figure can be proved on its own
 * and the eight hand-calculated payslips in the design page are tests.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. **Integers only.** Money is a whole number of pesewas, in a `bigint`
 *    while it is being worked out. No floating point number appears at any
 *    step, not even for an intermediate value.
 * 2. **Every rate comes from the tax table**, never from a number written
 *    here. Rates change with each national budget, so a new version is a new
 *    row, and a run records which one it used.
 * 3. **Every figure is worked out from the figures printed beside it**
 *    (decision 24). Only the two amounts that need a division are rounded,
 *    half-up, once each; everything else is addition and subtraction of those
 *    already-rounded pesewas. So a worker can check their payslip by hand, the
 *    run totals are the exact sums of the lines, and
 *    `net = gross − SSNIT − PAYE − other` holds by construction — which is
 *    also a `CHECK` constraint, so a bug here cannot reach the database.
 */

/** Hundredths of a percent: 550 basis points is 5.5%. */
const BASIS_POINTS = 10_000n;

/** What the worker is paid, copied from their pay terms row. */
export interface PayTerms {
  basicMonthlyPesewas: number;
  overtimeHourlyPesewas: number;
  taxableAllowancePesewas: number;
  nonTaxableAllowancePesewas: number;
  otherDeductionPesewas: number;
}

/** The period's shape for this worker, from `worked-minutes.ts`. */
export interface WorkedPeriod {
  daysInPeriod: number;
  daysEmployed: number;
  overtimeMinutes: number;
}

/** One band of the graduated PAYE table. The last has no width and no limit. */
export interface TaxBandRates {
  ordinal: number;
  widthPesewas: number | null;
  rateBasisPoints: number;
}

/** The statutory rates in force on the period's last day. */
export interface TaxRates {
  ssnitEmployeeBasisPoints: number;
  ssnitEmployerBasisPoints: number;
  ssnitTier1BasisPoints: number;
  ssnitTier2BasisPoints: number;
  bands: readonly TaxBandRates[];
}

/** Every money figure of one payroll line, in whole pesewas. */
export interface CalculatedPay {
  basicPesewas: number;
  overtimePesewas: number;
  taxableAllowancePesewas: number;
  nonTaxableAllowancePesewas: number;
  grossPesewas: number;
  taxableGrossPesewas: number;
  ssnitEmployeePesewas: number;
  ssnitEmployerPesewas: number;
  ssnitTier1Pesewas: number;
  ssnitTier2Pesewas: number;
  chargeableIncomePesewas: number;
  payePesewas: number;
  otherDeductionsPesewas: number;
  netPayPesewas: number;
}

/**
 * Rounds a division half-up, away from zero, so a tie never quietly favours
 * the company. An adjustment line may be negative (decision 20), so −0.5
 * pesewas becomes −1 and not 0.
 */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('A payroll period cannot be zero days long.');
  }
  const negative = numerator < 0n;
  const size = negative ? -numerator : numerator;
  const rounded = (size * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/**
 * The PAYE due on a chargeable income, from the graduated monthly bands. Each
 * band taxes the next slice; the last band has no width, so it takes whatever
 * is left. Rounded half-up once, at the end.
 */
export function payeOn(chargeableIncomePesewas: number, bands: readonly TaxBandRates[]): number {
  if (bands.length === 0) {
    throw new Error('A tax table needs at least one band.');
  }
  let left = BigInt(chargeableIncomePesewas);
  if (left <= 0n) {
    return 0;
  }
  let scaledTax = 0n;
  for (const band of [...bands].sort((left_, right) => left_.ordinal - right.ordinal)) {
    if (left <= 0n) break;
    const width = band.widthPesewas === null ? left : BigInt(band.widthPesewas);
    const inBand = left < width ? left : width;
    scaledTax += inBand * BigInt(band.rateBasisPoints);
    left -= inBand;
  }
  return Number(divideHalfUp(scaledTax, BASIS_POINTS));
}

/**
 * The whole of one worker's pay for one period.
 *
 * Basic is pro-rated by calendar days employed and nothing else: hours worked
 * never reduce it, because absence is handled by the attendance exception
 * queue, not by silently docking pay (decision 4). Allowances and the monthly
 * deduction are not pro-rated — a stated limitation, written up in decision 24.
 */
export function calculatePay(
  terms: PayTerms,
  worked: WorkedPeriod,
  rates: TaxRates,
): CalculatedPay {
  if (worked.daysInPeriod < 1) {
    throw new Error('A payroll period cannot be zero days long.');
  }
  if (worked.daysEmployed < 0 || worked.daysEmployed > worked.daysInPeriod) {
    throw new Error('Days employed must fall inside the period.');
  }

  // The only two divisions in the whole calculation, each rounded once.
  const basicPesewas = Number(
    divideHalfUp(
      BigInt(terms.basicMonthlyPesewas) * BigInt(worked.daysEmployed),
      BigInt(worked.daysInPeriod),
    ),
  );
  const overtimePesewas = Number(
    divideHalfUp(BigInt(terms.overtimeHourlyPesewas) * BigInt(worked.overtimeMinutes), 60n),
  );

  const { taxableAllowancePesewas, nonTaxableAllowancePesewas } = terms;
  const otherDeductionsPesewas = terms.otherDeductionPesewas;

  const grossPesewas =
    basicPesewas + overtimePesewas + taxableAllowancePesewas + nonTaxableAllowancePesewas;
  // The non-taxable allowance is the only part of gross that PAYE never sees.
  const taxableGrossPesewas = grossPesewas - nonTaxableAllowancePesewas;

  // Every SSNIT figure is a share of the basic actually paid. The employer's
  // 13% and both tiers are reported, never deducted from the worker.
  const shareOfBasic = (basisPoints: number) =>
    Number(divideHalfUp(BigInt(basicPesewas) * BigInt(basisPoints), BASIS_POINTS));
  const ssnitEmployeePesewas = shareOfBasic(rates.ssnitEmployeeBasisPoints);

  // Taxable gross is at least the basic, and the employee's share is a small
  // percentage of the basic, so this is never negative for an ordinary line.
  const chargeableIncomePesewas = taxableGrossPesewas - ssnitEmployeePesewas;
  const payePesewas = payeOn(chargeableIncomePesewas, rates.bands);

  return {
    basicPesewas,
    overtimePesewas,
    taxableAllowancePesewas,
    nonTaxableAllowancePesewas,
    grossPesewas,
    taxableGrossPesewas,
    ssnitEmployeePesewas,
    ssnitEmployerPesewas: shareOfBasic(rates.ssnitEmployerBasisPoints),
    ssnitTier1Pesewas: shareOfBasic(rates.ssnitTier1BasisPoints),
    ssnitTier2Pesewas: shareOfBasic(rates.ssnitTier2BasisPoints),
    chargeableIncomePesewas,
    payePesewas,
    otherDeductionsPesewas,
    netPayPesewas: grossPesewas - ssnitEmployeePesewas - payePesewas - otherDeductionsPesewas,
  };
}
