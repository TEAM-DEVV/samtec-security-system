import { describe, expect, it } from 'vitest';
import {
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

  it('reads every rate from the tax table, never from the code', () => {
    const doubled: TaxRates = {
      ...RATES_2026,
      ssnitEmployeeBasisPoints: 1100,
      bands: [{ ordinal: 1, widthPesewas: null, rateBasisPoints: 1000 }],
    };
    const pay = calculatePay(terms({ basicMonthlyPesewas: 200_000 }), WHOLE_MONTH, doubled);
    expect(pay.ssnitEmployeePesewas).toBe(22_000);
    // A flat 10% on everything chargeable, because that is what the table says.
    expect(pay.chargeableIncomePesewas).toBe(178_000);
    expect(pay.payePesewas).toBe(17_800);
  });
});

/** A fixed sequence, so a failure can always be reproduced. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('the rules that must hold for every line', () => {
  it('always adds up, so a worker can check their payslip by hand', () => {
    const next = sequence(20_260_924);
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const daysInPeriod = 28 + Math.floor(next() * 4);
      const pay = calculatePay(
        terms({
          basicMonthlyPesewas: Math.floor(next() * 500_000) + 1,
          overtimeHourlyPesewas: Math.floor(next() * 2_000),
          taxableAllowancePesewas: Math.floor(next() * 40_000),
          nonTaxableAllowancePesewas: Math.floor(next() * 20_000),
          otherDeductionPesewas: Math.floor(next() * 10_000),
        }),
        {
          daysInPeriod,
          daysEmployed: Math.floor(next() * (daysInPeriod + 1)),
          overtimeMinutes: Math.floor(next() * 3_000),
        },
        RATES_2026,
      );

      // Each total is exactly the sum of the parts printed beside it.
      expect(pay.grossPesewas).toBe(
        pay.basicPesewas +
          pay.overtimePesewas +
          pay.taxableAllowancePesewas +
          pay.nonTaxableAllowancePesewas,
      );
      expect(pay.taxableGrossPesewas).toBe(pay.grossPesewas - pay.nonTaxableAllowancePesewas);
      expect(pay.chargeableIncomePesewas).toBe(pay.taxableGrossPesewas - pay.ssnitEmployeePesewas);
      // The identity the database CHECK enforces on every line.
      expect(pay.netPayPesewas).toBe(
        pay.grossPesewas - pay.ssnitEmployeePesewas - pay.payePesewas - pay.otherDeductionsPesewas,
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
});
