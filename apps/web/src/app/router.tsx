import { createBrowserRouter } from 'react-router';
import { routes } from '@/app/routes';
import { AppShell } from '@/components/layout/app-shell';
import { RequireSession } from '@/components/require-session';
import { env } from '@/lib/env';
import { ComingInPhasePage } from '@/pages/coming-in-phase-page';
import { EmployeesPage } from '@/pages/employees-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { RouteErrorPage } from '@/pages/route-error-page';
import { SystemStatusPage } from '@/pages/system-status-page';
import { TwoFactorSetupPage } from '@/pages/two-factor-setup-page';
import { TwoFactorVerifyPage } from '@/pages/two-factor-verify-page';

/**
 * Every page of the dashboard and its web address.
 * Add new pages here as each roadmap phase builds them, and switch on their
 * link in `components/layout/nav-items.ts`.
 */
export const router = createBrowserRouter([
  // The sign-in pages stand alone, outside the app shell: no sidebar until signed in.
  { path: routes.login, element: <LoginPage />, errorElement: <RouteErrorPage /> },
  {
    path: routes.twoFactorVerify,
    element: <TwoFactorVerifyPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: routes.twoFactorSetup,
    element: <TwoFactorSetupPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: routes.home,
    // Everything inside the shell needs a signed-in user.
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <SystemStatusPage /> },
      {
        path: 'employees',
        // The real /employees endpoint exists, but it requires sign-in and
        // the dashboard has no sign-in screens yet — so live mode would only
        // show 401 errors. Keep this notice until the sign-in screens work
        // against the live API, then use `element: <EmployeesPage />` for both.
        element: env.useMocks ? (
          <EmployeesPage />
        ) : (
          <ComingInPhasePage title="Employees" phase={1} />
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
