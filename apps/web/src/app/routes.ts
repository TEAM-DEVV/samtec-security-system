/**
 * The web addresses pages send people to. Keeping them in one place means a
 * page never has to import another page just to know its address.
 */
export const routes = {
  home: '/',
  status: '/status',
  login: '/login',
  employees: '/employees',
  sites: '/sites',
  /** One employee's record. */
  employee: (employeeId: string) => `/employees/${encodeURIComponent(employeeId)}`,
  /** The 6-digit code screen, after a sign-in answered TWO_FACTOR_REQUIRED. */
  twoFactorVerify: '/login/two-factor',
  /** The QR code screen, after a sign-in answered TWO_FACTOR_SETUP_REQUIRED. */
  twoFactorSetup: '/login/two-factor/setup',
  /** Public: where a one-time password link (`/set-password#token=…`) lands. */
  setPassword: '/set-password',
} as const;
