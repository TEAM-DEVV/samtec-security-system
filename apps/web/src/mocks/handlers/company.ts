import type { CompanyBankAccount, CurrentUser } from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import {
  initialMockBankAccount,
  MOCK_COMPANY_NAME,
  type MockCompanyBankAccount,
} from '../data/company';
import { apiUrl, forbidden, type OrProblem, unauthorized, validationProblem } from '../helpers';
import { needsPassword, userForRequest } from './auth';

/**
 * The mock company bank account (`GET`/`PUT /company/bank-account`), with the
 * real API's rules built in:
 *
 * - `GET` is ADMIN and HR_PAYROLL; `PUT` is ADMIN only, and needs a fresh
 *   password confirmation (`needsPassword`), like the bank export.
 * - The account number is never returned in full — every response is built
 *   through `toApiBankAccount`, which masks it to its last four digits.
 *
 * Keeps its own copy, so the Company page can be built and tested in mock
 * mode; tests call `resetMockCompany()` to start fresh.
 */
type Role = CurrentUser['role'];

const noStore = { 'Cache-Control': 'no-store' };

let state: MockCompanyBankAccount = { ...initialMockBankAccount };

export function resetMockCompany(): void {
  state = { ...initialMockBankAccount };
}

/** `"1234567890123"` becomes `"**** 0123"`, the same shape the real API sends. */
function maskToLastFour(value: string | null): string | null {
  if (value === null) return null;
  return `**** ${value.length <= 4 ? value : value.slice(-4)}`;
}

function toApiBankAccount(): CompanyBankAccount {
  return {
    companyName: MOCK_COMPANY_NAME,
    bankName: state.bankName,
    branch: state.branch,
    accountName: state.accountName,
    accountNumberMasked: maskToLastFour(state.accountNumber),
  };
}

/** Signed in with one of these roles, or the matching 401/403. */
function signedInAs(request: Request, roles: Role[]) {
  const user = userForRequest(request);
  if (!user) return { refused: unauthorized('Sign in to continue.') };
  if (!roles.includes(user.role)) return { refused: forbidden() };
  return { user };
}

/** The same shape the contract gives these fields: no tab, newline, or formula-looking start. */
const BANK_TEXT = /^[^=+@\s"-][^\t\r\n]{1,99}$/;

function nullableTextProblem(value: unknown, path: string, shape: RegExp) {
  if (value === null) return undefined;
  return typeof value === 'string' && shape.test(value)
    ? undefined
    : validationProblem(path, 'This value is not in the right format.');
}

const FIELDS = ['bankName', 'branch', 'accountName', 'accountNumber'] as const;

export const companyHandlers = [
  http.get<PathParams, never, OrProblem<CompanyBankAccount>>(
    apiUrl('/company/bank-account'),
    ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN', 'HR_PAYROLL']);
      if (refused) return refused;
      return HttpResponse.json<CompanyBankAccount>(toApiBankAccount(), { headers: noStore });
    },
  ),

  http.put<PathParams, Record<string, unknown>, OrProblem<CompanyBankAccount>>(
    apiUrl('/company/bank-account'),
    async ({ request }) => {
      const { refused } = signedInAs(request, ['ADMIN']);
      if (refused) return refused;
      const unconfirmed = needsPassword(request);
      if (unconfirmed) return unconfirmed;

      const body: Record<string, unknown> = await request.json();
      const unknownField = Object.keys(body).find(
        (key) => !(FIELDS as readonly string[]).includes(key),
      );
      if (unknownField !== undefined) {
        return validationProblem(unknownField, 'Unrecognized field.');
      }
      const missing = FIELDS.find((field) => !(field in body));
      if (missing !== undefined) {
        return validationProblem(missing, 'Send null if the company has none, but send the field.');
      }
      const bad =
        nullableTextProblem(body.bankName, 'bankName', BANK_TEXT) ??
        nullableTextProblem(body.branch, 'branch', BANK_TEXT) ??
        nullableTextProblem(body.accountName, 'accountName', BANK_TEXT) ??
        nullableTextProblem(body.accountNumber, 'accountNumber', /^[0-9]{5,20}$/);
      if (bad) return bad;

      state = {
        bankName: (body.bankName as string | null) ?? null,
        branch: (body.branch as string | null) ?? null,
        accountName: (body.accountName as string | null) ?? null,
        accountNumber: (body.accountNumber as string | null) ?? null,
      };
      return HttpResponse.json<CompanyBankAccount>(toApiBankAccount(), { headers: noStore });
    },
  ),
];
