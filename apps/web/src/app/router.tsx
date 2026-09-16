import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { env } from '@/lib/env';
import { ComingInPhasePage } from '@/pages/coming-in-phase-page';
import { EmployeesPage } from '@/pages/employees-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { RouteErrorPage } from '@/pages/route-error-page';
import { SystemStatusPage } from '@/pages/system-status-page';

/**
 * Every page of the dashboard and its web address.
 * Add new pages here as each roadmap phase builds them, and switch on their
 * link in `components/layout/nav-items.ts`.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <SystemStatusPage /> },
      {
        path: 'employees',
        // The real API serves /employees from Phase 1. Until then, live mode
        // shows a notice. Phase 1: replace this with `element: <EmployeesPage />`.
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
