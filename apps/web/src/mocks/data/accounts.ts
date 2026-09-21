import type { UserAccount } from '@samtec/contracts';
import { mockUsers } from './users';

/**
 * The mock sign-in accounts as administrators see them on the Users screens.
 * Built from `mockUsers`, so every mock account appears here exactly once.
 * Fictional people only (see SECURITY.md).
 */
export const mockAccounts: UserAccount[] = mockUsers.map((user) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  role: user.role,
  status: 'ACTIVE',
  twoFactorEnabled: user.twoFactorEnabled,
  employeeId: user.employeeId,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
}));
