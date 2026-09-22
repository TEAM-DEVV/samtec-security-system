import { Menu } from 'lucide-react';
import { useState } from 'react';
import { Outlet } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { env } from '@/lib/env';
import { useSession } from '@/lib/session';
import { navItemsFor } from './nav-items';
import { SidebarNav } from './sidebar-nav';
import { ThemeToggle } from './theme-toggle';
import { UserCard } from './user-card';

/** The frame around every page: a sidebar (a slide-in menu on phones), a top bar and the page itself. */
export function AppShell() {
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = navItemsFor(session?.user.role ?? null);

  const brand = (
    <div className="flex items-center gap-3 px-5 py-4">
      <img src="/favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <p className="font-semibold tracking-wide">SAMTEC</p>
        <p className="text-sidebar-foreground/70 text-xs">Attendance &amp; Payroll</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh bg-background text-foreground md:grid md:grid-cols-[16rem_1fr]">
      <aside className="hidden bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        {brand}
        <div className="flex-1 overflow-y-auto py-2">
          <SidebarNav items={items} />
        </div>
        {session && <UserCard user={session.user} />}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-2.5 backdrop-blur md:px-6">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon-sm" className="md:hidden">
                <Menu aria-hidden="true" />
                <span className="sr-only">Open menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="bg-sidebar p-0 text-sidebar-foreground data-[side=left]:w-72"
            >
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Pages of the dashboard</SheetDescription>
              {brand}
              <div className="flex-1 overflow-y-auto py-2">
                <SidebarNav items={items} onNavigate={() => setMenuOpen(false)} />
              </div>
              {session && <UserCard user={session.user} />}
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2 md:hidden">
            <img src="/favicon.svg" alt="" className="size-6" />
            <span className="font-semibold tracking-wide">SAMTEC</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
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
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
