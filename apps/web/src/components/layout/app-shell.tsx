import { Menu } from 'lucide-react';
import { useState } from 'react';
import { Outlet } from 'react-router';
import { BrandMark } from '@/components/brand-mark';
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
import { PageTransition } from './page-transition';
import { SidebarNav } from './sidebar-nav';
import { ThemeToggle } from './theme-toggle';
import { UserCard } from './user-card';

/** The frame around every page: a sidebar (a slide-in menu on phones), a top bar and the page itself. */
export function AppShell() {
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = navItemsFor(session?.user.role ?? null);

  const brand = (
    <div className="relative flex items-center gap-3 px-5 py-5">
      <BrandMark className="size-9 text-white" />
      <div className="leading-tight">
        <p className="font-heading font-semibold text-[15px] tracking-[0.18em]">SAMTEC</p>
        <p className="text-[11px] text-sidebar-foreground/60 tracking-wide">
          Attendance &amp; Payroll
        </p>
      </div>
    </div>
  );

  // The sidebar and the phone menu show the same three parts.
  const sidebarContent = (
    <>
      {brand}
      <div className="mx-5 h-px bg-linear-to-r from-gold/70 via-sidebar-border to-transparent" />
      <div className="flex-1 overflow-y-auto py-4">
        <p className="mb-2 px-6 font-medium text-[11px] text-sidebar-foreground/65 uppercase tracking-[0.2em]">
          Workspace
        </p>
        <SidebarNav items={items} onNavigate={() => setMenuOpen(false)} />
      </div>
      {session && <UserCard user={session.user} />}
    </>
  );

  return (
    <div className="min-h-dvh bg-background text-foreground md:grid md:grid-cols-[17rem_1fr]">
      <aside className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        {/* A warm light at the top of the sidebar, like the sign-in stage. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -left-16 size-72 rounded-full bg-gold/20 blur-3xl"
        />
        {sidebarContent}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="surface-glass sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-2.5 md:px-8">
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
              {sidebarContent}
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2 md:hidden">
            <BrandMark className="size-6 text-primary" />
            <span className="font-heading font-semibold tracking-[0.18em]">SAMTEC</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <DataSourcePill />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-8 md:py-8">
          <PageTransition>
            <Outlet />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}

/** Says where the data comes from, so nobody mistakes pretend data for real data. */
function DataSourcePill() {
  if (env.useMocks) {
    return (
      <Badge
        variant="outline"
        title="Data comes from the built-in mock API, not the real backend."
        className="h-7 gap-2 border-amber-500/50 bg-amber-50 px-3 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
        Mock data
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-7 gap-2 border-emerald-600/30 bg-emerald-50 px-3 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
    >
      <span aria-hidden="true" className="relative flex size-1.5">
        <span className="absolute inline-flex size-full rounded-full bg-emerald-500 motion-safe:animate-ping-soft" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
      Live API
    </Badge>
  );
}
