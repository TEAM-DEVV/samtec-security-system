import type { CurrentUser } from '@samtec/contracts';

/** Every mock account signs in with this password. It only works with the mock API. */
export const MOCK_PASSWORD = 'demo-password';

/**
 * The mock API accepts this code at every two-factor step. Codes from a real
 * authenticator app do not work with the mock API.
 */
export const MOCK_TWO_FACTOR_CODE = '123456';

/**
 * Fictional sign-in accounts, one for each way signing in can go:
 *
 * - admin@samtec.example has two-factor authentication, so it gets a code challenge.
 * - admin2@samtec.example is the second administrator. Payroll needs one:
 *   whoever prepares a run may never approve it.
 * - hr@samtec.example must set up two-factor authentication before signing in.
 * - supervisor@samtec.example signs straight in.
 * - guard@samtec.example signs straight in, and may see only their own records.
 */
export const mockUsers: CurrentUser[] = [
  {
    id: '01927c3e-2222-7ccc-9ddd-000000000001',
    email: 'admin@samtec.example',
    fullName: 'Efua Mensah',
    role: 'ADMIN',
    twoFactorEnabled: true,
    employeeId: null,
  },
  {
    id: '01927c3e-2222-7ccc-9ddd-000000000005',
    email: 'admin2@samtec.example',
    fullName: 'Nii Armah',
    role: 'ADMIN',
    twoFactorEnabled: true,
    employeeId: null,
  },
  {
    id: '01927c3e-2222-7ccc-9ddd-000000000002',
    email: 'hr@samtec.example',
    fullName: 'Kofi Asante',
    role: 'HR_PAYROLL',
    twoFactorEnabled: false,
    employeeId: null,
  },
  {
    id: '01927c3e-2222-7ccc-9ddd-000000000003',
    email: 'supervisor@samtec.example',
    fullName: 'Yaw Boateng',
    role: 'SUPERVISOR',
    twoFactorEnabled: false,
    // Yaw Boateng is also employee SMT-00003 in data/employees.ts.
    employeeId: '01927c3e-5a4b-7c8d-9e0f-000000000003',
  },
  {
    id: '01927c3e-2222-7ccc-9ddd-000000000004',
    email: 'guard@samtec.example',
    fullName: 'Kwame Kofi Mensah',
    role: 'GUARD',
    twoFactorEnabled: false,
    // Kwame Kofi Mensah is employee SMT-00001 in data/employees.ts.
    employeeId: '01927c3e-5a4b-7c8d-9e0f-000000000001',
  },
];
