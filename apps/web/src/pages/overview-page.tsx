import { cn } from 'cn';
import { ArrowRight, CircleCheck, CircleX } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { ChainPills } from '@/components/chain-pills';
import { navItemsFor } from '@/components/layout/nav-items';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { firstName, formatLongDate, greetingForNow } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { roleDescriptions, roleLabels } from '@/lib/roles';
import { useSession } from '@/lib/session';

// Written out in full (not built from the index) so Tailwind finds the class names.
const CARD_DELAYS = [
  'stagger-1',
  'stagger-2',
  'stagger-3',
  'stagger-4',
  'stagger-5',
  'stagger-6',
  'stagger-7',
  'stagger-8',
];

/**
 * The first page after sign-in: a greeting, the pages this role may open,
 * what is coming in later phases, and whether the API is healthy.
 */
export function OverviewPage() {
  usePageTitle('Overview');
  const session = useSession();
  const health = $api.useQuery('get', '/health', {}, { retry: false });

  if (session === null) {
    return null;
  }
  const { user } = session;
  const items = navItemsFor(user.role).filter((item) => item.to !== routes.home);
  const openNow = items.filter((item) => item.available);
  const comingLater = items.filter((item) => !item.available);
  // Trust `data` only when the latest check succeeded: React Query keeps the
  // older good answer in `data` after a failed re-check.
  const healthy = !health.isError && health.data?.status === 'ok';

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <section className="bg-stage relative overflow-hidden rounded-2xl px-6 py-8 text-sidebar-foreground motion-safe:animate-rise sm:px-10 sm:py-12">
        <div aria-hidden="true" className="bg-grid-faint absolute inset-0" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-16 hidden size-80 rounded-full bg-gold/25 blur-3xl motion-safe:animate-float lg:block"
        />
        <div className="relative space-y-4">
          <p className="font-mono text-sidebar-foreground/65 text-xs uppercase tracking-[0.2em]">
            {formatLongDate()}
          </p>
          <h1 className="font-semibold text-3xl leading-tight tracking-tight sm:text-4xl">
            {greetingForNow()}, {firstName(user.fullName)}
          </h1>
          <p className="text-sidebar-foreground/80">Signed in as {roleLabels[user.role]}.</p>
          <ChainPills className="pt-2" />
        </div>
      </section>

      <section aria-labelledby="open-now" className="space-y-3">
        <h2
          id="open-now"
          className="font-medium font-sans text-muted-foreground text-xs uppercase tracking-[0.18em]"
        >
          Open now
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {openNow.map((item, index) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'group hover-lift relative rounded-2xl border bg-card p-5 text-card-foreground shadow-xs transition-colors hover:border-gold/60 focus-visible:outline-2 focus-visible:outline-ring motion-safe:animate-rise',
                CARD_DELAYS[index],
              )}
            >
              <div className="flex items-center justify-between">
                <span className="rounded-xl bg-primary/8 p-2.5 text-primary transition-colors group-hover:bg-gold/20 group-hover:text-gold-foreground dark:group-hover:text-gold">
                  <item.icon aria-hidden="true" className="size-5" />
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground transition-transform duration-300 group-hover:translate-x-1 group-hover:text-foreground"
                />
              </div>
              <p className="mt-5 font-heading font-semibold text-lg">{item.label}</p>
              <p className="mt-1 text-muted-foreground text-sm">{item.description}</p>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="stagger-4 motion-safe:animate-rise">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Your role</CardTitle>
            <CardDescription>{roleLabels[user.role]}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">{roleDescriptions[user.role]}</CardContent>
        </Card>

        <Card className="stagger-5 motion-safe:animate-rise">
          <CardHeader>
            <CardTitle className="font-heading text-lg">System</CardTitle>
            <CardDescription>
              <Link to={routes.status} className="underline underline-offset-4">
                Full status page
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {health.isPending ? (
              <Skeleton className="h-6 w-40" />
            ) : (
              <p
                className={
                  healthy
                    ? 'flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400'
                    : 'flex items-center gap-2 font-medium text-destructive'
                }
              >
                {healthy ? (
                  <CircleCheck aria-hidden="true" className="size-5" />
                ) : (
                  <CircleX aria-hidden="true" className="size-5" />
                )}
                {healthy ? 'API and database are up' : 'The API needs attention'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="stagger-6 motion-safe:animate-rise">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Coming in later phases</CardTitle>
            <CardDescription>Built one phase at a time, each with a working demo.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="relative ml-2 space-y-3 border-border border-l pl-4 text-sm">
              {comingLater.map((item) => (
                <li key={item.to} className="relative flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="-left-[21px] absolute size-2 rounded-full border border-background bg-gold"
                  />
                  <item.icon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span>{item.label}</span>
                  <span className="ml-auto rounded-full border px-2 py-0.5 font-mono text-muted-foreground text-xs tracking-wide">
                    Phase {item.phase}
                  </span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
