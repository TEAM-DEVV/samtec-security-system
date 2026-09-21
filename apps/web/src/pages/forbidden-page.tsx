import { Link } from 'react-router';
import { routes } from '@/app/routes';

/** Shown instead of a page the signed-in user's role may not open. Same wording as the API's 403. */
export function ForbiddenPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h1 className="font-semibold text-2xl tracking-tight">Not available for your role</h1>
      <p className="text-muted-foreground">
        Your role does not allow this action. Ask an administrator if you think you need it.
      </p>
      <Link to={routes.home} className="font-medium text-primary underline underline-offset-4">
        Go to System status
      </Link>
    </div>
  );
}
