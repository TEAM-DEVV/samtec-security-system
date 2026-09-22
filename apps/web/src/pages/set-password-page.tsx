import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { AuthLayout } from '@/components/layout/auth-layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchClient } from '@/lib/api';
import { restoreSession, signOut } from '@/lib/auth';
import { describeApiError } from '@/lib/problem';
import { getSession, mayHaveSession, useSession } from '@/lib/session';

// The contract's rule for a new password (`NewPassword`).
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

/**
 * The public page behind a one-time password link. An administrator never
 * sees or chooses anyone's password: they send the person a link like
 * `/set-password#token=…`, and the person picks their own password here.
 *
 * - The token sits after the `#`, a part of the address that browsers never
 *   send to any server, so it never lands in server logs. The page reads it
 *   once, keeps it in memory, and removes it from the address bar.
 * - Someone already signed in on this browser is asked to sign out first.
 *   The link itself is the proof, so this is not a security check; it stops
 *   a person setting someone else's password while they think it is theirs.
 * - The request goes straight through `fetchClient`, not a cached query, so
 *   no data cache ever holds the password.
 */
export function SetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
  // After a reload the session is not in memory yet: ask the API first, as
  // the signed-in part of the dashboard does, but only if this browser signed in before.
  const [checking, setChecking] = useState(() => getSession() === null && mayHaveSession());
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; traceId?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Set straight away on submit, so a quick double click can never send twice.
  const inFlight = useRef(false);

  useEffect(() => {
    if (location.hash !== '') {
      navigate({ search: location.search, hash: '' }, { replace: true });
    }
  }, [location.hash, location.search, navigate]);

  useEffect(() => {
    if (!checking) {
      return;
    }
    let cancelled = false;
    void restoreSession().finally(() => {
      if (!cancelled) {
        setChecking(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [checking]);

  if (token === '') {
    return (
      <AuthLayout title="This link is incomplete" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p>
            Open the whole link from your administrator's message, or ask them for a new one. The
            link works once, for 72 hours.
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link to={routes.login}>Go to sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Your password is set" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p>
            Sign in with your email and the password you just chose. Administrators and HR then set
            up two-factor authentication with an authenticator app.
          </p>
          <Button asChild className="w-full">
            <Link to={routes.login}>Go to sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (checking) {
    return (
      <AuthLayout title="Choose your password" description="Checking this browser first…">
        <p role="status" className="sr-only">
          Checking whether someone is signed in on this browser…
        </p>
        <Skeleton aria-hidden="true" className="h-32 w-full" />
      </AuthLayout>
    );
  }

  if (session !== null) {
    return (
      <AuthLayout title="You are signed in" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p>
            You are signed in as <strong>{session.user.fullName}</strong> ({session.user.email}).
            This link chooses the password of the person it was sent to, so sign out first.
          </p>
          <Button
            className="w-full"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await signOut();
              setSigningOut(false);
            }}
          >
            {signingOut ? 'Signing out…' : 'Sign out and continue'}
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to={routes.home}>Back to the dashboard</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) {
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setMistake(`Use at least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`);
      return;
    }
    if (password !== repeated) {
      setMistake('The two passwords are not the same. Type them again.');
      return;
    }
    setMistake(null);
    setProblem(null);
    inFlight.current = true;
    setSending(true);
    try {
      const { error } = await fetchClient.POST('/auth/set-password', {
        body: { token, newPassword: password },
      });
      if (error) {
        setProblem(describeApiError(error));
      } else {
        // The password is saved: forget what was typed.
        setPassword('');
        setRepeated('');
        setDone(true);
      }
    } catch (failure) {
      setProblem(describeApiError(failure));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <AuthLayout
      title="Choose your password"
      description="Only you will know it. Nobody at SAMTEC can see it."
    >
      {/* noValidate: the page's own checks below give clearer messages than the browser's. */}
      <form noValidate onSubmit={submit} aria-busy={sending} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            aria-describedby="new-password-rule"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p id="new-password-rule" className="text-muted-foreground text-xs">
            At least {PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember and hard
            to guess.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="repeat-password">Type it again</Label>
          <Input
            id="repeat-password"
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX_LENGTH}
            value={repeated}
            onChange={(event) => setRepeated(event.target.value)}
          />
        </div>

        {mistake && (
          <Alert variant="destructive">
            <AlertDescription>{mistake}</AlertDescription>
          </Alert>
        )}

        {problem && (
          <Alert variant="destructive">
            <AlertTitle>Could not set your password</AlertTitle>
            <AlertDescription>
              <p>{problem.message}</p>
              {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
            </AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={sending}>
          {sending ? 'Saving…' : 'Set my password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
