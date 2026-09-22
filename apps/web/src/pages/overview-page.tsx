import { ArrowRight, CircleCheck, CircleX } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { navItemsFor } from '@/components/layout/nav-items';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { firstName, formatLongDate, greetingForNow } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { roleDescriptions, roleLabels } from '@/lib/roles';
import { useSession } from '@/lib/session';

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
      <PageHeader
        title={`${greetingForNow()}, ${firstName(user.fullName)}`}
        description={`${formatLongDate()} · signed in as ${roleLabels[user.role]}`}
      />

      <section aria-labelledby="open-now" className="space-y-3">
        <h2
          id="open-now"
          className="font-medium text-muted-foreground text-sm uppercase tracking-wide"
        >
          Open now
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {openNow.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group rounded-xl border bg-card p-5 text-card-foreground shadow-xs transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div className="flex items-center justify-between">
                <span className="rounded-lg bg-primary/10 p-2 text-primary">
                  <item.icon aria-hidden="true" className="size-5" />
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                />
              </div>
              <p className="mt-4 font-semibold">{item.label}</p>
              <p className="mt-1 text-muted-foreground text-sm">{item.description}</p>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Your role</CardTitle>
            <CardDescription>{roleLabels[user.role]}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">{roleDescriptions[user.role]}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System</CardTitle>
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

        <Card>
          <CardHeader>
            <CardTitle>Coming in later phases</CardTitle>
            <CardDescription>Built one phase at a time, each with a working demo.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {comingLater.map((item) => (
                <li key={item.to} className="flex items-center gap-2">
                  <item.icon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span>{item.label}</span>
                  <span className="ml-auto rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
                    Phase {item.phase}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
