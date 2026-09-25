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
  /** Sign-in accounts (ADMIN only). */
  users: '/users',
  newUser: '/users/new',
  /** One sign-in account. */
  user: (userId: string) => `/users/${encodeURIComponent(userId)}`,
  /** Where a signed-in person changes their own password. */
  changePassword: '/account/password',
  /** Worked shifts for the company or a site (Phase 2). */
  attendance: '/attendance',
  /** The signed-in person's own shifts. */
  myAttendance: '/attendance/me',
  /** The live board of clock-ins and clock-outs (Phase 3). */
  liveBoard: '/attendance/live',
  /** The attendance exception queue. */
  exceptions: '/attendance/exceptions',
  exception: (exceptionId: string) => `/attendance/exceptions/${encodeURIComponent(exceptionId)}`,
  /** Clock-in devices (ADMIN only). */
  devices: '/devices',
  newDevice: '/devices/new',
  device: (deviceId: string) => `/devices/${encodeURIComponent(deviceId)}`,
  /** Every face and fingerprint attempt at the kiosks (ADMIN only), or one kiosk's. */
  kioskAttempts: (deviceId?: string) =>
    deviceId ? `/devices/attempts?deviceId=${encodeURIComponent(deviceId)}` : '/devices/attempts',
  /** The duplicate-enrollment queue: faces that looked like someone already enrolled (ADMIN only). */
  duplicateFaces: '/biometrics/duplicates',
  /** Payroll months and their runs (Phase 4): ADMIN and HR_PAYROLL. */
  payroll: '/payroll',
  /** One run: its totals, its lines, and the decisions about it. */
  payrollRun: (runId: string) => `/payroll/runs/${encodeURIComponent(runId)}`,
  /** A guard's own payslips. The one payroll page a guard may open. */
  myPayslips: '/payroll/payslips/me',
  /** The ghost-detection queue (Phase 5): ADMIN and HR_PAYROLL. */
  detection: '/detection',
  /** One alert, with its evidence and the way to answer it. */
  detectionAlert: (alertId: string) => `/detection/alerts/${encodeURIComponent(alertId)}`,
  /** The eleven rules and their numbers. Everyone who sees the queue may read them; ADMIN changes them. */
  detectionRules: '/detection/rules',
  /** The 6-digit code screen, after a sign-in answered TWO_FACTOR_REQUIRED. */
  twoFactorVerify: '/login/two-factor',
  /** The QR code screen, after a sign-in answered TWO_FACTOR_SETUP_REQUIRED. */
  twoFactorSetup: '/login/two-factor/setup',
  /** Public: where a one-time password link (`/set-password#token=…`) lands. */
  setPassword: '/set-password',
} as const;
