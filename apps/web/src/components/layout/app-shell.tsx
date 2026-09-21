import { cn } from 'cn';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth';
import { env } from '@/lib/env';
import { roleLabels } from '@/lib/roles';
import { useSession } from '@/lib/session';
import { navItems } from './nav-items';

/** The frame around every page: sidebar navigation, a top bar and the page itself. */
export function AppShell() {
  const session = useSession();
  const [signingOut, setSigningOut] = useState(false);

  // Once the session is cleared, `RequireSession` (which wraps the shell)
  // sends the user to the sign-in page; nothing to navigate here.
  async function handleSignOut() {
    // Ignore extra clicks while the API is being told. The button stays
    // enabled, so keyboard users never lose their place.
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background text-foreground md:grid md:grid-cols-[15rem_1fr]">
      <aside className="border-b bg-sidebar text-sidebar-foreground md:border-r md:border-b-0">
        <div className="flex items-center gap-3 px-5 py-4">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div className="leading-tight">
            <p className="font-semibold tracking-wide">SAMTEC</p>
            <p className="text-muted-foreground text-xs">Attendance &amp; Payroll</p>
          </div>
        </div>

        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col">
          {navItems.map((item) =>
            item.available ? (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent',
                    isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                  )
                }
              >
                <item.icon aria-hidden="true" className="size-4" />
                {item.label}
              </NavLink>
            ) : (
              <span
                key={item.to}
                aria-disabled="true"
                className="flex cursor-not-allowed items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-muted-foreground text-sm"
              >
                <item.icon aria-hidden="true" className="size-4" />
                {item.label}
                <span className="sr-only">(coming in Phase {item.phase})</span>
                <span
                  aria-hidden="true"
                  className="ml-auto rounded bg-muted px-1.5 py-0.5 font-medium text-[10px]"
                >
                  P{item.phase}
                </span>
              </span>
            ),
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-end gap-4 border-b px-6 py-3">
          {env.useMocks ? (
            <Badge
              variant="outline"
              title="Data comes from the built-in mock API, not the real backend."
              className="border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              Mock data
            </Badge>
          ) : (
            <Badge variant="secondary">Live API</Badge>
          )}

          {session && (
            <div className="flex items-center gap-3">
              <p className="text-right text-sm leading-tight">
                <span className="block font-medium">{session.user.fullName}</span>
                <span className="block text-muted-foreground text-xs">
                  {roleLabels[session.user.role]}
                </span>
              </p>
              <Button variant="ghost" size="sm" onClick={() => void handleSignOut()}>
                <LogOut aria-hidden="true" />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          )}
        </header>
        <main className="flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
