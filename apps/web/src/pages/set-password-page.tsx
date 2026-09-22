import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { AuthLayout } from '@/components/layout/auth-layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { $api } from '@/lib/api';
import { describeApiError } from '@/lib/problem';

// The contract's rule for a new password (`NewPassword`).
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

/**
 * The public page behind a one-time password link. An administrator never
 * sees or chooses anyone's password: they send the person a link like
 * `/set-password#token=…`, and the person picks their own password here.
 *
 * The token sits after the `#`, a part of the address that browsers never
 * send to any server, so it never lands in server logs. The page reads it
 * once, keeps it in memory, and removes it from the address bar.
 */
export function SetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [mistake, setMistake] = useState<string | null>(null);

  useEffect(() => {
    if (location.hash !== '') {
      navigate({ hash: '' }, { replace: true });
    }
  }, [location.hash, navigate]);

  const setPasswordRequest = $api.useMutation('post', '/auth/set-password');

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

  if (setPasswordRequest.isSuccess) {
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Ignore a second submit while the first one is still running.
    if (setPasswordRequest.isPending) {
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
    setPasswordRequest.mutate({ body: { token, newPassword: password } });
  }

  const problem = setPasswordRequest.error ? describeApiError(setPasswordRequest.error) : undefined;

  return (
    <AuthLayout
      title="Choose your password"
      description="Only you will know it. Nobody at SAMTEC can see it."
    >
      <form onSubmit={submit} aria-busy={setPasswordRequest.isPending} className="grid gap-4">
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

        <Button type="submit" className="w-full">
          {setPasswordRequest.isPending ? 'Saving…' : 'Set my password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
