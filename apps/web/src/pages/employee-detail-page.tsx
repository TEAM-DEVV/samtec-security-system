import type { Employee } from '@samtec/contracts';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { DetailRow } from '@/components/detail-row';
import { EmployeeStatusBadge } from '@/components/employee-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { describeApiError, isProblemDetails, isWorthRetrying } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

/**
 * One employee's full record. The API decides what the viewer may see: a
 * guard gets only their own record, a supervisor only people at their site,
 * and the Ghana Card number arrives only for roles that need it, so this page
 * shows that row only when the field is present.
 */
export function EmployeeDetailPage() {
  const { employeeId = '' } = useParams<{ employeeId: string }>();
  const session = useSession();
  const employee = useEmployeeQuery(employeeId);
  // A guard may open their own record but not the list, so no back link for them.
  const mayOpenList = session !== null && roleAllowed(pageRoles.employees, session.user.role);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {mayOpenList && (
        <Link
          to={routes.employees}
          className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Employees
        </Link>
      )}

      <RecordState employee={employee} />
    </div>
  );
}

type EmployeeQuery = ReturnType<typeof useEmployeeQuery>;
function useEmployeeQuery(employeeId: string) {
  return $api.useQuery('get', '/employees/{employeeId}', { params: { path: { employeeId } } });
}

/**
 * Error first: when a later refetch fails (for example the record was moved
 * out of this supervisor's site), React Query keeps the older record in
 * `data`, and it must not stay on screen next to the error.
 */
function RecordState({ employee }: { employee: EmployeeQuery }) {
  if (employee.isError) {
    return (
      <LoadError
        error={employee.error}
        retrying={employee.isFetching}
        onRetry={() => void employee.refetch()}
      />
    );
  }
  if (employee.isPending) {
    return <LoadingRecord />;
  }
  return <EmployeeRecord employee={employee.data} />;
}

function EmployeeRecord({ employee }: { employee: Employee }) {
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-semibold text-2xl tracking-tight">{employee.fullName}</h1>
          <p className="font-mono text-muted-foreground text-sm">{employee.staffNumber}</p>
        </div>
        <EmployeeStatusBadge status={employee.status} />
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Work</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <DetailRow term="Position">{employee.position}</DetailRow>
              <DetailRow term="Current site">
                {employee.currentSite ? (
                  <>
                    {employee.currentSite.name}{' '}
                    <span className="font-mono text-muted-foreground text-xs">
                      {employee.currentSite.code}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not posted</span>
                )}
              </DetailRow>
              <DetailRow term="Hired">
                <span className="tabular-nums">{formatDate(employee.hireDate)}</span>
              </DetailRow>
              {employee.terminationDate && (
                <DetailRow term="Left">
                  <span className="tabular-nums">{formatDate(employee.terminationDate)}</span>
                </DetailRow>
              )}
              <DetailRow term="Biometrics">
                {employee.biometricEnrolledAt ? (
                  <>
                    Enrolled{' '}
                    <span className="text-muted-foreground tabular-nums">
                      {formatDateTime(employee.biometricEnrolledAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not enrolled</span>
                )}
              </DetailRow>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contact and identity</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <DetailRow term="Phone">
                <span className="tabular-nums">{employee.phone}</span>
              </DetailRow>
              <DetailRow term="Email">
                {employee.email ?? <span className="text-muted-foreground">None</span>}
              </DetailRow>
              {/* Sent only to roles that may see it; never show a placeholder for it. */}
              {employee.ghanaCardNumber !== undefined && (
                <DetailRow term="Ghana Card">
                  <span className="font-mono">{employee.ghanaCardNumber}</span>
                </DetailRow>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground text-xs">
        Record created {formatDateTime(employee.createdAt)}, last changed{' '}
        {formatDateTime(employee.updatedAt)} (Ghana time).
      </p>
    </>
  );
}

function LoadingRecord() {
  return (
    <div className="grid gap-4">
      <span role="status" className="sr-only">
        Loading employee…
      </span>
      <Skeleton aria-hidden="true" className="h-8 w-64" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton aria-hidden="true" className="h-48 w-full" />
        <Skeleton aria-hidden="true" className="h-48 w-full" />
      </div>
    </div>
  );
}

/**
 * A 404 gets its own wording: the API answers it both for an unknown ID and
 * for a record this role may not see, on purpose, so the page says only that
 * nothing was found.
 */
interface LoadErrorProps {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

function LoadError({ error, retrying, onRetry }: LoadErrorProps) {
  if (isProblemDetails(error) && error.status === 404) {
    return (
      <Alert>
        <AlertTitle>No employee found</AlertTitle>
        <AlertDescription>
          <p>There is no employee with this ID that you can see.</p>
          <p className="font-mono text-xs">Trace ID: {error.traceId}</p>
        </AlertDescription>
      </Alert>
    );
  }
  const { message, traceId } = describeApiError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>The employee could not be loaded</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{message}</p>
        {traceId && <p className="font-mono text-xs">Trace ID: {traceId}</p>}
        {/* A 400 (bad ID in the address) would only fail the same way again. */}
        {isWorthRetrying(error) && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
