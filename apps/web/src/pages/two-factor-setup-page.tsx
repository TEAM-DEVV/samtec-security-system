import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { AuthLayout } from '@/components/layout/auth-layout';
import { StartOverLink } from '@/components/start-over-link';
import { TwoFactorCodeForm } from '@/components/two-factor-code-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { describeApiError, isWorthRetrying } from '@/lib/problem';
import { getPendingTwoFactor, startSession, useSession } from '@/lib/session';

const QR_CODE_SIZE = 192;

/**
 * First-time two-factor setup for admin and HR accounts. The page asks the
 * API for a new secret (`POST /auth/2fa/setup`), shows it as a QR code and as
 * text, and then proves the authenticator app works by sending its first code
 * to `POST /auth/2fa/enable`, which also signs the user in.
 */
export function TwoFactorSetupPage() {
  const navigate = useNavigate();
  // Read once, when the page opens. Finishing the setup clears the pending
  // token, and reading it again on that re-render would wrongly send the
  // newly signed-in user back to the password screen.
  const [pending] = useState(getPendingTwoFactor);
  const session = useSession();
  const setupToken = pending?.step === 'SETUP' ? pending.setupToken : undefined;

  // Asking for the secret is a POST, but for this page it behaves like a
  // read: ask once and keep the answer while the page is open. Asking again
  // would replace the secret and make a QR code the user may already have
  // scanned useless. `gcTime: 0` forgets the secret the moment the page closes,
  // so it never sits in the cache where a later script could read it.
  const setup = $api.useQuery(
    'post',
    '/auth/2fa/setup',
    { body: { setupToken: setupToken ?? '' } },
    {
      enabled: setupToken !== undefined,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );

  const enable = $api.useMutation('post', '/auth/2fa/enable', {
    onSuccess: (session) => {
      startSession({ accessToken: session.accessToken, user: session.user });
      navigate(routes.home, { replace: true });
    },
  });

  // Already signed in (for example the Back button after finishing): nothing to do here.
  if (session !== null) {
    return <Navigate to={routes.home} replace />;
  }
  // This account is mid-verification, not mid-setup: go to the right step.
  if (pending?.step === 'VERIFY') {
    return <Navigate to={routes.twoFactorVerify} replace />;
  }
  // Nothing to set up: the user refreshed the page (the token lives in memory
  // only) or came here directly. Password first.
  if (setupToken === undefined) {
    return <Navigate to={routes.login} replace />;
  }

  return (
    <AuthLayout
      title="Set up two-factor authentication"
      description="Your role requires a second step at every sign-in."
    >
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm">
        <li>
          Install an authenticator app such as Google Authenticator or Microsoft Authenticator.
        </li>
        <li>Scan the code below, or type the key into the app.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>

      {setup.isPending && (
        <div className="mb-4 grid justify-items-center gap-3">
          <span role="status" className="sr-only">
            Preparing your QR code…
          </span>
          <Skeleton aria-hidden="true" className="size-48" />
          <Skeleton aria-hidden="true" className="h-5 w-56" />
        </div>
      )}

      {setup.isError && <SetupError error={setup.error} onRetry={() => void setup.refetch()} />}

      {setup.data && (
        <div className="mb-4 grid justify-items-center gap-3">
          <div className="rounded-md bg-white p-3">
            <QRCodeSVG
              value={setup.data.otpauthUri}
              size={QR_CODE_SIZE}
              role="img"
              aria-label="QR code for your authenticator app"
            />
          </div>
          <p className="text-center text-muted-foreground text-xs">
            Cannot scan? Enter this key by hand:
            <br />
            <code className="select-all font-mono text-foreground text-sm tracking-wider">
              {setup.data.manualEntryKey}
            </code>
          </p>
        </div>
      )}

      {setup.data && (
        <TwoFactorCodeForm
          submitLabel="Turn on two-factor authentication"
          pending={enable.isPending}
          error={enable.error}
          onSubmit={(code) => enable.mutate({ body: { setupToken, code } })}
        />
      )}
    </AuthLayout>
  );
}

/**
 * The secret could not be prepared. "Try again" helps after a network blip;
 * "Start over" is the way out when the setup token itself has expired.
 */
function SetupError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { message, traceId } = describeApiError(error);
  return (
    <div className="grid gap-4">
      <Alert variant="destructive">
        <AlertTitle>The QR code could not be prepared</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{message}</p>
          {traceId && <p className="font-mono text-xs">Trace ID: {traceId}</p>}
          {isWorthRetrying(error) && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
      <StartOverLink />
    </div>
  );
}
