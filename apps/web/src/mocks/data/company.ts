// Fictional company data only (see SECURITY.md).

export const MOCK_COMPANY_NAME = 'Alpha Shield Security Ltd';

/**
 * What the mock remembers about the company's bank account. The full
 * `accountNumber` never leaves `handlers/company.ts`: every response is built
 * through `toApiBankAccount`, which masks it, the same rule the real API
 * follows.
 */
export interface MockCompanyBankAccount {
  bankName: string | null;
  branch: string | null;
  accountName: string | null;
  accountNumber: string | null;
}

export const initialMockBankAccount: MockCompanyBankAccount = {
  bankName: 'Akwaaba Bank',
  branch: 'Ridge',
  accountName: MOCK_COMPANY_NAME,
  accountNumber: '1234567890123',
};
