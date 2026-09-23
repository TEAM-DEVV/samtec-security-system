import { createBrowserRouter } from 'react-router';
import { routes } from '@/app/routes';
import { AppShell } from '@/components/layout/app-shell';
import { RequireRole } from '@/components/require-role';
import { RequireSession } from '@/components/require-session';
import { pageRoles } from '@/lib/roles';
import { AttendancePage } from '@/pages/attendance-page';
import { ChangePasswordPage } from '@/pages/change-password-page';
import { DeviceDetailPage } from '@/pages/device-detail-page';
import { DevicesPage } from '@/pages/devices-page';
import { EmployeeDetailPage } from '@/pages/employee-detail-page';
import { EmployeesPage } from '@/pages/employees-page';
import { ExceptionDetailPage } from '@/pages/exception-detail-page';
import { ExceptionsPage } from '@/pages/exceptions-page';
import { LoginPage } from '@/pages/login-page';
import { MyAttendancePage } from '@/pages/my-attendance-page';
import { NewDevicePage } from '@/pages/new-device-page';
import { NewUserPage } from '@/pages/new-user-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { OverviewPage } from '@/pages/overview-page';
import { RouteErrorPage } from '@/pages/route-error-page';
import { SetPasswordPage } from '@/pages/set-password-page';
import { SitesPage } from '@/pages/sites-page';
import { SystemStatusPage } from '@/pages/system-status-page';
import { TwoFactorSetupPage } from '@/pages/two-factor-setup-page';
import { TwoFactorVerifyPage } from '@/pages/two-factor-verify-page';
import { UserDetailPage } from '@/pages/user-detail-page';
import { UsersPage } from '@/pages/users-page';

/**
 * Every page of the dashboard and its web address, the same in mock mode and
 * against the live API. Add new pages here as each roadmap phase builds them,
 * and switch on their link in `components/layout/nav-items.ts`.
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
  // Public: the one-time link is the proof, so no sign-in is needed.
  { path: routes.setPassword, element: <SetPasswordPage />, errorElement: <RouteErrorPage /> },
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
      { index: true, element: <OverviewPage /> },
      { path: 'status', element: <SystemStatusPage /> },
      { path: 'account/password', element: <ChangePasswordPage /> },
      {
        path: 'employees',
        element: (
          <RequireRole roles={pageRoles.employees}>
            <EmployeesPage />
          </RequireRole>
        ),
      },
      {
        path: 'sites',
        element: (
          <RequireRole roles={pageRoles.sites}>
            <SitesPage />
          </RequireRole>
        ),
      },
      {
        // No RequireRole: any signed-in user may ask, and the API decides
        // record by record (a guard sees only their own).
        path: 'employees/:employeeId',
        element: <EmployeeDetailPage />,
      },
      {
        path: 'users',
        element: (
          <RequireRole roles={pageRoles.users}>
            <UsersPage />
          </RequireRole>
        ),
      },
      {
        path: 'users/new',
        element: (
          <RequireRole roles={pageRoles.users}>
            <NewUserPage />
          </RequireRole>
        ),
      },
      {
        path: 'users/:userId',
        element: (
          <RequireRole roles={pageRoles.users}>
            <UserDetailPage />
          </RequireRole>
        ),
      },
      {
        path: 'attendance',
        element: (
          <RequireRole roles={pageRoles.attendance}>
            <AttendancePage />
          </RequireRole>
        ),
      },
      // No RequireRole: every signed-in person may look at their own shifts.
      { path: 'attendance/me', element: <MyAttendancePage /> },
      {
        path: 'attendance/exceptions',
        element: (
          <RequireRole roles={pageRoles.exceptions}>
            <ExceptionsPage />
          </RequireRole>
        ),
      },
      {
        path: 'attendance/exceptions/:exceptionId',
        element: (
          <RequireRole roles={pageRoles.exceptions}>
            <ExceptionDetailPage />
          </RequireRole>
        ),
      },
      {
        path: 'devices',
        element: (
          <RequireRole roles={pageRoles.devices}>
            <DevicesPage />
          </RequireRole>
        ),
      },
      {
        path: 'devices/new',
        element: (
          <RequireRole roles={pageRoles.devices}>
            <NewDevicePage />
          </RequireRole>
        ),
      },
      {
        path: 'devices/:deviceId',
        element: (
          <RequireRole roles={pageRoles.devices}>
            <DeviceDetailPage />
          </RequireRole>
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
