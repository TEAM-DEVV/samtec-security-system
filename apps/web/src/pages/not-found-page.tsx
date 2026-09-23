import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center motion-safe:animate-rise">
      <span className="rounded-2xl bg-primary/8 p-4 text-primary">
        <Compass aria-hidden="true" className="size-8" />
      </span>
      <h1 className="font-semibold text-3xl tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">
        This page does not exist yet. It may arrive in a later roadmap phase.
      </p>
      <Button asChild variant="outline">
        <Link to={routes.home}>Back to the overview</Link>
      </Button>
    </div>
  );
}
