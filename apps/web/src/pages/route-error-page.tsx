import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/** Shown when a page crashes, instead of a blank screen. */
export function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'An unexpected error stopped this page from loading.';

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="font-semibold text-2xl tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">{message}</p>
      <Link to="/" className="font-medium text-primary underline underline-offset-4">
        Back to the dashboard
      </Link>
    </div>
  );
}
