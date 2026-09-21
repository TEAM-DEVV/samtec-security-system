import type { CurrentUser } from '@samtec/contracts';
import { mockEmployees } from './data/employees';

/**
 * Which sites a signed-in user may see, like the real API decides it:
 * administrators and HR see every site (undefined = no limit); a supervisor
 * sees only the site they are posted to; a guard sees no site list at all.
 */
export function visibleSiteIds(user: CurrentUser): string[] | undefined {
  if (user.role === 'ADMIN' || user.role === 'HR_PAYROLL') {
    return undefined;
  }
  if (user.role === 'GUARD') {
    return [];
  }
  const self = mockEmployees.find((employee) => employee.id === user.employeeId);
  return self?.currentSite ? [self.currentSite.id] : [];
}

/** True when this user may see an employee posted at `siteId` (null = not posted anywhere). */
export function canSeeSite(user: CurrentUser, siteId: string | null): boolean {
  const allowed = visibleSiteIds(user);
  return allowed === undefined || (siteId !== null && allowed.includes(siteId));
}
