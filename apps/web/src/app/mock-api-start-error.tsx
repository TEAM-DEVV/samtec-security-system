import { BrandMark } from '@/components/brand-mark';

/**
 * Shown instead of the dashboard when mock mode cannot start its pretend API.
 * The usual cause is a browser that blocks service workers, which MSW needs.
 */
export function MockApiStartError() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6 py-12 text-sm motion-safe:animate-rise">
      <BrandMark className="size-10 text-primary" />
      <h1 className="font-semibold text-3xl tracking-tight">The mock API could not start</h1>
      <p>
        Mock mode (<code>pnpm dev:web</code>) runs a pretend API inside the browser with a service
        worker, and this browser did not allow it.
      </p>
      <ul className="list-disc space-y-2 pl-6">
        <li>
          Open <code>{window.location.origin}</code> in Chrome, Edge or Firefox. Private windows and
          some built-in preview browsers block service workers.
        </li>
        <li>
          Or use the real API instead: start the database with <code>pnpm db:start</code>, then run{' '}
          <code>pnpm dev</code>.
        </li>
      </ul>
      <p className="text-muted-foreground">The browser console has the technical details.</p>
    </main>
  );
}
