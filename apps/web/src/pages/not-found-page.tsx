import { Link } from 'react-router';
import { routes } from '@/app/routes';

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h1 className="font-semibold text-2xl tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">
        This page does not exist yet. It may arrive in a later roadmap phase.
      </p>
      <Link to={routes.home} className="font-medium text-primary underline underline-offset-4">
        Back to the overview
      </Link>
    </div>
  );
}
