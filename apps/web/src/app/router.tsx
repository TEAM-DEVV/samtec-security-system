import { createBrowserRouter } from 'react-router';
import { routes } from '@/app/routes';
import { AppShell } from '@/components/layout/app-shell';
import { RequireRole } from '@/components/require-role';
import { RequireSession } from '@/components/require-session';
import { env } from '@/lib/env';
import { pageRoles } from '@/lib/roles';
import { ComingInPhasePage } from '@/pages/coming-in-phase-page';
import { EmployeeDetailPage } from '@/pages/employee-detail-page';
import { EmployeesPage } from '@/pages/employees-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { RouteErrorPage } from '@/pages/route-error-page';
import { SitesPage } from '@/pages/sites-page';
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
        // Keep this notice in live mode until sign-in has been verified against
        // the real API (task 7), then use the mock-mode element for both.
        element: env.useMocks ? (
          <RequireRole roles={pageRoles.employees}>
            <EmployeesPage />
          </RequireRole>
        ) : (
          <ComingInPhasePage title="Employees" phase={1} />
        ),
      },
      {
        path: 'sites',
        element: env.useMocks ? (
          <RequireRole roles={pageRoles.sites}>
            <SitesPage />
          </RequireRole>
        ) : (
          <ComingInPhasePage title="Sites" phase={1} />
        ),
      },
      {
        // No RequireRole: any signed-in user may ask, and the API decides
        // record by record (a guard sees only their own).
        path: 'employees/:employeeId',
        element: env.useMocks ? (
          <EmployeeDetailPage />
        ) : (
          <ComingInPhasePage title="Employee" phase={1} />
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
