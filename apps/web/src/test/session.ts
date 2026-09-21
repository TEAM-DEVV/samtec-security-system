import { fetchClient } from '@/lib/api';
import { type SignedInSession, startSession } from '@/lib/session';
import { MOCK_PASSWORD, MOCK_TWO_FACTOR_CODE } from '@/mocks/data/users';

/**
 * Signs a mock account in the way the real screens would, and remembers the
 * session in the dashboard. Every protected mock endpoint needs this first.
 * Handles all three sign-in outcomes, so any mock account works.
 */
export async function signInForTests(email = 'supervisor@samtec.example'): Promise<void> {
  const login = await fetchClient.POST('/auth/login', { body: { email, password: MOCK_PASSWORD } });
  if (!login.data) {
    throw new Error(`Mock sign-in failed for ${email}: ${login.error?.detail}`);
  }

  // TypeScript fails the build if the contract adds an outcome this switch does not assign.
  let session: SignedInSession;
  switch (login.data.status) {
    case 'AUTHENTICATED':
      session = login.data;
      break;
    case 'TWO_FACTOR_REQUIRED': {
      const verified = await fetchClient.POST('/auth/2fa/verify', {
        body: { challengeToken: login.data.challengeToken, code: MOCK_TWO_FACTOR_CODE },
      });
      if (!verified.data) {
        throw new Error(`Mock two-factor step failed for ${email}`);
      }
      session = verified.data;
      break;
    }
    case 'TWO_FACTOR_SETUP_REQUIRED': {
      const { setupToken } = login.data;
      await fetchClient.POST('/auth/2fa/setup', { body: { setupToken } });
      const enabled = await fetchClient.POST('/auth/2fa/enable', {
        body: { setupToken, code: MOCK_TWO_FACTOR_CODE },
      });
      if (!enabled.data) {
        throw new Error(`Mock two-factor setup failed for ${email}`);
      }
      session = enabled.data;
      break;
    }
  }
  startSession({ accessToken: session.accessToken, user: session.user });
}
