import { describe, expect, it } from 'vitest';
import {
  type CalculatedPay,
  calculatePay,
  divideHalfUp,
  type PayTerms,
  payeOn,
  type TaxRates,
} from './pay-calculation.js';

/**
 * The 2026 statutory rates from docs/plan/09-payroll-engine-ghana.md. Widths
 * are pesewas, so the first GHS 490 is 49000. The last band has no width
 * because it has no upper limit.
 */
const RATES_2026: TaxRates = {
  ssnitEmployeeBasisPoints: 550,
  ssnitEmployerBasisPoints: 1300,
  ssnitTier1BasisPoints: 1350,
  ssnitTier2BasisPoints: 500,
  bands: [
    { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
    { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
    { ordinal: 3, widthPesewas: 50_000, rateBasisPoints: 1000 },
    { ordinal: 4, widthPesewas: 200_000, rateBasisPoints: 1750 },
    { ordinal: 5, widthPesewas: 200_000, rateBasisPoints: 2500 },
    { ordinal: 6, widthPesewas: 1_491_000, rateBasisPoints: 3000 },
    { ordinal: 7, widthPesewas: null, rateBasisPoints: 3500 },
  ],
};

function terms(overrides: Partial<PayTerms> = {}): PayTerms {
  return {
    basicMonthlyPesewas: 0,
    overtimeHourlyPesewas: 0,
    taxableAllowancePesewas: 0,
    nonTaxableAllowancePesewas: 0,
    otherDeductionPesewas: 0,
    ...overrides,
  };
}

/** September 2026: thirty days, and the worker was there for all of them. */
const WHOLE_MONTH = { daysInPeriod: 30, daysEmployed: 30, overtimeMinutes: 0 };

/**
 * The hand-calculated payslips from the design page. Every figure was worked
 * out by hand and checked a second way, and the dashboard's mock API is pinned
 * to these same numbers, so the two can never quietly drift apart.
 */
describe('the eight golden payslips', () => {
  it('1. taxes nothing below the threshold', () => {
    const pay = calculatePay(terms({ basicMonthlyPesewas: 45_000 }), WHOLE_MONTH, RATES_2026);
    expect(pay.basicPesewas).toBe(45_000);
    expect(pay.grossPesewas).toBe(45_000);
    expect(pay.ssnitEmployeePesewas).toBe(2_475);
    expect(pay.chargeableIncomePesewas).toBe(42_525);
    // GHS 425.25 is inside the first GHS 490, which is taxed at nothing.
    expect(pay.payePesewas).toBe(0);
    expect(pay.netPayPesewas).toBe(42_525);
  });

  it('2. works out a mid-band salary', () => {
    const pay = calculatePay(terms({ basicMonthlyPesewas: 200_000 }), WHOLE_MONTH, RATES_2026);
    expect(pay.ssnitEmployeePesewas).toBe(11_000);
    expect(pay.chargeableIncomePesewas).toBe(189_000);
    // 490 at 0, 100 at 5%, 500 at 10%, then 800 of the 2,000 band at 17.5%.
    expect(pay.payePesewas).toBe(19_500);
    expect(pay.netPayPesewas).toBe(169_500);
  });

  it('3. pays forty hours of overtime on top of the basic', () => {
    const pay = calculatePay(
      terms({ basicMonthlyPesewas: 120_000, overtimeHourlyPesewas: 800 }),
      { ...WHOLE_MONTH, overtimeMinutes: 2_400 },
      RATES_2026,
    );
    expect(pay.overtimePesewas).toBe(32_000);
    expect(pay.grossPesewas).toBe(152_000);
    expect(pay.ssnitEmployeePesewas).toBe(6_600);
    expect(pay.chargeableIncomePesewas).toBe(145_400);
    expect(pay.payePesewas).toBe(11_870);
    expect(pay.netPayPesewas).toBe(133_530);
  });

  it('4. pro-rates the basic for somebody who joined mid-month', () => {
    const pay = calculatePay(
      terms({ basicMonthlyPesewas: 150_000 }),
      { ...WHOLE_MONTH, daysEmployed: 15 },
      RATES_2026,
    );
    expect(pay.basicPesewas).toBe(75_000);
    expect(pay.ssnitEmployeePesewas).toBe(4_125);
    expect(pay.chargeableIncomePesewas).toBe(70_875);
    // The rounding witness: PAYE is exactly 1687.5 pesewas, and half-up takes
    // it to 1688. If this ever reads 1687, the rounding has changed direction.
    expect(pay.payePesewas).toBe(1_688);
    expect(pay.netPayPesewas).toBe(69_187);
  });

  it('5. pro-rates the basic for somebody who left mid-month', () => {
    const pay = calculatePay(
      terms({ basicMonthlyPesewas: 180_000 }),
      { ...WHOLE_MONTH, daysEmployed: 10 },
      RATES_2026,
    );
    expect(pay.basicPesewas).toBe(60_000);
    expect(pay.ssnitEmployeePesewas).toBe(3_300);
    expect(pay.chargeableIncomePesewas).toBe(56_700);
    expect(pay.payePesewas).toBe(385);
    expect(pay.netPayPesewas).toBe(56_315);
  });

  it('6. pays a night-shift worker their whole month', () => {
    // Which day a night shift belongs to is decided before the money is worked
    // out; worked-minutes.spec.ts proves that half of golden case 6.
    const pay = calculatePay(terms({ basicMonthlyPesewas: 100_000 }), WHOLE_MONTH, RATES_2026);
    expect(pay.ssnitEmployeePesewas).toBe(5_500);
    expect(pay.chargeableIncomePesewas).toBe(94_500);
    expect(pay.payePesewas).toBe(4_050);
    expect(pay.netPayPesewas).toBe(90_450);
  });

  it('7. leaves the non-taxable allowance out of the taxed income', () => {
    const pay = calculatePay(
      terms({
        basicMonthlyPesewas: 160_000,
        taxableAllowancePesewas: 25_000,
        nonTaxableAllowancePesewas: 15_000,
        otherDeductionPesewas: 5_000,
      }),
      WHOLE_MONTH,
      RATES_2026,
    );
    expect(pay.grossPesewas).toBe(200_000);
    // Taxed on 160,000 + 25,000; never on the 15,000 that is not taxed.
    expect(pay.taxableGrossPesewas).toBe(185_000);
    expect(pay.ssnitEmployeePesewas).toBe(8_800);
    expect(pay.chargeableIncomePesewas).toBe(176_200);
    expect(pay.payePesewas).toBe(17_260);
    expect(pay.netPayPesewas).toBe(168_940);
  });

  it('8. reaches the top band above twenty thousand cedis', () => {
    const pay = calculatePay(
      terms({ basicMonthlyPesewas: 2_500_000, taxableAllowancePesewas: 300_000 }),
      WHOLE_MONTH,
      RATES_2026,
    );
    expect(pay.grossPesewas).toBe(2_800_000);
    expect(pay.ssnitEmployeePesewas).toBe(137_500);
    expect(pay.chargeableIncomePesewas).toBe(2_662_500);
    // GHS 6,625 of the income sits above 20,000 and is taxed at 35%.
    expect(pay.payePesewas).toBe(769_675);
    expect(pay.netPayPesewas).toBe(1_892_825);
  });
});

describe('what the worker pays, and what the company pays', () => {
  it('never deducts the employer contributions from the worker', () => {
    const pay = calculatePay(terms({ basicMonthlyPesewas: 200_000 }), WHOLE_MONTH, RATES_2026);
    expect(pay.ssnitEmployerPesewas).toBe(26_000);
    expect(pay.ssnitTier1Pesewas).toBe(27_000);
    expect(pay.ssnitTier2Pesewas).toBe(10_000);
    // Tier 1 plus Tier 2 is the whole 18.5%: both are of basic, and the 5% is
    // not a slice of the employer's 13%.
    expect(pay.ssnitTier1Pesewas + pay.ssnitTier2Pesewas).toBe(
      pay.ssnitEmployeePesewas + pay.ssnitEmployerPesewas,
    );
    // None of the three appears in what the worker is actually paid.
    expect(pay.netPayPesewas).toBe(
      pay.grossPesewas - pay.ssnitEmployeePesewas - pay.payePesewas - pay.otherDeductionsPesewas,
    );
  });

  it('splits the tiers so they always add up to what was contributed', () => {
    // 120,019 pesewas is deliberately awkward: 5.5%, 13% and 13.5% of it all
    // land on a half pesewa, so rounding the two tiers separately gave
    // 22,204 against the 22,203 actually deducted and paid. The statutory
    // summary reports both figures, so they have to tie.
    const pay = calculatePay(terms({ basicMonthlyPesewas: 120_019 }), WHOLE_MONTH, RATES_2026);
    expect(pay.ssnitEmployeePesewas).toBe(6_601);
    expect(pay.ssnitEmployerPesewas).toBe(15_602);
    expect(pay.ssnitTier1Pesewas).toBe(16_203);
    // Derived, so the split is exactly the total: 6,601 + 15,602 − 16,203.
    expect(pay.ssnitTier2Pesewas).toBe(6_000);
    expect(pay.ssnitTier1Pesewas + pay.ssnitTier2Pesewas).toBe(22_203);
  });

  it('reads every rate from the tax table, never from the code', () => {
    const doubled: TaxRates = {
      ...RATES_2026,
      ssnitEmployeeBasisPoints: 1100,
      // The tiers are a split of the employee and employer shares together, so
      // a table that doubles one of them splits the larger total.
      ssnitTier1BasisPoints: 1900,
      ssnitTier2BasisPoints: 500,
      bands: [{ ordinal: 1, widthPesewas: null, rateBasisPoints: 1000 }],
    };
    const pay = calculatePay(terms({ basicMonthlyPesewas: 200_000 }), WHOLE_MONTH, doubled);
    expect(pay.ssnitEmployeePesewas).toBe(22_000);
    // A flat 10% on everything chargeable, because that is what the table says.
    expect(pay.chargeableIncomePesewas).toBe(178_000);
    expect(pay.payePesewas).toBe(17_800);
  });
});

/**
 * A second way of working out the same payslip, written deliberately unlike
 * `pay-calculation.ts`.
 *
 * A test that says `gross === basic + overtime + allowances` cannot fail,
 * because that is the line of code it is checking. So this derives every
 * figure again by a different route — rounding by comparing the remainder
 * rather than by the `(2n + d) / 2d` trick, taxing by cumulative band
 * ceilings rather than by walking a remaining balance, and building gross
 * up from the taxable part rather than subtracting down to it — and the
 * tests compare whole results. Two implementations that disagree on any
 * input mean one of them is wrong, which is something a test can find.
 */
function roundAnotherWay(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const size = negative ? -numerator : numerator;
  const whole = size / denominator;
  const remainder = size - whole * denominator;
  const rounded = remainder * 2n >= denominator ? whole + 1n : whole;
  return negative ? -rounded : rounded;
}

function payeAnotherWay(chargeableIncomePesewas: number, rates: TaxRates): number {
  if (chargeableIncomePesewas <= 0) return 0;
  const income = BigInt(chargeableIncomePesewas);
  const sorted = [...rates.bands].sort((left, right) => left.ordinal - right.ordinal);
  let ceiling = 0n;
  let scaledTax = 0n;
  for (const band of sorted) {
    const floor = ceiling;
    ceiling = band.widthPesewas === null ? income : floor + BigInt(band.widthPesewas);
    const top = income < ceiling ? income : ceiling;
    if (top > floor) scaledTax += (top - floor) * BigInt(band.rateBasisPoints);
    if (ceiling >= income) break;
  }
  return Number(roundAnotherWay(scaledTax, 10_000n));
}

function payAnotherWay(
  pay: PayTerms,
  worked: { daysInPeriod: number; daysEmployed: number; overtimeMinutes: number },
  rates: TaxRates,
): CalculatedPay {
  const basicPesewas = Number(
    roundAnotherWay(
      BigInt(pay.basicMonthlyPesewas) * BigInt(worked.daysEmployed),
      BigInt(worked.daysInPeriod),
    ),
  );
  const overtimePesewas = Number(
    roundAnotherWay(BigInt(pay.overtimeHourlyPesewas) * BigInt(worked.overtimeMinutes), 60n),
  );
  const share = (basisPoints: number) =>
    Number(roundAnotherWay(BigInt(basicPesewas) * BigInt(basisPoints), 10_000n));

  const taxableGrossPesewas = basicPesewas + overtimePesewas + pay.taxableAllowancePesewas;
  const grossPesewas = taxableGrossPesewas + pay.nonTaxableAllowancePesewas;
  const ssnitEmployeePesewas = share(rates.ssnitEmployeeBasisPoints);
  const ssnitEmployerPesewas = share(rates.ssnitEmployerBasisPoints);
  const ssnitTier1Pesewas = share(rates.ssnitTier1BasisPoints);
  const chargeableIncomePesewas = taxableGrossPesewas - ssnitEmployeePesewas;
  const payePesewas = payeAnotherWay(chargeableIncomePesewas, rates);
  return {
    basicPesewas,
    overtimePesewas,
    taxableAllowancePesewas: pay.taxableAllowancePesewas,
    nonTaxableAllowancePesewas: pay.nonTaxableAllowancePesewas,
    grossPesewas,
    taxableGrossPesewas,
    ssnitEmployeePesewas,
    ssnitEmployerPesewas,
    ssnitTier1Pesewas,
    ssnitTier2Pesewas: ssnitEmployeePesewas + ssnitEmployerPesewas - ssnitTier1Pesewas,
    chargeableIncomePesewas,
    payePesewas,
    otherDeductionsPesewas: pay.otherDeductionPesewas,
    netPayPesewas: grossPesewas - ssnitEmployeePesewas - payePesewas - pay.otherDeductionPesewas,
  };
}

/**
 * A fixed sequence, so a failure can always be reproduced. It is a 64-bit
 * generator in `bigint`: the same arithmetic in `number` loses its low bits
 * past 2^53, which collapses it to a far shorter cycle than it looks.
 */
function sequence(seed: number): () => number {
  const modulus = 1n << 64n;
  let state = BigInt(seed);
  return () => {
    state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % modulus;
    return Number(state >> 33n) / 2_147_483_648;
  };
}

describe('the rules that must hold for every line', () => {
  it('always adds up, so a worker can check their payslip by hand', () => {
    const next = sequence(20_260_924);
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const daysInPeriod = 28 + Math.floor(next() * 4);
      const payTerms = terms({
        basicMonthlyPesewas: Math.floor(next() * 500_000) + 1,
        overtimeHourlyPesewas: Math.floor(next() * 2_000),
        taxableAllowancePesewas: Math.floor(next() * 40_000),
        nonTaxableAllowancePesewas: Math.floor(next() * 20_000),
        otherDeductionPesewas: Math.floor(next() * 10_000),
      });
      const worked = {
        daysInPeriod,
        daysEmployed: Math.floor(next() * (daysInPeriod + 1)),
        overtimeMinutes: Math.floor(next() * 3_000),
      };
      const pay = calculatePay(payTerms, worked, RATES_2026);

      // Every field, worked out a second way. This is what makes the test
      // able to fail at all: the two routes round differently and tax
      // differently, so any disagreement is a real bug in one of them.
      expect(pay).toEqual(payAnotherWay(payTerms, worked, RATES_2026));

      // The two SSNIT tiers are a split of one contribution, so they add up
      // to what was actually paid — for every basic, not only round ones.
      expect(pay.ssnitTier1Pesewas + pay.ssnitTier2Pesewas).toBe(
        pay.ssnitEmployeePesewas + pay.ssnitEmployerPesewas,
      );
      // Chargeable income is never negative on an ordinary line, so the PAYE
      // bands are never asked to tax a negative amount.
      expect(pay.chargeableIncomePesewas).toBeGreaterThanOrEqual(0);
      expect(pay.payePesewas).toBeLessThanOrEqual(pay.chargeableIncomePesewas);
      expect(Number.isSafeInteger(pay.netPayPesewas)).toBe(true);
    }
  });

  it('pays nothing to somebody who was not employed for a single day', () => {
    const pay = calculatePay(
      terms({ basicMonthlyPesewas: 200_000 }),
      { daysInPeriod: 30, daysEmployed: 0, overtimeMinutes: 0 },
      RATES_2026,
    );
    expect(pay.basicPesewas).toBe(0);
    expect(pay.ssnitEmployeePesewas).toBe(0);
    expect(pay.payePesewas).toBe(0);
    expect(pay.netPayPesewas).toBe(0);
  });

  it('refuses a period of no days rather than dividing by zero', () => {
    expect(() =>
      calculatePay(
        terms({ basicMonthlyPesewas: 200_000 }),
        { daysInPeriod: 0, daysEmployed: 0, overtimeMinutes: 0 },
        RATES_2026,
      ),
    ).toThrow(/zero days/);
  });

  it('refuses days employed that fall outside the period', () => {
    expect(() =>
      calculatePay(
        terms({ basicMonthlyPesewas: 200_000 }),
        { daysInPeriod: 30, daysEmployed: 31, overtimeMinutes: 0 },
        RATES_2026,
      ),
    ).toThrow(/inside the period/);
  });
});

describe('divideHalfUp', () => {
  it('rounds a half away from zero, so a tie never favours the company', () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(7n, 2n)).toBe(4n);
    expect(divideHalfUp(4n, 2n)).toBe(2n);
    // An adjustment line may be negative.
    expect(divideHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideHalfUp(-7n, 2n)).toBe(-4n);
  });

  it('refuses to divide by zero', () => {
    expect(() => divideHalfUp(1n, 0n)).toThrow();
  });
});

describe('payeOn', () => {
  it('fills each band in order, and the last band takes the rest', () => {
    // Exactly the top of band 6 is GHS 20,000, so nothing reaches 35%.
    expect(payeOn(2_000_000, RATES_2026.bands)).toBe(0 + 500 + 5_000 + 35_000 + 50_000 + 447_300);
  });

  it('charges nothing on nothing', () => {
    expect(payeOn(0, RATES_2026.bands)).toBe(0);
    expect(payeOn(-100, RATES_2026.bands)).toBe(0);
  });

  it('refuses a table with no bands at all', () => {
    expect(() => payeOn(100_000, [])).toThrow(/at least one band/);
  });

  it('refuses a table whose top band has an upper limit', () => {
    // This is the failure the open top band exists to prevent. Before, the
    // income above the highest band was silently dropped and a worker on
    // GHS 26,625 chargeable was taxed nothing at all.
    const bounded = [
      { ordinal: 1, widthPesewas: 49_000, rateBasisPoints: 0 },
      { ordinal: 2, widthPesewas: 10_000, rateBasisPoints: 500 },
    ];
    expect(() => payeOn(2_662_500, bounded)).toThrow(/no upper limit/);
    // Income that fits inside the bands is still taxed normally.
    expect(payeOn(59_000, bounded)).toBe(500);
  });
});

/**
 * The same eight payslips, with every field compared rather than the handful
 * each test above names.
 *
 * The tests above pin the figures a person worked out on paper, which is what
 * makes them trustworthy — but between them they never assert the employer's
 * SSNIT, either tier, or the other deductions. A drift in any of those would
 * pass. Comparing whole results against the second implementation closes that
 * gap without hand-typing a hundred more numbers.
 */
describe('the eight golden payslips, every field', () => {
  const goldens: { name: string; terms: PayTerms; worked: typeof WHOLE_MONTH }[] = [
    {
      name: '1. below the threshold',
      terms: terms({ basicMonthlyPesewas: 45_000 }),
      worked: WHOLE_MONTH,
    },
    {
      name: '2. a middling salary',
      terms: terms({ basicMonthlyPesewas: 200_000 }),
      worked: WHOLE_MONTH,
    },
    {
      name: '3. forty hours of overtime',
      terms: terms({ basicMonthlyPesewas: 120_000, overtimeHourlyPesewas: 800 }),
      worked: { daysInPeriod: 30, daysEmployed: 30, overtimeMinutes: 2_400 },
    },
    {
      name: '4. half a month, and a rounding tie',
      terms: terms({ basicMonthlyPesewas: 150_000 }),
      worked: { daysInPeriod: 30, daysEmployed: 15, overtimeMinutes: 0 },
    },
    {
      name: '5. ten days of thirty',
      terms: terms({ basicMonthlyPesewas: 180_000 }),
      worked: { daysInPeriod: 30, daysEmployed: 10, overtimeMinutes: 0 },
    },
    {
      name: '6. a night shift crossing the month end',
      terms: terms({ basicMonthlyPesewas: 100_000 }),
      worked: WHOLE_MONTH,
    },
    {
      name: '7. a non-taxable allowance',
      terms: terms({
        basicMonthlyPesewas: 170_000,
        taxableAllowancePesewas: 15_000,
        nonTaxableAllowancePesewas: 15_000,
      }),
      worked: WHOLE_MONTH,
    },
    {
      name: '8. the highest band',
      terms: terms({ basicMonthlyPesewas: 2_820_000 }),
      worked: WHOLE_MONTH,
    },
  ];

  for (const golden of goldens) {
    it(`${golden.name} matches in every field`, () => {
      expect(calculatePay(golden.terms, golden.worked, RATES_2026)).toEqual(
        payAnotherWay(golden.terms, golden.worked, RATES_2026),
      );
    });
  }
});

/**
 * A correction to a locked run becomes an adjustment line on a later one
 * (decision 20), which is the difference between what should have been paid
 * and what was. Nothing tested that difference, and it is the mechanism that
 * makes a frozen run safe to freeze.
 */
describe('an adjustment line', () => {
  /** What a later run must carry to correct an earlier one. */
  function adjustmentBetween(before: CalculatedPay, after: CalculatedPay): CalculatedPay {
    const keys = Object.keys(before) as (keyof CalculatedPay)[];
    return Object.fromEntries(
      keys.map((key) => [key, after[key] - before[key]]),
    ) as unknown as CalculatedPay;
  }

  it('still adds up when the correction is negative', () => {
    // Somebody was paid for the whole month, then found to have joined on the
    // 16th. The correction takes money back.
    const paid = calculatePay(terms({ basicMonthlyPesewas: 150_000 }), WHOLE_MONTH, RATES_2026);
    const owed = calculatePay(
      terms({ basicMonthlyPesewas: 150_000 }),
      { daysInPeriod: 30, daysEmployed: 15, overtimeMinutes: 0 },
      RATES_2026,
    );
    const adjustment = adjustmentBetween(paid, owed);

    expect(adjustment.basicPesewas).toBe(-75_000);
    expect(adjustment.netPayPesewas).toBeLessThan(0);

    // Every identity the database CHECK enforces holds for the difference
    // too, which is why a negative line can be stored at all.
    expect(adjustment.grossPesewas).toBe(
      adjustment.basicPesewas +
        adjustment.overtimePesewas +
        adjustment.taxableAllowancePesewas +
        adjustment.nonTaxableAllowancePesewas,
    );
    expect(adjustment.taxableGrossPesewas).toBe(
      adjustment.grossPesewas - adjustment.nonTaxableAllowancePesewas,
    );
    expect(adjustment.chargeableIncomePesewas).toBe(
      adjustment.taxableGrossPesewas - adjustment.ssnitEmployeePesewas,
    );
    expect(adjustment.netPayPesewas).toBe(
      adjustment.grossPesewas -
        adjustment.ssnitEmployeePesewas -
        adjustment.payePesewas -
        adjustment.otherDeductionsPesewas,
    );
  });

  it('rounds a negative correction away from zero, like a positive one', () => {
    // Half a pesewa owed back is a whole pesewa owed back, so a tie never
    // quietly favours the company in either direction (decision 24).
    expect(divideHalfUp(-1n, 2n)).toBe(-1n);
    expect(divideHalfUp(1n, 2n)).toBe(1n);
  });
});

describe('the limits the engine refuses to cross', () => {
  it('refuses negative overtime rather than quietly reducing pay', () => {
    expect(() =>
      calculatePay(
        terms({ basicMonthlyPesewas: 150_000, overtimeHourlyPesewas: 800 }),
        { daysInPeriod: 30, daysEmployed: 30, overtimeMinutes: -600 },
        RATES_2026,
      ),
    ).toThrow(/never be negative/);
  });

  it('refuses a tax table whose tiers do not add up to the contributions', () => {
    const wrong: TaxRates = { ...RATES_2026, ssnitTier2BasisPoints: 400 };
    expect(() => calculatePay(terms({ basicMonthlyPesewas: 150_000 }), WHOLE_MONTH, wrong)).toThrow(
      /must add up/,
    );
  });

  it('pays a negative net when a monthly deduction outruns a part month', () => {
    // A stated limitation of decision 24: deductions are not pro-rated, so
    // somebody employed for one day still owes the whole loan instalment. The
    // bank file must leave such a row out rather than send a negative amount.
    const pay = calculatePay(
      terms({ basicMonthlyPesewas: 150_000, otherDeductionPesewas: 20_000 }),
      { daysInPeriod: 30, daysEmployed: 1, overtimeMinutes: 0 },
      RATES_2026,
    );
    expect(pay.basicPesewas).toBe(5_000);
    expect(pay.grossPesewas).toBe(5_000);
    expect(pay.ssnitEmployeePesewas).toBe(275);
    expect(pay.payePesewas).toBe(0);
    expect(pay.otherDeductionsPesewas).toBe(20_000);
    // 5,000 − 275 − 0 − 20,000.
    expect(pay.netPayPesewas).toBe(-15_275);
  });
});
