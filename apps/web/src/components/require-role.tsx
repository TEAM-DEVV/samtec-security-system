import type { UserRole } from '@samtec/contracts';
import type { ReactNode } from 'react';
import { roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';
import { ForbiddenPage } from '@/pages/forbidden-page';

interface RequireRoleProps {
  roles: readonly UserRole[];
  children: ReactNode;
}

/**
 * Shows the page only to the listed roles, and a clear "not for your role"
 * page to everyone else. It must sit inside `RequireSession`, which
 * guarantees a signed-in user. The API checks the role again on every
 * request: this is a courtesy, not the security boundary.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const session = useSession();
  if (session === null) {
    // Nobody signed in: `RequireSession` is about to redirect. Show nothing meanwhile.
    return null;
  }
  if (!roleAllowed(roles, session.user.role)) {
    return <ForbiddenPage />;
  }
  return children;
}
