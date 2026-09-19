import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { routes } from '@/app/routes';
import { Skeleton } from '@/components/ui/skeleton';
import { restoreSession } from '@/lib/auth';
import { getSession, useSession } from '@/lib/session';

type Status = 'checking' | 'checked';

/**
 * Wraps everything that needs a signed-in user. With no session in memory it
 * first tries to restore one from the refresh cookie (a page reload), and only
 * then sends the visitor to the sign-in page. Signing out anywhere inside
 * clears the session, so this also sends the user back to sign in.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>(() =>
    getSession() === null ? 'checking' : 'checked',
  );

  useEffect(() => {
    if (status === 'checked') {
      return;
    }
    let cancelled = false;
    void restoreSession().finally(() => {
      if (!cancelled) {
        setStatus('checked');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  // Whoever signs in next must never see what the previous user loaded, so
  // every session end (sign out, refused refresh, start over) empties the
  // data cache. Doing it here covers all of them in one place.
  const sessionEnded = status === 'checked' && session === null;
  useEffect(() => {
    if (sessionEnded) {
      queryClient.clear();
    }
  }, [sessionEnded, queryClient]);

  if (status === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <p role="status" className="sr-only">
          Checking your sign-in…
        </p>
        <Skeleton aria-hidden="true" className="h-40 w-full max-w-sm" />
      </div>
    );
  }
  if (session === null) {
    return <Navigate to={routes.login} replace />;
  }
  return children;
}
