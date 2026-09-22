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
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';
import { getSession, mayHaveSession, useSession } from '@/lib/session';

// The contract's rule for a new password (`NewPassword`).
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

type Screen = 'incomplete' | 'checking' | 'unsure' | 'signed-in' | 'form' | 'done';
type Field = 'new-password' | 'repeat-password';

/** The token in `#token=…`, or '' when there is none. */
function tokenFrom(hash: string): string {
  return new URLSearchParams(hash.slice(1)).get('token') ?? '';
}

/** After a reload the session is not in memory yet; ask the API only if this browser signed in before. */
function needsSignInCheck(): boolean {
  return getSession() === null && mayHaveSession();
}

/**
 * The public page behind a one-time password link. An administrator never
 * sees or chooses anyone's password: they send the person a link like
 * `/set-password#token=…`, and the person picks their own password here.
 *
 * - The token sits after the `#`, a part of the address that browsers never
 *   send to any server, so it never lands in server logs. The page keeps it
 *   in memory and removes it from the address bar. A new link pasted into the
 *   same tab replaces it and starts again.
 * - Someone already signed in on this browser is asked to sign out first, and
 *   when that cannot be checked the form stays hidden. The link itself is the
 *   proof, so this is not a security check; it stops a person setting someone
 *   else's password while they think it is their own.
 * - The request goes straight through `fetchClient`, not a cached query, so
 *   no data cache ever holds the password.
 */
export function SetPasswordPage() {
  usePageTitle('Choose your password');
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const [token, setToken] = useState(() => tokenFrom(location.hash));
  const [checking, setChecking] = useState(needsSignInCheck);
  // The check got no clear answer (the API was slow or unreachable).
  const [unsure, setUnsure] = useState(false);
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [mistake, setMistake] = useState<{ field: Field; text: string; count: number } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ message: string; traceId?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Set straight away on submit, so a quick double click can never send twice.
  const inFlight = useRef(false);
  const newPasswordInput = useRef<HTMLInputElement>(null);
  const repeatInput = useRef<HTMLInputElement>(null);
  // Where keyboard focus goes when the page changes to another screen.
  const screenStart = useRef<HTMLElement | null>(null);
  const markScreenStart = (element: HTMLElement | null) => {
    screenStart.current = element;
  };

  let screen: Screen = 'form';
  if (token === '') screen = 'incomplete';
  else if (done) screen = 'done';
  else if (checking) screen = 'checking';
  else if (unsure) screen = 'unsure';
  else if (session !== null) screen = 'signed-in';

  // Read the token, then take it out of the address bar. A different link
  // pasted into this tab later arrives here too, and starts everything again.
  useEffect(() => {
    if (location.hash === '') {
      return;
    }
    const fresh = tokenFrom(location.hash);
    if (fresh !== '' && fresh !== token) {
      setToken(fresh);
      setPassword('');
      setRepeated('');
      setMistake(null);
      setProblem(null);
      setDone(false);
      setUnsure(false);
      setChecking(needsSignInCheck());
    }
    navigate({ search: location.search, hash: '' }, { replace: true });
  }, [location.hash, location.search, navigate, token]);

  useEffect(() => {
    if (!checking) {
      return;
    }
    let cancelled = false;
    void restoreSession()
      .catch(() => false)
      .then((restored) => {
        if (cancelled) {
          return;
        }
        // A definite "not signed in" (401) also wipes the signed-in note. If
        // the note is still there, the API never answered: do not guess.
        setUnsure(!restored && mayHaveSession());
        setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [checking]);

  // Move focus to the new screen, so keyboard and screen-reader users follow
  // along. The first screen keeps the browser's normal focus.
  const shownScreen = useRef(screen);
  useEffect(() => {
    if (shownScreen.current !== screen) {
      shownScreen.current = screen;
      screenStart.current?.focus();
    }
  }, [screen]);

  async function signOutAndContinue() {
    setSigningOut(true);
    await signOut();
    setSigningOut(false);
    setUnsure(false);
  }

  function complain(field: Field, text: string) {
    setMistake((previous) => ({ field, text, count: (previous?.count ?? 0) + 1 }));
    (field === 'new-password' ? newPasswordInput : repeatInput).current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) {
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      complain(
        'new-password',
        `Use at least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`,
      );
      return;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      complain('new-password', `Use at most ${PASSWORD_MAX_LENGTH} characters.`);
      return;
    }
    if (password !== repeated) {
      complain('repeat-password', 'The two passwords are not the same. Type them again.');
      return;
    }
    setMistake(null);
    setProblem(null);
    inFlight.current = true;
    setSending(true);
    try {
      const { error, response } = await fetchClient.POST('/auth/set-password', {
        body: { token, newPassword: password },
      });
      // Judge by the status: an error from a proxy may come with no body at all.
      if (!response.ok) {
        setProblem(describeApiError(error));
        return;
      }
      // The password is saved: forget what was typed.
      setPassword('');
      setRepeated('');
      setDone(true);
    } catch (failure) {
      setProblem(describeApiError(failure));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  // Text that receives focus when a screen appears needs no focus ring.
  const focusable = 'outline-none';

  if (screen === 'incomplete') {
    return (
      <AuthLayout title="This link is incomplete" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p ref={markScreenStart} tabIndex={-1} className={focusable}>
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

  if (screen === 'done') {
    return (
      <AuthLayout title="Your password is set" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p ref={markScreenStart} tabIndex={-1} className={focusable}>
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

  if (screen === 'checking') {
    return (
      <AuthLayout title="Choose your password" description="Checking this browser first…">
        <p role="status" className="sr-only">
          Checking whether someone is signed in on this browser…
        </p>
        <Skeleton aria-hidden="true" className="h-32 w-full" />
      </AuthLayout>
    );
  }

  if (screen === 'unsure') {
    return (
      <AuthLayout title="Could not check this browser" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p ref={markScreenStart} tabIndex={-1} className={focusable}>
            Someone may be signed in here, and SAMTEC did not answer in time. Try again, or sign out
            to continue with this link.
          </p>
          <Button className="w-full" onClick={() => setChecking(true)}>
            Try again
          </Button>
          <Button
            variant="outline"
            className="w-full"
            aria-disabled={signingOut}
            onClick={() => {
              if (!signingOut) void signOutAndContinue();
            }}
          >
            {signingOut ? 'Signing out…' : 'Sign out and continue'}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (screen === 'signed-in' && session !== null) {
    return (
      <AuthLayout title="You are signed in" description="Choose your SAMTEC password">
        <div className="grid gap-4 text-sm">
          <p ref={markScreenStart} tabIndex={-1} className={focusable}>
            You are signed in as <strong>{session.user.fullName}</strong> ({session.user.email}).
            This link chooses the password of the person it was sent to, so sign out first.
          </p>
          <Button
            className="w-full"
            aria-disabled={signingOut}
            onClick={() => {
              if (!signingOut) void signOutAndContinue();
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

  const describedBy = (field: Field, own?: string) =>
    [own, mistake?.field === field ? 'set-password-mistake' : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

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
            ref={(element) => {
              newPasswordInput.current = element;
              screenStart.current = element;
            }}
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            aria-invalid={mistake?.field === 'new-password' || undefined}
            aria-describedby={describedBy('new-password', 'new-password-rule')}
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
            ref={repeatInput}
            id="repeat-password"
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX_LENGTH}
            aria-invalid={mistake?.field === 'repeat-password' || undefined}
            aria-describedby={describedBy('repeat-password')}
            value={repeated}
            onChange={(event) => setRepeated(event.target.value)}
          />
        </div>

        {mistake && (
          // A new key for every mistake, so the same message is announced again.
          <Alert key={mistake.count} id="set-password-mistake" variant="destructive">
            <AlertDescription>{mistake.text}</AlertDescription>
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

        {/* aria-disabled, not disabled: a disabled button would drop the keyboard focus. */}
        <Button type="submit" className="w-full" aria-disabled={sending}>
          {sending ? 'Saving…' : 'Set my password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
