import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { routes } from '@/app/routes';
import { AuthLayout } from '@/components/layout/auth-layout';
import { TwoFactorCodeForm } from '@/components/two-factor-code-form';
import { $api } from '@/lib/api';
import { getPendingTwoFactor, startSession } from '@/lib/session';

/**
 * The second sign-in step for accounts with two-factor authentication: the
 * 6-digit code from the authenticator app goes to `POST /auth/2fa/verify`
 * together with the challenge token from the password step.
 */
export function TwoFactorVerifyPage() {
  const navigate = useNavigate();
  // Read once, when the page opens. Finishing the sign-in clears the pending
  // token, and reading it again on that re-render would wrongly send the
  // newly signed-in user back to the password screen.
  const [pending] = useState(getPendingTwoFactor);

  const verify = $api.useMutation('post', '/auth/2fa/verify', {
    onSuccess: (session) => {
      startSession({ accessToken: session.accessToken, user: session.user });
      navigate(routes.home, { replace: true });
    },
  });

  // This account is mid-setup, not mid-verification: go to the right step.
  if (pending?.step === 'SETUP') {
    return <Navigate to={routes.twoFactorSetup} replace />;
  }
  // Nothing to verify: the user refreshed the page (the token lives in memory
  // only) or came here directly. Password first.
  if (!pending) {
    return <Navigate to={routes.login} replace />;
  }
  const { challengeToken } = pending;

  return (
    <AuthLayout
      title="Enter your code"
      description="Open your authenticator app and enter the code for SAMTEC."
    >
      <TwoFactorCodeForm
        submitLabel="Verify code"
        pending={verify.isPending}
        error={verify.error}
        onSubmit={(code) => verify.mutate({ body: { challengeToken, code } })}
      />
    </AuthLayout>
  );
}
