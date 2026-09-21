import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { clearSession } from '@/lib/session';

/**
 * The way out of a stuck two-factor step: forget the half-finished sign-in
 * and go back to the password screen.
 */
export function StartOverLink() {
  return (
    <p className="text-center text-muted-foreground text-xs">
      Wrong account or the code has expired?{' '}
      <Link to={routes.login} onClick={clearSession} className="underline underline-offset-4">
        Start over
      </Link>
    </p>
  );
}
