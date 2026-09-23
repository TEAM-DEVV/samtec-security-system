import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { routes } from '@/app/routes';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';

/** Shown when a page crashes, instead of a blank screen. */
export function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'An unexpected error stopped this page from loading.';

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center motion-safe:animate-rise">
      <BrandMark className="size-12 text-primary" />
      <h1 className="font-semibold text-3xl tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">{message}</p>
      <Button asChild variant="outline">
        <Link to={routes.home}>Back to the overview</Link>
      </Button>
    </div>
  );
}
