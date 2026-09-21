import type { LoginResponse } from '@samtec/contracts';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { AuthLayout } from '@/components/layout/auth-layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { $api } from '@/lib/api';
import { env } from '@/lib/env';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';
import { setPendingTwoFactor, startSession, useSession } from '@/lib/session';

// The contract's limits for the sign-in fields.
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 128;

/**
 * Email and password sign-in. The API answers with one of three outcomes
 * (signed in, code needed, or two-factor setup needed), and this page sends
 * the user to the right next step for each.
 */
export function LoginPage() {
  usePageTitle('Sign in');
  const navigate = useNavigate();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = $api.useMutation('post', '/auth/login', {
    onSuccess: (outcome) => continueSignIn(outcome),
  });

  // Already signed in: nothing to do here.
  if (session !== null) {
    return <Navigate to={routes.home} replace />;
  }

  function continueSignIn(outcome: LoginResponse) {
    switch (outcome.status) {
      case 'AUTHENTICATED':
        startSession({ accessToken: outcome.accessToken, user: outcome.user });
        navigate(routes.home, { replace: true });
        return;
      case 'TWO_FACTOR_REQUIRED':
        setPendingTwoFactor({ step: 'VERIFY', challengeToken: outcome.challengeToken });
        navigate(routes.twoFactorVerify);
        return;
      case 'TWO_FACTOR_SETUP_REQUIRED':
        setPendingTwoFactor({ step: 'SETUP', setupToken: outcome.setupToken });
        navigate(routes.twoFactorSetup);
        return;
      default:
        // TypeScript fails the build if the contract ever adds a fourth outcome.
        outcome satisfies never;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Ignore a second submit while the first one is still running.
    if (login.isPending) {
      return;
    }
    login.mutate({ body: { email: email.trim(), password } });
  }

  const problem = login.error ? describeApiError(login.error) : undefined;

  return (
    <AuthLayout title="Sign in to SAMTEC" description="Attendance & Payroll dashboard">
      <form onSubmit={submit} aria-busy={login.isPending} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            maxLength={EMAIL_MAX_LENGTH}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {problem && (
          <Alert variant="destructive">
            <AlertTitle>Could not sign in</AlertTitle>
            <AlertDescription>
              <p>{problem.message}</p>
              {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
            </AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full">
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {/* `import.meta.env.DEV` lets the production build drop the hint (and its strings) entirely. */}
      {import.meta.env.DEV && env.useMocks && <MockAccountsHint />}
    </AuthLayout>
  );
}

/** Shown in mock mode only, so anyone trying the dashboard knows which pretend accounts exist. */
function MockAccountsHint() {
  return (
    <div className="mt-6 rounded-md border border-dashed bg-muted/40 p-3 text-muted-foreground text-xs">
      <p className="font-medium text-foreground">Mock accounts</p>
      <p>
        The password is <code>demo-password</code> and every two-factor code is <code>123456</code>.
        Five wrong passwords lock an email until you reload the page.
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        <li>
          <code>supervisor@samtec.example</code> signs straight in
        </li>
        <li>
          <code>guard@samtec.example</code> signs straight in, sees only their own records
        </li>
        <li>
          <code>admin@samtec.example</code> asks for a two-factor code
        </li>
        <li>
          <code>hr@samtec.example</code> must set up two-factor authentication first
        </li>
      </ul>
    </div>
  );
}
