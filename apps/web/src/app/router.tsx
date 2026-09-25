import { createBrowserRouter } from 'react-router';
import { routes } from '@/app/routes';
import { AppShell } from '@/components/layout/app-shell';
import { RequireRole } from '@/components/require-role';
import { RequireSession } from '@/components/require-session';
import { pageRoles } from '@/lib/roles';
import { AttendancePage } from '@/pages/attendance-page';
import { ChangePasswordPage } from '@/pages/change-password-page';
import { DetectionAlertPage } from '@/pages/detection-alert-page';
import { DetectionPage } from '@/pages/detection-page';
import { DetectionRulesPage } from '@/pages/detection-rules-page';
import { DeviceDetailPage } from '@/pages/device-detail-page';
import { DevicesPage } from '@/pages/devices-page';
import { DuplicateFacesPage } from '@/pages/duplicate-faces-page';
import { EditEmployeePage } from '@/pages/edit-employee-page';
import { EmployeeDetailPage } from '@/pages/employee-detail-page';
import { EmployeesPage } from '@/pages/employees-page';
import { ExceptionDetailPage } from '@/pages/exception-detail-page';
import { ExceptionsPage } from '@/pages/exceptions-page';
import { KioskAttemptsPage } from '@/pages/kiosk-attempts-page';
import { LiveBoardPage } from '@/pages/live-board-page';
import { LoginPage } from '@/pages/login-page';
import { MyAttendancePage } from '@/pages/my-attendance-page';
import { MyPayslipsPage } from '@/pages/my-payslips-page';
import { NewDevicePage } from '@/pages/new-device-page';
import { NewEmployeePage } from '@/pages/new-employee-page';
import { NewUserPage } from '@/pages/new-user-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { OverviewPage } from '@/pages/overview-page';
import { PayrollPage } from '@/pages/payroll-page';
import { PayrollRunPage } from '@/pages/payroll-run-page';
import { ReportsPage } from '@/pages/reports-page';
import { RouteErrorPage } from '@/pages/route-error-page';
import { SetPasswordPage } from '@/pages/set-password-page';
import { SitesPage } from '@/pages/sites-page';
import { SystemStatusPage } from '@/pages/system-status-page';
import { TerminateEmployeePage } from '@/pages/terminate-employee-page';
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
        // Before `employees/:employeeId`, so "new" is never read as an ID.
        path: 'employees/new',
        element: (
          <RequireRole roles={pageRoles.employeeChanges}>
            <NewEmployeePage />
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
        path: 'employees/:employeeId/edit',
        element: (
          <RequireRole roles={pageRoles.employeeChanges}>
            <EditEmployeePage />
          </RequireRole>
        ),
      },
      {
        path: 'employees/:employeeId/terminate',
        element: (
          <RequireRole roles={pageRoles.employeeChanges}>
            <TerminateEmployeePage />
          </RequireRole>
        ),
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
        path: 'attendance/live',
        element: (
          <RequireRole roles={pageRoles.liveBoard}>
            <LiveBoardPage />
          </RequireRole>
        ),
      },
      {
        path: 'biometrics/duplicates',
        element: (
          <RequireRole roles={pageRoles.duplicateFaces}>
            <DuplicateFacesPage />
          </RequireRole>
        ),
      },
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
        path: 'devices/attempts',
        element: (
          <RequireRole roles={pageRoles.kioskAttempts}>
            <KioskAttemptsPage />
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
      {
        path: 'payroll',
        element: (
          <RequireRole roles={pageRoles.payroll}>
            <PayrollPage />
          </RequireRole>
        ),
      },
      {
        path: 'payroll/runs/:runId',
        element: (
          <RequireRole roles={pageRoles.payroll}>
            <PayrollRunPage />
          </RequireRole>
        ),
      },
      {
        // The one payroll page a guard may open, and only for their own.
        path: 'payroll/payslips/me',
        element: (
          <RequireRole roles={pageRoles.payslips}>
            <MyPayslipsPage />
          </RequireRole>
        ),
      },
      {
        path: 'reports',
        element: (
          <RequireRole roles={pageRoles.reports}>
            <ReportsPage />
          </RequireRole>
        ),
      },
      {
        path: 'detection',
        element: (
          <RequireRole roles={pageRoles.detection}>
            <DetectionPage />
          </RequireRole>
        ),
      },
      {
        path: 'detection/rules',
        element: (
          <RequireRole roles={pageRoles.detection}>
            <DetectionRulesPage />
          </RequireRole>
        ),
      },
      {
        path: 'detection/alerts/:alertId',
        element: (
          <RequireRole roles={pageRoles.detection}>
            <DetectionAlertPage />
          </RequireRole>
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
