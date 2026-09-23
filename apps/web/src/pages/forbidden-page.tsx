import { ShieldOff } from 'lucide-react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { Button } from '@/components/ui/button';

/** Shown instead of a page the signed-in user's role may not open. Same wording as the API's 403. */
export function ForbiddenPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center motion-safe:animate-rise">
      <span className="rounded-2xl bg-primary/8 p-4 text-primary">
        <ShieldOff aria-hidden="true" className="size-8" />
      </span>
      <h1 className="font-semibold text-3xl tracking-tight">Not available for your role</h1>
      <p className="text-muted-foreground">
        Your role does not allow this action. Ask an administrator if you think you need it.
      </p>
      <Button asChild variant="outline">
        <Link to={routes.home}>Back to the overview</Link>
      </Button>
    </div>
  );
}
